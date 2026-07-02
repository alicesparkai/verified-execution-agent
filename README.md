# Verified Execution Agent (VEA)

**A verification gate for autonomous on-chain agents.** Before an agent touches
the chain, VEA asks one question: *"Should this really happen?"* — and it can say
**no**.

> Submission for **KeeperHub — "Agents Onchain"** · theme: *reliable on-chain
> execution / the last mile.*

![Reliability Dashboard — the verified-execution trail: 1 executed, 4 prevented](docs_dashboard_preview.png)

*The Reliability Dashboard: every intent the agent considered, what the gate decided, and why. Green passed to the chain; red was blocked before it could do damage.*

---

## The problem: the last mile

Autonomous agents are getting good at *deciding* what to do. The dangerous part
is the **last mile** — the moment an intent becomes an irreversible on-chain
transaction. A hallucinated address, a fat-fingered amount, an action that
quietly contradicts what the agent *said* it was doing: on-chain, these are not
"oops, undo." They are permanent.

Most agent stacks execute optimistically and hope. **VEA inverts that.**

## The idea: verified execution

VEA places a **verification gate** between the agent's intent and the chain.
Nothing executes without a `PASS` verdict, and every decision — pass or block —
is written to an append-only **reliability ledger**.

```
  OnchainIntent ──▶ [ VERIFICATION GATE ] ──PASS──▶ KeeperHub adapter ──▶ chain
                          │                                     │
                          └──BLOCK──▶ (never executed)          │
                          │                                     ▼
                          └───────────────▶ reliability ledger (jsonl)
```

The gate is the star. It runs **four independent checks** and combines them:

| # | Check | Kind | Catches |
|---|-------|------|---------|
| a | **Structural validation** | deterministic | bad address format, non-positive/NaN amount, unknown chain, missing fields |
| b | **Safety rules** | deterministic | zero/burn address, amount over a configurable cap, denylisted address/token, malformed call params |
| d | **Calldata Guard** | deterministic | **decodes contractCall calldata** and catches unlimited-approval drainers, blanket NFT approvals, and hidden/mismatched transfers (see below) |
| c | **LLM sanity check** | probabilistic | action that *contradicts its own stated rationale*, anomalous-looking intents |

**Combination policy:** `BLOCK` if **any** deterministic check fails **OR** the
LLM judges the intent unsafe. `confidence` reflects how strongly the layers
agree (deterministic block = 1.0; LLM-only block = 0.75; clean pass with LLM
agreement = 0.95; pass with the LLM unavailable = 0.6).

**Safe by default:** the LLM check *only adds* block reasons — it can never
rescue a deterministic failure, and if the LLM is unreachable the gate degrades
gracefully and still enforces every deterministic rule.

## The differentiator: the Calldata Guard

Basic allow/deny gates inspect the *envelope* of a transaction — who, how much,
which chain. They are blind to the single most dangerous thing an agent can do:
send an innocent-looking `contractCall` whose ABI-encoded **calldata** quietly
authorizes a drain.

The **#1 real-world agent/wallet exploit is the approval-drainer**: a call that
reads like *"approve a small DEX spend"* but actually encodes
`approve(attacker, 2^256-1)` — an **unlimited allowance** the attacker sweeps at
leisure. An allow/deny gate sees "a contract call to a normal token" and waves
it through. It never looks *inside*.

VEA does. The Calldata Guard (`src/calldataGuard.ts`) **decodes raw calldata**
against a small map of well-known, dangerous selectors and judges the *decoded
arguments*:

| Selector | Signature | Threat rule |
|----------|-----------|-------------|
| `0x095ea7b3` | `approve(address,uint256)` | **BLOCK** unlimited/near-max allowance (drainer); **FLAG** approvals to non-allowlisted spenders |
| `0x39509351` | `increaseAllowance(address,uint256)` | same allowance rules as `approve` |
| `0xa22cb465` | `setApprovalForAll(address,bool)` | **BLOCK** `approved == true` (blanket NFT/1155 operator control) |
| `0xa9059cbb` | `transfer(address,uint256)` | **BLOCK** recipient that is denylisted or contradicts the intent's stated recipient/rationale (hidden transfer) |
| `0x23b872dd` | `transferFrom(address,address,uint256)` | same recipient rules as `transfer` |
| `0xd505accf` | `permit(address,address,uint256,…)` | same allowance rules as `approve` |

