/**
 * Hedera rail for x402 — real settlement, and a public audit trail for the receipts.
 *
 * Why Hedera specifically, and not "one more EVM chain in accepts[]":
 *
 * VEA sells one thing — a *pre-flight verdict* on an irreversible action, plus a signed
 * receipt of that verdict. The hard part was never signing the receipt; it is proving
 * afterwards that the verdict existed BEFORE the action, and that nobody rewrote it.
 * That is an ordering-and-timestamp problem, and Hedera Consensus Service is a primitive
 * built exactly for it: an append-only topic where every message gets a consensus
 * timestamp and a sequence number, for a fixed $0.0001.
 *
 * So this rail does two things:
 *   1. PAYMENT  — the caller pays HBAR on Hedera testnet; we verify it against the
 *                 Mirror Node before serving the resource (no facilitator, no trust).
 *   2. ANCHOR   — the receipt for that verification is published to an HCS topic, so the
 *                 decision is publicly ordered and timestamped. The caller gets a
 *                 HashScan link they can show to anyone.
 *
 * Everywhere else in this repo, settlement is honestly labelled "simulated". On this rail
 * it is not: the payment is a real transaction on Hedera testnet and the anchor is a real
 * HCS message. Both are verifiable at hashscan.io/testnet by anyone, without our server.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rail configuration.
 *
 * The environment-backed fields are **getters, not captured values**. In ESM every `import`
 * is hoisted and executed before the importing module's first statement — so a server that
 * calls `loadEnv()` at the top of its body still runs it *after* this module was evaluated.
 * Reading `process.env` eagerly here would therefore capture an empty key and fail with
 * "HEDERA_PRIVATE_KEY is not set" even though the .env is perfectly fine. Lazy reads make
 * the load order irrelevant.
 */
export const HEDERA = {
  /** CAIP-2 identifier for Hedera testnet. */
  network: 'hedera:testnet',
  /** EVM-compatible view of the same network, for callers coming from Ethereum tooling. */
  evmChainId: 296,
  explorer: 'https://hashscan.io/testnet',
  get mirror() {
    return process.env.HEDERA_MIRROR ?? 'https://testnet.mirrornode.hedera.com';
  },
  /** Account that receives payments. Also the operator that publishes HCS receipts. */
  get payTo() {
    return process.env.HEDERA_ACCOUNT_ID ?? '0.0.9698784';
  },
  get operatorId() {
    return process.env.HEDERA_ACCOUNT_ID ?? '0.0.9698784';
  },
  get operatorKey() {
    return process.env.HEDERA_PRIVATE_KEY ?? '';
  },
  /** Price of one verification: 0.01 HBAR, expressed in tinybars (1 HBAR = 1e8 tinybars). */
  priceTinybars: 1_000_000,
  /** A payment older than this is not accepted — it belongs to some earlier request. */
  maxAgeSeconds: 900,
};

const STATE_PATH = join(__dirname, '..', '.hedera-state.json');

type RailState = { topicId?: string; spent: string[]; payer?: { accountId: string; privateKey: string } };

function loadState(): RailState {
  if (!existsSync(STATE_PATH)) return { spent: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as RailState;
    return { topicId: s.topicId, payer: s.payer, spent: Array.isArray(s.spent) ? s.spent : [] };
  } catch {
    return { spent: [] };
  }
}

