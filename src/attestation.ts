/**
 * The ATTESTATION Core — VEA's portable proof artifact.
 *
 * After an intent is decided (executed or blocked), this module produces a
 * SIGNED attestation that compares what was INTENDED against what ACTUALLY
 * executed. That single artifact carries three framings at once:
 *
 *   • reliable-execution proof   — "the agent did exactly what it was told" (for
 *                                   a keeper / execution platform);
 *   • accuracy-oracle verdict    — "this agent's claimed action matches reality"
 *                                   (for an agent society that rates agents);
 *   • verification-service receipt — "an independent verifier checked this and
 *                                   signed off" (for a paid-verification market).
 *
 * ONE CORE, THREE FRAMINGS. The valuable part is DEVIATION DETECTION: an agent
 * that SAYS it did X but actually did Y is exactly the failure this catches.
 *
 * ── Chain-agnostic ─────────────────────────────────────────────────────────
 * This core does NOT depend on KeeperHub (or any specific chain). It compares an
 * `OnchainIntent` against a generic `ExecutionResult` shape, so it works behind
 * ANY execution adapter. The adapter just needs to report back what it actually
 * executed (`to` / `valueOrAmount` / `calldata`).
 *
 * ── Cryptography ───────────────────────────────────────────────────────────
 * Signatures use Node's built-in `crypto` with an Ed25519 keypair — no external
 * dependency. The keypair is generated on first run and persisted locally to
 * `attestor_key.json` (gitignored) so the attestor identity is stable across
 * runs. The public key is embedded in every attestation; `verifyAttestation()`
 * re-checks the signature, proving the artifact is tamper-evident.
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { OnchainIntent, Verdict, ExecutionResult } from './types.js';
import { decodeCalldata } from './calldataGuard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Where the (gitignored) attestor keypair is persisted. Project root. */
export const ATTESTOR_KEY_PATH = join(__dirname, '..', 'attestor_key.json');

/** Append-only log of signed attestations, parallel to the reliability ledger. */
export const ATTESTATIONS_PATH = join(__dirname, '..', 'attestations.jsonl');

// ---------------------------------------------------------------------------
// The attestation shape
// ---------------------------------------------------------------------------

/** What the agent INTENDED to do — the claim under attestation. */
export interface AttestationIntended {
  chainId: string;
  action: string;
  to: string;
  /** Value/amount as a chain-agnostic decimal string (empty for pure calls). */
  valueOrAmount: string;
  token?: string;
  /** Raw calldata for contractCall-style actions. */
  calldata?: string;
}

/** What ACTUALLY executed — null when the intent was blocked before execution. */
export interface AttestationActual {
  txHash: string;
  to?: string;
  valueOrAmount?: string;
  calldata?: string;
  blockNumber?: number;
  status: string;
}

/** The intended-vs-actual comparison result. */
export interface AttestationMatch {
  /** True when actual matched intended (or nothing executed, as the gate intended). */
  ok: boolean;
  /** Concrete, human-readable divergences (or block reasons, for blocked intents). */
  deviations: string[];
}

export type AttestationVerdict =
  | 'APPROVED_FOR_EXECUTION'   // gate PASS, pre-flight: verifier одобрил, исполнение за вызывающим (non-custodial)
  | 'EXECUTED_AS_INTENDED'
  | 'BLOCKED_PRE_EXECUTION'
  | 'DEVIATION_DETECTED';

/**
 * The signed proof artifact. `signature` covers the canonical JSON of every
 * other field (including `attestorPubKey`), so any tampering is detectable.
 */
export interface Attestation {
  intentId: string;
  intended: AttestationIntended;
  actual: AttestationActual | null;
  match: AttestationMatch;
  verdict: AttestationVerdict;
  timestamp: string;
  /** Base64 SPKI-DER of the attestor's Ed25519 public key. */
  attestorPubKey: string;
  /** Base64 Ed25519 signature over the canonical attestation body. */
  signature: string;
}

// ---------------------------------------------------------------------------
// Deterministic canonicalization (stable key order, undefined dropped) so the
// signed bytes are identical before persistence and after a JSON round-trip.
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') +
    '}'
  );
}

/** Canonical bytes that get signed / verified: every field except `signature`. */
function canonicalBody(att: Omit<Attestation, 'signature'>): string {
  return stableStringify({
    intentId: att.intentId,
    intended: att.intended,
    actual: att.actual,
    match: att.match,
    verdict: att.verdict,
    timestamp: att.timestamp,
    attestorPubKey: att.attestorPubKey,
  });
}

