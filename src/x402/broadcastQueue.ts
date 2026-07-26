/**
 * broadcastQueue.ts — очередь вещания: сервис кладёт вызов, машина с агентским кошельком берёт.
 *
 * НАПРАВЛЕНИЕ ВЫБРАНО НЕ ОТ УДОБСТВА, А ОТ РЕАЛЬНОСТИ:
 *   у машины нет публичного адреса, а открывать его я не буду. Значит сервис не может
 *   «позвонить» машине — машина сама СПРАШИВАЕТ, есть ли работа. Инициатива у той стороны,
 *   которая достижима.
 *
 * ЖИЗНЕННЫЙ ЦИКЛ ОДНОГО ЗАДАНИЯ:
 *   enqueue() ← фасилитатор во время расчёта, ждёт хеш
 *     → claim()  ← машина опрашивает раз в секунду
 *       → submit() ← машина вернула txHash (или ошибку)
 *         → промис enqueue() разрешается, расчёт продолжается
 *
 * ПОЧЕМУ ЖЁСТКИЙ ТАЙМАУТ: покупатель ждёт HTTP-ответ (их maxTimeoutSeconds = 60). Задание,
 * которое никто не забрал, обязано УПАСТЬ ЯВНО, а не висеть — иначе запрос покупателя
 * зависнет, и он увидит не отказ, а мёртвый сервис. Вчерашний урок: оплаченный запрос,
 * ответивший ошибкой, читается как сломанный сервис — но ЗАВИСШИЙ читается ещё хуже.
 *
 * ПОЧЕМУ В ПАМЯТИ, А НЕ В БАЗЕ: задание живёт секунды и осмысленно только внутри одного
 * HTTP-запроса. Переживать перезапуск ему незачем — при перезапуске покупатель всё равно
 * получит ошибку и повторит платёж.
 */
import { randomUUID } from 'node:crypto';

export type Job = {
  id: string;
  to: `0x${string}`;
  data: `0x${string}`;
  chain: string;
  createdAt: number;
  claimedAt?: number;
  resolve: (hash: `0x${string}`) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const pending: Job[] = [];
const inFlight = new Map<string, Job>();

/** Сколько ждём, пока машина заберёт и выполнит. Меньше, чем ждёт покупатель. */
const JOB_TIMEOUT_MS = Number(process.env.VEA_JOB_TIMEOUT_MS ?? 45_000);

/** Общий секрет: без него любой прохожий мог бы забирать задания и подсовывать чужие хеши. */
export function queueSecretOk(header: unknown): boolean {
  const want = process.env.VEA_QUEUE_SECRET;
  if (!want) return false; // не задан → очередь закрыта наглухо, а не открыта всем
  return typeof header === 'string' && header === want;
}

/** Положить вызов в очередь и ЖДАТЬ хеш от машины. */
export function enqueueBroadcast(to: `0x${string}`, data: `0x${string}`, chain = 'xlayer'): Promise<`0x${string}`> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      const i = pending.findIndex((j) => j.id === id);
      if (i >= 0) pending.splice(i, 1);
      inFlight.delete(id);
      reject(new Error(
        `вещание не выполнено за ${JOB_TIMEOUT_MS} мс: машина с агентским кошельком не забрала задание. ` +
        'Расчёт на X Layer возможен только когда она в сети.',
      ));
    }, JOB_TIMEOUT_MS);
    const job: Job = { id, to, data, chain, createdAt: Date.now(), resolve, reject, timer };
    pending.push(job);
    console.log(`[очередь] задание ${id.slice(0, 8)} → ${to} (${data.length} симв. calldata)`);
  });
}

/**
 * Когда машина последний раз спрашивала работу. Нужно, чтобы «вещатель мёртв» было ВИДНО
 * снаружи, а не выяснялось из проваленного платежа покупателя. Вчерашний урок в лоб:
 * о своей неисправности узнавай проверкой, а не по жалобе оплатившего.
 */
let lastPollAt = 0;

/** Машина забирает самое старое задание. null — работы нет. */
export function claimJob(): { id: string; to: string; data: string; chain: string } | null {
  lastPollAt = Date.now();
  const job = pending.shift();
  if (!job) return null;
  job.claimedAt = Date.now();
  inFlight.set(job.id, job);
  console.log(`[очередь] задание ${job.id.slice(0, 8)} забрано машиной`);
  return { id: job.id, to: job.to, data: job.data, chain: job.chain };
}

/** Машина вернула результат: либо хеш, либо честную ошибку. */
export function submitResult(id: string, txHash?: string, error?: string): boolean {
  const job = inFlight.get(id);
  if (!job) return false;
  inFlight.delete(id);
  clearTimeout(job.timer);
  if (txHash && /^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    console.log(`[очередь] задание ${id.slice(0, 8)} → tx ${txHash}`);
    job.resolve(txHash as `0x${string}`);
  } else {
    console.error(`[очередь] задание ${id.slice(0, 8)} провалено: ${error || 'нет хеша'}`);
    job.reject(new Error(error || 'машина не вернула хеш транзакции'));
  }
  return true;
}

/** Для /health?deep=1 — видно ли снаружи, что вещание живо. */
export function queueStats() {
  const ago = lastPollAt ? Date.now() - lastPollAt : null;
  // Вещатель опрашивает раз в ~1.5 с. Молчит больше минуты — считаем оторванным и говорим прямо,
  // а не показываем бодрый «ok». Индикатор обязан отражать способность, а не намерение.
  const alive = ago !== null && ago < 60_000;
  return {
    broadcaster: alive ? 'подключён' : lastPollAt ? 'ОТОРВАН' : 'ни разу не выходил на связь',
    lastPollSecondsAgo: ago === null ? null : Math.round(ago / 1000),
    pending: pending.length,
    inFlight: inFlight.size,
    secretConfigured: Boolean(process.env.VEA_QUEUE_SECRET),
    timeoutMs: JOB_TIMEOUT_MS,
  };
}
