/**
 * VEA ASP server — the callable service layer.
 *
 * VEA is a NON-CUSTODIAL verification service for autonomous agents. Other agents
 * call it BEFORE they touch the chain; VEA returns allow/deny plus a cryptographically
 * signed receipt. It never holds keys and never executes — the calling agent executes
 * with its own keys, then optionally calls back to /attest so deviations become a
 * permanent, signed record. Verify → execute → attest.
 *
 * ~250 lines of HTTP over the existing verification core. No web framework (deps: undici
 * only) — node:http keeps the surface tiny and auditable.
 *
 *   npm run serve      # start on :8402  (8402 = x402 payment theme)
 */
import { createServer, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { verifyIntent } from './verificationGate.js';
import {
  attestVerdict,
  attestExecution,
  verifyAttestation,
  readAttestations,
  logAttestation,
  attestorPublicKey,
} from './attestation.js';
import { logEntry, readLedger } from './ledger.js';
import type { OnchainIntent, Verdict } from './types.js';

const PORT = Number(process.env.PORT ?? 8402);

/**
 * x402 payment terms — REAL chain/token/recipient (X Layer mainnet).
 * Values verified against OKX's own token list (okx/xlayer-tokenlist, chainId 196),
 * not copied second-hand: USDC 0x74b7…6d22, 6 decimals.
 */
const X402 = {
  version: 2,
  network: 'eip155:196',                                          // CAIP-2: X Layer mainnet
  asset: '0x74b7F16337b8972027F6196A17a631aC6dE26d22',            // USDC on X Layer
  assetName: 'USD Coin',
  assetVersion: '2',                                              // EIP-712 domain version (EIP-3009)
  decimals: 6,
  amount: '1000',                                                 // atomic units = 0.001 USDC
  payTo: process.env.VEA_PAY_TO ?? '0xda9fa90cd39039af4a854e0bd7e3510e6a3ac960',
  maxTimeoutSeconds: 60,
  resource: process.env.VEA_RESOURCE ?? 'https://verified-execution-agent.onrender.com/verify',
};

const PRICE = {
  model: 'per-call' as const,
  price: '0.001 USDC',
  asset: 'USDC',
  network: 'X Layer (eip155:196)',
  settlement: 'on-chain (x402 exact / EIP-3009)' as const,
  note: 'x402 challenge is emitted per spec in the PAYMENT-REQUIRED header (base64 JSON).',
};

/**
 * Build the x402 challenge exactly as the spec (and OKX listing review) requires:
 *   {x402Version, resource, accepts:[{scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra}]}
 * It is emitted base64-encoded in the PAYMENT-REQUIRED header AND in the body, so both
 * v2 (header) and body-reading clients can obtain the payment requirements.
 */
function x402Challenge() {
  return {
    x402Version: X402.version,
    resource: X402.resource,
    accepts: [
      {
        scheme: 'exact',
        network: X402.network,
        asset: X402.asset,
        amount: X402.amount,
        payTo: X402.payTo,
        maxTimeoutSeconds: X402.maxTimeoutSeconds,
        description: 'Pre-flight verification of one on-chain intent (allow/deny + signed receipt).',
        mimeType: 'application/json',
        extra: { name: X402.assetName, version: X402.assetVersion, decimals: X402.decimals },
      },
    ],
  };
}

function challengeHeader() {
  return Buffer.from(JSON.stringify(x402Challenge()), 'utf8').toString('base64');
}

const MANIFEST = {
  service: 'VEA — Verified Execution Agent',
  kind: 'Agentic Service Provider (ASP)',
  summary:
    'Non-custodial pre-flight firewall for agent transactions. Call before you touch the chain: allow/deny + a signed receipt.',
  model: 'Verify → execute (caller, own keys) → attest',
  endpoints: {
    'POST /verify': 'Verify an intent. Returns decision + signed receipt. (pay-per-call)',
    'POST /attest': 'Post-execution: submit what actually happened; get a deviation receipt.',
    'GET /receipts/:intentId': 'Fetch a receipt and live re-verify its signature.',
    'POST /receipts/verify': 'Verify ANY receipt you hold — do not trust us, check the signature.',
    'GET /ledger?limit=50': 'Public append-only audit feed + aggregates.',
    'GET /health': 'Liveness + attestor public key.',
  },
  pricing: PRICE,
  attestorPubKey: attestorPublicKey(),
  honesty: {
    real: ['4-layer verification gate', 'ABI calldata decoding', 'Ed25519 signed receipts', 'deviation detection'],
    simulated: ['payment settlement (402 handshake shape is real)'],
    outOfScope: ['on-chain execution — VEA is non-custodial by design'],
  },
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * x402-style pay-per-call check. No X-Payment header → 402 challenge (caller then
 * retries with proof). Any `X-Payment: sim:<nonce>` is accepted (settlement simulated).
 * The shape is the real x402 agent-payment handshake; only settlement is stubbed — stated plainly.
 */
function checkPayment(req: IncomingMessage): { ok: true; ref: string } | { ok: false; challenge: unknown } {
  const pay = req.headers['x-payment'];
  // Three-state protocol (real x402 shape): valid proof → charge; malformed proof → reject;
  // no proof → challenge. Only settlement is simulated — the handshake states are real.
  if (typeof pay === 'string' && /^sim:[\w-]{4,}$/.test(pay)) {
    return { ok: true, ref: pay };
  }
  if (typeof pay === 'string' && pay.length > 0) {
    return {
      ok: false,
      challenge: {
        error: 'invalid payment proof',
        status: 402,
        reason: 'malformed X-Payment (expected  sim:<nonce>  where nonce is 4+ [A-Za-z0-9_-])',
        accepts: [{ scheme: 'x402-sim', ...PRICE, payTo: 'vea-treasury.sim' }],
      },
    };
  }
  return {
    ok: false,
    challenge: {
      error: 'payment required',
      status: 402,
      ...x402Challenge(),
      how: 'Read the PAYMENT-REQUIRED header (base64 JSON) or the accepts[] above, pay per x402, retry with X-PAYMENT.',
    },
  };
}

async function handleVerify(body: any, payRef: string) {
  if (!body || typeof body.intent !== 'object') {
    throw new Error('missing "intent" object');
  }
  const intent: OnchainIntent = { id: body.intent.id ?? `vea-${randomUUID()}`, ...body.intent };
  const verdict: Verdict = await verifyIntent(intent); // core, unchanged
  const receipt = logAttestation(attestVerdict(intent, verdict));
  logEntry(intent, verdict, false);
  return {
    intentId: intent.id,
    decision: verdict.decision,
    confidence: verdict.confidence,
    reasons: verdict.reasons,
    receipt,
    verify: {
      how: 'POST /receipts/verify with this receipt, or verify the Ed25519 signature offline',
      attestorPubKey: attestorPublicKey(),
    },
    billing: { ...PRICE, charged: true, paymentRef: payRef },
  };
}

async function handleAttest(body: any) {
  if (!body || typeof body.intent !== 'object' || typeof body.execution !== 'object') {
    throw new Error('need { intent, execution }');
  }
  const intent: OnchainIntent = body.intent;
  const gateVerdict: Verdict = await verifyIntent(intent);
  const receipt = logAttestation(
    attestExecution({ intent, gateVerdict, executed: true, execution: body.execution }),
  );
  logEntry(intent, gateVerdict, true, body.execution);
  return {
    intentId: intent.id,
    verdict: receipt.verdict, // EXECUTED_AS_INTENDED | DEVIATION_DETECTED
    deviations: receipt.match.deviations,
    receipt,
    signatureValid: verifyAttestation(receipt),
  };
}

const server = createServer(async (req, res) => {
  const send = (code: number, obj: unknown) => {
    const payload = JSON.stringify(obj, null, 2);
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    // x402: a 402 MUST carry the challenge in the PAYMENT-REQUIRED header (base64 JSON),
    // otherwise the caller cannot learn asset / amount / payTo. (OKX listing review, 25.07.)
    if (code === 402) headers['PAYMENT-REQUIRED'] = challengeHeader();
    res.writeHead(code, headers);
    res.end(payload);
  };
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // --- GET routes ---
    if (req.method === 'GET' && path === '/') return send(200, MANIFEST);
    if (req.method === 'GET' && path === '/health')
      return send(200, { ok: true, service: 'VEA', attestor: attestorPublicKey(), version: '0.2.0' });
    if (req.method === 'GET' && path === '/ledger') {
      const all = readLedger();
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const blocked = all.filter((e) => e.verdict.decision === 'BLOCK').length;
      return send(200, {
        total: all.length,
        verified: all.length,
        blocked,
        passed: all.length - blocked,
        revenueSimulated: `${(all.length * 0.001).toFixed(3)} USDC`,
        entries: all.slice(-limit),
      });
    }
    if (req.method === 'GET' && path.startsWith('/receipts/')) {
      const id = decodeURIComponent(path.split('/')[2] ?? '');
      const att = readAttestations().find((a) => a.intentId === id);
      return att
        ? send(200, { receipt: att, signatureValid: verifyAttestation(att) })
        : send(404, { error: `no receipt for intentId ${id}` });
    }

    // --- POST routes ---
    if (req.method === 'POST') {
      const raw = await readBody(req);
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: 'invalid JSON body' });
      }
      if (path === '/verify') {
        const pay = checkPayment(req);
        if (!pay.ok) return send(402, pay.challenge);
        return send(200, await handleVerify(body, pay.ref));
      }
      if (path === '/attest') return send(200, await handleAttest(body));
      if (path === '/receipts/verify') {
        // body IS a receipt (Attestation)
        return send(200, { valid: verifyAttestation(body), attestorPubKey: attestorPublicKey() });
      }
    }

    send(404, { error: 'unknown endpoint', see: 'GET / for the service manifest' });
  } catch (e) {
    send(400, { error: String(e instanceof Error ? e.message : e) });
  }
});

server.listen(PORT, () => {
  console.log(`VEA ASP listening on :${PORT}  (verify → execute → attest, non-custodial)`);
  console.log(`  manifest:  GET  http://localhost:${PORT}/`);
  console.log(`  verify:    POST http://localhost:${PORT}/verify   (pay-per-call, x402-sim)`);
});
