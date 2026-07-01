/**
 * The Verification Gate — the heart of VEA.
 *
 * Before ANY on-chain action is executed, it must pass this gate.
 * The gate runs three independent checks and combines them into a single Verdict:
 *
 *   (a) Structural validation  — is the intent well-formed? (deterministic)
 *   (b) Safety rules           — is it obviously dangerous?  (deterministic)
 *   (c) LLM sanity check        — does the action match its stated rationale,
 *                                 and does it look non-anomalous? (probabilistic)
 *
 * Combination policy: BLOCK if ANY deterministic check fails OR the LLM says unsafe.
 * The gate is "safe by default": if the LLM is unavailable it degrades gracefully
 * and still enforces the deterministic checks.
 */

import { setGlobalDispatcher, ProxyAgent } from 'undici';
import type { OnchainIntent, Verdict } from './types.js';

// ---------------------------------------------------------------------------
// Network setup: this machine reaches the internet via a local Xray proxy.
// Route all undici (global fetch) traffic through it.
// ---------------------------------------------------------------------------
const PROXY_URL = process.env.VEA_PROXY ?? 'http://127.0.0.1:10801';
try {
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
} catch {
  // If the proxy can't be set up, the LLM check will simply fail-soft later.
}

// ---------------------------------------------------------------------------
// Configuration (tunable safety policy)
// ---------------------------------------------------------------------------

/** Chains the agent is allowed to operate on. */
const KNOWN_CHAINS = new Set([
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
]);

/** Absurdly-large-amount cap. Anything above this is auto-blocked. */
export const AMOUNT_CAP = Number(process.env.VEA_AMOUNT_CAP ?? 1_000_000);

/** The canonical "burn" / zero address. Sending funds here loses them forever. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Tiny hardcoded denylist of known-bad addresses / tokens.
 * In production this would be a live threat-intel feed.
 */
const DENYLIST = new Set<string>([
  '0x000000000000000000000000000000000000dead',
  'SCAMCOIN',
]);

/** Pollinations free, OpenAI-compatible endpoint (no API key required). */
const LLM_URL = 'https://text.pollinations.ai/openai';
const LLM_MODEL = 'openai-fast';

// ---------------------------------------------------------------------------
// (a) Structural validation
// ---------------------------------------------------------------------------

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function isValidAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && EVM_ADDRESS_RE.test(addr);
}

function toNumber(amount: string | number | undefined): number | undefined {
  if (amount === undefined) return undefined;
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) ? n : NaN;
}