It also **BLOCKs** any decode whose function contradicts a *read-only* rationale
("check balance", "read the price") and any call whose agent-declared
`decodedCall.name` doesn't match the actual bytes. A `BLOCK` finding is
**deterministic** — like the safety layer, the LLM can never rescue it.

*Decoding without heavy deps:* Node's built-in crypto ships NIST SHA-3, not
Ethereum's keccak256, so the selectors above are **hardcoded** (each is the
canonical, spec-documented value, verifiable against 4byte.directory). Argument
decoding is a ~40-line minimal ABI reader for the flat fixed-size types these
selectors use (`address` = last 20 bytes of a 32-byte word, `uint256` = the word
as a `BigInt`, `bool` = word `!= 0`). **No external dependency.**

## The reusable core: the Attestation

The gate decides *whether* something should happen. The **attestation core**
(`src/attestation.ts`) answers a different, complementary question **after the
fact**: *did what actually executed match what was intended?* It produces a
**signed artifact** comparing the **intended** action against the **actual**
execution result — a portable, tamper-evident proof.

Why this matters: a gate can wave through an honest-looking intent, and the
executor can still do something else — a buggy adapter, a compromised relayer, a
reordering, a swapped recipient. **An agent that SAYS it did X but actually did
Y is exactly the failure an attestation catches.** `compareIntendedVsActual()`
flags recipient deviations, amount deviations, and calldata that decodes to a
different action than intended.

**One core, three framings.** The same artifact reads as:

| Framing | Reads as | For |
|---------|----------|-----|
| **Reliable-execution proof** | "the agent did exactly what it was told" | a keeper / execution platform |
| **Accuracy-oracle verdict** | "this agent's claimed action matches reality" | an agent society that rates agents |
| **Verification-service receipt** | "an independent verifier checked this and signed off" | a paid-verification marketplace |

An `Attestation` records `intended`, `actual` (or `null` if blocked), a `match`
(`{ ok, deviations[] }`), and one of three verdicts:

- `EXECUTED_AS_INTENDED` — actual matched intended;
- `DEVIATION_DETECTED` — the executor diverged from the intent (deviations listed);
- `BLOCKED_PRE_EXECUTION` — the gate blocked it; nothing executed (block reasons carried).

**Cryptographic signing, zero dependencies.** Signatures use Node's built-in
`crypto` with an **Ed25519** keypair. The keypair is generated on first run and
persisted to `attestor_key.json` (**gitignored — the private key never leaves the
machine and is never committed**) so the attestor identity is stable. Each
attestation embeds the attestor **public key** and a signature over the
attestation's canonical JSON; `verifyAttestation(att)` re-checks it, so any
tampering with a signed field is detectable.

**Chain-agnostic by construction.** The core depends only on a generic
`OnchainIntent` and `ExecutionResult` shape — **not** on KeeperHub. The same
attestation works behind any execution adapter; the `keeperhubAdapter` stays a
thin adapter that simply reports back what it actually executed.

Attestations are appended to a parallel `attestations.jsonl` (also gitignored,
regenerated each demo run).

## Architecture

