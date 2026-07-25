# Hedera testnet — on-chain evidence

Everything below was produced by `npm run hedera:demo` against Hedera testnet. Nothing is
staged: each link resolves on HashScan without this server running.

## Accounts

| Role | Account | Note |
|---|---|---|
| Service (receives payment, publishes receipts) | [`0.0.9698784`](https://hashscan.io/testnet/account/0.0.9698784) | operator |
| Client agent (pays for verifications) | [`0.0.9742563`](https://hashscan.io/testnet/account/0.0.9742563) | separate account, created on-chain by `ensurePayer()` |

A distinct payer is not cosmetic. Payment verification counts what was *credited to the
service account*, and an account paying itself nets to minus-fees — so a demo paying from
the operator account would either fail its own check or tempt me to loosen the check until
it passed.

## HCS receipt topic

**[`0.0.9742511`](https://hashscan.io/testnet/topic/0.0.9742511)** — append-only log of
verification receipts. Each message carries the verdict, the intent id, the receipt
signature, and the payment that bought it. Only the receipt envelope is published, never the
intent payload: the point is public provability that the decision existed at that moment,
not publishing what the caller was doing.

| Seq | Consensus timestamp | Verdict | Paid with |
|---|---|---|---|
| #1 | `1784972904.894263137` | `BLOCK` | `0.0.9742563-1784972892-929145731` |
| #2 | `1784973012.894284427` | `BLOCK` | `0.0.9742563-1784972998-674354696` |

Read them back yourself, no auth required:

```bash
curl https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.9742511/messages
```

## Payments (x402 settlement)

| Transaction | What it was |
|---|---|
| [`0.0.9742563@1784972892.929145731`](https://hashscan.io/testnet/transaction/0.0.9742563@1784972892.929145731) | 0.01 HBAR — bought verification #1 |
| [`0.0.9742563@1784972998.674354696`](https://hashscan.io/testnet/transaction/0.0.9742563@1784972998.674354696) | 0.01 HBAR — bought verification #2 |
| [`0.0.9742563@1784972807.502816264`](https://hashscan.io/testnet/transaction/0.0.9742563@1784972807.502816264) | earlier run — paid, then correctly refused because the Mirror Node had not indexed it yet (this is what led to the bounded-wait fix) |

## Infrastructure transactions

| Transaction | What it was |
|---|---|
| `0.0.9698784-1784972265-978010612` | `CONSENSUSCREATETOPIC` — created the receipt topic |
| `0.0.9698784-1784972900-443246062` | `CONSENSUSSUBMITMESSAGE` — anchored receipt #1 |
| `0.0.9698784-1784973007-984820831` | `CONSENSUSSUBMITMESSAGE` — anchored receipt #2 |

## The verdict those payments bought

Both runs submitted the same intent: a token approval whose stated rationale was *"routine,
small amount"* while the calldata said `approve(0xd8da…6045, 2^256-1)`.

The gate decoded the bytes and returned:

> `BLOCK` — *unlimited-approval drainer: `approve(0xd8da…6045, 2^256-1 (uint256 max))` grants
> an effectively-unlimited allowance — the #1 real-world wallet-drain pattern. This directly
> contradicts the stated "small/limited spend" rationale.*

That contradiction — between what an agent says it is doing and what its bytes actually do —
is the thing VEA exists to catch, and the reason the verdict is worth anchoring where nobody
can quietly revise it afterwards.

## Reproduce

```bash
cp .env.example .env      # testnet account from portal.hedera.com (free, 1000 HBAR/day)
npm install
npm run hedera:setup      # creates your own HCS topic
npm run hedera:demo
```
