---
conversation_id: 6959d9d0-2f00-8328-9e83-8ed7eee2a03b
created: 2026-01-04
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: Neon Auth Pricing
type: note
updated: 2026-01-04
---

# Neon Auth Pricing

**Related:** [[business_startup]]

> Conversation ID: 6959d9d0-2f00-8328-9e83-8ed7eee2a03b
> Created: 2026-01-04T03:09:04Z
> Updated: 2026-01-04T03:09:35Z
> Messages: 4

---

## User

how much is neon auth

---

## Assistant

Mr. White — **Neon Auth doesn’t have a separate sticker price** by itself. It’s included **as part of the Neon platform** — you enable it from the Neon console and use it with your Neon Postgres project without an extra auth-specific fee listed. citeturn1search1

### Neon overall pricing (Auth included)
- **Free tier:** $0/month — always free, auth included. citeturn0search0  
- **Paid / usage-based:** starts from a usage model with a **$5/mo minimum** (compute/storage/branches) on paid plans. Authentication is part of the platform features — no separate auth add-on cost stated. citeturn0search3turn1search0

### What that means
- You *pay for the Neon database resources you use* (compute hours, storage, etc.), and Neon Auth comes bundled with your project. citeturn1search1  
- There’s **no published per-user or per-auth-transaction fee** by Neon like some dedicated auth services (Auth0, Clerk).  
- If you keep usage within the free tier’s limits, **Neon Auth can effectively cost $0**. citeturn0search0

If you want a precise monthly estimate based on your expected database usage + auth usage patterns, I can help calculate a sample cost.

---

## User

how much would we pay with 10k mau

---

## Assistant

Mr. White — **Neon Auth doesn’t charge per user or per MAU** on its own. It’s bundled into the Neon platform and you pay based on **database usage (compute/storage/branches/etc.)**, not a per-user auth fee. citeturn0search0turn0search1

### Key points
- **No published per-MAU fees** for Neon Auth like you’d see with Auth0 or Clerk. Auth is included with your Neon Postgres project. citeturn0search0  
- Your monthly bill depends on **compute hours and storage consumed**, **not the number of logins**. citeturn0search1

### Rough cost estimate with ~10k MAU
Because Neon bills usage-based, your cost depends on how much database load your app generates when 10k users are active:

**Compute** (the biggest driver):  
- Neon compute is billed by **CU-hours** (compute unit hours) at ~**$0.14/CU-hour** (can vary by plan/region). citeturn0search1  
- If your app needs, say, a **0.5–1 CU database running 24/7** to handle traffic:  
  - 0.5 CU × 730 hours ≈ **365 CU-hours/mo × $0.14 ≈ $51/mo**  
  - 1 CU × 730 hours ≈ **730 CU-hours/mo × $0.14 ≈ $102/mo**  
  These are approximate and **don’t include storage or network**. citeturn0search1

**Storage:**  
- Charged per **GB-month** at ~**$0.35/GB-month** — trivial unless you store lots of data. citeturn0search1

**Branches/Other:**  
- Minimal for a typical production setup unless you create many ephemeral branches. citeturn0search1

**Real-world ballpark:**  
- A basic production-ready Neon database handling 10k MAU might cost **roughly $50–150/mo**, assuming moderate query volume and continuous DB availability.  
- If your workload spikes or requires more compute power (higher CUs), add accordingly.

### What *won’t* affect cost directly
- You **don’t pay extra per MAU for Neon Auth** the way you would with Auth0/Clerk — user count itself doesn’t generate auth billing. Auth is synced to your DB and the cost come from the DB usage behind it. citeturn0search0

If you can share an expected **RPS/queries per second**, I can give a tighter cost projection based on compute requirements.


**Topic:** [[chatgpt-clusters/business_startup]]
