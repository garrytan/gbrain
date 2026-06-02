---
title: "Cookie banner requirements"
type: note
created: 2025-12-16
updated: 2025-12-16
source: chatgpt-export
conversation_id: 6940a177-6e2c-8327-89fc-5f16594862eb
message_count: 2
tags: [chatgpt, import]
---
# Cookie banner requirements

> Conversation ID: 6940a177-6e2c-8327-89fc-5f16594862eb
> Created: 2025-12-16T00:02:00Z
> Updated: 2025-12-16T00:04:46Z
> Messages: 2

---

## User

where do we have to show a cookie banner

---

## Assistant

Mr. White,

You **must show a cookie banner** primarily when users are covered by **EU/UK privacy law** or similar regimes that require **prior consent** for non-essential cookies.

### Where a cookie banner is required
**EU / EEA (GDPR + ePrivacy Directive)**
- Required if you use **non-essential cookies** (analytics, ads, tracking).
- Consent must be **prior, explicit, granular**, with **Reject** as easy as Accept.

**United Kingdom (UK GDPR + PECR)**
- Same rule as the EU.

**Countries aligned with EU ePrivacy rules**
- E.g., **Switzerland**, **Norway**, **Iceland** → banner required for non-essential cookies.

### Where a banner is usually *not* legally required
**United States (including California)**
- **No general cookie banner requirement.**
- **California (CPRA/CCPA)** requires:
  - Disclosure of cookies in a **privacy policy**
  - **“Do Not Sell or Share”** link if cookies involve cross-context behavioral advertising
- A banner is optional unless used to implement opt-out mechanisms.

**Canada**
- Generally disclosure-based; banner not strictly required unless consent standards aren’t otherwise met.

### Practical rule used by most companies
- If you **target or receive traffic from the EU/UK**, show a banner to those users (geo-based).
- If you **only target the US**, a banner is not legally required, but some companies use one for risk reduction.

### What triggers the requirement
- Analytics (Google Analytics without strict anonymization)
- Ad pixels (Meta, Google Ads, TikTok)
- Cross-site tracking
- Any cookie not **strictly necessary** for core functionality

If you want, I can:
- Map this to **your specific product**
- Tell you **exactly which cookies force a banner**
- Draft **EU-compliant vs US-only** setups


## See Also
- [[chatgpt/chatgpt_cookie-banner-requirements-3]]
- [[chatgpt/chatgpt_cookie-banner-requirements]]
- [[chatgpt/chatgpt_banner-design-request]]
- [[chatgpt/chatgpt_bar-sink-requirements-california]]
- [[chatgpt/chatgpt_deepseek-v4-requirements]]