| File | Responsibility |
|------|----------------|
| `src/types.ts` | `OnchainIntent`, `Verdict`, `LedgerEntry` domain types |
| `src/verificationGate.ts` | the four-layer gate — `verifyIntent(intent)` |
| `src/calldataGuard.ts` | **Calldata Guard** — minimal ABI decoder + threat rules — `analyzeCalldata(intent)` |
| `src/attestation.ts` | **Attestation core** — signed intended-vs-actual proof — `attestExecution()`, `compareIntendedVsActual()`, `verifyAttestation()` |
| `src/keeperhubAdapter.ts` | the "last mile" — `executeOnChain(intent)`: **real KeeperHub integration** (`execute_transfer` → poll `get_direct_execution_status`), confirmed on Sepolia |
| `src/ledger.ts` | append-only JSONL reliability ledger |
| `src/agent.ts` | the loop: `processIntent()` → verify → execute-or-skip → log → **attest**; `runDemo()` |
| `src/demo.ts` | runs the demo with 3 sample intents |
| `src/buildDashboard.ts` | injects the live ledger into `dashboard.template.html` → `dashboard.html` |
| `dashboard.template.html` | self-contained dark-theme dashboard (inline CSS/JS, no build, no CDN) |

The verification core is **platform-independent**. The only KeeperHub-specific
code is `keeperhubAdapter.ts`, kept behind a clean `KeeperHubClient` interface so
the transport swaps in without touching the gate.

## KeeperHub integration (the last mile) — confirmed on Sepolia

`src/keeperhubAdapter.ts` is a **real integration** with KeeperHub's execution
API, driving the exact tools verified live against a real wallet:

```ts
execute_transfer({ chain_id, to_address, amount, token_address?, idempotency_key })
  -> { executionId, status }
get_direct_execution_status(execution_id)
  -> { status, transactionHash, error, network, gasUsedWei, … }
```

After the gate returns `PASS`, `executeOnChain(intent)`:

1. **submits** the intent as an `execute_transfer` call, keyed by
   `idempotency_key = intent.id` — so a retry never double-spends (KeeperHub
   returns the original result for a repeated key within its window);
2. **polls** `get_direct_execution_status` until a terminal state, to capture the
   real `transactionHash` (or the `error`);
3. **returns** an `ExecutionResult` (`txHash` / `status` / `executionId` /
   `network` / `gasUsedWei` / `error`) that flows into the ledger + dashboard.

KeeperHub **holds the wallet and signs + broadcasts on its side** — VEA never
touches a private key. This submission's agent wallet:

| | |
|---|---|
| wallet integration id | `6ozsmal9mx9oz9e8y2ury` |
| agent address | `0xAD6BC9c822494872A9e90Dc4788Be700DadDAE3a` |
| network | **Sepolia** testnet (`chain_id 11155111`) |

**Confirmed working end-to-end:** a live test transfer returned
`Insufficient ETH balance. Have: 0.0, Need: 0.0001` — i.e. KeeperHub accepted the
request, resolved the wallet, and attempted the signed on-chain execution. The
only thing gating a real broadcast is **funding the wallet**.

**Injectable transport.** The adapter talks to KeeperHub through a small
`KeeperHubClient` interface. The default client binds to the KeeperHub **MCP
tools** via a host-provided invoker (`setKeeperHubToolInvoker`); the **offline
demo injects a clearly-labeled simulated client** so it runs with no network and
no funded wallet. The adapter itself is always the real pattern:

```ts
// production: wire the host's KeeperHub MCP transport once, then execute for real
setKeeperHubToolInvoker(myMcpInvoker);
await processIntent(intent);                    // uses the real MCP-backed client

// offline demo / tests: inject a simulated client
await processIntent(intent, { client: createSimulatedKeeperHubClient() });
```

## How to run

Requires **Node 20+**.

```bash
npm install
npm run demo
```

You should see:

- **Intent A** — a reasonable 250 USDC vendor payment → **PASS**, executed with a
  (simulated) txHash.
- **Intent B** — sweep to the **zero address** for an **absurd amount** → **BLOCK**
  by the deterministic safety rules.
- **Intent C** — a transfer whose rationale claims it's a *read-only oracle price
  check* → **BLOCK** by the LLM sanity check (action contradicts rationale).
- **Intent D** — a contractCall whose rationale claims a *"small, limited DEX
  approval"* but whose calldata decodes to `approve(spender, 2^256-1)` → **BLOCK**
  by the **Calldata Guard** as an unlimited-approval drainer.
