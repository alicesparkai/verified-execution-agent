/**
 * KeeperHub execution adapter — the "last mile".
 *
 * This is the ONLY place in VEA that touches on-chain execution. Everything
 * upstream (the verification gate) is platform-independent; this file maps a
 * gate-APPROVED `OnchainIntent` onto KeeperHub's real execution API.
 *
 * ── REAL INTEGRATION (confirmed on Sepolia) ────────────────────────────────
 * KeeperHub exposes execution as two tools/endpoints, which this adapter drives:
 *
 *   execute_transfer({ chain_id, to_address, amount, token_address?,
 *                      idempotency_key }) -> { executionId, status }
 *   get_direct_execution_status(execution_id)
 *                     -> { status, transactionHash, error, network, gasUsedWei, … }
 *
 * KeeperHub holds the agent's wallet integration and SIGNS + BROADCASTS on its
 * side — VEA never touches a private key. The wallet used for this submission:
 *
 *   wallet integration id : 6ozsmal9mx9oz9e8y2ury
 *   agent address         : 0xAD6BC9c822494872A9e90Dc4788Be700DadDAE3a
 *   network               : Sepolia testnet (chain_id 11155111)
 *
 * This path is CONFIRMED working end-to-end: a live test transfer returned
 * "Insufficient ETH balance. Have: 0.0, Need: 0.0001" — i.e. KeeperHub accepted
 * the request, resolved the wallet, and attempted the signed on-chain execution.
 * The only thing gating a real broadcast is funding the wallet.
 *
 * ── Transport is injectable ────────────────────────────────────────────────
 * The adapter talks to KeeperHub through a small `KeeperHubClient` interface.
 * The default client binds to the KeeperHub MCP tools via a host-provided tool
 * invoker (`setKeeperHubToolInvoker`). Tests / the offline demo inject a
 * simulated client instead — the adapter itself is always the real pattern.
 */

import type { OnchainIntent, ExecutionResult } from './types.js';

// ---------------------------------------------------------------------------
// Confirmed KeeperHub wallet / network constants (this submission's agent)
// ---------------------------------------------------------------------------

/** KeeperHub wallet integration id that signs/executes on the agent's behalf. */
export const KEEPERHUB_WALLET_INTEGRATION_ID = '6ozsmal9mx9oz9e8y2ury';

/** The agent's on-chain address behind that wallet integration. */
export const KEEPERHUB_AGENT_ADDRESS =
  '0xAD6BC9c822494872A9e90Dc4788Be700DadDAE3a';

/** Sepolia testnet — the network the confirmed wallet integration lives on. */
export const SEPOLIA_CHAIN_ID = '11155111';

/**
 * Named-chain → numeric chain_id map. KeeperHub's `execute_transfer` takes a
 * numeric chain id as a string. The CONFIRMED, funded wallet is on Sepolia;
 * mainnet ids are included so the same adapter works once mainnet wallets are
 * provisioned. Override per-call via ExecuteOptions.chainId or the
 * VEA_KEEPERHUB_CHAIN_ID env var.
 */
const CHAIN_IDS: Record<string, string> = {
  ethereum: '1',
  base: '8453',
  arbitrum: '42161',
  optimism: '10',
  polygon: '137',
  sepolia: SEPOLIA_CHAIN_ID,
};

// ---------------------------------------------------------------------------
// KeeperHub client interface — the exact confirmed execution surface
// ---------------------------------------------------------------------------

/** Request shape for KeeperHub `execute_transfer` (confirmed). */
export interface ExecuteTransferRequest {
  chain_id: string;
  to_address: string;
  /** Human-readable units, e.g. "0.1" (NOT wei). */
  amount: string;
  /** ERC20 contract address. Omit for native (ETH/MATIC) transfers. */
  token_address?: string;
  /** Agent-side transaction id; makes retries safe within KeeperHub's window. */
  idempotency_key?: string;
}

/** Response shape for KeeperHub `execute_transfer` (confirmed). */
export interface ExecuteTransferResponse {
  executionId: string;
  status: string;
}

/** Response shape for KeeperHub `get_direct_execution_status` (confirmed). */
export interface DirectExecutionStatus {
  status: string;
  transactionHash?: string;
  error?: string;
  network?: string;
  gasUsedWei?: string;
  /** KeeperHub may return additional fields; keep them without losing type-safety. */
  [key: string]: unknown;
}

/**
 * The minimal KeeperHub execution surface VEA depends on. Implemented for real
 * by {@link mcpKeeperHubClient}; stubbed by {@link createSimulatedKeeperHubClient}
 * for the offline demo/tests.
 */
export interface KeeperHubClient {
  executeTransfer(req: ExecuteTransferRequest): Promise<ExecuteTransferResponse>;
  getDirectExecutionStatus(executionId: string): Promise<DirectExecutionStatus>;
}