// ---------------------------------------------------------------------------
// Attestor identity — a persistent Ed25519 keypair (Node built-in crypto)
// ---------------------------------------------------------------------------

interface Attestor {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** Base64 SPKI-DER of the public key — the stable, shareable attestor id. */
  pubKeyB64: string;
}

interface AttestorKeyFile {
  privateKeyPem: string;
  publicKeyPem: string;
  createdAt: string;
}

let cached: Attestor | undefined;

/**
 * Load the persisted attestor keypair, or generate + persist one on first run.
 * The private key never leaves this machine; only the public key is embedded in
 * attestations. `attestor_key.json` is gitignored so no secret is ever committed.
 */
function loadOrCreateAttestor(): Attestor {
  if (cached) return cached;

  // 1. Env var (production / deploy): the attestor identity MUST stay stable across
  //    redeploys, or previously-issued receipts stop verifying. Hosts like Railway /
  //    Render / Fly have ephemeral filesystems, so the on-disk key file is wiped on
  //    every restart. Set `VEA_ATTESTOR_KEY` to the JSON contents of attestor_key.json
  //    (a secret — it holds the private key) to pin the identity. Env wins over file.
  const fromEnv = process.env.VEA_ATTESTOR_KEY;
  if (fromEnv && fromEnv.trim()) {
    const parsed = JSON.parse(fromEnv) as AttestorKeyFile;
    const privateKey = createPrivateKey(parsed.privateKeyPem);
    const publicKey = createPublicKey(parsed.publicKeyPem);
    cached = { privateKey, publicKey, pubKeyB64: publicKeyToB64(publicKey) };
    return cached;
  }

  if (existsSync(ATTESTOR_KEY_PATH)) {
    const parsed = JSON.parse(readFileSync(ATTESTOR_KEY_PATH, 'utf8')) as AttestorKeyFile;
    const privateKey = createPrivateKey(parsed.privateKeyPem);
    const publicKey = createPublicKey(parsed.publicKeyPem);
    cached = { privateKey, publicKey, pubKeyB64: publicKeyToB64(publicKey) };
    return cached;
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyFile: AttestorKeyFile = {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    createdAt: new Date().toISOString(),
  };
  // Written locally and gitignored — this file holds the attestor PRIVATE key.
  writeFileSync(ATTESTOR_KEY_PATH, JSON.stringify(keyFile, null, 2), 'utf8');
  cached = { privateKey, publicKey, pubKeyB64: publicKeyToB64(publicKey) };
  return cached;
}

function publicKeyToB64(publicKey: KeyObject): string {
  return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

/** The attestor's stable public key (base64 SPKI-DER). Safe to publish/share. */
export function attestorPublicKey(): string {
  return loadOrCreateAttestor().pubKeyB64;
}

/** A short, log-friendly rendering of the attestor public key. */
export function shortAttestorKey(): string {
  const k = attestorPublicKey();
  return k.length > 16 ? `${k.slice(0, 10)}…${k.slice(-6)}` : k;
}

// ---------------------------------------------------------------------------
// Intended-vs-actual comparison — the deviation detector
// ---------------------------------------------------------------------------

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function strip0x(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
}

/** Normalize an amount for comparison: numeric when possible, else trimmed string. */
function normalizeAmount(v: string): string {
  const t = v.trim();
  const n = Number(t);
  return Number.isFinite(n) && t !== '' ? String(n) : t;
}

/**
 * Compare what was INTENDED against what ACTUALLY executed and derive the match
 * + verdict. This is the heart of the attestation: it catches an executor that
 * sent to a different recipient, moved a different amount, or ran calldata that
 * decodes to a different action than the intent declared.
 *
 * Chain-agnostic: takes only an `OnchainIntent` and a generic `ExecutionResult`.
 */
export function compareIntendedVsActual(
  intent: OnchainIntent,
  execution: ExecutionResult,
): { match: AttestationMatch; verdict: AttestationVerdict } {
  const deviations: string[] = [];

  // (1) Recipient deviation — the classic "sent somewhere else" failure.
  const intendedTo = intent.to?.toLowerCase();
  const actualTo = execution.to?.toLowerCase();
  if (intendedTo && actualTo && intendedTo !== actualTo) {
    deviations.push(
      `recipient deviation: intended recipient ${short(intent.to)} but the ` +
        `execution actually paid/called ${short(execution.to!)}.`,
    );
  }

  // (2) Amount deviation — moved a different value than intended.
  const intendedAmt =
    intent.amount !== undefined ? normalizeAmount(String(intent.amount)) : undefined;
  const actualAmt =
    execution.valueOrAmount !== undefined
      ? normalizeAmount(execution.valueOrAmount)
      : undefined;
  if (intendedAmt !== undefined && actualAmt !== undefined && intendedAmt !== actualAmt) {
    deviations.push(
      `amount deviation: intended to move ${intendedAmt} but the execution ` +
        `actually moved ${actualAmt}.`,
    );
  }

  // (3) Action deviation — actual calldata decodes to a DIFFERENT action than
  //     the intent's calldata (or the same action with different bytes/args).
  if (intent.calldata && execution.calldata) {
    const di = decodeCalldata(intent.calldata);
    const da = decodeCalldata(execution.calldata);
    const intendedFn = di?.name ?? di?.selector;
    const actualFn = da?.name ?? da?.selector;
    if (intendedFn && actualFn && intendedFn !== actualFn) {
      deviations.push(
        `action deviation: intended calldata invokes ${di?.signature ?? di?.selector} ` +
          `but the executed calldata invokes ${da?.signature ?? da?.selector}.`,
      );
    } else if (
      strip0x(intent.calldata).toLowerCase() !== strip0x(execution.calldata).toLowerCase()
    ) {
      deviations.push(
        `calldata deviation: executed calldata differs from the intended calldata ` +
          `for ${da?.signature ?? da?.selector ?? 'the call'} (argument-level change).`,
      );
    }
  }

  const ok = deviations.length === 0;
  return {
    match: { ok, deviations },
    verdict: ok ? 'EXECUTED_AS_INTENDED' : 'DEVIATION_DETECTED',
  };
}

// ---------------------------------------------------------------------------
// Build + sign an attestation
// ---------------------------------------------------------------------------

/** Everything the attestor needs to know about how an intent was handled. */
export interface AttestationInput {
  intent: OnchainIntent;
  /** The gate's verdict — its block reasons become the deviations for a block. */
  gateVerdict: Verdict;
  /** Whether the intent was executed (PASS) or blocked. */
  executed: boolean;
  /** The execution result, present when `executed` is true. */
  execution?: ExecutionResult;
}

/**
 * Produce a signed attestation for a handled intent.
 *   • blocked            -> BLOCKED_PRE_EXECUTION (actual = null, block reasons in deviations)
 *   • executed, matches  -> EXECUTED_AS_INTENDED
 *   • executed, diverges -> DEVIATION_DETECTED
 */
/** Build the signed "intended" summary from an intent. Shared by attestExecution and attestVerdict. */
function intendedFrom(intent: OnchainIntent): AttestationIntended {
  return {
    chainId: intent.chain,
    action: intent.action,
    to: intent.to,
    valueOrAmount: intent.amount !== undefined ? String(intent.amount) : '',
    ...(intent.token ? { token: intent.token } : {}),
    ...(intent.calldata ? { calldata: intent.calldata } : {}),
  };
}

/** Sign a body (fills in the Ed25519 signature). Shared helper. */
function signBody(body: Omit<Attestation, 'signature'>): Attestation {
  const { privateKey } = loadOrCreateAttestor();
  const signature = edSign(null, Buffer.from(canonicalBody(body), 'utf8'), privateKey).toString(
    'base64',
  );
  return { ...body, signature };
}

/**
 * PRE-FLIGHT receipt on the gate's verdict ALONE — nothing executed yet.
 * This is the receipt POST /verify returns: PASS → APPROVED_FOR_EXECUTION (caller executes with
 * its own keys, non-custodial), BLOCK → BLOCKED_PRE_EXECUTION. Signed & tamper-evident like all receipts.
 */
export function attestVerdict(intent: OnchainIntent, gateVerdict: Verdict): Attestation {
  const body: Omit<Attestation, 'signature'> = {
    intentId: intent.id,
    intended: intendedFrom(intent),
    actual: null,
    match: {
      ok: gateVerdict.decision === 'PASS',
      deviations: [...gateVerdict.reasons],
    },
    verdict:
      gateVerdict.decision === 'PASS' ? 'APPROVED_FOR_EXECUTION' : 'BLOCKED_PRE_EXECUTION',
    timestamp: new Date().toISOString(),
    attestorPubKey: attestorPublicKey(),
  };
  return signBody(body);
}

export function attestExecution(input: AttestationInput): Attestation {
  const { intent, gateVerdict, executed, execution } = input;

  const intended: AttestationIntended = intendedFrom(intent);

  let actual: AttestationActual | null;
  let match: AttestationMatch;
  let verdict: AttestationVerdict;

  if (!executed || !execution) {
    // Blocked before the last mile: nothing executed — which is the outcome the
    // gate intended. Carry the block reasons as the "deviations" per the spec.
    actual = null;
    match = { ok: true, deviations: [...gateVerdict.reasons] };
    verdict = 'BLOCKED_PRE_EXECUTION';
  } else {
    actual = {
      txHash: execution.txHash,
      status: execution.status,
      ...(execution.to !== undefined ? { to: execution.to } : {}),
      ...(execution.valueOrAmount !== undefined
        ? { valueOrAmount: execution.valueOrAmount }
        : {}),
      ...(execution.calldata !== undefined ? { calldata: execution.calldata } : {}),
      ...(execution.blockNumber !== undefined
        ? { blockNumber: execution.blockNumber }
        : {}),
    };
    const compared = compareIntendedVsActual(intent, execution);
    match = compared.match;
    verdict = compared.verdict;
  }

  const body: Omit<Attestation, 'signature'> = {
    intentId: intent.id,
    intended,
    actual,
    match,
    verdict,
    timestamp: new Date().toISOString(),
    attestorPubKey: attestorPublicKey(),
  };

  const { privateKey } = loadOrCreateAttestor();
  const signature = edSign(null, Buffer.from(canonicalBody(body), 'utf8'), privateKey).toString(
    'base64',
  );

  return { ...body, signature };
}

// ---------------------------------------------------------------------------
// Verify an attestation (tamper-evidence)
// ---------------------------------------------------------------------------

/**
 * Re-check an attestation's signature against its embedded public key. Returns
 * false if the signature is invalid or any signed field was altered — this is
 * what makes the artifact portable proof rather than a mere claim.
 */
export function verifyAttestation(att: Attestation): boolean {
  try {
    const { signature, ...body } = att;
    const publicKey = createPublicKey({
      key: Buffer.from(att.attestorPubKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return edVerify(
      null,
      Buffer.from(canonicalBody(body), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Append-only attestation log (parallel to the reliability ledger)
// ---------------------------------------------------------------------------

/** Append one signed attestation to `attestations.jsonl`. */
export function logAttestation(att: Attestation): Attestation {
  appendFileSync(ATTESTATIONS_PATH, JSON.stringify(att) + '\n', 'utf8');
  return att;
}

/** Truncate the attestation log (used by the demo for clean, repeatable runs). */
export function resetAttestations(): void {
  writeFileSync(ATTESTATIONS_PATH, '', 'utf8');
}

/** Read every attestation currently on disk. */
export function readAttestations(): Attestation[] {
  if (!existsSync(ATTESTATIONS_PATH)) return [];
  return readFileSync(ATTESTATIONS_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Attestation);
}

/** Pretty-print the signed attestations, re-verifying each signature live. */
export function printAttestations(): void {
  const atts = readAttestations();
  console.log('\n============== SIGNED ATTESTATIONS ==============');
  console.log(`attestor public key: ${attestorPublicKey()}`);
  if (atts.length === 0) {
    console.log('(none)');
    console.log('================================================\n');
    return;
  }

  for (const a of atts) {
    const sigOk = verifyAttestation(a);
    console.log(
      `\n${a.intentId}: ${a.verdict}  [signature ${sigOk ? 'VALID' : 'INVALID'}]`,
    );
    if (a.actual) {
      console.log(`   actual: tx=${a.actual.txHash || '(none)'} status=${a.actual.status}`);
    } else {
      console.log('   actual: (nothing executed — blocked pre-execution)');
    }
    for (const d of a.match.deviations) {
      console.log(`   - ${d}`);
    }
  }

  const byVerdict = (v: AttestationVerdict) => atts.filter((a) => a.verdict === v).length;
  console.log(
    `\n-- ${byVerdict('EXECUTED_AS_INTENDED')} executed-as-intended / ` +
      `${byVerdict('DEVIATION_DETECTED')} deviation / ` +
      `${byVerdict('BLOCKED_PRE_EXECUTION')} blocked, ` +
      `all signatures re-verified --`,
  );
  console.log('================================================\n');
}
