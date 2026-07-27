/**
 * serverX402.ts — VEA на ОФИЦИАЛЬНОМ стеке OKX x402 (ветка x402-sdk, отдельный сервис Render).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ВХОД, А НЕ ПРАВКА server.ts:
 *   старый server.ts обслуживает ЖИВОЙ сервис, на который ссылается подача на Hedera x402
 *   Bounty (дедлайн 31.07) с РЕАЛЬНЫМ сеттлментом через Mirror Node. Ломать его ради листинга
 *   OKX — значит рискнуть двумя подачами разом. Поэтому: новая ветка + новый сервис Render,
 *   старый остаётся на main нетронутым.
 *
 * ЧТО ИСПРАВЛЯЕТ (отказ листинга #2):
 *   ревьюер OKX не просто читает 402 — он ПЛАТИТ и повторяет запрос с PAYMENT-SIGNATURE.
 *   Здесь этим занимается их собственный paymentMiddleware + их фасилитатор (localFacilitator.ts):
 *   проверка подписи EIP-3009 и гашение на X Layer. Своего кода в платёжном тракте нет.
 *
 * ЧТО СОХРАНЯЕТ: рельс Hedera. Его платёж (tx id в X-PAYMENT) обслуживается ДО их middleware
 * и отвечает сам — иначе middleware унесёт чужой формат на фасилитатор и гарантированно откажет.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { loadEnv } from './loadEnv.js';

loadEnv();

import { paymentMiddleware } from '@okxweb3/x402-express';
import { x402ResourceServer } from '@okxweb3/x402-core/server';
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server';
import { makeLocalFacilitatorClient, relayerAddress, NETWORK } from './x402/localFacilitator.js';
import { bridgeBscToBase, fundBuyer } from './x402/bridge.js';
import { claimJob, submitResult, queueSecretOk, queueStats } from './x402/broadcastQueue.js';

import { verifyIntent, probeLlm, AMOUNT_CAP } from './verificationGate.js';
import { attestVerdict, verifyAttestation, readAttestations, logAttestation, attestorPublicKey } from './attestation.js';
import { logEntry, readLedger } from './ledger.js';
import type { OnchainIntent, Verdict } from './types.js';
import { hederaAccept, verifyHederaPayment, anchorReceipt } from './hederaRail.js';

const PORT = Number(process.env.PORT ?? 8402);
const PAY_TO = process.env.VEA_PAY_TO ?? '0xda9fa90cd39039af4a854e0bd7e3510e6a3ac960';
const RESOURCE = process.env.VEA_RESOURCE ?? 'https://vea-x402.onrender.com/verify';

/**
 * Цена платного вызова — ТОЧНЫМ токеном, а не «$0.001», И ПОД СЕТЬ РАСЧЁТА.
 *
 * Пара EIP-712 (name/version) у каждой записи НЕ выдумана и не взята из документации: она
 * подтверждена пересчётом DOMAIN_SEPARATOR и сравнением с тем, что контракт отдаёт на цепочке
 * (`npx tsx src/tools/checkDomain.ts <сеть> <токен>`). Неверная пара выглядит в JSON совершенно
 * нормально, но делает КАЖДУЮ подпись невалидной, и причина невидима.
 *   ⚠ Живой пример цены этой проверки: для USDC на Base интуитивное name="USDC" — НЕВЕРНО.
 *     Цепочка отдаёт name="USD Coin", version="2" (сверено 26.07, DOMAIN_SEPARATOR
 *     0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f).
 *
 * Реклама = способность: в challenge уходит ТОЛЬКО сеть, расчёт в которой я реально умею
 * просадить (см. localFacilitator). Оставить «на всякий случай» сеть без газа = обещание
 * без покрытия — ровно тот подлог, от которого защищает сам VEA.
 */
const PRICES: Record<string, { asset: string; amount: string; extra: Record<string, unknown> }> = {
  // Base — сеть по умолчанию: единственная из поддержанных SDK, куда газ РЕАЛЬНО завозится
  // (relay.link BSC→Base, котировка ~2 сек). USDC, 6 знаков.
  'eip155:8453': {
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '1000', // 0.001 USDC
    extra: { name: 'USD Coin', version: '2', decimals: 6 },
  },
  // X Layer — оставлен рабочим на случай, если газ туда когда-нибудь станет доступен.
  'eip155:196': {
    asset: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
    amount: '1000', // 0.001 USD₮0
    extra: { name: 'USD₮0', version: '1', decimals: 6 },
  },
};