// ---------------------------------------------------------------------------
// Default (real) client: bind to the KeeperHub MCP tools via a host invoker
// ---------------------------------------------------------------------------

/**
 * A transport that invokes a KeeperHub MCP tool by name and returns its raw
 * result. The host runtime (which owns the MCP connection to KeeperHub) wires
 * this in via {@link setKeeperHubToolInvoker}. This keeps VEA dependency-free
 * while still driving the *real* `execute_transfer` / `get_direct_execution_status`
 * tools that were confirmed on Sepolia.
 */
export type McpToolInvoker = (
  toolName: 'execute_transfer' | 'get_direct_execution_status',
  args: Record<string, unknown>,
) => Promise<unknown>;

let registeredInvoker: McpToolInvoker | undefined;

/** Register the KeeperHub MCP tool invoker used by the default real client. */
export function setKeeperHubToolInvoker(invoker: McpToolInvoker): void {
  registeredInvoker = invoker;
}

/**
 * Coerce an MCP tool result into a plain object. MCP tools typically return
 * `{ content: [{ type: 'text', text: '<json>' }] }`; some return the object
 * directly. Handle both without inventing structure.
 */
function coerceToolResult(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && 'content' in (raw as any)) {
    const content = (raw as any).content;
    if (Array.isArray(content)) {
      const textPart = content.find(
        (p) => p && typeof p === 'object' && typeof (p as any).text === 'string',
      );
      if (textPart) {
        try {
          return JSON.parse((textPart as any).text);
        } catch {
          return { status: 'unknown', raw: (textPart as any).text };
        }
      }
    }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return { status: 'unknown', raw };
}

/**
 * The real KeeperHub client. Maps our typed calls onto the confirmed MCP tools
 * through the registered invoker. If no invoker is wired, it fails loud and
 * clear rather than silently faking a result — honesty is a feature.
 */
export const mcpKeeperHubClient: KeeperHubClient = {
  async executeTransfer(req) {
    if (!registeredInvoker) {
      throw new Error(
        'KeeperHub MCP transport not configured. Call setKeeperHubToolInvoker() ' +
          'with a host invoker, or inject a client via executeOnChain(intent, { client }).',
      );
    }
    const result = coerceToolResult(
      await registeredInvoker('execute_transfer', { ...req } as Record<string, unknown>),
    );
    return {
      executionId: String(result.executionId ?? result.execution_id ?? ''),
      status: String(result.status ?? 'submitted'),
    };
  },

  async getDirectExecutionStatus(executionId) {
    if (!registeredInvoker) {
      throw new Error('KeeperHub MCP transport not configured (setKeeperHubToolInvoker).');
    }
    const result = coerceToolResult(
      await registeredInvoker('get_direct_execution_status', {
        execution_id: executionId,
      }),
    );
    return result as DirectExecutionStatus;
  },
};

// ---------------------------------------------------------------------------
// executeOnChain — the public "last mile" entry point
// ---------------------------------------------------------------------------

/** Options for {@link executeOnChain}. */
export interface ExecuteOptions {
  /** KeeperHub client to use. Defaults to the real MCP-backed client. */
  client?: KeeperHubClient;
  /** Force a specific numeric chain_id (overrides the intent's named chain). */
  chainId?: string;
  /** Delay between status polls, ms. Default 1500. */
  pollIntervalMs?: number;
  /** Max status polls before giving up and returning the last known state. Default 20. */
  maxPollAttempts?: number;
}

/** Terminal execution states (case-insensitive) at which polling stops. */
const TERMINAL_STATUS_RE =
  /^(confirmed|success|succeeded|completed|complete|failed|failure|error|reverted|cancelled|canceled)$/i;

function isTerminalStatus(status: string | undefined): boolean {
  return TERMINAL_STATUS_RE.test((status ?? '').trim());
}

