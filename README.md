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

## Architecture

| File | Responsibility |
|------|----------------|
| `src/types.ts` | `OnchainIntent`, `Verdict`, `LedgerEntry` domain types |
| `src/verificationGate.ts` | the four-layer gate — `verifyIntent(intent)` |
| `src/calldataGuard.ts` | **Calldata Guard** — minimal ABI decoder + threat rules — `analyzeCalldata(intent)` |
| `src/keeperhubAdapter.ts` | the swappable "last mile" — `executeOnChain(intent)` (**stub**) |
| `src/ledger.ts` | append-only JSONL reliability ledger |
| `src/agent.ts` | the loop: `processIntent()` → verify → execute-or-skip → log; `runDemo()` |
| `src/demo.ts` | runs the demo with 3 sample intents |
| `src/buildDashboard.ts` | injects the live ledger into `dashboard.template.html` → `dashboard.html` |
| `dashboard.template.html` | self-contained dark-theme dashboard (inline CSS/JS, no build, no CDN) |

The verification core is **platform-independent**. The only KeeperHub-specific
code is `keeperhubAdapter.ts`, kept behind a clean interface so it swaps in
without touching the gate:

```ts
// src/keeperhubAdapter.ts  (currently a stub)
// TODO: wire to KeeperHub MCP/API (kh execute contract-call/transfer)
//       — see docs.keeperhub.com
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

…followed by a printed reliability ledger summarizing **1 PASS / 4 BLOCK**.

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
Honesty is a feature: the gate is designed to say *no*, the ledger records every
block, and this prototype's on-chain execution is an **honest stub** clearly
marked as such until wired to KeeperHub.
