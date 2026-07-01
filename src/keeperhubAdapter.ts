/**
 * KeeperHub execution adapter.
 *
 * This is the ONLY place that touches the "last mile" — the actual on-chain
 * execution. It is deliberately a thin, swappable interface so the verification
 * core stays platform-independent.
 *
 * For the prototype this is a STUB that simulates a successful execution and
 * returns a fake txHash.
 *
 * // TODO: wire to KeeperHub MCP/API (kh execute contract-call/transfer)
 * //       — see docs.keeperhub.com
 */

import type { OnchainIntent, ExecutionResult } from './types.js';

/** Deterministic-ish fake tx hash so demo output is readable. */
function fakeTxHash(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  // Pad out to a realistic 32-byte hash shape.
  return '0x' + (hex + hex + hex + hex + hex + hex + hex + hex).slice(0, 64);
}

/**
 * Execute a verified intent on-chain.
 *
 * PRECONDITION: callers MUST only pass intents that already PASSED the
 * verification gate. This adapter does not re-verify.
 *
 * @param intent an already-verified OnchainIntent
 * @returns the resulting txHash and status
 */
export async function executeOnChain(
  intent: OnchainIntent,
): Promise<ExecutionResult> {
  // --- STUB IMPLEMENTATION -------------------------------------------------
  // Simulate a small amount of network latency.
  await new Promise((resolve) => setTimeout(resolve, 50));

  // In the real adapter this branch would call:
  //   kh execute transfer      --chain <> --to <> --amount <> --token <>
  //   kh execute contract-call --chain <> --to <> --params <>
  const txHash = fakeTxHash(intent.id + intent.to + String(intent.amount ?? ''));

  return {
    txHash,
    status: 'confirmed(simulated)',
  };
  // --- END STUB ------------------------------------------------------------
}
