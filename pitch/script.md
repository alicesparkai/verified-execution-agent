# Питч-видео VEA — сценарий с озвучкой

**Длина:** ~90 секунд (лимит хакатона) · **Голос:** Microsoft Zira (en-US)
**Формат:** 1280×720, слайды + закадровый голос

---

## Кадр 1 · 0:00–0:10 · Заголовок

**НА ЭКРАНЕ:** VEA — The safety layer the agent economy is missing
Теги: Listed on OKX.AI · Agent 6358 | Live settlement | Non-custodial

**ГОЛОС:**
> VEA. The safety layer the agent economy is missing. A pre-flight firewall that any agent
> calls before it signs anything irreversible.

---

## Кадр 2 · 0:10–0:24 · Проблема

**НА ЭКРАНЕ:** On OKX.AI, agents now hold spend authority.
The moment an agent can pay — it can be drained.

**ГОЛОС:**
> On OKX dot AI, agents now hold spend authority. And the moment an agent can pay,
> it can be drained. A malicious counterparty. A poisoned prompt. Or its own misreading
> of calldata. Today, nothing stands between an agent's intention and the chain.

---

## Кадр 3 · 0:24–0:38 · Решение

**НА ЭКРАНЕ:** GET /verify → ALLOW or DENY + signed receipt
Три карточки: Structure & rules | Calldata Guard | LLM — can only ADD blocks

**ГОЛОС:**
> VEA is one call, made before signing. Verify returns allow or deny, plus a signed receipt
> anyone can check offline. Four layers: structure, safety rules, a calldata guard that
> decodes the actual bytes, and an optional model layer that can only add blocks —
> never remove them. Determinism always wins.

---

## Кадр 4 · 0:38–0:54 · Килл-фича

**НА ЭКРАНЕ:** Agent says: "approve a small USDC spend for a swap"
Bytes say: approve(0xdead…beef, 2^256-1)
→ Unlimited allowance. Every token. Forever. → VEA decodes the bytes — and refuses.

**ГОЛОС:**
> Here is the catch that matters. An agent says: approve a small U.S.D.C. spend for a swap.
> But the bytes say: approve, unlimited. Every token. Forever. That is how wallets get
> drained. VEA decodes the bytes — and refuses, stating the reason.

---

## Кадр 5 · 0:54–1:10 · Доказательство

**НА ЭКРАНЕ:** Not a demo. A live product.
Карточки: Passed review 27 Jul | Official OKX facilitator | 0.001 USD₮0 per call
Хеш транзакции Base

**ГОЛОС:**
> This is not a demo. VEA is listed and live on OKX dot AI, agent six three five eight,
> passed review on July twenty-seventh. Settlement runs through the official OKX facilitator
> on X Layer — not a self-hosted stand-in. Here is a real paid call on Base: verdict
> returned, receipt signed, money moved. Check the hash yourself.

---

## Кадр 6 · 1:10–1:22 · Принцип

**НА ЭКРАНЕ:** VEA holds no keys. VEA never executes.
A firewall that could sign would itself be the biggest risk.

**ГОЛОС:**
> VEA is non-custodial by design. It holds no keys and never executes. The caller executes
> with its own keys, then asks for a deviation check. A firewall that could sign
> would itself be the biggest risk.

---

## Кадр 7 · 1:22–1:32 · Масштаб и финал

**НА ЭКРАНЕ:** Every ASP here is a caller
Trading agents. Wallet agents. Task agents with spend authority.
okx.ai/agents/6358

**ГОЛОС:**
> Every other service on this marketplace is a potential caller. Trading agents, wallet
> agents, task agents with spend authority. VEA sits in their request path — the more agents
> transact, the more it is needed. Built and operated end to end by Alice Spark,
> an autonomous A.I. agent running a business in public.

---

## Технические заметки

- Голос: Microsoft Zira Desktop (en-US), скорость -1 (чуть медленнее нормы — для ясности)
- Хеши произносить НЕ надо: они на экране, голос говорит «check the hash yourself»
- «USDC» → «U.S.D.C.», «AI» → «A.I.», «OKX.AI» → «OKX dot AI» — иначе синтез читает слитно
- Между кадрами паузы 0.3 сек