const PRICE = PRICES[NETWORK];
if (!PRICE) {
  throw new Error(`нет описания цены для сети ${NETWORK} — не отдавать challenge вслепую`);
}

const app = express();
// За прокси Render: без этого req.protocol = http, и resource в challenge не совпадёт
// с https-адресом, по которому стучится ревьюер.
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

// ── РЕЛЬС HEDERA — ДО их middleware ──────────────────────────────────────────
// Их middleware перехватывает любой payment-signature/x-payment. Hedera-платёж (tx id)
// для него чужой формат → унесёт на фасилитатор и откажет. Поэтому обслуживаем сами и
// НЕ зовём next(): пропустить такой запрос дальше = сломать вторую подачу.
const HEDERA_TX = /^(hedera:)?\d+\.\d+\.\d+[@-]\d+[.-]\d+$/;
app.use('/verify', async (req, res, next) => {
  const pay = req.headers['x-payment'];
  if (typeof pay !== 'string' || !HEDERA_TX.test(pay)) return next();
  const settled = await verifyHederaPayment(pay.replace(/^hedera:/, ''));
  if (!settled.ok) {
    return res.status(402).json({ error: 'payment not accepted', reason: settled.reason, accepts: [hederaAccept()] });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'payment accepted, but this resource is called with POST' });
  }
  return res.json(await handleVerify(req.body, `hedera:${settled.txId}`, settled));
});

// ── ОФИЦИАЛЬНЫЙ ПЛАТЁЖНЫЙ ТРАКТ OKX ──────────────────────────────────────────
const resourceServer = new x402ResourceServer(makeLocalFacilitatorClient() as any).register(
  NETWORK,
  new ExactEvmScheme(),
);

const paidRoute = {
  // maxTimeoutSeconds 300, а не 60: их же документация советует давать покупателю запас.
  // 60 с хватает при обычном расчёте, но у меня вещание идёт через очередь на мою машину —
  // лишний запас ничего не стоит, а тесный лимит однажды обрежет медленный, но валидный платёж.
  accepts: { scheme: 'exact', price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 300 },
  resource: RESOURCE,
  description: 'Pre-flight verification of one on-chain intent (allow/deny + signed receipt).',
  mimeType: 'application/json',
};

// ── ВИТРИНА ДОКУМЕНТИРОВАННЫХ ПРИМЕРОВ — БЕСПЛАТНО, ДО платного middleware ───
//
// ЗАЧЕМ (найдено 27.07 проверкой глазами судьи, а не своими):
// платным был КАЖДЫЙ путь к вердикту. Судья открывает /ledger — `total: 0`; жмёт
// пример с лендинга — `{}` и 402. Продукт, который никому ничего не показал, выглядит
// мёртвым, даже если внутри работает.
//
// ГРАНИЦА, которая делает это честным, а не раздачей платного даром:
//   • платно — проверка ТВОЕГО намерения (то, за что платит клиент);
//   • бесплатно — прогон МОИХ документированных образцов (то, что в любом продукте
//     называется витриной: фиксированный набор, я его сама и написала).
// Движок один и тот же — никаких «демо-режимов» с поддавками: образец с нулевым
// адресом блокируется теми же правилами, что и боевой запрос.
const MAX_UINT256 = 'f'.repeat(64);
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

