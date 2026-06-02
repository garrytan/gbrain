---
title: "Mercury callsign explanation"
type: note
created: 2025-12-17
updated: 2025-12-17
source: chatgpt-export
conversation_id: 6942ff8f-e0c8-832f-93b9-daf0d183dd2a
message_count: 6
tags: [chatgpt, import]
---
# Mercury callsign explanation

> Conversation ID: 6942ff8f-e0c8-832f-93b9-daf0d183dd2a
> Created: 2025-12-17T19:08:02Z
> Updated: 2025-12-17T21:14:13Z
> Messages: 6

---

## User

what is this

---

## Assistant

Mr. White,

This is **Mercury’s “callsign” setup screen** during business account onboarding.

**What it is**
- A short, custom identifier for your Mercury account.
- Used to personalize things like:
  - Your **bill-forwarding email address**
  - Your **referral link**
  - Internal Mercury URLs and labels

**What it is not**
- Not your legal business name  
- Not shown on bank statements  
- Not visible to customers or vendors by default

**Practical guidance**
- Pick something **short, lowercase-friendly, and brand-aligned**
- Avoid sensitive info or long names
- Think of it like a **username for your bank account**

Example:  
If your callsign is `jovie`, your bill-forwarding email might look like `bills+jovie@mercury.com`.

If you want, I can suggest optimal callsigns based on branding, privacy, and future-proofing.

---

## User

send safe through atlas or mercury?

---

## Assistant

Mr. White,

**Mercury.**

What you’re seeing is **Mercury’s built-in SAFE issuance flow**. Atlas (Stripe Atlas) is not involved at this stage.

**How this works in practice**
- **Atlas**: Incorporation, initial legal setup, templates, and early cap table scaffolding.
- **Mercury**:  
  - Generates the SAFE  
  - Emails it to the investor  
  - Collects e-signature  
  - Receives funds directly into your Mercury account  
  - Stores the executed SAFE

**When you would use Atlas instead**
- If you’re issuing SAFEs **during incorporation** or using Atlas’s bundled legal workflow.
- If you want Atlas to manage the doc but still manually handle signatures and wires.

**Bottom line**
- Since you’re already on this screen, **send the SAFE via Mercury**. It’s faster, cleaner, and ties the money + document together.

If you want, I can sanity-check investor type selection, entity naming, or SAFE terms before you hit **Review**.

---

## User

both let me send SAFES and i have both whcih is better

---

## Assistant

Mr. White,

**Mercury is better in almost all post-incorporation cases.**  
Here’s the clean, factual comparison.

## Mercury vs. Atlas for SAFEs

### Mercury — **Preferred**
**Pros**
- Signature **and funds** handled in one flow
- Money lands directly in your operating account
- Fewer steps for the investor → higher close rate
- Clear audit trail (doc + payment linked)
- No extra coordination with wires or Stripe

**Cons**
- Lighter cap-table awareness (you still track SAFEs elsewhere)

**Best use**
- Ongoing fundraising
- Angels, small funds, rolling closes
- Speed matters

---

### Atlas — **Situational**
**Pros**
- Tighter connection to incorporation records
- Familiar to lawyers
- Clean if *everything* is still inside Atlas

**Cons**
- Payment is external (wire/ACH/manual follow-up)
- More investor friction
- Slower closes
- Easy for docs and money to get out of sync

**Best use**
- During incorporation only
- When counsel explicitly requires Atlas-generated docs

---

## Clear recommendation
- **Already incorporated + already banking at Mercury → use Mercury**
- Pick **one system** and standardize. Mixing Atlas SAFEs and Mercury SAFEs creates bookkeeping and diligence mess later.

## Decision rule
If your priority is:
- **Speed + fewer mistakes** → Mercury  
- **Lawyer comfort during formation** → Atlas  

You are past formation. Use **Mercury**.

If you want, I can also tell you how VCs will view Mercury-issued SAFEs in diligence (short answer: they don’t care, as long as the doc is standard).
