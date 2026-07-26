/**
 * localFacilitator.ts — ОФИЦИАЛЬНЫЙ фасилитатор OKX, поднятый В СВОЁМ ПРОЦЕССЕ.
 *
 * ЗАЧЕМ (отказ листинга #2, 26.07):
 *   «your service is not integrated with the official OKX Payment SDK, which prevents us
 *    from completing verification»
 * Их проверка — это РЕАЛЬНЫЙ оплаченный вызов: ревьюер парсит наш 402, подписывает платёж
 * и повторяет запрос с заголовком PAYMENT-SIGNATURE. Сервер обязан проверить подпись и
 * ПРОСАДИТЬ РАСЧЁТ. Мой прежний сервер читал только `x-payment` и не умел ни того, ни другого.
 *
 * ПОЧЕМУ НЕ ОБЛАЧНЫЙ ФАСИЛИТАТОР OKX:
 *   `OKXFacilitatorClient` требует apiKey/secretKey/passphrase (README §Server Usage; замер:
 *   GET /api/v6/pay/x402/supported → 401 с 5 датацентров). Ключи выдаёт портал web3.okx.com,
 *   недоступный по сети из Алматы. НО пакет экспортирует `./exact/facilitator` — ту же
 *   реализацию как КОД. Значит фасилитатор можно держать у себя: SDK официальный, ключи не нужны.
 *
 * ЦЕНА РЕШЕНИЯ: расчёт теперь гасим МЫ → нужен газ (OKB) на кошельке-ретрансляторе.
 * Выручка при этом идёт мимо ретранслятора — сразу на payTo.
 *
 * ВСЁ ЗДЕСЬ — ИХ КОД. Своего только переходник (три метода интерфейса FacilitatorClient),
 * потому что ResourceServer ждёт клиента, а у нас фасилитатор в том же процессе.
 */
import { x402Facilitator } from '@okxweb3/x402-core/facilitator';
import { ExactEvmScheme as ExactEvmFacilitator } from '@okxweb3/x402-evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@okxweb3/x402-evm';
import { createWalletClient, http, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, xLayer } from 'viem/chains';
import { makeAgenticSigner } from './agenticSigner.js';
import { enqueueBroadcast } from './broadcastQueue.js';

/**
 * СЕТИ, КОТОРЫЕ УМЕЕТ ЭТОТ ФАСИЛИТАТОР.
 *
 * ПОЧЕМУ СЕТЬ СТАЛА ПЕРЕМЕННОЙ (26.07, поворот):
 *   Я час искала мост в X Layer и упёрлась: Gas.zip — «Insufficient Liquidity» на любую сумму,
 *   relay.link не знает сеть 196 вовсе, и даже СОБСТВЕННЫЙ агрегатор OKX (`onchainos cross-chain`)
 *   отвечает `no_path`. X Layer оказался островом: газ туда не завезти.
 *   Ошибка была в рамке — я держала сеть за ДАННОСТЬ и искала обход. А переменной была именно сеть:
 *   grep по установленному пакету @okxweb3/x402-* показал, что их SDK поддерживает и "eip155:8453"
 *   (Base), не только "eip155:196". Base — не остров: relay.link даёт BSC→Base за ~2 секунды.
 *   Дешевле сменить требование, чем ломиться в остров.
 *
 * Выбор сети — через VEA_NETWORK. По умолчанию Base: это единственная сеть из поддержанных SDK,
 * куда я РЕАЛЬНО могу завезти газ (проверено котировкой, а не списком сетей).
 */
const CHAINS = {
  'eip155:196': { chain: xLayer, rpc: 'https://rpc.xlayer.tech', rpcEnv: 'VEA_XLAYER_RPC' },
  'eip155:8453': { chain: base, rpc: 'https://mainnet.base.org', rpcEnv: 'VEA_BASE_RPC' },
} as const;

export type SupportedNetwork = keyof typeof CHAINS;

function pickNetwork(): SupportedNetwork {
  const n = (process.env.VEA_NETWORK ?? 'eip155:8453') as SupportedNetwork;
  if (!(n in CHAINS)) {
    throw new Error(
      `VEA_NETWORK=${n} не поддержан. Доступны: ${Object.keys(CHAINS).join(', ')}. ` +
        'Рекламировать сеть, которую не умею просадить, нельзя — это обещание без покрытия.',
    );
  }
  return n;
}

/** CAIP-2 сети расчёта — ровно та, что стоит в challenge нашего 402. */
export const NETWORK: SupportedNetwork = pickNetwork();

/**
 * Собрать подписанта фасилитатора из приватного ключа ретранслятора.
 * Ключ приходит ТОЛЬКО из окружения (Render env VEA_RELAYER_KEY) — в репозитории его нет.
 */
function buildSigner(privateKey: `0x${string}`, rpcUrl?: string) {
  const account = privateKeyToAccount(privateKey);
  const cfg = CHAINS[NETWORK];
  const client = createWalletClient({
    account,
    chain: cfg.chain,
    transport: http(rpcUrl || process.env[cfg.rpcEnv] || cfg.rpc),
  }).extend(publicActions);
  // toFacilitatorEvmSigner ждёт объект с `address` + методами чтения/записи цепочки.
  return toFacilitatorEvmSigner(Object.assign(client, { address: account.address }) as any);
}

