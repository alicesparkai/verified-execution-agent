/**
 * demoTrader.ts — a standalone autonomous agent ("trader-bot-7") that HIRES the
 * VEA verification service over HTTP before it touches the chain.
 *
 * This is the client side of the story: VEA is a paid, non-custodial firewall
 * (an Agentic Service Provider). trader-bot-7 keeps its own keys and does its own
 * (mock) execution — but it refuses to move a single wei without a signed PASS
 * from VEA, and it posts back what actually happened so deviations are caught.
 *
 *   Verify (pay-per-call, x402) → execute (own keys) → attest.
 *
 * Run:  npm run demo:agent      (needs `npm run serve` up on :8402)
 */

import type { OnchainIntent, ExecutionResult } from './types.js';
import type { Attestation } from './attestation.js';

const VEA_URL = process.env.VEA_URL ?? 'http://localhost:8402';
const ME = 'trader-bot-7';

// ── The entire VEA SDK: verify an intent, transparently paying the x402 toll. ──
async function verifyWithVEA(intent: OnchainIntent): Promise<any> {
  const post = (headers: Record<string, string>) =>
    fetch(`${VEA_URL}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ intent, caller: { agentId: ME } }),
    });
  let res = await post({});
  if (res.status === 402) {
    console.log(`  [${ME}] VEA wants 0.001 USDC — paying (sim) and retrying…`);
    res = await post({ 'X-Payment': `sim:${Date.now()}` });
  }
  return res.json();
}

// ── Tiny ABI helpers so the drainer calldata is provably what it claims ──
const word = (hex: string) => hex.toLowerCase().replace(/^0x/i, '').padStart(64, '0');
const UINT256_MAX = (1n << 256n) - 1n;
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NONALLOWLISTED_SPENDER = '0xDEF1C0ded9bec7F1a1670819833240f027b25EfF';
// approve(NONALLOWLISTED_SPENDER, 2^256-1) — the classic unlimited-approval drainer.
const DRAINER_APPROVE_CALLDATA =
  '0x095ea7b3' + word(NONALLOWLISTED_SPENDER) + word(UINT256_MAX.toString(16));

const VENDOR_A = '0x52908400098527886E0F7030069857D2E4169EE7'; // where the intent says to pay
const ROGUE_B = '0x000000000000000000000000000000000BADc0DE'; // where a rogue executor sends it

const line = (s = '') => console.log(s);
const mockTx = () => '0x' + [...Array(64)].map(() => ((Math.random() * 16) | 0).toString(16)).join('');

async function main() {
  line('======  trader-bot-7 — autonomous agent hiring VEA  ======');
  line(`VEA service: ${VEA_URL}   (verify → execute → attest, non-custodial)\n`);

  // ─────────────────────────────── ACT 1 ───────────────────────────────
  // Benign transfer. Verify (pay the toll) → PASS → execute → attest honestly.
  line('── ACT 1: a routine 250 USDC vendor payment ──');
  const benign: OnchainIntent = {
    id: 'trade-1-payroll',
    action: 'transfer',
    chain: 'base',
    to: VENDOR_A,
    amount: 250,
    token: 'USDC',
    rationale: 'Pay the monthly infra invoice of 250 USDC to our verified vendor wallet.',
  };
  const v1 = await verifyWithVEA(benign);
  line(`  [VEA] decision=${v1.decision} confidence=${v1.confidence} — ${v1.reasons?.[0] ?? ''}`);
  if (v1.decision === 'PASS') {
    const exec: ExecutionResult = { txHash: mockTx(), status: 'confirmed', to: VENDOR_A, valueOrAmount: '250', blockNumber: 21_000_001 };
    line(`  [${ME}] PASS — executing with my own keys. tx=${exec.txHash.slice(0, 12)}…`);
    const a1 = await postAttest(benign, exec);
    line(`  [VEA] attestation: ${a1.verdict}  (signature ${a1.signatureValid ? 'VALID' : 'INVALID'})`);
  }
  line();

  // ─────────────────────────────── ACT 2 ───────────────────────────────
  // The attack. "Small 200 USDC swap" — but the calldata is an infinite approval
  // to a non-allowlisted spender. Structurally clean; only the Calldata Guard sees it.
  line('── ACT 2: a DEX swap request… that is actually a wallet drainer ──');
  const attack: OnchainIntent = {
    id: 'trade-2-swap',
    action: 'contractCall',
    chain: 'base',
    to: USDC_BASE,
    token: 'USDC',
    params: { function: 'approve', note: 'grant DEX a small spend allowance for the swap' },
    calldata: DRAINER_APPROVE_CALLDATA,
    rationale: 'Approve a small 200 USDC spend so the DEX router can execute a modest swap on our behalf.',
  };
  const v2 = await verifyWithVEA(attack);
  line(`  [VEA] decision=${v2.decision} confidence=${v2.confidence}`);
  const savedReceipt: Attestation = v2.receipt;
  if (v2.decision === 'BLOCK') {
    line(`  [${ME}] VEA BLOCKED my tx — NOT executing. Reason: ${v2.reasons?.[0]}`);
    line(`  [${ME}] Receipt ${savedReceipt.intentId} saved (${savedReceipt.verdict}, signed).`);
  } else {
    line(`  [${ME}] !! VEA let the drainer through — this should not happen.`);
  }
  line();

  // ─────────────────────────────── ACT 3 ───────────────────────────────
  // Honest intent, rogue executor. VEA PASSes the intent (it IS honest), but the
  // executor pays a different address. Only the signed attestation catches it.
  line('── ACT 3: an honest transfer, hijacked by a rogue executor ──');
  const honest: OnchainIntent = {
    id: 'trade-3-vendor',
    action: 'transfer',
    chain: 'base',
    to: VENDOR_A,
    amount: 100,
    token: 'USDC',
    rationale: 'Pay 100 USDC to our audited payroll vendor — a routine, expected transfer.',
  };
  const v3 = await verifyWithVEA(honest);
  line(`  [VEA] decision=${v3.decision} confidence=${v3.confidence}`);
  if (v3.decision === 'PASS') {
    const rogue: ExecutionResult = { txHash: mockTx(), status: 'confirmed', to: ROGUE_B, valueOrAmount: '100', blockNumber: 21_000_002 };
    line(`  [${ME}] PASS — but a compromised executor sent it to ${ROGUE_B.slice(0, 10)}… instead.`);
    const a3 = await postAttest(honest, rogue);
    line(`  [VEA] attestation: ${a3.verdict}  (signature ${a3.signatureValid ? 'VALID' : 'INVALID'})`);
    for (const d of a3.deviations ?? []) line(`         ! ${d}`);
  }
  line();

  // ─────────────────────────────── FINALE ──────────────────────────────
  line('── FINALE: the public ledger + a tamper test ──');
  const ledger: any = await (await fetch(`${VEA_URL}/ledger`)).json();
  line(`  [ledger] total=${ledger.total} passed=${ledger.passed} blocked=${ledger.blocked} revenue=${ledger.revenueSimulated}`);

  // Tamper: take the signed BLOCK receipt from Act 2, flip one char of its
  // signature, and ask VEA to re-verify. Don't trust — check.
  const before = await postReceiptVerify(savedReceipt);
  const sig = savedReceipt.signature;
  const flip = sig[5] === 'A' ? 'B' : 'A';
  const tampered: Attestation = { ...savedReceipt, signature: sig.slice(0, 5) + flip + sig.slice(6) };
  const after = await postReceiptVerify(tampered);
  line(`  [tamper] Act-2 receipt as issued → valid: ${before.valid}`);
  line(`  [tamper] one signature byte flipped → valid: ${after.valid}`);
  line(`\n  ✔ trader-bot-7 paid for verification, dodged a drainer, and proved a deviation — all with signed, checkable receipts.`);
}

async function postAttest(intent: OnchainIntent, execution: ExecutionResult): Promise<any> {
  const res = await fetch(`${VEA_URL}/attest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent, execution }),
  });
  return res.json();
}

async function postReceiptVerify(receipt: Attestation): Promise<any> {
  const res = await fetch(`${VEA_URL}/receipts/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(receipt),
  });
  return res.json();
}

main().catch((err) => {
  console.error('trader-bot-7 crashed:', err);
  process.exit(1);
});
