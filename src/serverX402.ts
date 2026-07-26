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

import { verifyIntent } from './verificationGate.js';
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
  accepts: { scheme: 'exact', price: PRICE, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 },
  resource: RESOURCE,
  description: 'Pre-flight verification of one on-chain intent (allow/deny + signed receipt).',
  mimeType: 'application/json',
};

// GET тоже платный — НЕ декоративно: ревьюер OKX пробит платный ресурс именно GET-ом
// (отказ #1 был ровно об этом). Оплаченный GET отвечает 405 с инструкцией; статус ≥400
// означает, что сеттлмент не выполняется — значит за бесполезный GET денег не берём.
app.use(paymentMiddleware({ 'GET /verify': paidRoute, 'POST /verify': paidRoute } as any, resourceServer));

app.get('/verify', (_req, res) => {
  res.status(405).json({
    error: 'payment accepted, but this resource is called with POST',
    howToCall: { type: 'http', method: 'POST', bodyType: 'json', body: { intent: { action: 'transfer', to: '0x…', value: '…' } } },
  });
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
    billing: { paymentRef: payRef, charged: true },
    ...(anchor ? { hedera: { anchor } } : {}),
  };
}

// ── БЕСПЛАТНЫЕ МАРШРУТЫ ──────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'VEA',
    version: '0.3.0-x402sdk',
    attestor: attestorPublicKey(),
    // адрес ретранслятора виден ФАКТОМ: если газа нет, платный маршрут не сможет
    // просадить расчёт — лучше это видеть снаружи, чем гадать
    relayer: relayerAddress(),
    network: NETWORK,
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