/**
 * Переходник: ResourceServer работает с FacilitatorClient (сетевой контракт),
 * а наш фасилитатор живёт в этом же процессе. Методы совпадают один в один —
 * поэтому это честный проброс, а не своя логика проверки.
 * getSupported у фасилитатора синхронный, у клиента — Promise: оборачиваем.
 */
export class LocalFacilitatorClient {
  constructor(private readonly facilitator: x402Facilitator) {}

  async verify(paymentPayload: any, paymentRequirements: any) {
    return this.facilitator.verify(paymentPayload, paymentRequirements);
  }

  async settle(paymentPayload: any, paymentRequirements: any) {
    return this.facilitator.settle(paymentPayload, paymentRequirements);
  }

  async getSupported() {
    return this.facilitator.getSupported();
  }
}

/**
 * Готовый клиент фасилитатора для ResourceServer.
 * Бросает ЯВНО, если ключа нет: без него платный маршрут не сможет просадить расчёт,
 * и лучше упасть на старте, чем молча отдавать 402, который невозможно закрыть (fail-loud).
 */
export function makeLocalFacilitatorClient(): LocalFacilitatorClient {
  // ── ВЕТКА X LAYER: вещает агентский кошелёк OKX, газ платит их бандлер ──────
  // Своего ключа тут нет и не нужно: на 196 нативный OKB недоступен ни одним мостом,
  // зато агентский кошелёк — ERC-4337 smart account со спонсором (доказано цепочкой
  // 26.07: tx 0xb11dcaace0…c587a прошла при НУЛЕВОМ балансе). Подменяется ровно точка
  // вещания, платёжный тракт SDK не тронут.
  // VEA_BROADCAST_VIA=agentic принудительно включает эту ветку в ЛЮБОЙ сети.
  // Зачем: сквозной тест на X Layer невозможен — чтобы заплатить самой, нужен USD₮0 в сети,
  // куда ничего не завозится. Значит проверяю МЕХАНИКУ (подписант→очередь→CLI) там, где деньги
  // есть — на Base, — а бесплатность вещания на 196 уже доказана отдельной транзакцией.
  // Две проверки вместе покрывают путь, которого не покрыть одной.
  const agentic = process.env.VEA_AGENTIC_WALLET as `0x${string}` | undefined;
  const viaAgentic = NETWORK === 'eip155:196' || process.env.VEA_BROADCAST_VIA === 'agentic';
  if (viaAgentic) {
    if (!agentic || !/^0x[0-9a-fA-F]{40}$/.test(agentic)) {
      throw new Error(
        'VEA_AGENTIC_WALLET не задан (адрес агентского кошелька OKX, 0x + 40 hex). ' +
          'На X Layer расчёт вещает он — своего ключа с газом там нет и быть не может.',
      );
    }
    // Имя сети для CLI на машине: он принимает 'xlayer'/'base', а не CAIP-2.
    const cliChain = NETWORK === 'eip155:196' ? 'xlayer' : 'base';
    const signer = makeAgenticSigner({
      address: agentic,
      chain: CHAINS[NETWORK].chain,
      rpcUrl: process.env[CHAINS[NETWORK].rpcEnv],
      broadcast: (to, data) => enqueueBroadcast(to, data, cliChain),
    });
    const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmFacilitator(signer as any));
    return new LocalFacilitatorClient(facilitator);
  }

  // ── ВЕТКА BASE (и прочие EOA-сети): подписываем своим ключом ────────────────
  const pk = process.env.VEA_RELAYER_KEY as `0x${string}` | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      'VEA_RELAYER_KEY не задан (нужен приватный ключ ретранслятора, 0x + 64 hex). ' +
        `Без него фасилитатор не сможет просадить расчёт в сети ${NETWORK}.`,
    );
  }
  const signer = buildSigner(pk, process.env.VEA_BASE_RPC);
  const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmFacilitator(signer));
  return new LocalFacilitatorClient(facilitator);
}

/**
 * Адрес вещателя — для /health, чтобы видеть ФАКТОМ, кто отправляет расчёт.
 * На X Layer это агентский кошелёк (газ спонсирует бандлер OKX), в остальных сетях — мой EOA.
 * Показывать ключевой адрес там, где вещает кошелёк, значило бы врать в собственной диагностике.
 */
export function relayerAddress(): string | null {
  // ⚠ Учитывает И флаг VEA_BROADCAST_VIA: без этого диагностика врёт. 27.07 она показала мне
  // EOA-адрес, когда вещал уже кошелёк, — и я десять минут ждала «выката», который давно был.
  if (NETWORK === 'eip155:196' || process.env.VEA_BROADCAST_VIA === 'agentic') {
    const a = process.env.VEA_AGENTIC_WALLET;
    return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a} (агентский кошелёк OKX, газ спонсирован)` : null;
  }
  const pk = process.env.VEA_RELAYER_KEY as `0x${string}` | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  return privateKeyToAccount(pk).address;
}
