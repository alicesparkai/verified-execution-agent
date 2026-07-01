/**
 * Reliability ledger — an append-only audit trail.
 *
 * Every intent the agent considers is recorded here with its verdict, whether
 * it was executed, and the resulting txHash. This is the accountability layer:
 * "trust, but verify — and keep the receipts."
 *
 * Storage format is JSON Lines (one JSON object per line) so it is append-only
 * and trivially streamable / greppable.
 */

import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  OnchainIntent,
  Verdict,
  ExecutionResult,
  LedgerEntry,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Ledger lives at the project root (one level up from /src or /dist). */
export const LEDGER_PATH = join(__dirname, '..', 'ledger.jsonl');

/**
 * Append one entry to the ledger.
 * The timestamp is stamped here (this is the IO boundary; using Date here is fine).
 */
export function logEntry(
  intent: OnchainIntent,
  verdict: Verdict,
  executed: boolean,
  execution?: ExecutionResult,
): LedgerEntry {
  const entry: LedgerEntry = {
    timestamp: new Date().toISOString(),
    intent,
    verdict,
    executed,
    execution,
  };
  appendFileSync(LEDGER_PATH, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/**
 * Truncate the ledger to empty. Used by the demo so repeated runs produce a
 * clean, self-contained audit trail. (In production you would never do this.)
 */
export function resetLedger(): void {
  writeFileSync(LEDGER_PATH, '', 'utf8');
}

/** Read every entry currently in the ledger. */
export function readLedger(): LedgerEntry[] {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

/** Pretty-print the ledger to stdout as a human-readable summary table. */
export function printLedger(): void {
  const entries = readLedger();
  console.log('\n================= RELIABILITY LEDGER =================');
  if (entries.length === 0) {
    console.log('(empty)');
    console.log('=====================================================\n');
    return;
  }

  for (const e of entries) {
    const mark = e.verdict.decision === 'PASS' ? 'PASS ' : 'BLOCK';
    const exec = e.executed
      ? `executed tx=${e.execution?.txHash} (${e.execution?.status})`
      : 'not executed';
    console.log(
      `\n[${e.timestamp}] ${mark} conf=${e.verdict.confidence.toFixed(2)}  ` +
        `intent=${e.intent.id} (${e.intent.action} -> ${e.intent.to})`,
    );
    console.log(`   ${exec}`);
    for (const r of e.verdict.reasons) {
      console.log(`   - ${r}`);
    }
  }

  const passed = entries.filter((e) => e.verdict.decision === 'PASS').length;
  const blocked = entries.length - passed;
  console.log(
    `\n-- totals: ${passed} PASS / ${blocked} BLOCK across ${entries.length} intents --`,
  );
  console.log('=====================================================\n');
}