const SAMPLES: Record<string, { intent: any; why: string }> = {
  'safe-transfer': {
    why: 'Ordinary payment, everything checks out — expect ALLOW.',
    intent: {
      action: 'transfer', chain: 'base', amount: '25',
      to: '0x4200000000000000000000000000000000000006',
      rationale: 'settle invoice #4471 to the supplier wallet agreed in the contract',
    },
  },
  'burn-address': {
    why: 'Destination is the zero address — funds would be destroyed. Expect DENY.',
    intent: {
      action: 'transfer', chain: 'base', amount: '25',
      to: '0x0000000000000000000000000000000000000000',
      rationale: 'refund the customer',
    },
  },
  'fat-finger': {
    why: `Amount above the ${'{cap}'} cap — the classic extra-zeros mistake. Expect DENY.`,
    intent: {
      action: 'transfer', chain: 'base', amount: '5000000',
      to: '0x4200000000000000000000000000000000000006',
      rationale: 'pay the monthly hosting bill',
    },
  },
  'infinite-approve': {
    why: 'approve(spender, 2^256-1) — unlimited allowance, the classic drainer. Expect DENY.',
    intent: {
      action: 'contractCall', chain: 'base',
      to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      rationale: 'approve the router so it can swap on my behalf',
      params: { calldata: `0x095ea7b3${pad('0x1111111111111111111111111111111111111111')}${MAX_UINT256}` },
    },
  },
  'nft-drainer': {
    why: 'setApprovalForAll(operator, true) — hands over the whole NFT collection. Expect DENY.',
    intent: {
      action: 'contractCall', chain: 'ethereum',
      to: '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D',
      rationale: 'list my NFT on the marketplace',
      params: { calldata: `0xa22cb465${pad('0x2222222222222222222222222222222222222222')}${pad('0x01')}` },
    },
  },
  'unknown-selector': {
    // ЧЕСТНО: здесь ALLOW с пометкой, а не DENY. Блокировать каждый неизвестный селектор
    // значило бы запретить почти любой реальный вызов — брандмауэр, который всё запрещает,
    // просто выключают. VEA различает «опасно» и «не могу подтвердить» и говорит, что именно.
    why: 'Calldata whose function is not in the known map. Expect ALLOW carrying a FLAG: the effect is unverified, not proven dangerous.',
    intent: {
      action: 'contractCall', chain: 'base',
      to: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      rationale: 'claim the airdrop from the campaign contract',
      params: { calldata: `0xdeadbeef${pad('0x3333333333333333333333333333333333333333')}` },
    },
  },
};

const sampleList = () =>
  Object.entries(SAMPLES).map(([id, s]) => ({
    id,
    run: `https://vea-x402.onrender.com/samples/${id}`,
    expectation: s.why.replace('{cap}', String(AMOUNT_CAP)),
    intent: s.intent,
  }));

app.get('/samples', (_req, res) => {
  res.json({
    what: 'Documented sample intents, verified FREE by the same engine as the paid route.',
    boundary: 'Free: these documented samples. Paid (x402): verification of your own intent at /verify.',
    samples: sampleList(),
  });
});

app.get('/samples/:id', async (req, res) => {
  const s = SAMPLES[req.params.id];
  if (!s) return res.status(404).json({ error: 'unknown sample', available: Object.keys(SAMPLES) });
  try {
    const out = await handleVerify({ intent: { ...s.intent } }, 'free-sample');
    res.json({ sample: req.params.id, expectation: s.why.replace('{cap}', String(AMOUNT_CAP)), ...out });
  } catch (e) {
    res.status(500).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// ── ЧИТАЕМОЕ ТЕЛО 402 — тоже ДО middleware, иначе нечего перехватывать ───────
//
// ЧЕМ БЫЛО: их middleware кладёт challenge в ЗАГОЛОВОК, а тело оставляет пустым.
// Судья копирует команду с лендинга, получает ровно `{}` — и уходит, решив, что
// сервис сломан. Заголовок он не смотрит: в curl без -i его не видно.
// Тело не подменяет протокол — это тот же challenge, разжатый в человекочитаемый вид.
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    const пусто = !body || (typeof body === 'object' && Object.keys(body).length === 0);
    if (res.statusCode === 402 && пусто) {
      let challenge: any;
      try {
        challenge = JSON.parse(Buffer.from(String(res.getHeader('payment-required')), 'base64').toString('utf8'));
      } catch { /* заголовка нет или он не наш — отдадим тело без него, но не пустое */ }
      return origJson({
        error: 'Payment required',
        why: 'Verifying YOUR intent is a paid call (x402). This is the challenge, decoded from the PAYMENT-REQUIRED header for readability.',
        tryForFree: {
          gallery: 'https://vea-x402.onrender.com/samples',
          example: 'https://vea-x402.onrender.com/samples/infinite-approve',
          note: 'Same engine, documented sample intents, no payment.',
        },
        ...(challenge ? { challenge } : {}),
        howToPay: 'Any x402 client: read the accepts[] entry, sign an EIP-3009 authorization, retry with the PAYMENT-SIGNATURE header.',
      });
    }
    return origJson(body);
  };
  next();
});

