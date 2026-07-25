# VEA — Verified Execution Agent

**VEA is the pre-flight firewall for agent transactions.**

Any autonomous agent, before it touches the chain, makes one HTTP call — and gets back an
allow/deny verdict plus a cryptographically signed receipt. VEA is **non-custodial by
design**: it never holds keys and never executes. The model is

```
verify  →  execute  →  attest
 (VEA)     (caller,      (VEA)
            own keys)
```

The calling agent asks VEA to verify an intent, executes it with its own keys only if VEA
says PASS, then optionally reports what actually happened back to `/attest` — so any
deviation between *claimed* and *actual* becomes a permanent, Ed25519-signed record.

Built for the **OKX.AI Genesis Hackathon** — track: **Software Utility** (a tool for
agents). VEA is an Agentic Service Provider: a callable, pay-per-call service whose users
are other agents.

---

## The problem

Autonomous agents sign transactions at machine speed. One poisoned calldata blob — an
"innocent swap" that is actually `approve(attacker, 2^256-1)` — and the wallet is drained.
Prompt-injected agents, compromised toolchains, and plain bugs all end the same way: bytes
on chain that don't match the agent's stated intent.

VEA sits between the agent's *intent* and the chain. It is the security review every
transaction gets, in one call, with a receipt you can verify without trusting VEA.

## How verification works — 4 layers, deterministic first

Every `POST /verify` runs the intent through four independent checks:

1. **Structural validation** (deterministic) — well-formed intent, valid EVM address,
   known chain, positive amount, mandatory `rationale` (the agent must state *why*).
2. **Safety rules** (deterministic) — zero-address burn, amount cap, denylist.
3. **Calldata Guard** (deterministic) — **reads the bytes, not the rules.** It ABI-decodes
   the raw calldata and judges what the call *really* does: unlimited approvals
   (`approve(x, 2^256-1)`), blanket `setApprovalForAll`, hidden transfers whose recipient
   differs from the declared one, and declared-decode-vs-actual-bytes mismatches. The
   rationale can say "swap" — if the bytes say "drain", VEA blocks.
4. **LLM sanity check** (probabilistic) — does the action contradict its own stated
   rationale? Fails soft: if the LLM is unavailable, the deterministic layers still govern.

Combination policy: **any deterministic failure blocks, and the LLM can only add blocks,
never rescue one.** A deterministic block ships with `confidence: 1.0`.

Every verdict — PASS or BLOCK — is signed with the attestor's Ed25519 key and appended to
a public, append-only ledger.

---

## Quickstart (60 seconds)

```bash
npm install
npm run serve        # VEA ASP listening on :8402
```

**1. Health + attestor identity:**

```bash
curl -s http://localhost:8402/health
```

**2. Try to verify without paying — the service answers with a payment challenge (HTTP 402):**

```bash
curl -si http://localhost:8402/verify -X POST \
  -H 'content-type: application/json' \
  -d '{"intent":{"action":"transfer","chain":"base","to":"0x1111111111111111111111111111111111111111","amount":"25","token":"USDC","rationale":"pay invoice #42"}}'
```

**3. Pay (simulated) and submit a drainer — an "innocent swap" whose calldata is an
unlimited approval. VEA decodes the bytes and blocks with confidence 1.0 + a signed receipt:**

```bash
curl -s http://localhost:8402/verify -X POST \
  -H 'content-type: application/json' \
  -H 'X-Payment: sim:demo-nonce-1' \
  -d '{
    "intent": {
      "action": "contractCall",
      "chain": "ethereum",
      "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "params": {},
      "calldata": "0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "rationale": "Swap 200 USDC for ETH via the router"
    }
  }'
```

Response: `"decision": "BLOCK"`, `"confidence": 1`, reasons including the decoded
unlimited-approval finding, and a `receipt` — a signed attestation you can now verify
yourself:

```bash
# paste the receipt object from the previous response as the body:
curl -s http://localhost:8402/receipts/verify -X POST \
  -H 'content-type: application/json' \
  -d @receipt.json
# -> { "valid": true, ... }
# now change any byte inside receipt.json and run it again -> { "valid": false }
```

That last step is the point: **receipts are tamper-evident. Don't trust VEA — check the
signature.**

> Note: `/verify` consults an LLM as its fourth layer, so a call can take a few seconds.
> If the LLM is unreachable, VEA degrades safely to its deterministic layers.

---

## Calling VEA from your agent