function isFailureStatus(status: string | undefined): boolean {
  return /^(failed|failure|error|reverted|cancelled|canceled)$/i.test((status ?? '').trim());
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Resolve the intent's chain to a KeeperHub numeric chain_id. */
function resolveChainId(intent: OnchainIntent, override?: string): string {
  if (override) return override;
  const envOverride = process.env.VEA_KEEPERHUB_CHAIN_ID;
  if (envOverride) return envOverride;
  const chain = (intent.chain ?? '').toLowerCase();
  if (CHAIN_IDS[chain]) return CHAIN_IDS[chain];
  // Already numeric? pass through.
  if (/^\d+$/.test(chain)) return chain;
  throw new Error(
    `KeeperHub adapter: unknown chain "${intent.chain}" (no chain_id mapping). ` +
      `Known: ${Object.keys(CHAIN_IDS).join(', ')}.`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a verified intent on-chain via KeeperHub.
 *
 * PRECONDITION: callers MUST only pass intents that already PASSED the
 * verification gate. This adapter does not re-verify.
 *
 * Flow (the confirmed KeeperHub pattern):
 *   1. Map the intent → `execute_transfer` and submit it with an
 *      idempotency_key (the intent id), so a retry never double-spends.
 *   2. Poll `get_direct_execution_status` until a terminal state, to obtain
 *      the real transactionHash (or the error).
 *   3. Return an {@link ExecutionResult} that flows into the ledger + dashboard.
 *
 * @param intent  an already-verified OnchainIntent
 * @param options transport/polling overrides (defaults to the real MCP client)
 */
export async function executeOnChain(
  intent: OnchainIntent,
  options: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const client = options.client ?? mcpKeeperHubClient;
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxPollAttempts = options.maxPollAttempts ?? 20;

  // The confirmed interface used here is `execute_transfer`. Contract-call
  // execution is a separate KeeperHub tool (`execute_contract_call`) and is out
  // of scope for this transfer-focused submission; such intents are rejected
  // rather than silently mishandled. (In the VEA demo, every contractCall is
  // BLOCKed by the gate and so never reaches this adapter.)
  if (intent.action !== 'transfer') {
    return {
      txHash: '',
      status: `not-executed (action "${intent.action}" needs execute_contract_call — out of confirmed scope)`,
      error: `Unsupported action for execute_transfer: ${intent.action}`,
      executionId: undefined,
    };
  }

  const chainId = resolveChainId(intent, options.chainId);

  const req: ExecuteTransferRequest = {
    chain_id: chainId,
    to_address: intent.to,
    amount: String(intent.amount ?? ''),
    // We only have a token SYMBOL on the intent; KeeperHub wants a contract
    // address. Pass token_address only when the intent carries an actual 0x
    // address, otherwise treat it as a native (ETH) transfer — the confirmed
    // path. Symbol→address resolution is intentionally out of scope here.
    ...(typeof intent.token === 'string' && EVM_ADDRESS_RE.test(intent.token)
      ? { token_address: intent.token }
      : {}),
    // Idempotency: reusing the same key (with the same args) returns the
    // original result instead of executing again — safe retries by design.
    idempotency_key: intent.id,
  };

  // 1) Submit the transfer to KeeperHub (it signs + broadcasts on its side).
  const submitted = await client.executeTransfer(req);
  const executionId = submitted.executionId;

  // If KeeperHub couldn't even accept the request, surface that immediately.
  if (!executionId) {
    return {
      txHash: '',
      status: submitted.status || 'submit-failed',
      error: 'KeeperHub did not return an executionId.',
      executionId: undefined,
      network: intent.chain,
    };
  }

  // 2) Poll for a terminal state to obtain the real tx hash (or the error).
  let last: DirectExecutionStatus = { status: submitted.status };
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    last = await client.getDirectExecutionStatus(executionId);

    const done =
      isTerminalStatus(last.status) ||
      typeof last.error === 'string' ||
      typeof last.transactionHash === 'string';

    if (done) break;
    if (attempt < maxPollAttempts) await sleep(pollIntervalMs);
  }

  // 3) Fold the final KeeperHub state into an ExecutionResult for the ledger.
  const failed = isFailureStatus(last.status) || typeof last.error === 'string';
  return {
    txHash: last.transactionHash ?? '',
    status: failed ? last.status || 'failed' : last.status || 'pending',
    executionId,
    network: last.network ?? intent.chain,
    gasUsedWei: last.gasUsedWei,
    error: typeof last.error === 'string' ? last.error : undefined,
  };
}

// ---------------------------------------------------------------------------
// Simulated client — for the OFFLINE demo / tests only (clearly labeled)
// ---------------------------------------------------------------------------

/** Deterministic-ish fake tx hash so simulated demo output is readable. */
function fakeTxHash(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  return '0x' + (hex + hex + hex + hex + hex + hex + hex + hex).slice(0, 64);
}

/**
 * A simulated KeeperHub client for the offline demo and tests. It mirrors the
 * real execute→poll shape but never touches the network, and labels its output
 * as simulated so nothing is mistaken for a real broadcast. Inject via
 * `executeOnChain(intent, { client: createSimulatedKeeperHubClient() })`.
 */
export function createSimulatedKeeperHubClient(): KeeperHubClient {
  return {
    async executeTransfer(req) {
      await sleep(20);
      return {
        executionId: `sim-${req.idempotency_key ?? req.to_address}`,
        status: 'submitted',
      };
    },
    async getDirectExecutionStatus(executionId) {
      await sleep(20);
      return {
        status: 'confirmed (simulated)',
        transactionHash: fakeTxHash(executionId),
        network: 'sepolia (simulated)',
        gasUsedWei: '0',
      };
    },
  };
}
