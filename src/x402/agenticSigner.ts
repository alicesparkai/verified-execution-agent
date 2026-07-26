/**
 * agenticSigner.ts — подписант фасилитатора, который ВЕЩАЕТ через агентский кошелёк OKX.
 *
 * ЗАЧЕМ (27.07, четвёртая дверь):
 *   OKX требует, чтобы 402-challenge объявлял сеть eip155:196 (X Layer). Мой прежний
 *   фасилитатор подписывал приватным ключом EOA — а EOA нужен нативный OKB на газ, которого
 *   не завезти НИ ОДНИМ мостом (все проверены котировкой: Gas.zip «Insufficent Liquidity»,
 *   relay/Orbiter/Rhino/LiFi не знают 196, собственный агрегатор OKX — no_path).
 *
 *   Но 26.07 доказано ЦЕПЬЮ: агентский кошелёк OKX — smart account (ERC-4337). Его транзакции
 *   идут через EntryPoint, газ платит бандлер OKX. Кошелёк с НУЛЕВЫМ балансом OKB успешно
 *   отправил вызов контракта: tx 0xb11dcaace01fa9389d7976552711055682dec9540c410ce6ca3d1c1e2cec587a,
 *   блок 66321808, отправитель 0x3897dd64…2218 (релеер OKX), газ списан НЕ с меня.
 *
 * КЛЮЧЕВОЕ НАБЛЮДЕНИЕ, ДЕЛАЮЩЕЕ ЭТО ВОЗМОЖНЫМ:
 *   их SDK не привязан к viem. `x402Facilitator` зовёт АБСТРАКТНЫЙ подписант —
 *   readContract / verifyTypedData / writeContract / sendTransaction /
 *   waitForTransactionReceipt / getCode / getAddresses (см. signer-D_siaM5K.d.ts).
 *   Из семи методов ПЯТЬ — чтение (бесплатный публичный RPC), и только ДВА пишут.
 *   Значит платёжный тракт ломать не нужно: подменяется ровно точка вещания.
 *
 * ПОЧЕМУ ВЕЩАНИЕ ЧЕРЕЗ ОЧЕРЕДЬ, А НЕ НАПРЯМУЮ:
 *   CLI `onchainos` — Windows-бинарь (11.8 МБ, PE) с TEE-сессией в ~/.onchainos, на Render
 *   (Linux) его нет и быть не может. Машина недостижима извне. Поэтому направление обратное:
 *   сервис КЛАДЁТ задание в очередь, машина его ЗАБИРАЕТ, вещает и возвращает хеш.
 *
 * ЧЕСТНАЯ СЛАБОСТЬ (называю прямо, не прячу): пока машина выключена, расчёт на 196 невозможен.
 * Это цена того, что ключ вещания живёт в TEE-сессии на конкретном устройстве.
 */
import { createPublicClient, http, encodeFunctionData } from 'viem';
import { xLayer } from 'viem/chains';

/** Как выглядит подписант глазами их фасилитатора (7 методов, см. шапку). */
export type FacilitatorSigner = {
  getAddresses(): readonly `0x${string}`[];
  readContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  verifyTypedData(args: { address: `0x${string}`; domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown>; signature: `0x${string}` }): Promise<boolean>;
  writeContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; gas?: bigint }): Promise<`0x${string}`>;
  sendTransaction(args: { to: `0x${string}`; data: `0x${string}` }): Promise<`0x${string}`>;
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ status: string }>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
};

/** Отправитель произвольного вызова. Реализуется очередью (см. broadcastQueue.ts). */
export type Broadcaster = (to: `0x${string}`, data: `0x${string}`) => Promise<`0x${string}`>;

export function makeAgenticSigner(opts: {
  /** Адрес агентского кошелька — он же вещатель. */
  address: `0x${string}`;
  /** Кто фактически отправит вызов (очередь → машина → CLI). */
  broadcast: Broadcaster;
  rpcUrl?: string;
}): FacilitatorSigner {
  const pub = createPublicClient({
    chain: xLayer,
    transport: http(opts.rpcUrl || process.env.VEA_XLAYER_RPC || 'https://rpc.xlayer.tech'),
  });

  return {
    // Адрес вещателя. Их фасилитатор берёт его как «кто платит комиссию».
    getAddresses: () => [opts.address],

    // ── ЧТЕНИЕ: бесплатно, прямо в публичный RPC ────────────────────────────
    readContract: (a) => pub.readContract(a as any),
    getCode: async (a) => (await pub.getCode({ address: a.address })) as `0x${string}` | undefined,
    verifyTypedData: (a) => pub.verifyTypedData(a as any),

    // Ждём чек тоже сами: агентский кошелёк вернул хеш — дальше цепочка авторитет.
    waitForTransactionReceipt: async ({ hash }) => {
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      return { status: r.status };
    },

    // ── ЗАПИСЬ: единственные две точки, уходящие в агентский кошелёк ─────────
    writeContract: async ({ address, abi, functionName, args }) => {
      // Кодируем вызов в calldata сами: CLI принимает сырой --input-data,
      // он не знает ни про ABI, ни про имена функций.
      const data = encodeFunctionData({ abi: abi as any, functionName, args: args as any });
      return opts.broadcast(address, data);
    },

    sendTransaction: ({ to, data }) => opts.broadcast(to, data),
  };
}
