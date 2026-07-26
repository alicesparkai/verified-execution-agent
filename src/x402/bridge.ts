/**
 * bridge.ts — перевод нативного газа BNB(BSC) → ETH(Base) через relay.link.
 *
 * ПОЧЕМУ ЭТО ЖИВЁТ В СЕРВИСЕ, А НЕ У МЕНЯ НА МАШИНЕ:
 *   приватный ключ ретранслятора существует ТОЛЬКО как переменная окружения Render.
 *   Панель Render не отдаёт значения секретов клиенту (поля значений приходят пустыми) —
 *   и это правильно. Значит подписать перевод может лишь тот, у кого ключ в рантайме:
 *   сам сервис. Отсюда — запуск по флагу окружения на старте.
 *
 * ПОЧЕМУ НЕ АДМИН-ЭНДПОИНТ:
 *   публичный маршрут, двигающий деньги, — это дверь, которую надо охранять секретом,
 *   а секрет можно утечь. Флаг окружения меняю только я, дверей наружу не появляется.
 *
 * ПОЧЕМУ БЕЗОПАСНО ПРИ ПЕРЕЗАПУСКАХ (Render свободного тарифа усыпляет и будит сервис):
 *   операция ИДЕМПОТЕНТНА ПО ПРИРОДЕ — мостить нечего, если на BSC осталось меньше резерва.
 *   Повторный старт просто ничего не делает и честно это пишет.
 */
import { createWalletClient, createPublicClient, http, formatEther, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, bsc } from 'viem/chains';

const RELAY_QUOTE = 'https://api.relay.link/quote';
const NATIVE = '0x0000000000000000000000000000000000000000';
/** Резерв на газ самой отправки в BSC (21k…150k газа × ~1 gwei) — с большим запасом. */
const GAS_RESERVE = 2_000_000_000_000_000n; // 0.002 BNB

export type BridgeResult =
  | { status: 'nothing'; bnb: string }
  | { status: 'dry'; bnb: string; willSend: string; expect: string }
  | { status: 'sent'; txHash: string; expect: string }
  | { status: 'arrived'; txHash: string; before: string; after: string };

async function quote(user: string, amountWei: bigint) {
  const r = await fetch(RELAY_QUOTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user,
      recipient: user,
      originChainId: bsc.id,
      destinationChainId: base.id,
      originCurrency: NATIVE,
      destinationCurrency: NATIVE,
      amount: amountWei.toString(),
      tradeType: 'EXACT_INPUT',
    }),
  });
  const j: any = await r.json();
  if (!j?.steps?.length) throw new Error('relay не дал шагов: ' + JSON.stringify(j).slice(0, 300));
  return j;
}

/**
 * Перевести весь свободный BNB ретранслятора на Base.
 * @param execute false = сухой прогон (ничего не отправляется).
 * @param log куда писать ход (по умолчанию console.log) — чтобы виднелось в логах Render.
 */
export async function bridgeBscToBase(execute: boolean, log: (s: string) => void = console.log): Promise<BridgeResult> {
  const pk = process.env.VEA_RELAYER_KEY as `0x${string}` | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('VEA_RELAYER_KEY не задан — мостить нечем');

  const account = privateKeyToAccount(pk);
  const bscClient = createWalletClient({
    account,
    chain: bsc,
    transport: http(process.env.VEA_BSC_RPC || 'https://bsc-dataseed.binance.org'),
  }).extend(publicActions);
  const baseClient = createPublicClient({
    chain: base,
    transport: http(process.env.VEA_BASE_RPC || 'https://mainnet.base.org'),
  });

  const bnb = await bscClient.getBalance({ address: account.address });
  const baseBefore = await baseClient.getBalance({ address: account.address });
  log(`[мост] ретранслятор ${account.address}`);
  log(`[мост] BNB на BSC: ${formatEther(bnb)} | ETH на Base: ${formatEther(baseBefore)}`);

  if (bnb <= GAS_RESERVE) {
    log('[мост] мостить нечего (меньше резерва на газ) — это не ошибка, просто нет средств');
    return { status: 'nothing', bnb: formatEther(bnb) };
  }

  const amount = bnb - GAS_RESERVE;
  const q = await quote(account.address, amount);
  const expect = `${q.details?.currencyOut?.amountFormatted} ETH ($${q.details?.currencyOut?.amountUsd})`;
  log(`[мост] отдаю ${formatEther(amount)} BNB → ожидаю ${expect}`);

  const item = q.steps.find((s: any) => s.kind === 'transaction')?.items?.[0];
  if (!item?.data?.to) throw new Error('в шаге relay нет транзакции');
  if (Number(item.data.chainId) !== bsc.id) {
    throw new Error(`relay просит сеть ${item.data.chainId}, подписываю только BSC(${bsc.id}) — вслепую не подписываю`);
  }

  if (!execute) {
    log('[мост] СУХОЙ ПРОГОН — ничего не отправлено');
    return { status: 'dry', bnb: formatEther(bnb), willSend: formatEther(amount), expect };
  }

  const txHash = await bscClient.sendTransaction({
    to: item.data.to as `0x${string}`,
    data: (item.data.data ?? '0x') as `0x${string}`,
    value: BigInt(item.data.value ?? '0'),
  });
  log(`[мост] tx BSC: ${txHash}  https://bscscan.com/tx/${txHash}`);

  const rec = await bscClient.waitForTransactionReceipt({ hash: txHash });
  log(`[мост] статус BSC: ${rec.status}`);
  if (rec.status !== 'success') throw new Error('транзакция BSC не удалась — на Base ничего не придёт');

  // Приход проверяем БАЛАНСОМ, а не статусом моста: «система сказала ОК» ≠ «мир изменился».
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const now = await baseClient.getBalance({ address: account.address });
    if (now > baseBefore) {
      log(`[мост] ✅ ПРИШЛО на Base: ${formatEther(now)} ETH (было ${formatEther(baseBefore)})`);
      return { status: 'arrived', txHash, before: formatEther(baseBefore), after: formatEther(now) };
    }
  }
  log('[мост] ⚠️ за 8 минут баланс Base не вырос — транзакция BSC прошла, смотреть статус relay');
  return { status: 'sent', txHash, expect };
}
