/**
 * Core domain types for the Verified Execution Agent (VEA).
 *
 * An OnchainIntent is a *proposed* action an autonomous agent wants to take.
 * It is NOT executed until it passes the verification gate.
 */

/** Supported action kinds. Kept intentionally small for the prototype. */
export type OnchainAction = 'transfer' | 'contractCall';

/**
 * A structured, verifiable description of what the agent wants to do on-chain.
 * The `rationale` is first-class: the agent must state *why* it wants this,
 * so the verification gate (and humans) can judge intent vs. action.
 */
export interface OnchainIntent {
  /** Stable unique id for this intent (used in the ledger). */
  id: string;
  /** What kind of on-chain action this is. */
  action: OnchainAction;
  /** Target chain, e.g. "ethereum", "base", "arbitrum". */
  chain: string;
  /** Destination address (EVM 0x-prefixed) or contract address. */
  to: string;
  /** Amount to transfer, as a decimal string or number. Optional for pure calls. */
  amount?: string | number;
  /** Token symbol/address being moved, e.g. "USDC", "ETH". Optional. */
  token?: string;
  /** Arbitrary call parameters for contractCall actions. */
  params?: Record<string, unknown>;
  /** Human-readable justification: WHY the agent wants to do this. */
  rationale: string;
}

/** The gate's decision on an intent. */
export type Decision = 'PASS' | 'BLOCK';

/**
 * The verdict returned by the verification gate.
 * `confidence` in [0, 1] reflects how strongly the combined checks agree.
 */
export interface Verdict {
  decision: Decision;
  confidence: number;
  reasons: string[];
}

/** Result of an (attempted) on-chain execution. */
export interface ExecutionResult {
  txHash: string;
  status: string;
}

/** One immutable row in the reliability ledger. */
export interface LedgerEntry {
  timestamp: string;
  intent: OnchainIntent;
  verdict: Verdict;
  executed: boolean;
  execution?: ExecutionResult;
}