function saveState(s: RailState): void {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The x402 challenge entry for this rail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry for the x402 `accepts[]` array.
 *
 * A note on `scheme`: x402's canonical `exact` scheme settles via EIP-3009
 * (`transferWithAuthorization`), where the payer signs and a facilitator submits.
 * Hedera's native rail has no EIP-3009 — the payer submits the transfer themselves and
 * then presents the transaction id. Same guarantee for the resource server (exact amount,
 * verifiable, non-repudiable), different mechanics, so it is declared plainly in `extra`
 * rather than pretending the mechanism is identical.
 */
export function hederaAccept() {
  return {
    scheme: 'exact',
    network: HEDERA.network,
    asset: 'HBAR',
    amount: String(HEDERA.priceTinybars),
    payTo: HEDERA.payTo,
    maxTimeoutSeconds: HEDERA.maxAgeSeconds,
    description: 'Pre-flight verification of one on-chain intent (allow/deny + receipt anchored to HCS).',
    mimeType: 'application/json',
    extra: {
      name: 'HBAR',
      decimals: 8,
      settlement: 'native-transfer',
      verifiedVia: `${HEDERA.mirror}/api/v1/transactions/{transactionId}`,
      evmChainId: HEDERA.evmChainId,
      instructions:
        `Transfer ${HEDERA.priceTinybars} tinybars (0.01 HBAR) to ${HEDERA.payTo} on Hedera testnet, ` +
        'then retry this request with header  X-PAYMENT: <transactionId>  ' +
        '(e.g. 0.0.1234@1700000000.000000000).',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Payment verification — against the Mirror Node, not against our own word
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentCheck =
  | { ok: true; txId: string; amountTinybars: number; consensusAt: string; explorer: string }
  | { ok: false; reason: string };

/**
 * Hedera transaction ids come in two spellings — `0.0.5@1700.000` (SDK) and
 * `0.0.5-1700-000` (Mirror Node REST). Normalise to the REST form.
 */
export function normaliseTxId(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)$/);
  return m ? `${m[1]}-${m[2]}-${m[3].padStart(9, '0')}` : t;
}

/**
 * Verify that a claimed payment is real, sufficient, recent, and not already used.
 *
 * Every one of those four is a way the check can be fooled if skipped:
 *  - real       → the transaction exists AND its result is SUCCESS (a failed transfer
 *                 still has a transaction id, and would otherwise look like proof);
 *  - sufficient → the credit to *our* account is >= price (transfers[] contains every
 *                 party, including node and service fees — only our line counts);
 *  - recent     → an ancient payment must not unlock today's request;
 *  - unused     → the same transaction id must not buy two verifications (replay).
 */
export async function verifyHederaPayment(rawTxId: string): Promise<PaymentCheck> {
  const txId = normaliseTxId(rawTxId);
  if (!/^\d+\.\d+\.\d+-\d+-\d+$/.test(txId)) {
    return { ok: false, reason: `malformed transaction id: ${rawTxId}` };
  }

  const state = loadState();
  if (state.spent.includes(txId)) {
    return { ok: false, reason: 'this payment was already used for a previous verification' };
  }

  // Consensus finality and Mirror Node availability are NOT the same moment on Hedera:
  // the transfer reaches consensus in ~3s, but the Mirror Node needs a few seconds more to
  // index it, and answers 404 until then. A single immediate lookup therefore rejects a
  // payment that has genuinely happened — the caller pays and still gets a 402. So a 404 is
  // treated as "not yet", with a short bounded wait; any other failure is decided at once.
  let body: any;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${HEDERA.mirror}/api/v1/transactions/${txId}`);
      if (res.ok) {
        body = await res.json();
        break;
      }
      if (res.status !== 404) {
        return { ok: false, reason: `mirror node returned ${res.status} for this payment` };
      }
      if (Date.now() > deadline) {
        return { ok: false, reason: 'payment not found on Hedera testnet (not indexed within 20s)' };
      }
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      return { ok: false, reason: `mirror node unreachable: ${String(e).slice(0, 80)}` };
    }
  }

  const tx = body?.transactions?.[0];
  if (!tx) return { ok: false, reason: 'payment not found on Hedera testnet' };
  if (tx.result !== 'SUCCESS') return { ok: false, reason: `payment did not succeed (${tx.result})` };

  const credited = (tx.transfers ?? [])
    .filter((t: any) => t.account === HEDERA.payTo && t.amount > 0)
    .reduce((sum: number, t: any) => sum + t.amount, 0);

  if (credited < HEDERA.priceTinybars) {
    return {
      ok: false,
      reason: `underpaid: ${credited} tinybars credited, ${HEDERA.priceTinybars} required`,
    };
  }

  const ageSeconds = Date.now() / 1000 - Number(tx.consensus_timestamp);
  if (ageSeconds > HEDERA.maxAgeSeconds) {
    return { ok: false, reason: `payment is stale (${Math.round(ageSeconds)}s old)` };
  }

  state.spent.push(txId);
  saveState(state);

  return {
    ok: true,
    txId,
    amountTinybars: credited,
    consensusAt: tx.consensus_timestamp,
    explorer: `${HEDERA.explorer}/transaction/${tx.consensus_timestamp}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Receipt anchoring — Hedera Consensus Service
// ─────────────────────────────────────────────────────────────────────────────

async function client() {
  const { Client, PrivateKey, AccountId } = await import('@hashgraph/sdk');
  if (!HEDERA.operatorKey) throw new Error('HEDERA_PRIVATE_KEY is not set');
  const c = Client.forTestnet();
  c.setOperator(AccountId.fromString(HEDERA.operatorId), PrivateKey.fromStringECDSA(HEDERA.operatorKey));
  return c;
}

/** Create the audit topic once; reuse it on every later run. */
export async function ensureTopic(): Promise<string> {
  const state = loadState();
  if (state.topicId) return state.topicId;

  const { TopicCreateTransaction } = await import('@hashgraph/sdk');
  const c = await client();
  const receipt = await (
    await new TopicCreateTransaction()
      .setTopicMemo('VEA — pre-flight verification receipts (allow/deny + intent hash)')
      .execute(c)
  ).getReceipt(c);

  const topicId = receipt.topicId!.toString();
  saveState({ ...state, topicId });
  c.close();
  return topicId;
}

export type Anchor = { topicId: string; sequenceNumber: string; consensusAt: string; explorer: string };

/**
 * Publish a receipt to HCS.
 *
 * Only the receipt *envelope* goes on-chain — verdict, intent hash, signature — never the
 * intent payload itself. The point is public provability that this decision existed at
 * this moment, not publishing what the caller was doing.
 */
export async function anchorReceipt(receipt: unknown): Promise<Anchor> {
  const topicId = await ensureTopic();
  const { TopicMessageSubmitTransaction } = await import('@hashgraph/sdk');
  const c = await client();

  const submit = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(JSON.stringify(receipt))
    .execute(c);
  const rec = await submit.getReceipt(c);
  const record = await submit.getRecord(c);
  c.close();

  const anchor: Anchor = {
    topicId,
    sequenceNumber: rec.topicSequenceNumber!.toString(),
    consensusAt: record.consensusTimestamp.toString(),
    explorer: `${HEDERA.explorer}/topic/${topicId}`,
  };
  appendFileSync(join(__dirname, '..', 'hcs-anchors.jsonl'), JSON.stringify(anchor) + '\n');
  return anchor;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. A second account, so the demo pays like a real client would
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create (once) a separate "client agent" account that pays for verifications.
 *
 * This is not decoration. Payment verification counts what was *credited to the service
 * account*, and an account paying itself nets to minus-fees — so a demo that paid from the
 * operator account would either fail the check or, worse, tempt me to loosen the check
 * until it passed. A distinct payer keeps the verification honest and the demo faithful to
 * how a real caller behaves.
 */
export async function ensurePayer(): Promise<{ accountId: string; privateKey: string }> {
  const state = loadState();
  if (state.payer) return state.payer;

  const { AccountCreateTransaction, PrivateKey, Hbar } = await import('@hashgraph/sdk');
  const c = await client();
  const key = PrivateKey.generateECDSA();
  const receipt = await (
    await new AccountCreateTransaction()
      .setKeyWithoutAlias(key.publicKey)
      .setInitialBalance(new Hbar(20))
      .setAccountMemo('VEA demo — paying client agent')
      .execute(c)
  ).getReceipt(c);
  c.close();

  const payer = { accountId: receipt.accountId!.toString(), privateKey: key.toStringDer() };
  saveState({ ...state, payer });
  return payer;
}

/** Pay for one verification from the client-agent account. Returns the real transaction id. */
export async function payForVerification(): Promise<{ txId: string; explorer: string }> {
  const payer = await ensurePayer();
  const { Client, AccountId, PrivateKey, TransferTransaction, Hbar, HbarUnit } = await import('@hashgraph/sdk');

  const c = Client.forTestnet();
  c.setOperator(AccountId.fromString(payer.accountId), PrivateKey.fromStringDer(payer.privateKey));

  const amount = Hbar.from(HEDERA.priceTinybars, HbarUnit.Tinybar);
  const resp = await new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(payer.accountId), amount.negated())
    .addHbarTransfer(AccountId.fromString(HEDERA.payTo), amount)
    .setTransactionMemo('x402 payment — VEA pre-flight verification')
    .execute(c);
  await resp.getReceipt(c);
  c.close();

  const txId = resp.transactionId.toString();
  return { txId, explorer: `${HEDERA.explorer}/transaction/${txId}` };
}
