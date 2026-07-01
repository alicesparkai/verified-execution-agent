/**
 * Core domain types for the Verified Execution Agent (VEA).
 *
 * An OnchainIntent is a *proposed* action an autonomous agent wants to take.
 * It is NOT executed until it passes the verification gate.
 */

/** Supported action kinds. Kept intentionally small for the prototype. */
export type OnchainAction = 'transfer' | 'contractCall';

/**
 * An (optionally) agent-supplied claim about what a contractCall's calldata does.
 * The Calldata Guard cross-checks this against the ACTUAL decode of the bytes —
 * a mismatch (declaring one thing, encoding another) is itself a hard block.
 */
export interface DecodedCall {
  /** 0x-prefixed 4-byte function selector, e.g. "0x095ea7b3". */
  selector?: string;
  /** Canonical signature, e.g. "approve(address,uint256)". */
  signature?: string;
  /** Function name, e.g. "approve". */
  name?: string;
  /** Decoded arguments by name (stringified). */
  args?: Record<string, string>;
}

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
  /**
   * Raw ABI-encoded calldata for a contractCall, as a 0x-prefixed hex string
   * (e.g. "0xa9059cbb…"). The Calldata Guard DECODES this and judges what the
   * call really does — the key differentiator over simple allow/deny gates.
   */
  calldata?: string;
  /** Optional agent-declared decode of `calldata`, cross-checked against the bytes. */
  decodedCall?: DecodedCall;
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
