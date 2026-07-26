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
import { xLayer } from 'viem/chains';

/** CAIP-2 сети X Layer — та же, что стоит в challenge нашего 402. */
export const NETWORK = 'eip155:196' as const;

/**
 * Собрать подписанта фасилитатора из приватного ключа ретранслятора.
 * Ключ приходит ТОЛЬКО из окружения (Render env VEA_RELAYER_KEY) — в репозитории его нет.
 */
function buildSigner(privateKey: `0x${string}`, rpcUrl?: string) {
  const account = privateKeyToAccount(privateKey);
  const client = createWalletClient({
    account,
    chain: xLayer,
    transport: http(rpcUrl || 'https://rpc.xlayer.tech'),
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
  const pk = process.env.VEA_RELAYER_KEY as `0x${string}` | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(
      'VEA_RELAYER_KEY не задан (нужен приватный ключ ретранслятора, 0x + 64 hex). ' +
        'Без него фасилитатор не сможет просадить расчёт на X Layer.',
    );
  }
  const signer = buildSigner(pk, process.env.VEA_XLAYER_RPC);
  const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmFacilitator(signer));
  return new LocalFacilitatorClient(facilitator);
}

/** Адрес ретранслятора — для /health, чтобы видеть ФАКТОМ, чем подписываем. */
export function relayerAddress(): string | null {
  const pk = process.env.VEA_RELAYER_KEY as `0x${string}` | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  return privateKeyToAccount(pk).address;
}
