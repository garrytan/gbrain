---
title: "eBay MCP or Skill"
type: note
created: 2026-05-13
updated: 2026-05-13
source: chatgpt-export
conversation_id: 6a050e2e-0a00-83e8-a74e-152eb5e3a19f
message_count: 3
tags: [chatgpt, import]
---
# eBay MCP or Skill

> Conversation ID: 6a050e2e-0a00-83e8-a74e-152eb5e3a19f
> Created: 2026-05-13T23:50:06Z
> Updated: 2026-05-13T23:52:25Z
> Messages: 3

---

## User

Is there an eBay mcp or skill or whatever that can run my eBay and Maximo value

---

## Assistant

I’ll check the available tool environment and public eBay MCP/API automation options, then give you the practical path.

---

## Assistant

Mr. White, **I don’t see an eBay MCP/connector available in this chat’s connected-tool list**, and I did **not find an official eBay MCP server** in the public sources I checked. The practical route is to build or use an **eBay API wrapper exposed as MCP**.

MCP is the right kind of “whatever” for this: it is an open standard that lets AI apps connect to outside systems, access data, and perform actions through tools/workflows. citeturn541026view0

eBay already has the APIs needed to run most of a seller operation:

| Function | eBay API path |
|---|---|
| Listings / inventory / offers / price & quantity updates | Inventory API can create inventory records, create/publish offers, update offers, withdraw offers, and bulk update price/quantity. citeturn963580view1 |
| Orders / tracking / refunds / disputes | Fulfillment API can retrieve orders, create shipping fulfillments/tracking, issue refunds, and manage payment disputes. citeturn963580view2 |
| Seller policies / shipping / payment / returns / privileges | Account API manages business policies, sales tax, seller privileges, and opted-in programs. citeturn623340view0 |
| Ads / promotions / markdowns / reports | Marketing API supports Promoted Listings, discounts, store email campaigns, ad bid updates, campaign creation, and reports. citeturn376378view0 |
| Traffic / seller performance | Analytics API reports buyer engagement, customer-service metrics, and seller standards. citeturn917546view0 |
| Ad recommendations | Recommendation API can tell which active listings may benefit from Promoted Listings and suggest bid percentages. citeturn917546view1 |
| Payouts / fees / earnings | Finances API can retrieve payouts, transactions, order earnings, fees, charges, and seller funds summaries. citeturn917546view2 |

For **maximizing value**, the best build is an “eBay Operator” MCP with a human-approval layer:

1. **Read-only audit:** pull active listings, traffic, sales, fees, returns, seller standards, payout data.
2. **Pricing engine:** compare price, sell-through, shipping, fees, margin, age of inventory, and traffic.
3. **Listing optimizer:** improve title, category, item specifics, condition details, images checklist, and description. eBay also has a newer Inventory Mapping API for AI-powered listing recommendations in the U.S. marketplace. citeturn609296view0
4. **Action queue:** suggest price changes, markdowns, ad rate changes, relists, quantity changes, and shipping policy changes.
5. **Guarded execution:** require approval for anything destructive or money-impacting: price changes, refunds, cancellations, ad spend, listing withdrawals, account policy edits.
6. **Order ops:** auto-surface unfulfilled orders, tracking gaps, disputes, returns, and late-shipment risks.

Important constraint: eBay APIs require OAuth tokens, scopes, and a Developer Program account; user-specific actions require user authorization, and credentials/tokens must be stored securely. citeturn417093view0 eBay also enforces API call limits, though the default limits are high enough for most small/seller automation use cases. citeturn475405view0

My recommendation: **do not look for a generic “AI agent that runs eBay.” Build a narrow MCP that wraps eBay’s official APIs and starts read-only.** Then graduate to approved write actions: price updates, ad bid updates, inventory updates, and fulfillment tracking. That gives you maximum value without handing an agent unchecked control over your seller account.


## See Also
- [[chatgpt/chatgpt_app-performance-hardening-skill]]
- [[chatgpt/chatgpt_change-ebay-payout-account]]
- [[chatgpt/chatgpt_custom-skill-optimization]]
- [[chatgpt/chatgpt_ebay-auction-tips]]
- [[chatgpt/chatgpt_ebay-listing-profit]]
