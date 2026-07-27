/**
 * vea.ts — клиент VEA в одном файле, без зависимостей.
 *
 * ЗАЧЕМ ОН СУЩЕСТВУЕТ. До него подключиться к VEA можно было, только прочитав мою прозу
 * и собрав запросы руками. Это разница между «демо на хакатоне» и продуктом: у продукта
 * встраивание занимает три строки, а не вечер.
 *
 *   import { vea } from './vea.js';
 *   const verdict = await vea.verify(intent);      // ДО подписи
 *   if (!verdict.allowed) return;                  // отказ — с причиной
 *
 * НОЛЬ ЗАВИСИМОСТЕЙ — намеренно. Файрвол, который тянет за собой дерево пакетов,
 * увеличивает ровно ту поверхность атаки, которую взялся уменьшать. Здесь только fetch.
 *
 * ЧЕСТНО О ПЛАТНОСТИ: verify/attest — платные (x402). Клиент НЕ прячет это и НЕ пытается
 * платить за вас молча: при 402 он бросает ошибку с разобранным вызовом на оплату, чтобы
 * решение «платить или нет» осталось у вызывающего. Бесплатные образцы доступны сразу.
 */

export interface VeaIntent {
  id?: string;
  action: 'transfer' | 'contractCall';
  chain: string;
  to?: string;
  amount?: string;
  token?: string;
  /**
   * Зачем агент это делает. ОБЯЗАТЕЛЬНО и никогда не придумывается за вас:
   * именно с этой фразой сверяются расшифрованные байты вызова.
   */
  rationale: string;
  params?: { calldata?: string };
}

export interface VeaVerdict {
  allowed: boolean;
  decision: 'PASS' | 'BLOCK';
  confidence: number;
  reasons: string[];
  receipt: unknown;
  raw: any;
}

export interface VeaAttestation {
  matched: boolean;
  verdict: 'EXECUTED_AS_INTENDED' | 'DEVIATION_DETECTED' | 'BLOCKED_PRE_EXECUTION';
  deviations: string[];
  receipt: unknown;
  raw: any;
}

export class VeaPaymentRequired extends Error {
  constructor(public readonly challenge: unknown, public readonly body: unknown) {
    super('VEA: payment required (x402). Sign the authorization and retry with PAYMENT-SIGNATURE.');
    this.name = 'VeaPaymentRequired';
  }
}

const BASE = 'https://vea-x402.onrender.com';

async function call(path: string, body: unknown, paymentSignature?: string, base = BASE) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(paymentSignature ? { 'PAYMENT-SIGNATURE': paymentSignature } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 402) {
    // Разбираем и заголовок, и тело: заголовок — протокол, тело — человекочитаемое.
    let challenge: unknown = null;
    const hdr = res.headers.get('payment-required');
    if (hdr) {
      try {
        challenge = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
      } catch {
        /* заголовок нечитаем — отдадим то, что есть в теле */
      }
    }
    throw new VeaPaymentRequired(challenge, await res.json().catch(() => null));
  }
  if (!res.ok) throw new Error(`VEA ${path} → HTTP ${res.status}`);
  return res.json();
}

export const vea = {
  /** ДО подписи: стоит ли это делать? */
  async verify(intent: VeaIntent, paymentSignature?: string, base = BASE): Promise<VeaVerdict> {
    const r: any = await call('/verify', { intent }, paymentSignature, base);
    return {
      allowed: r.decision === 'PASS',
      decision: r.decision,
      confidence: r.confidence,
      reasons: r.reasons ?? [],
      receipt: r.receipt,
      raw: r,
    };
  },

  /** ПОСЛЕ исполнения: а сделано ли именно то? */
  async attest(
    intent: VeaIntent,
    execution: { txHash: string; status: 'success' | 'failed'; to?: string; valueOrAmount?: string; calldata?: string },
    paymentSignature?: string,
    base = BASE,
  ): Promise<VeaAttestation> {
    const r: any = await call('/attest', { intent, execution }, paymentSignature, base);
    return {
      matched: r.verdict === 'EXECUTED_AS_INTENDED',
      verdict: r.verdict,
      deviations: r.deviations ?? [],
      receipt: r.receipt,
      raw: r,
    };
  },

  /**
   * Бесплатно и без оплаты: прогнать документированный образец тем же движком.
   * Полезно в тестах — проверить, что интеграция жива, не тратя ни цента.
   */
  async sample(id: string, base = BASE) {
    const res = await fetch(`${base}/samples/${id}`);
    if (!res.ok) throw new Error(`VEA sample ${id} → HTTP ${res.status}`);
    return res.json();
  },

  /**
   * Проверить чек. Можно и не звать сюда вовсе: подпись Ed25519 проверяется офлайн
   * по attestorPubKey — «не доверять нам» и есть задуманный способ пользования.
   */
  async verifyReceipt(receipt: unknown, base = BASE) {
    const res = await fetch(`${base}/receipts/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receipt),
    });
    return res.json();
  },
};

export default vea;
