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

/** Three sample intents used by the demo (exported for reuse/tests). */
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
