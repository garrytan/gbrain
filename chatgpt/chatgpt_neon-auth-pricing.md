---
title: "Neon Auth Pricing"
type: note
created: 2026-01-04
updated: 2026-01-04
source: chatgpt-export
conversation_id: 6959d965-a040-8327-bf8e-cc99d7b16427
message_count: 2
tags: [chatgpt, import]
---
# Neon Auth Pricing

> Conversation ID: 6959d965-a040-8327-bf8e-cc99d7b16427
> Created: 2026-01-04T03:07:18Z
> Updated: 2026-01-04T03:07:50Z
> Messages: 2

---

## User

neon auth pricing

---

## Assistant

Here’s what I can find on **Neon Auth pricing** (the managed authentication feature from Neon):

**Key point:**  
Neon Auth itself doesn’t appear to have a *separate published price* — its cost is generally tied to your Neon project usage and the overall Neon platform billing model rather than a standalone per-user or tiered Auth charge that’s clearly listed on a pricing page. citeturn0search2

### Neon Platform Pricing (Auth INCLUDED)
Neon Auth is a part of the Neon ecosystem and inherits Neon’s overall pricing structure, which is:

- **Free tier:** $0/month with limits on compute/storage — good for prototyping and small projects. citeturn1search1  
- **Paid usage-based:** You pay for compute hours and storage based on actual usage, with a **$5/month minimum bill** once you exceed the free tier. citeturn1search1  
- Compute billed per CU-hour (fractional vCPU/RAM) and storage per GB-month. citeturn1search1  
- No separate line item for Neon Auth in the published pricing — it’s enabled within your project and covered by your overall Neon usage. citeturn0search2

### What That Means for Neon Auth
- Neon Auth doesn’t currently list *per-user* or *per-active-session* fees like some dedicated Auth providers (e.g., Auth0, Clerk).  
- Costs you incur for using Neon Auth come indirectly via:
  - the Neon project owning your database/auth resources,
  - compute consumption driven by API calls and operations,
  - storage used for user profiles and auth data.  
- If your Neon project sits in the Free tier, Neon Auth usage *should* effectively be free as long as total compute/storage stays within the free limits. citeturn1search1

**Bottom line:**  
There’s no separate **Neon Auth pricing plan** on Neon’s pricing page. Instead, Auth usage is bundled with your Neon project’s usage and billed under Neon’s usage-based model. You pay for compute and storage as you go, with a minimum of $5/month beyond the free tier. citeturn1search1

If you want precise numbers for your expected traffic and auth load, tell me your expected monthly active users and typical request volume and I can help estimate costs.


**Topic:** [[chatgpt-clusters/business_startup]]
