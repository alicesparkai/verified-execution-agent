/**
 * Calldata Guard — VEA's fourth, most sophisticated verification layer.
 *
 * Simple allow/deny gates look at the *envelope* of a transaction (who, how much,
 * what chain). They are blind to the single most dangerous thing an agent can do:
 * send an innocent-looking `contractCall` whose ABI-encoded **calldata** quietly
 * authorizes a drain. The #1 real-world agent/wallet exploit is the
 * **approval-drainer**: a contract call that reads like "approve a small DEX
 * spend" but actually encodes `approve(attacker, 2^256-1)` — an unlimited
 * allowance the attacker sweeps later.
 *
 * This module DECODES raw calldata against a small map of well-known, dangerous
 * ERC-20/721/1155 selectors and applies threat rules to the *decoded* arguments,
 * so the gate can judge what a call REALLY does — not what it claims to do.
 *
 * No external dependencies: a ~40-line minimal ABI decoder handles the flat,
 * fixed-size types (`address`, `uint256`, `bool`) these selectors use.
 */

import type { OnchainIntent } from './types.js';

// ---------------------------------------------------------------------------
// Known-dangerous 4-byte function selectors.
//
// A selector is the first 4 bytes of keccak256(canonical_signature). Node's
// built-in crypto only ships NIST SHA3 (different padding from Ethereum's
// keccak256), so rather than pull in a keccak dependency we HARDCODE the
// well-known, standardized selectors below. Each is the canonical, widely
// documented value for its signature (verifiable against 4byte.directory / the
// ERC specs). This keeps the layer dependency-free and auditable.
// ---------------------------------------------------------------------------

type SolType = 'address' | 'uint256' | 'bool';

interface KnownFn {
  signature: string;
  name: string;
  /** Arg definitions in ABI order. Only the leading fixed-size args we care
   *  about need to be listed; trailing words (e.g. permit's v/r/s) are ignored. */
  args: { name: string; type: SolType }[];
}

