---
title: "Clerc billing setup"
type: note
created: 2025-08-09
updated: 2025-08-09
source: chatgpt-export
conversation_id: 6897a8c2-1924-8323-8132-f15fc9831a99
message_count: 2
tags: [chatgpt, import]
---
# Clerc billing setup

> Conversation ID: 6897a8c2-1924-8323-8132-f15fc9831a99
> Created: 2025-08-09T20:00:17Z
> Updated: 2025-08-09T20:00:47Z
> Messages: 2

---

## User

https://clerk.com/docs/nextjs/billing/b2c-saas Take a look at the Clerc website. Tell me what environmental variables must be set to display a pricing table for using Clerc Billing.

---

## Assistant

Mr. White — just the standard Clerk keys:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`

That’s all you need for `<PricingTable />`. No Stripe keys in your app; Stripe is wired via the Clerk Dashboard. citeturn2search4turn2search15turn1view0
