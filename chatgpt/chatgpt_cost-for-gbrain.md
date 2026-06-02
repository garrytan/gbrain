---
title: "Cost for GBrain"
type: note
created: 2026-05-29
updated: 2026-05-29
source: chatgpt-export
conversation_id: 6a19f17b-7ea0-83e8-bf11-697c95d50599
message_count: 3
tags: [chatgpt, import]
---
# Cost for GBrain

> Conversation ID: 6a19f17b-7ea0-83e8-bf11-697c95d50599
> Created: 2026-05-29T20:05:16Z
> Updated: 2026-05-29T20:09:25Z
> Messages: 3

---

## User

how much would this cost us for gbrain

---

## Assistant

I’ll estimate this from the Supabase pricing shown, treating gbrain as a production app unless usage data says otherwise. I’ll separate fixed platform costs from usage-driven drivers.

---

## Assistant

Mr. White — for **Gbrain**, assuming early-stage usage around **a few users to ~10k MAU**, **Clerk for auth**, and Supabase mainly for **Postgres + storage**, I’d budget:

## Likely Supabase cost

| Setup | Estimated monthly cost | Notes |
|---|---:|---|
| **Free dev / prototype** | **$0/mo** | Works for demos, but limits are tight: 500 MB DB, 1 GB storage, 5 GB egress, no automatic backups, and inactive projects pause. |
| **Single production project** | **$25/mo** | Best default. Supabase Pro includes one project, $10/mo compute credit, 8 GB DB, 100 GB storage, 250 GB egress, 7-day backups, and email support. citeturn330179view0 |
| **Dev + prod projects** | **~$35/mo** | Pro is $25/mo; additional projects start at $10/mo. citeturn330179view0 |
| **Prod + dev + staging** | **~$45/mo** | Roughly $25 + two extra Micro projects at $10/mo each. |
| **Always-on branch environments** | **+$9.68/mo per branch** | Branching is listed at **$0.01344/hour**, so always-on monthly cost is about $9.68 per branch. citeturn330179view0 |

## My recommendation

Use **Supabase Pro at $25/mo** for Gbrain’s first production deployment.

That should cover the likely MVP needs:

- **Postgres DB:** 8 GB included
- **File storage:** 100 GB included
- **Egress:** 250 GB included
- **Compute:** Micro instance effectively included via the $10/mo compute credit
- **Backups:** daily backups with 7-day retention
- **Auth MAUs:** likely irrelevant if Clerk remains primary auth; relevant only if you use Supabase Auth

## Compute scaling math

If Gbrain needs more database horsepower, the first-project monthly cost roughly becomes:

| Compute size | Supabase bill estimate |
|---|---:|
| Micro | **$25/mo** |
| Small | **$30/mo** |
| Medium | **$75/mo** |
| Large | **$125/mo** |
| XL | **$225/mo** |
| 2XL | **$425/mo** |

Formula: **$25 Pro plan + compute price − $10 compute credit**. Supabase lists Micro at $10, Small at $15, Medium at $60, Large at $110, XL at $210, and 2XL at $410. citeturn330179view0

## Overages to watch

For Gbrain, the main variables that could push cost up are:

| Usage item | Included on Pro | Overage |
|---|---:|---:|
| Database size | 8 GB | $0.125/GB |
| File storage | 100 GB | $0.0213/GB |
| Egress | 250 GB | $0.09/GB |
| Cached egress | 250 GB | $0.03/GB |
| Edge Functions | 2M invocations | $2 / 1M |
| Realtime connections | 500 peak concurrent | $10 / 1,000 |
| Realtime messages | 5M/mo | $2.50 / 1M |
| Custom domain | Add-on | $10/domain/mo/project |

## Practical budget

For Gbrain’s near-term MVP:

**Budget: $25–$45/mo.**

I’d treat **$25/mo** as the base case and **$45/mo** as the clean dev/prod/staging setup. If Gbrain becomes storage-heavy with images/files, budget a buffer around **$75–$150/mo** before it becomes worth re-architecting storage/CDN separately.
