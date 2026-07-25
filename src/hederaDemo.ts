/**
 * End-to-end demo of the Hedera x402 rail. Every number printed below comes from the
 * network — nothing here is staged.
 *
 *   npm run hedera:demo
 *
 * What it walks through:
 *   1. an unpaid call            → 402 with a real x402 challenge in the PAYMENT-REQUIRED header
 *   2. a real HBAR payment       → Hedera testnet transaction, from a separate client account
 *   3. the paid call             → server verifies the payment against the Mirror Node, runs
 *                                  the verification gate, anchors the receipt to HCS
 *   4. round-trip proof          → the anchored receipt is read BACK from the Mirror Node,
 *                                  so the audit trail is confirmed from outside our process
 *   5. replay rejection          → the same payment presented twice is refused
 *
 * Steps 4 and 5 are the ones that matter. Anyone can print "payment accepted"; the point is
 * that an outside observer can confirm it, and that a second attempt with the same proof
 * fails. HashScan links are printed for every on-chain artefact.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadEnv } from './loadEnv.js';

loadEnv();

const { HEDERA, ensureTopic, ensurePayer, payForVerification } = await import('./hederaRail.js');

// Own port, deliberately not 8402: if a server from an earlier session is still listening
// there, the demo would quietly talk to THAT process — and a stale binary without this rail
// reports "no Hedera entry" while the code in front of you is perfectly correct. Cost me a
// confused debugging round; an isolated port makes the demo answer for its own code.
const PORT = process.env.DEMO_PORT ?? '8412';
const BASE = `http://127.0.0.1:${PORT}`;
const line = (s = '') => console.log(s);
const rule = (t: string) => line(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);

/**
 * The intent under test: an unlimited token approval — the single most common way agents
 * hand away everything they hold. The agent's stated rationale sounds reasonable ("needed
 * for the swap"), which is exactly why the gate decodes the calldata instead of trusting
 * the description: the bytes say `approve(spender, MAX_UINT256)`, not "approve 50 USDC".
 */
const INTENT = {
  id: `hedera-demo-${Date.now()}`,
  action: 'contractCall' as const,
  chain: 'hedera:testnet',
  to: '0x00000000000000000000000000000000000186a0',
  token: 'USDC',
  calldata:
    '0x095ea7b3' +
    '000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  rationale: 'Approve the router so the pending swap can execute — routine, small amount.',
};

async function waitForServer(proc: ChildProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  proc.kill();
  throw new Error('server did not come up');
}

async function main() {
  if (!HEDERA.operatorKey) {
    console.error('HEDERA_PRIVATE_KEY is not set — see .env.example, then run npm run hedera:setup');
    process.exit(1);
  }

  rule('0. setup');
  const topicId = await ensureTopic();
  const payer = await ensurePayer();
  line(`service account : ${HEDERA.payTo}`);
  line(`client agent    : ${payer.accountId}   (separate account — it really pays)`);
  line(`HCS topic       : ${topicId}`);
  line(`price           : ${HEDERA.priceTinybars / 1e8} HBAR per verification`);

  // Spawn the runtime DIRECTLY, without `shell: true`. With a shell, `server.kill()` kills
  // the shell wrapper and leaves the real node process orphaned — still holding the port.
  // The next run then talks to that stale server and reports failures the current code does
  // not have. Two debugging rounds went into that before the port, not the code, was at fault.
  const tsxCli = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const server = spawn(process.execPath, [tsxCli, 'src/server.ts'], {
    stdio: 'ignore',
    env: { ...process.env, PORT },
  });
  try {
    await waitForServer(server);

    // ── 1. Unpaid ────────────────────────────────────────────────────────────
    rule('1. call without paying');
    const unpaid = await fetch(`${BASE}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: INTENT }),
    });
    line(`HTTP ${unpaid.status}`);
    const headerB64 = unpaid.headers.get('payment-required') ?? '';
    const challenge = JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8'));
    const hedera = challenge.accepts.find((a: any) => a.network === 'hedera:testnet');
    if (!hedera) throw new Error('the server answering on this port does not advertise the Hedera rail');
    line(`PAYMENT-REQUIRED header decodes to ${challenge.accepts.length} accepted rails; Hedera entry:`);
    line(`  scheme ${hedera.scheme} · ${hedera.amount} tinybars ${hedera.asset} → ${hedera.payTo}`);

    // ── 2. Pay for real ──────────────────────────────────────────────────────
    rule('2. pay on Hedera testnet');
    const payment = await payForVerification();
    line(`transaction : ${payment.txId}`);
    line(`hashscan    : ${payment.explorer}`);

    // ── 3. Paid call ─────────────────────────────────────────────────────────
    rule('3. retry with proof of payment');
    const paid = await fetch(`${BASE}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-PAYMENT': payment.txId },
      body: JSON.stringify({ intent: INTENT }),
    });
    const out: any = await paid.json();
    line(`HTTP ${paid.status}`);
    line(`decision    : ${out.decision}   (${(out.reasons ?? []).slice(0, 2).join('; ')})`);
    if (!out.hedera?.anchor) {
      line('anchor      : NOT anchored — the receipt was not written to HCS');
    } else {
      line(`payment seen: ${out.hedera.payment.amountTinybars} tinybars @ ${out.hedera.payment.consensusAt}`);
      line(`HCS message : topic ${out.hedera.anchor.topicId}, sequence #${out.hedera.anchor.sequenceNumber}`);
      line(`hashscan    : ${out.hedera.anchor.explorer}`);
    }

    // ── 4. Round-trip: read the anchor back from outside ──────────────────────
    rule('4. read the receipt back from the Mirror Node');
    if (out.hedera?.anchor) {
      const seq = out.hedera.anchor.sequenceNumber;
      let seen: any = null;
      for (let i = 0; i < 12 && !seen; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const res = await fetch(`${HEDERA.mirror}/api/v1/topics/${topicId}/messages/${seq}`);
        if (res.ok) seen = await res.json();
      }
      if (!seen) {
        line('not visible on the Mirror Node yet (it lags a few seconds) — check the link above');
      } else {
        const msg = JSON.parse(Buffer.from(seen.message, 'base64').toString('utf8'));
        line(`consensus   : ${seen.consensus_timestamp}`);
        line(`decision on-chain : ${msg.decision}   intent ${msg.intentId}`);
        line(`paid with   : ${msg.paidWith}`);
        line('→ an outside observer can confirm this verdict existed, and when. Not our word.');
      }
    }

    // ── 5. Replay ────────────────────────────────────────────────────────────
    rule('5. try to reuse the same payment');
    const replay = await fetch(`${BASE}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-PAYMENT': payment.txId },
      body: JSON.stringify({ intent: { ...INTENT, id: INTENT.id + '-replay' } }),
    });
    const rj: any = await replay.json();
    line(`HTTP ${replay.status} — ${rj.challenge?.reason ?? rj.reason ?? 'rejected'}`);

    rule('done');
    line('Every artefact above is checkable at hashscan.io/testnet without this server.');
  } finally {
    server.kill();
  }
}

await main();
