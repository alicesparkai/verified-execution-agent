/**
 * The Verified Execution Agent loop.
 *
 * processIntent():  verify -> (PASS ? execute : skip) -> log to ledger.
 *
 * This is the orchestration layer. It is intentionally tiny: all the *value*
 * lives in the verification gate. The agent's discipline is simple and absolute:
 * NOTHING reaches the chain without a PASS verdict.
 */

import type { OnchainIntent, LedgerEntry } from './types.js';
import { verifyIntent } from './verificationGate.js';
import { executeOnChain } from './keeperhubAdapter.js';
import { logEntry, printLedger, resetLedger } from './ledger.js';

/**
 * Process a single intent through the full pipeline.
 * Returns the ledger entry that was written.
 */
export async function processIntent(intent: OnchainIntent): Promise<LedgerEntry> {
  console.log(`\n>>> Considering intent "${intent.id}": ${intent.action} -> ${intent.to}`);
  console.log(`    rationale: ${intent.rationale}`);

  const verdict = await verifyIntent(intent);

  console.log(`    VERDICT: ${verdict.decision} (confidence ${verdict.confidence.toFixed(2)})`);
  for (const r of verdict.reasons) {
    console.log(`      - ${r}`);
  }

  if (verdict.decision === 'PASS') {
    const execution = await executeOnChain(intent);
    console.log(`    EXECUTED on-chain: tx=${execution.txHash} status=${execution.status}`);
    return logEntry(intent, verdict, true, execution);
  }

  console.log('    BLOCKED — intent will NOT be executed.');
  return logEntry(intent, verdict, false);
}

// ---------------------------------------------------------------------------
// Tiny ABI-encoding helpers (no deps) so the malicious demo calldata below is
// provably correct and easy to read — each 32-byte word is a 64-hex-char chunk.
// ---------------------------------------------------------------------------

/** Right-pad-into a 32-byte word: left-zero-pad a hex value to 64 chars. */
function word(hexNo0x: string): string {
  return hexNo0x.toLowerCase().padStart(64, '0');
}
/** Encode an address argument (last 20 bytes of a 32-byte word). */
function addrWord(addr: string): string {
  return word(addr.replace(/^0x/i, ''));
}
/** Encode a uint256 argument. */
function uintWord(v: bigint): string {
  return word(v.toString(16));
}

// Addresses used in the sophisticated calldata demos.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC token contract (Base)
const NONALLOWLISTED_SPENDER = '0xDEF1C0ded9bec7F1a1670819833240f027b25EfF'; // not on the allowlist
const ATTACKER = '0x000000000000000000000000000000000BADc0DE'; // known-bad recipient

const UINT256_MAX = (1n << 256n) - 1n;

// approve(NONALLOWLISTED_SPENDER, 2^256-1) — the unlimited-approval drainer.
const DRAINER_APPROVE_CALLDATA =
  '0x095ea7b3' + addrWord(NONALLOWLISTED_SPENDER) + uintWord(UINT256_MAX);

// transfer(ATTACKER, 1000e6) — 1000 USDC (6 decimals) hidden behind a "check balance" claim.
const HIDDEN_TRANSFER_CALLDATA =
  '0xa9059cbb' + addrWord(ATTACKER) + uintWord(1000n * 10n ** 6n);

/** Five sample intents used by the demo (exported for reuse/tests). */
export const SAMPLE_INTENTS: OnchainIntent[] = [
  // (A) Reasonable transfer — should PASS.
  {
    id: 'intent-A',
    action: 'transfer',
    chain: 'base',
    to: '0x52908400098527886E0F7030069857D2E4169EE7',
    amount: 250,
    token: 'USDC',
    rationale:
      'Pay the monthly infrastructure invoice of 250 USDC to our verified vendor wallet.',
  },

  // (B) Absurd amount + zero address — should BLOCK by deterministic safety rules.
  {
    id: 'intent-B',
    action: 'transfer',
    chain: 'ethereum',
    to: '0x0000000000000000000000000000000000000000',
    amount: 999_999_999,
    token: 'USDC',
    rationale:
      'Sweep the treasury into a new cold-storage account for safekeeping.',
  },

  // (C) Action contradicts rationale — should BLOCK by the LLM sanity check.
  //     (Structurally & safety-wise valid, so only the LLM can catch it.)
  {
    id: 'intent-C',
    action: 'transfer',
    chain: 'arbitrum',
    to: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
    amount: 5000,
    token: 'USDC',
    rationale:
      'Read the current ETH/USD price from the Chainlink oracle. This is a ' +
      'read-only price check and must not move any funds.',
  },

  // (D) contractCall: rationale claims a "small" DEX approval, but the calldata
  //     decodes to approve(spender, 2^256-1) — the classic unlimited-approval
  //     drainer. Structurally & safety-clean; ONLY the Calldata Guard catches it.
  {
    id: 'intent-D',
    action: 'contractCall',
    chain: 'base',
    to: USDC_BASE,
    token: 'USDC',
    calldata: DRAINER_APPROVE_CALLDATA,
    params: { function: 'approve', note: 'grant DEX a small spend allowance' },
    rationale:
      'Approve a small, limited USDC spend so the DEX router can execute a modest swap on our behalf.',
  },

  // (E) contractCall: rationale claims a read-only "check balance", but the
  //     calldata decodes to transfer(attacker, 1000e6) — a hidden fund transfer.
  {
    id: 'intent-E',
    action: 'contractCall',
    chain: 'base',
    to: USDC_BASE,
    token: 'USDC',
    calldata: HIDDEN_TRANSFER_CALLDATA,
    params: { function: 'balanceOf', note: 'read-only balance check' },
    rationale:
      'Check the current USDC balance of our treasury wallet. Read-only query, must not move any funds.',
  },
];

/**
 * Run the end-to-end demo:
 *   - process each sample intent through the gate + adapter,
 *   - then print the reliability ledger.
 */
export async function runDemo(): Promise<void> {
  console.log('====== Verified Execution Agent (VEA) — DEMO ======');
  console.log('Every intent passes through the verification gate before the last mile.\n');

  // Start each demo run from a clean ledger for readable, self-contained output.
  resetLedger();

  for (const intent of SAMPLE_INTENTS) {
    await processIntent(intent);
  }

  printLedger();
}