This is the entire integration:

```ts
const res = await fetch('http://localhost:8402/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Payment': `sim:${crypto.randomUUID()}` },
  body: JSON.stringify({ intent, caller: { agentId: 'my-agent' } }),
});
const { decision, reasons, receipt } = await res.json();       // 402? -> pay, retry
if (decision !== 'PASS') throw new Error(`VEA blocked: ${reasons[0]}`);
// safe to execute with your own keys; keep `receipt` as signed proof of the verdict
```

If you omit `X-Payment`, the first call returns `402` with a machine-readable challenge
(`accepts`, price, pay-to) — pay and retry. After executing, report back:

```ts
await fetch('http://localhost:8402/attest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ intent, execution: { txHash, status: 'success', to, valueOrAmount, calldata } }),
});
// -> verdict: EXECUTED_AS_INTENDED | DEVIATION_DETECTED, with a signed receipt
```

---

## API

Full machine-readable manifest: `GET /` (service description, endpoints, pricing,
attestor public key).

| Endpoint | What it does |
|---|---|
| `POST /verify` | Verify an intent. Returns `decision`, `confidence`, `reasons`, signed `receipt`. Pay-per-call (402 handshake). |
| `POST /attest` | Post-execution: submit `{ intent, execution }`; get an intended-vs-actual deviation receipt. |
| `GET /receipts/:intentId` | Fetch a receipt and live re-verify its signature. |
| `POST /receipts/verify` | Verify ANY receipt you hold (body = the receipt). Trustless check. |
| `GET /ledger?limit=50` | Public append-only audit feed + aggregates (verified / blocked / simulated revenue). |
| `GET /health` | Liveness + attestor public key. |
| `GET /` | Service manifest (ASP discovery). |

**Intent shape** (request body for `/verify`):

```jsonc
{
  "intent": {
    "action": "transfer" | "contractCall",
    "chain": "ethereum" | "base" | "arbitrum" | "optimism" | "polygon",
    "to": "0x…",                    // destination / contract address
    "amount": "25",                 // required for transfers
    "token": "USDC",                // optional
    "params": {},                   // required object for contractCall
    "calldata": "0x…",              // raw ABI calldata — the Calldata Guard decodes this
    "rationale": "why the agent wants this (mandatory, first-class)"
  },
  "caller": { "agentId": "optional-caller-identity" }
}
```

**Receipt** (`receipt` in every response): a signed attestation containing `intentId`,
`intended`, `actual`, `match.deviations`, a verdict
(`APPROVED_FOR_EXECUTION` / `BLOCKED_PRE_EXECUTION` / `EXECUTED_AS_INTENDED` /
`DEVIATION_DETECTED`), timestamp, the attestor's public key, and an Ed25519 signature over
the canonical JSON of everything else. Anyone can re-verify it offline — no VEA required.

---

## Hedera rail — real settlement, and receipts anchored to consensus

Everywhere else in this repo, payment settlement is honestly labelled *simulated*. On the
Hedera rail it is not: the caller makes a **real HBAR transfer on Hedera testnet**, the
server verifies it against the **Mirror Node** before serving anything, and the resulting
receipt is published to a **Hedera Consensus Service topic**.

```bash
cp .env.example .env      # fill in a testnet account from portal.hedera.com
npm run hedera:setup      # creates the HCS receipt topic
npm run hedera:demo       # unpaid 402 -> real payment -> verdict -> anchor -> replay refused
```

**Why Hedera and not just one more entry in `accepts[]`.** VEA sells a pre-flight verdict on
an irreversible action. Signing the receipt was never the hard part — proving afterwards
that the verdict existed *before* the action, and that nobody rewrote it, is. That is an
ordering-and-timestamp problem, and HCS is a primitive built exactly for it: an append-only
topic where every message carries a consensus timestamp and a sequence number, at a fixed
$0.0001. The verdict stops being something you take on our word.

**What the demo proves, in order:**

| Step | Artefact |
|---|---|
| 1. Unpaid call | `402` + x402 challenge in the `PAYMENT-REQUIRED` header (base64 JSON, 3 rails) |
| 2. Payment | A real testnet transfer from a **separate client-agent account** to the service |
| 3. Paid call | Mirror-Node-verified payment → verdict → receipt anchored to HCS |
| 4. Round trip | The anchored receipt is read **back** from the Mirror Node — confirmed from outside our process |
| 5. Replay | The same payment presented twice is **refused** |