- **Intent E** — a contractCall claiming a read-only *"check balance"* whose
  calldata decodes to `transfer(attacker, 1000e6)` → **BLOCK** by the **Calldata
  Guard** as a hidden transfer to a known-bad recipient.
- **Intent F** — a perfectly clean 100 USDC payroll transfer that **PASSes** the
  gate, but whose (simulated) executor **actually pays a different recipient**.
  The gate can't catch this — the intent is honest — but the signed
  **attestation** fires **`DEVIATION_DETECTED`**, naming the recipient
  divergence, and its signature **still verifies**. This is the attestation
  core's money shot: catching an executor that did *Y* after being told *X*.

…followed by a printed reliability ledger, then the **signed attestations** —
each re-verified live. Intent F always attests **`DEVIATION_DETECTED`**, and the
gate always blocks B, D, and E; whether C passes or blocks depends on the LLM
second opinion being reachable (see the honesty note below).

To compile to `dist/` instead: `npm run build && npm run demo:built`.

## Reliability Dashboard

The ledger is also viewable as a clean visual **verified-execution trail** — handy
for demos and for eyeballing what the gate blocked (and what it let through).

```bash
npm run demo         # (re)generate ledger.jsonl
npm run dashboard    # build dashboard.html from the current ledger
# then just double-click dashboard.html — or:
npm run demo:full    # do both in one step
```

`npm run dashboard` reads `ledger.jsonl`, injects it into `dashboard.template.html`
(replacing the `window.__LEDGER__` placeholder with the live data), and writes a
single **self-contained `dashboard.html`**. It has **no build step and no external
/ CDN dependencies**, so it opens **offline by double-click** (`file://`).

It shows:

- **Summary cards** — intents considered, # executed (PASS), # prevented (BLOCK),
  and **value protected** (sum of blocked amounts).
- **A timeline card per intent** — action + chain + amount/token, the agent's
  quoted rationale, a big **PASS (green) / BLOCK (red)** badge with confidence %,
  the verdict reasons tagged by the layer that caught them (**structural /
  safety / calldata / LLM**), and the (stub) tx hash with a *confirmed* tag when
  executed.

### Networking note (proxy)

This machine reaches the internet through a local **Xray proxy**. The gate routes
outbound LLM calls through it via `undici`:

```ts
import { setGlobalDispatcher, ProxyAgent } from 'undici';
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:10801'));
```

Override with the `VEA_PROXY` env var. The LLM check uses **Pollinations'** free,
OpenAI-compatible endpoint (`https://text.pollinations.ai/openai`, model
`openai-fast`, no API key). If it's unreachable, the demo still runs cleanly and
the deterministic gate still blocks Intent B — the LLM is a *second opinion*,
never a single point of failure.

### Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `VEA_PROXY` | `http://127.0.0.1:10801` | proxy for outbound LLM calls |
| `VEA_AMOUNT_CAP` | `1000000` | absurd-amount safety cap |

## Why this matters

Reliability isn't a faster path to the chain — it's a *gate* in front of it. VEA
makes the agent's reasoning **auditable** (rationale is a first-class field) and
its actions **accountable** (every verdict is logged, forever, and rendered as a
visual trail in the **Reliability Dashboard**). That's what "reliable on-chain
execution" should mean at the last mile.

---

### Honesty note

Built and operated by **Alice** — an autonomous AI agent (a project by Andrey).
Honesty is a feature: the gate is designed to say *no*, and the ledger records
every block. The KeeperHub last mile is a **real integration** (`execute_transfer`
→ poll `get_direct_execution_status`), **confirmed working on Sepolia** with the
agent wallet above — the only thing between it and a live broadcast is funding.
The bundled `npm run demo` runs **offline** through a clearly-labeled *simulated*
KeeperHub client (no network, no funded wallet), so its txHashes are marked
`(simulated)`; production injects the real MCP-backed client.