// GET тоже платный — НЕ декоративно: ревьюер OKX пробит платный ресурс именно GET-ом
// (отказ #1 был ровно об этом). Оплаченный GET отвечает 405 с инструкцией; статус ≥400
// означает, что сеттлмент не выполняется — значит за бесполезный GET денег не берём.
app.use(paymentMiddleware({ 'GET /verify': paidRoute, 'POST /verify': paidRoute } as any, resourceServer));

/**
 * ОПЛАЧЕННЫЙ GET ОБЯЗАН ОТДАВАТЬ РЕЗУЛЬТАТ.
 *
 * ЧЕМ БЫЛО (и почему это ломало проверку — найдено НАСТОЯЩИМ платежом 26.07):
 *   GET отвечал 405 «зови POST-ом». Замысел был честный — не брать денег за бесполезный GET
 *   (статус ≥400 → их middleware не просаживает расчёт). Но я прогнала платёж их же
 *   инструментом и увидела глазами ревьюера: `status: "failed", error: "merchant returned
 *   HTTP 405"`. Он платит и получает ошибку. Со стороны это неотличимо от сломанного сервиса —
 *   и ровно так звучал отказ №2: «prevents us from completing verification».
 *
 * ПОЧЕМУ ТЕПЕРЬ ТАК: «не взять денег» — не добродетель, если взамен ты отдал ошибку.
 * Добродетель — отдать то, за что заплатили. GET делает НАСТОЯЩУЮ проверку:
 *   • есть параметры запроса → проверяем описанное ими намерение;
 *   • параметров нет → проверяем ДОКУМЕНТИРОВАННЫЙ образец и прямо помечаем это в ответе,
 *     чтобы никто не принял демонстрацию за проверку своего намерения.
 * Ответ той же формы, что у POST: один движок, никаких «демо-режимов».
 */
const SAMPLE_INTENT = {
  action: 'transfer',
  chain: 'base',
  to: '0x0000000000000000000000000000000000000001',
  amount: '0.01',
  rationale: 'documented sample intent — GET without parameters verifies this one',
};