/** Returns a list of structural problems (empty === structurally valid). */
function structuralCheck(intent: OnchainIntent): string[] {
  const problems: string[] = [];

  if (!intent.id || typeof intent.id !== 'string') {
    problems.push('Structural: missing intent id.');
  }
  if (intent.action !== 'transfer' && intent.action !== 'contractCall') {
    problems.push(`Structural: unknown action "${String(intent.action)}".`);
  }
  if (!intent.chain || !KNOWN_CHAINS.has(intent.chain)) {
    problems.push(`Structural: unknown/unsupported chain "${String(intent.chain)}".`);
  }
  if (!isValidAddress(intent.to)) {
    problems.push(`Structural: "to" is not a valid EVM address ("${String(intent.to)}").`);
  }
  if (!intent.rationale || typeof intent.rationale !== 'string') {
    problems.push('Structural: missing rationale (agent must state why).');
  }

  // Transfers must carry a positive, finite amount.
  if (intent.action === 'transfer') {
    const amt = toNumber(intent.amount);
    if (amt === undefined) {
      problems.push('Structural: transfer is missing an amount.');
    } else if (Number.isNaN(amt)) {
      problems.push(`Structural: amount is not a number ("${String(intent.amount)}").`);
    } else if (amt <= 0) {
      problems.push(`Structural: amount must be positive (got ${amt}).`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// (b) Safety rules (deterministic policy)
// ---------------------------------------------------------------------------

/** Returns a list of safety violations (empty === passes safety policy). */
function safetyCheck(intent: OnchainIntent): string[] {
  const problems: string[] = [];

  // Zero / burn address.
  if (typeof intent.to === 'string' && intent.to.toLowerCase() === ZERO_ADDRESS) {
    problems.push('Safety: destination is the zero address (funds would be burned).');
  }

  // Absurdly large amount.
  const amt = toNumber(intent.amount);
  if (amt !== undefined && !Number.isNaN(amt) && amt > AMOUNT_CAP) {
    problems.push(
      `Safety: amount ${amt} exceeds cap ${AMOUNT_CAP} (possible fat-finger or exploit).`,
    );
  }

  // Denylist (address or token).
  if (typeof intent.to === 'string' && DENYLIST.has(intent.to.toLowerCase())) {
    problems.push(`Safety: destination "${intent.to}" is on the denylist.`);
  }
  if (intent.token && DENYLIST.has(intent.token.toUpperCase())) {
    problems.push(`Safety: token "${intent.token}" is on the denylist.`);
  }

  // Malformed params for contract calls.
  if (intent.action === 'contractCall') {
    if (intent.params === undefined || intent.params === null) {
      problems.push('Safety: contractCall has no params object.');
    } else if (typeof intent.params !== 'object' || Array.isArray(intent.params)) {
      problems.push('Safety: contractCall params are malformed (expected an object).');
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// (c) LLM sanity check
// ---------------------------------------------------------------------------

interface LlmResult {
  available: boolean;
  safe: boolean;
  reason: string;
}

/**
 * Extract the first JSON object from a possibly-noisy LLM string.
 * Handles code fences and leading/trailing prose.
 */
function extractJson(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Ask a free LLM whether the intent's action matches its rationale and looks
 * non-anomalous. Fails soft: on ANY error, returns { available: false } so the
 * deterministic gate still governs the decision.
 */
async function llmSanityCheck(intent: OnchainIntent): Promise<LlmResult> {
  const system =
    'You are a security reviewer for on-chain transactions. You judge whether a ' +
    "proposed blockchain action is consistent with the agent's stated rationale and " +
    'whether it looks anomalous or dangerous. Respond ONLY with strict minified JSON ' +
    'of the form {"safe": boolean, "reason": string}. No prose, no code fences.';

  const user =
    'Evaluate this proposed on-chain intent. Does the ACTION match the RATIONALE, ' +
    'and does it look safe / non-anomalous?\n\n' +
    JSON.stringify(
      {
        action: intent.action,
        chain: intent.chain,
        to: intent.to,
        amount: intent.amount,
        token: intent.token,
        params: intent.params,
        rationale: intent.rationale,
      },
      null,
      2,
    );

  // Pollinations' free tier rate-limits bursts (HTTP 429). Retry a few times
  // with backoff so a transient limit doesn't silently disable the check.
  const MAX_ATTEMPTS = 4;
  let lastReason = 'LLM unavailable';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const res = await fetch(LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // Ask for JSON when the backend honors it; harmless otherwise.
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Retryable server-side conditions.
      if (res.status === 429 || res.status >= 500) {
        lastReason = `LLM HTTP ${res.status}`;
        await backoff(attempt);
        continue;
      }

      if (!res.ok) {
        return { available: false, safe: true, reason: `LLM HTTP ${res.status}` };
      }

      const data: any = await res.json();
      const content: string =
        data?.choices?.[0]?.message?.content ??
        (typeof data === 'string' ? data : '');

      const parsed = extractJson(content) as
        | { safe?: unknown; reason?: unknown }
        | undefined;

      if (!parsed || typeof parsed.safe !== 'boolean') {
        lastReason = 'LLM returned unparseable output';
        await backoff(attempt);
        continue;
      }

      return {
        available: true,
        safe: parsed.safe,
        reason:
          typeof parsed.reason === 'string' && parsed.reason
            ? parsed.reason
            : '(no reason given)',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastReason = `LLM unavailable: ${msg}`;
      await backoff(attempt);
    }
  }

  return { available: false, safe: true, reason: lastReason };
}

/** Exponential-ish backoff between retry attempts (skips the wait on the last try). */
async function backoff(attempt: number): Promise<void> {
  const waitMs = Math.min(2000 * attempt, 8000);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

// ---------------------------------------------------------------------------
// Combine everything into a Verdict
// ---------------------------------------------------------------------------

/**
 * Run the full three-layer verification gate on an intent.
 *
 * Decision rule:
 *   - Any structural OR safety problem  => BLOCK.
 *   - LLM explicitly says unsafe        => BLOCK.
 *   - Otherwise                         => PASS.
 *
 * Confidence:
 *   - Deterministic BLOCK  => 1.0 (we are certain it is malformed/dangerous).
 *   - LLM-only BLOCK       => 0.75 (probabilistic judgement).
 *   - PASS with LLM agree  => 0.95.
 *   - PASS, LLM unavailable=> 0.6  (deterministic checks passed but no second opinion).
 */
export async function verifyIntent(intent: OnchainIntent): Promise<Verdict> {
  const reasons: string[] = [];

  const structural = structuralCheck(intent);
  const safety = safetyCheck(intent);
  reasons.push(...structural, ...safety);

  const deterministicFail = structural.length > 0 || safety.length > 0;

  // Always consult the LLM for the second opinion (even on structural fails it's
  // cheap context), but its verdict only *adds* BLOCK reasons — it never rescues
  // a deterministic failure.
  const llm = await llmSanityCheck(intent);

  if (llm.available) {
    if (llm.safe) {
      reasons.push(`LLM: action is consistent with rationale — ${llm.reason}`);
    } else {
      reasons.push(`LLM: flagged as unsafe/anomalous — ${llm.reason}`);
    }
  } else {
    reasons.push(`LLM: unavailable (deterministic checks still enforced) — ${llm.reason}`);
  }

  const llmBlock = llm.available && !llm.safe;
  const decision = deterministicFail || llmBlock ? 'BLOCK' : 'PASS';

  let confidence: number;
  if (decision === 'BLOCK') {
    confidence = deterministicFail ? 1.0 : 0.75;
  } else {
    confidence = llm.available ? 0.95 : 0.6;
  }

  return { decision, confidence, reasons };
}