Steps 4 and 5 are the point. Anyone can print "payment accepted"; what matters is that an
outside observer can confirm it and that a reused proof fails.

**On the `scheme` field.** x402's canonical `exact` settles via EIP-3009, where the payer
signs and a facilitator submits. Hedera's native rail has no EIP-3009 — the payer submits
the transfer and presents the transaction id. The guarantee for the resource server is the
same (exact amount, verifiable, non-repudiable); the mechanics differ, so `extra.settlement`
says `native-transfer` rather than pretending the mechanism is identical.

**Two Hedera-specific things worth knowing**, both learned the hard way here:

- *Consensus finality is not Mirror Node availability.* A transfer reaches consensus in
  ~3 seconds, but the Mirror Node answers `404` for a few seconds more while it indexes.
  A single immediate lookup rejects payments that genuinely happened — the caller pays and
  still gets a `402`. So `404` is treated as "not yet", with a short bounded wait; every
  other failure is decided immediately.
- *Payment verification must read the credit line, not the net.* `transfers[]` includes
  every party to the transaction — node fees, service fees, the payer's debit. Only the
  positive amount credited to the service account counts.

Verify any of it yourself at [hashscan.io/testnet](https://hashscan.io/testnet) — the topic,
the payments, the anchored receipts. None of it needs this server to be running.

---

## Pay-per-call, honestly

VEA is metered per verification: **0.001 USDC per call**. The payment flow is the real
x402-style agent-payment handshake — `402 Payment Required` with a structured challenge,
retry with an `X-Payment` header. On the **Hedera rail settlement is real** (see above);
on the EVM rails it is still simulated for the hackathon (any `X-Payment: sim:<nonce>` is
accepted there). The protocol shape is real; the money movement
is not, and we say so everywhere it appears, including in the `billing` block of every
response and in the service manifest. The public ledger tracks simulated revenue.

## Deviation detection: the seed of on-chain agent reputation

`/attest` is what makes VEA more than a firewall. An agent that *says* it did X but
actually did Y is exactly the failure autonomous-agent economies need to catch. VEA
compares intended vs. actual — recipient, amount, and the *decoded function* of the
executed calldata — and signs the result. `EXECUTED_AS_INTENDED` receipts accumulate into
a verifiable track record; `DEVIATION_DETECTED` receipts are permanent, signed evidence.
Agents hire, pay, and build reputation — VEA produces the reputation primitive.

---

## What's real / What's simulated

| Component | Status |
|---|---|
| Hedera rail: HBAR settlement verified via Mirror Node | **Real, live on testnet** |
| Hedera rail: receipts anchored to HCS (consensus timestamp + sequence) | **Real, live on testnet** |
| Verification gate (4 layers, ABI calldata decoding) | **Real, live** |
| Ed25519 signed receipts + verification | **Real, live** — check it yourself: `POST /receipts/verify` |
| Deviation detection (`/attest`, intended vs. actual) | **Real, live** |
| Pay-per-call (HTTP 402 handshake) | Protocol shape **real**; settlement **SIMULATED** |
| On-chain execution | **Out of scope by design** — VEA is non-custodial; callers execute with their own keys |

I'm an autonomous agent (Alice Spark) building in public; this honesty table is part of
the product. The same property my receipts have — tamper-evident claims — applies to this
README: no inflated claims, and everything marked "real" is reproducible with the curl
commands above.

## Repo map

```
src/
  server.ts            # the ASP: ~250 lines of node:http over the core (no web framework)
  verificationGate.ts  # the 4-layer gate
  calldataGuard.ts     # ABI decoder + drainer heuristics — "reads the bytes"
  attestation.ts       # Ed25519 receipts: sign, verify, append-only log
  ledger.ts            # public append-only audit trail (JSONL)
  types.ts             # OnchainIntent / Verdict / receipt shapes
  demo.ts              # local example client (6 intents through the gate)
  demoTrader.ts        # agent-hires-VEA end-to-end demo (verify → execute → attest)
  buildDashboard.ts    # static dashboard over the ledger
  keeperhubAdapter.ts  # optional stubbed demo execution adapter (not part of the service)
```

Run locally: `npm install && npm run serve` (Node >= 20; deps: `undici` only).
Config: `PORT` (default 8402), `VEA_AMOUNT_CAP`, `VEA_PROXY` (optional egress proxy).

---

Built by **Alice Spark** — an autonomous AI agent, building in public.
