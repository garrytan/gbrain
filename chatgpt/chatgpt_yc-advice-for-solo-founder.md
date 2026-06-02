---
title: "YC advice for solo founder"
type: note
created: 2025-12-13
updated: 2025-12-13
source: chatgpt-export
conversation_id: 693df639-48b0-832a-aa6a-383033f82bf4
message_count: 2
tags: [chatgpt, import]
---
# YC advice for solo founder

> Conversation ID: 693df639-48b0-832a-aa6a-383033f82bf4
> Created: 2025-12-13T23:26:49Z
> Updated: 2025-12-13T23:28:16Z
> Messages: 2

---

## User

What would the yc advice be for solo founder software startup setting up equity structure through stripe atlas

---

## Assistant

Mr. White, YC-style advice here is basically: keep the cap table **boring, standard, and clean**, so you can hire + raise without weird edge cases.

### A very “YC-ish” solo-founder setup (using Stripe Atlas)
**1) Use the standard Delaware C-Corp / 10,000,000-share model**
A common Silicon Valley/Atlas pattern is:
- **10,000,000 shares authorized**
- **8,000,000 issued to founder(s)**
- **1,000,000 reserved for an option pool**
- **1,000,000 left unissued/unreserved for flexibility** citeturn1view2

Atlas/Orrick explicitly describes this and notes Atlas’s founder issuance tool issues **80% to founder(s)** by default. citeturn1view2

**2) Founder vesting: decide intentionally (even as solo)**
- Market standard vesting is **4 years with a 1-year cliff** (25% at 1 year, then monthly). citeturn1view2  
- Orrick notes that **single-founder stock is often not subject to vesting initially**, but **investors may later require it**. citeturn1view2  
YC-flavored move: if you expect fundraising soon, consider putting yourself on standard vesting early so it’s not a renegotiation later.

**3) File your 83(b) election immediately**
If your founder stock is subject to vesting, the 83(b) is usually critical. Atlas reminds you it must be filed **within 30 calendar days of the stock purchase** (each founder files their own). citeturn0search5turn0search9

**4) Option pool: keep it reasonable, and understand how it hits dilution**
YC’s SAFE materials explain the general expectation that an option pool exists and how it interacts with investor ownership/dilution (especially around seed/priced rounds). citeturn0search0turn0search7  
Practical YC-ish rule: don’t create an enormous pool “just in case.” Create what you need for near-term hiring, because pools are real dilution (and often get resized right before a priced round anyway).

**5) Don’t “pre-give” chunks of common stock to early helpers**
YC generally prefers:
- Employees: **options** under a plan (not founder-like common stock gifts)
- Advisors: small, vesting equity (or just cash), and keep it tight

### What this looks like in Atlas, concretely
- Incorporate → accept the standard authorized share count
- Issue founder shares (Atlas flow)
- Set up stock plan + reserve pool when you’re ready to grant (board + stockholder approvals are part of the standard flow) citeturn1view2
- File 83(b) inside the deadline citeturn0search5turn0search9

If you tell me whether you expect to raise (SAFE vs priced) in the next 6–12 months and whether you’re hiring in the next 90 days, I’ll suggest a “keep-it-clean” pool size and founder vesting choice that matches that path.


## See Also
- [[chatgpt/chatgpt_funding-with-solo-founder]]
- [[chatgpt/chatgpt_co-founder-breakup-causes]]
- [[chatgpt/chatgpt_founder-experience-summary]]
- [[chatgpt/chatgpt_founder-vs-ceo-explained]]
- [[chatgpt/chatgpt_technical-co-founder-search]]
