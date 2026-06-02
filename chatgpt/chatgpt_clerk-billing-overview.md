---
title: "Clerk billing overview"
type: note
created: 2025-08-07
updated: 2025-08-07
source: chatgpt-export
conversation_id: 6893f099-12b4-8331-8250-80dea9c8c1b2
message_count: 2
tags: [chatgpt, import]
---
# Clerk billing overview

> Conversation ID: 6893f099-12b4-8331-8250-80dea9c8c1b2
> Created: 2025-08-07T00:17:29Z
> Updated: 2025-08-07T00:18:13Z
> Messages: 2

---

## User

clerk billing

---

## Assistant

​Clerk offers integrated billing solutions for both B2C and B2B SaaS applications, streamlining subscription management and payment processing.

---

### 🔧 Clerk Billing Overview

- **Integration with Stripe**: Clerk connects directly to your Stripe account, handling user interfaces and entitlement logic, while Stripe manages payment processing. citeturn0search2

- **Subscription Management**: Define and manage subscription plans within the Clerk dashboard. Utilize the `<PricingTable />` component to display plans and allow users to manage subscriptions through Clerk's profile components. citeturn0search5

- **Feature Access Control**: Use Clerk’s `has()` helper function to control user access based on subscription plans and features. citeturn0search5

---

### 💳 Pricing Structure

- **Free Plan**: Includes up to 10,000 Monthly Active Users (MAUs) and 100 Monthly Active Organizations (MAOs) at no cost. citeturn0search0

- **Pro Plan**: Starts at $25/month, with additional charges of $0.02 per MAU beyond the first 10,000 and $1 per MAO beyond the first 100. citeturn0search0

- **Add-ons**: Enhanced features like multi-factor authentication, device tracking, and custom roles are available as add-ons, each priced at $100/month. citeturn0search0

---

### 🧾 Billing Management

- **Dashboard Access**: Manage your subscription, view invoices, and update billing information directly through the Clerk dashboard. citeturn0search1

- **Payment Methods**: Supports credit card payments, SEPA transfers for Euro transactions, and international bank transfers. citeturn0search1

- **Autoscaling**: Clerk automatically adjusts your subscription tier based on sustained usage increases, ensuring your plan aligns with your needs. citeturn0search1

---

For a comprehensive understanding of Clerk's billing features and to explore detailed documentation, visit the [Clerk Billing Overview](https://clerk.com/docs/billing/overview). 


## See Also
- [[chatgpt/chatgpt_clerk-authentication-overview]]
- [[chatgpt/chatgpt_clerk-vs-stripe-billing]]
- [[chatgpt/chatgpt_codex-billing-overview]]
- [[chatgpt/chatgpt_clerk-account-management-features]]
- [[chatgpt/chatgpt_clerk-allowlist-feature]]