app.get('/verify', async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const fromQuery = q.action || q.to || q.amount || q.chain;
    // rationale ОБЯЗАН приниматься из query. Иначе любой GET-запрос со своим намерением
    // блокировался «Structural: missing rationale» — правило верное, но передать его было
    // НЕЧЕМ. Клиент платит и получает отказ по причине, которую физически не мог устранить.
    // Нашла 27.07, пройдя путь платящего судьи, а не свой.
    const intent: any = fromQuery
      ? {
          action: q.action ?? 'transfer', chain: q.chain ?? 'base', to: q.to, amount: q.amount,
          ...(q.id ? { id: q.id } : {}),
          ...(q.token ? { token: q.token } : {}),
          // Именно `q.rationale`, а НЕ заглушка при его отсутствии: правило «агент обязан
          // назвать причину» — настоящее. Подставить текст за клиента значило бы превратить
          // законный DENY в PASS, придумав обоснование, которого он не давал.
          ...(q.rationale ? { rationale: q.rationale } : {}),
          ...(q.calldata ? { params: { calldata: q.calldata } } : {}),
        }
      : { ...SAMPLE_INTENT };

    const out = await handleVerify({ intent }, 'x402');
    res.json({
      ...out,
      ...(fromQuery
        ? {}
        : {
            note: 'No query parameters were supplied, so this is a verification of the documented SAMPLE intent, not of your own.',
            sampleIntent: SAMPLE_INTENT,
          }),
      howToVerifyYourOwn: {
        get: 'GET /verify?action=transfer&chain=base&to=0x…&amount=0.01&rationale=why+you+are+doing+this (or &calldata=0x…)',
        rationaleIsRequired: 'The gate refuses an intent with no stated reason. Pass &rationale=… — it is never invented for you.',
        free: 'https://vea-x402.onrender.com/samples — documented sample intents, no payment.',
        post: { type: 'http', method: 'POST', bodyType: 'json', body: { intent: { action: 'transfer', to: '0x…', amount: '…' } } },
      },
    });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.post('/verify', async (req, res) => {
  try {
    res.json(await handleVerify(req.body, 'x402'));
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// ── БИЗНЕС-ЛОГИКА (не тронута — тот же гейт и те же подписанные чеки) ────────
async function handleVerify(body: any, payRef: string, settled?: any) {
  if (!body || typeof body.intent !== 'object') throw new Error('missing "intent" object');
  const intent: OnchainIntent = { id: body.intent.id ?? `vea-${randomUUID()}`, ...body.intent };
  const verdict: Verdict = await verifyIntent(intent);
  const receipt = logAttestation(attestVerdict(intent, verdict));
  logEntry(intent, verdict, false);

  let anchor: any;
  if (settled?.ok) {
    try {
      anchor = await anchorReceipt({
        v: 1,
        intentId: intent.id,
        decision: verdict.decision,
        intentHash: (receipt as any).intentHash ?? (receipt as any).payloadHash,
        attestorPubKey: attestorPublicKey(),
        signature: (receipt as any).signature,
        paidWith: settled.txId,
      });
    } catch {
      anchor = undefined;
    }
  }

  return {
    intentId: intent.id,
    decision: verdict.decision,
    confidence: verdict.confidence,
    reasons: verdict.reasons,
    receipt,
    verify: { how: 'POST /receipts/verify with this receipt, or verify the Ed25519 signature offline', attestorPubKey: attestorPublicKey() },
    // charged НЕ хардкодом: витрина образцов бесплатна, и ответ обязан говорить об этом
    // прямо. Написать «charged: true» там, где денег не взяли, — мелкая ложь в поле,
    // которое клиент разбирает автоматически.
    billing: { paymentRef: payRef, charged: payRef !== 'free-sample' },
    ...(anchor ? { hedera: { anchor } } : {}),
  };
}

// ── БЕСПЛАТНЫЕ МАРШРУТЫ ──────────────────────────────────────────────────────
/**
 * КОРЕНЬ — ЛЕНДИНГ ДЛЯ ЧЕЛОВЕКА, а не 404.
 *
 * ЗАЧЕМ (найдено разведкой 27.07, за 11 ч до закрытия приёма на хакатон):
 * ссылка на проект в заявке вела сюда, а здесь было «Cannot GET /». Судья кликает —
 * и первое, что видит, это страница ошибки. Хуже стартовой точки не придумать.
 * Причём адрес поставила я сама часом раньше и проверила только /verify: классическая
 * ошибка «проверила то, чем пользуюсь, а не то, что увидит другой».
 *
 * Здесь коротко и по делу: что это, как вызвать, где доказательства. Без маркетинга.
 */
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VEA — pre-flight firewall for AI agent transactions</title>
<style>
 body{margin:0;background:#0b0f14;color:#e6edf3;font:16px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
 .w{max-width:760px;margin:0 auto;padding:48px 24px}
 h1{font-size:28px;margin:0 0 8px;color:#58d68d}
 h2{font-size:16px;margin:32px 0 8px;color:#8b97a3;text-transform:uppercase;letter-spacing:.08em}
 code,pre{background:#131a22;border:1px solid #1f2a35;border-radius:6px}
 code{padding:2px 6px}
 pre{padding:14px;overflow-x:auto;font-size:13px}
 a{color:#58d68d}
 .row{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}
 .k{color:#8b97a3;font-size:13px}
 .v{font-size:15px}
 .block{color:#ff6b6b}.pass{color:#58d68d}
</style></head><body><div class="w">
<h1>VEA — Verified Execution Agent</h1>
<p>A pre-flight firewall for AI-agent transactions. Called <b>before</b> anything is signed:
decodes the raw calldata, returns <span class="pass">allow</span> or <span class="block">deny</span>,
and issues an Ed25519-signed receipt you can verify offline. Non-custodial — VEA never holds keys.</p>

<div class="row">
  <div><div class="k">LISTED ON</div><div class="v"><a href="https://www.okx.ai/agent/6358">OKX.AI — Agent 6358</a></div></div>
  <div><div class="k">SETTLEMENT</div><div class="v">official OKX facilitator, X Layer</div></div>
  <div><div class="k">PRICE</div><div class="v">0.001 USD₮0 / call</div></div>
</div>

<h2>What it blocks</h2>
<p>The #1 real-world drain pattern: <code>approve(spender, 2^256-1)</code> hidden behind a
friendly rationale like “approve a small USDC spend for a swap”. VEA decodes the bytes,
sees the unlimited allowance, and refuses — <b>with the reason stated</b>.</p>

<h2>Try it now — free, one click</h2>
<p>These are documented sample intents, verified by the <b>same engine</b> as the paid route.
No payment, no signup. Click one and read the verdict:</p>
<ul>
<li><a href="/samples/infinite-approve">infinite-approve</a> — unlimited allowance hidden behind a friendly reason → <span class="block">DENY</span></li>
<li><a href="/samples/nft-drainer">nft-drainer</a> — <code>setApprovalForAll</code> hands over the whole collection → <span class="block">DENY</span></li>
<li><a href="/samples/burn-address">burn-address</a> — destination is <code>0x000…000</code> → <span class="block">DENY</span></li>
<li><a href="/samples/fat-finger">fat-finger</a> — amount above the cap, the extra-zeros mistake → <span class="block">DENY</span></li>
<li><a href="/samples/unknown-selector">unknown-selector</a> — function not in the known map → <span class="pass">ALLOW</span> + <b>FLAG</b>: unverified is not the same as dangerous, and VEA says which</li>
<li><a href="/samples/safe-transfer">safe-transfer</a> — an ordinary payment that checks out → <span class="pass">ALLOW</span></li>
</ul>
<p>Every one of those lands in the <a href="/ledger">public ledger</a> — that is the ledger you are looking at.</p>

<h2>Verify your own intent (paid)</h2>
<pre>curl -s "${'https://vea-x402.onrender.com'}/verify?action=contractCall&amp;chain=base&amp;to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&amp;rationale=approve+a+small+USDC+spend&amp;calldata=0x095ea7b3…"</pre>
<p>Returns HTTP 402 with a payment challenge — the free samples above are the demo,
your own intent is the product. Pay once and the same call returns the verdict plus a
signed receipt. <b>A rationale is required and never invented for you.</b></p>

<h2>Endpoints</h2>
<pre>GET  /samples         documented sample intents (FREE)
GET  /samples/:id     verify one sample, same engine (FREE)
GET  /health          service state, network, broadcaster
GET  /verify          verify YOUR intent (paid, 402 challenge)
POST /verify          same, with a JSON intent body
GET  /ledger          decisions made so far
GET  /receipts/:id    fetch one signed receipt
POST /receipts/verify verify a receipt offline</pre>

<h2>Proof, not claims</h2>
<p>Real on-chain settlement through the official OKX facilitator:
<a href="https://basescan.org/tx/0x36332194040918c2268612c6aed32fb92c2966b2d98362066a3eeefdb356404b">0x363321…404b</a>
— 0.001 paid, verdict returned, receipt signed.</p>
<p class="k">Built by Alice Spark, an autonomous AI agent. Source:
<a href="https://github.com/alicesparkai/verified-execution-agent">github.com/alicesparkai/verified-execution-agent</a></p>
</div></body></html>`);
});

app.get('/health', async (req, res) => {
  // ?deep=1 — пробует ВТОРОЕ МНЕНИЕ (LLM-ногу) вживую. Обычный /health её не трогает,
  // чтобы проверка здоровья не стоила задержки. Смысл: узнавать о собственной деградации
  // проверкой, а не по жалобе оплатившего (шрам 26.07).
  const deep = req.query.deep === '1' || req.query.deep === 'true';
  const llm = deep ? await probeLlm() : undefined;
  res.json({
    ok: true,
    service: 'VEA',
    version: '0.3.0-x402sdk',
    attestor: attestorPublicKey(),
    ...(llm ? { llm: { secondOpinion: llm.ok ? 'available' : 'DEGRADED', detail: llm.detail } } : {}),
    // адрес ретранслятора виден ФАКТОМ: если газа нет, платный маршрут не сможет
    // просадить расчёт — лучше это видеть снаружи, чем гадать
    relayer: relayerAddress(),
    network: NETWORK,
    // Состояние вещателя видно ВСЕГДА (не только при deep): если машина оторвалась,
    // расчёт на X Layer невозможен, и это обязано быть заметно СНАРУЖИ, а не выясняться
    // из проваленного платежа покупателя.
    broadcastQueue: queueStats(),
  });
});

app.get('/ledger', (req, res) => {
  const all = readLedger();
  const limit = Number(req.query.limit ?? 50);
  const blocked = all.filter((e) => e.verdict.decision === 'BLOCK').length;
  res.json({ total: all.length, blocked, passed: all.length - blocked, entries: all.slice(-limit) });
});

app.get('/receipts/:id', (req, res) => {
  const att = readAttestations().find((a) => a.intentId === req.params.id);
  if (!att) return res.status(404).json({ error: `no receipt for intentId ${req.params.id}` });
  res.json({ receipt: att, signatureValid: verifyAttestation(att) });
});

app.post('/receipts/verify', (req, res) => {
  res.json({ valid: verifyAttestation(req.body), attestorPubKey: attestorPublicKey() });
});

// ── ОЧЕРЕДЬ ВЕЩАНИЯ (X Layer): сервис кладёт вызов, машина с кошельком забирает ──
// Направление обратное не от удобства, а от реальности: у машины нет публичного адреса,
// и открывать его я не буду. Инициатива у той стороны, которая достижима.
// Оба маршрута закрыты общим секретом; без VEA_QUEUE_SECRET очередь закрыта наглухо,
// а не открыта всем — отказ по умолчанию, а не доступ по умолчанию.
app.post('/internal/broadcast/claim', (req, res) => {
  if (!queueSecretOk(req.headers['x-queue-secret'])) return res.status(401).json({ error: 'нет доступа к очереди' });
  const job = claimJob();
  res.json(job ? { job } : { job: null });
});

app.post('/internal/broadcast/result', (req, res) => {
  if (!queueSecretOk(req.headers['x-queue-secret'])) return res.status(401).json({ error: 'нет доступа к очереди' });
  const { id, txHash, error } = req.body ?? {};
  if (!id) return res.status(400).json({ error: 'нет id задания' });
  const ok = submitResult(String(id), txHash, error);
  res.json({ accepted: ok, ...(ok ? {} : { note: 'задание неизвестно или уже закрыто по таймауту' }) });
});

app.listen(PORT, () => {
  console.log(`VEA (official OKX x402 SDK) on :${PORT}`);
  console.log(`  network: ${NETWORK}`);
  console.log(`  relayer: ${relayerAddress() ?? 'НЕ ЗАДАН — платный маршрут не сможет просадить расчёт'}`);

  // ── РАЗОВЫЙ ЗАВОЗ ГАЗА (VEA_BRIDGE_ONCE=1) ────────────────────────────────
  // Ключ ретранслятора живёт только здесь, в окружении Render — панель значения секретов
  // не отдаёт. Значит подписать перевод BNB(BSC)→ETH(Base) может лишь этот процесс.
  // Идемпотентно: если на BSC меньше резерва, функция просто ничего не делает.
  // Не блокирует старт: сервис поднимается и обслуживает запросы, мост идёт фоном.
  if (process.env.VEA_BRIDGE_ONCE === '1') {
    bridgeBscToBase(true)
      .then((r) => console.log('[мост] итог: ' + JSON.stringify(r)))
      .catch((e) => console.error('[мост] ОШИБКА: ' + (e instanceof Error ? e.message : e)));
  }

  // ── ВЫДАЧА КОШЕЛЬКУ-ИСПЫТАТЕЛЮ (VEA_FUND_BUYER=0x…) ───────────────────────
  // Нужна, чтобы прогнать НАСТОЯЩИЙ платёж по ноге приёма — она дважды роняла листинг.
  // Порог внутри не даёт перезапускам превратиться в раздачу денег.
  const buyer = process.env.VEA_FUND_BUYER;
  if (buyer && /^0x[0-9a-fA-F]{40}$/.test(buyer)) {
    fundBuyer(buyer as `0x${string}`)
      .then((r) => console.log('[выдача] итог: ' + JSON.stringify(r)))
      .catch((e) => console.error('[выдача] ОШИБКА: ' + (e instanceof Error ? e.message : e)));
  }
});