const SELECTORS: Record<string, KnownFn> = {
  // ERC-20 allowance grant — the classic drainer vector.
  '0x095ea7b3': {
    signature: 'approve(address,uint256)',
    name: 'approve',
    args: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  // ERC-20 direct transfer.
  '0xa9059cbb': {
    signature: 'transfer(address,uint256)',
    name: 'transfer',
    args: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  // ERC-20 delegated transfer (pull funds already approved).
  '0x23b872dd': {
    signature: 'transferFrom(address,address,uint256)',
    name: 'transferFrom',
    args: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  },
  // Non-standard but extremely common allowance bump.
  '0x39509351': {
    signature: 'increaseAllowance(address,uint256)',
    name: 'increaseAllowance',
    args: [
      { name: 'spender', type: 'address' },
      { name: 'addedValue', type: 'uint256' },
    ],
  },
  // ERC-721 / ERC-1155 blanket operator approval — NFT drainer vector.
  '0xa22cb465': {
    signature: 'setApprovalForAll(address,bool)',
    name: 'setApprovalForAll',
    args: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
  },
  // ERC-2612 gasless permit — a signature-based allowance grant.
  '0xd505accf': {
    signature: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
    name: 'permit',
    args: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Threat-rule thresholds & lists (tunable policy)
// ---------------------------------------------------------------------------

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Any allowance at/above this is "effectively unlimited": 2^128 ≈ 3.4e38, which
 * is orders of magnitude beyond any legitimate ERC-20 balance (a 18-decimal
 * token with a 1e13 supply tops out near 1e31). Real spends never reach here;
 * drainers always do.
 */
const EFFECTIVELY_UNLIMITED = 1n << 128n;

/**
 * Spenders/operators the agent is allowed to grant (finite) approvals to.
 * In production this would be a curated, live registry of audited routers.
 * Lower-cased for comparison.
 */
const ALLOWLISTED_SPENDERS = new Set<string>([
  // Uniswap V3 SwapRouter02 (mainnet) — an example trusted spender.
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45',
]);

/** Known-bad recipients/operators (lower-cased). Mirrors the gate's denylist. */
const KNOWN_ATTACKERS = new Set<string>([
  '0x000000000000000000000000000000000badc0de',
  '0x000000000000000000000000000000000000dead',
]);

/** Rationale that claims a read-only / non-mutating action. */
const READ_ONLY_HINTS =
  /\b(check|balance|read[-\s]?only|readonly|view|query|inspect|oracle|price|quote|fetch|look\s?up|monitor|no funds|does not? move|must not move|non[-\s]?mutating)\b/i;

/** Rationale that claims a small / bounded spend. */
const SMALL_HINTS = /\b(small|tiny|minimal|minimum|limited|bounded|modest|little|low|exact)\b/i;

// ---------------------------------------------------------------------------
// Findings model
// ---------------------------------------------------------------------------

export type CalldataSeverity = 'BLOCK' | 'FLAG' | 'INFO';

export interface CalldataFinding {
  severity: CalldataSeverity;
  /** Human-readable, decode-grounded explanation. */
  message: string;
}

export interface DecodedArg {
  name: string;
  type: SolType;
  /** address -> 0x…40; uint256 -> decimal string; bool -> "true"/"false". */
  value: string;
}

export interface CalldataDecode {
  selector: string;
  signature?: string;
  name?: string;
  args: DecodedArg[];
}

export interface CalldataGuardResult {
  /** True when the intent actually carried calldata for us to analyze. */
  applicable: boolean;
  decode?: CalldataDecode;
  findings: CalldataFinding[];
}

// ---------------------------------------------------------------------------
// Minimal ABI decoder (no external deps)
// ---------------------------------------------------------------------------

function strip0x(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

const HEX_RE = /^[0-9a-fA-F]*$/;

/** Pull the raw calldata hex from wherever the intent carries it. */
export function extractCalldata(intent: OnchainIntent): string | undefined {
  const candidate =
    intent.calldata ??
    (typeof intent.params?.calldata === 'string'
      ? (intent.params.calldata as string)
      : undefined) ??
    (typeof intent.params?.data === 'string' ? (intent.params.data as string) : undefined);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Decode flat, fixed-size ABI calldata against the known-selector map.
 * Returns undefined only when the input isn't valid hex.
 */
export function decodeCalldata(raw: string): CalldataDecode | undefined {
  const hex = strip0x(raw.trim());
  if (!HEX_RE.test(hex) || hex.length < 8) {
    return undefined;
  }

  const selector = '0x' + hex.slice(0, 8).toLowerCase();
  const body = hex.slice(8);
  const fn = SELECTORS[selector];

  const decode: CalldataDecode = {
    selector,
    signature: fn?.signature,
    name: fn?.name,
    args: [],
  };

  if (!fn) return decode; // unknown selector: selector-only, no args.

  for (let i = 0; i < fn.args.length; i++) {
    const start = i * 64;
    const word = body.slice(start, start + 64);
    if (word.length < 64) break; // truncated calldata; stop decoding.

    const def = fn.args[i];
    if (def.type === 'address') {
      decode.args.push({ name: def.name, type: def.type, value: '0x' + word.slice(24) });
    } else if (def.type === 'uint256') {
      decode.args.push({ name: def.name, type: def.type, value: BigInt('0x' + word).toString() });
    } else {
      // bool
      decode.args.push({
        name: def.name,
        type: def.type,
        value: BigInt('0x' + word) !== 0n ? 'true' : 'false',
      });
    }
  }

  return decode;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arg(decode: CalldataDecode, name: string): DecodedArg | undefined {
  return decode.args.find((a) => a.name === name);
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Format a big allowance readably (calls out uint256 max explicitly). */
function describeAmount(value: bigint): string {
  if (value === UINT256_MAX) return `2^256-1 (uint256 max)`;
  return value.toString();
}

// ---------------------------------------------------------------------------
// Threat rules
// ---------------------------------------------------------------------------

/**
 * Analyze an intent's calldata and return decode + findings.
 * Any finding with severity 'BLOCK' should force an overall BLOCK verdict.
 */
export function analyzeCalldata(intent: OnchainIntent): CalldataGuardResult {
  const raw = extractCalldata(intent);
  if (!raw) return { applicable: false, findings: [] };

  const decode = decodeCalldata(raw);
  if (!decode) {
    return {
      applicable: true,
      findings: [
        {
          severity: 'FLAG',
          message: `calldata is not valid hex — cannot decode / verify what this call does.`,
        },
      ],
    };
  }

  const findings: CalldataFinding[] = [];
  const rationale = intent.rationale ?? '';
  const claimsReadOnly = READ_ONLY_HINTS.test(rationale);
  const claimsSmall = SMALL_HINTS.test(rationale);

  // Unknown selector: we can't vouch for it — flag, don't hard-block.
  if (!decode.name) {
    findings.push({
      severity: 'FLAG',
      message: `unknown function selector ${decode.selector} — not in the known-safe/known-danger map; cannot verify its effect.`,
    });
    return { applicable: true, decode, findings };
  }

  // Cross-check any agent-declared decode against the ACTUAL decode. Lying about
  // what the calldata does is itself a hard block.
  const declaredName = intent.decodedCall?.name;
  if (declaredName && declaredName !== decode.name) {
    findings.push({
      severity: 'BLOCK',
      message: `declared call "${declaredName}" but calldata actually invokes ${decode.signature} — the stated decode does not match the bytes.`,
    });
  }

  // A read-only / balance-check rationale must never carry a state-changing call.
  if (claimsReadOnly) {
    findings.push({
      severity: 'BLOCK',
      message: `hidden state-changing call: rationale claims a read-only/balance check, but calldata invokes ${decode.signature} — which moves funds or grants permissions.`,
    });
  }

  switch (decode.name) {
    case 'approve':
    case 'increaseAllowance':
    case 'permit': {
      const spender = arg(decode, 'spender');
      const amountArg =
        arg(decode, 'amount') ?? arg(decode, 'addedValue') ?? arg(decode, 'value');
      const amount = amountArg ? BigInt(amountArg.value) : 0n;
      const spenderAddr = spender?.value.toLowerCase();
      const label = decode.name === 'permit' ? 'permit allowance' : `${decode.name} allowance`;

      if (spenderAddr && KNOWN_ATTACKERS.has(spenderAddr)) {
        findings.push({
          severity: 'BLOCK',
          message: `${decode.name}() grants an allowance to known-bad spender ${short(spender!.value)}.`,
        });
      }

      if (amount === UINT256_MAX || amount >= EFFECTIVELY_UNLIMITED) {
        const smallNote = claimsSmall
          ? ` This directly contradicts the stated "small/limited spend" rationale.`
          : '';
        findings.push({
          severity: 'BLOCK',
          message:
            `unlimited-approval drainer: ${decode.name}(${short(spender?.value ?? '?')}, ${describeAmount(amount)}) ` +
            `grants an effectively-unlimited ${label} — the #1 real-world wallet-drain pattern.${smallNote}`,
        });
      } else if (spenderAddr && !ALLOWLISTED_SPENDERS.has(spenderAddr)) {
        findings.push({
          severity: 'FLAG',
          message: `${decode.name}() grants a ${amount.toString()}-unit allowance to a non-allowlisted spender ${short(spender!.value)}.`,
        });
      }
      break;
    }

    case 'setApprovalForAll': {
      const operator = arg(decode, 'operator');
      const approved = arg(decode, 'approved')?.value === 'true';
      const opAddr = operator?.value.toLowerCase();

      if (approved) {
        const attackerNote = opAddr && KNOWN_ATTACKERS.has(opAddr) ? ' (a known-bad operator)' : '';
        const allowNote =
          opAddr && !ALLOWLISTED_SPENDERS.has(opAddr) ? ' non-allowlisted' : '';
        findings.push({
          severity: 'BLOCK',
          message:
            `blanket-approval drainer: setApprovalForAll(${short(operator?.value ?? '?')}, true) ` +
            `grants${allowNote} operator${attackerNote} control over ALL tokens in this collection — the NFT-drain pattern.`,
        });
      } else {
        findings.push({
          severity: 'INFO',
          message: `setApprovalForAll(${short(operator?.value ?? '?')}, false) revokes operator approval — harmless.`,
        });
      }
      break;
    }

    case 'transfer':
    case 'transferFrom': {
      const to = arg(decode, 'to');
      const amountArg = arg(decode, 'amount');
      const toAddr = to?.value.toLowerCase();

      if (toAddr && KNOWN_ATTACKERS.has(toAddr)) {
        findings.push({
          severity: 'BLOCK',
          message: `${decode.name}() sends funds to known-bad recipient ${short(to!.value)}.`,
        });
      }

      // Hidden-transfer: decoded recipient contradicts a stated/expected recipient.
      const expected =
        (typeof intent.params?.expectedRecipient === 'string'
          ? (intent.params.expectedRecipient as string)
          : undefined) ??
        (typeof intent.params?.recipient === 'string'
          ? (intent.params.recipient as string)
          : undefined);
      if (expected && toAddr && expected.toLowerCase() !== toAddr) {
        findings.push({
          severity: 'BLOCK',
          message: `hidden-transfer: calldata recipient ${short(to!.value)} != the intent's stated recipient ${short(expected)}.`,
        });
      }

      // Neutral, decoded description so the ledger shows exactly what would move.
      if (!claimsReadOnly) {
        findings.push({
          severity: 'INFO',
          message: `${decode.name}() would move ${amountArg?.value ?? '?'} base units to ${short(to?.value ?? '?')}.`,
        });
      }
      break;
    }

    default:
      break;
  }

  return { applicable: true, decode, findings };
}
