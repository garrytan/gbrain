---
title: "Card decline troubleshooting"
type: note
created: 2025-12-20
updated: 2025-12-20
source: chatgpt-export
conversation_id: 694621ae-d2a4-8329-b3fe-f99c5967b0d4
message_count: 2
tags: [chatgpt, import]
---
# Card decline troubleshooting

**Related:** [[coding_troubleshoot]]

> Conversation ID: 694621ae-d2a4-8329-b3fe-f99c5967b0d4
> Created: 2025-12-20T04:11:08Z
> Updated: 2025-12-20T04:11:58Z
> Messages: 2

---

## User

I have a Mercury account, and I'm creating virtual cards to try and use with Cursor Checkout, Cursor, the IDE, and I'm trying to check out using Stripe Checkout, and for some reason, it just keeps telling me my card declines. I've got thousands of dollars in the specific account within the Mercury account, and very high limits set on the virtual card. I tried a merchant-locked card, and I now switch to not a merchant-locked card, and it's not working. I can't figure out what's going on. Can you help?

---

## Assistant

Mr. White — when a card “declines” in Stripe Checkout, it’s almost always one of three buckets: **issuer (Mercury/issuing bank) declined**, **Stripe blocked it (risk / card type / unsupported)**, or **your card controls (merchant lock / blocks / restrictions) caused it**. Here’s the fastest way to pin down which one and fix it.

## 1) Get the *real* decline reason (this determines the fix)
**Do this first**: in Mercury, open the card → look at the attempted transaction (or any “authorization attempt”) and see whether Mercury shows:
- **“Declined” with a reason**, or
- **No attempt logged at all** (meaning the payment never reached Mercury; it was blocked earlier by Stripe/Checkout or bad details).

If Cursor/Stripe shows a generic message, ask Cursor support to tell you the **Stripe decline_code** (e.g., `do_not_honor`, `generic_decline`, `insufficient_funds`, `card_not_supported`, AVS/CVC failure). Stripe explicitly notes some declines (like `do_not_honor`) can *only* be resolved by the cardholder contacting the issuer. citeturn0search4turn0search3turn0search1

## 2) If you used a Mercury merchant-locked card: assume it’s the culprit
Mercury merchant locks are **not reversible** once applied to a virtual card. If the lock was set to the “wrong” merchant identity (very common with Stripe, where the descriptor/legal entity can differ), it will keep declining. citeturn1search13turn0search2

**Fix:** create a **brand new un-locked virtual card** (never merchant-lock it), and retry.

Also confirm you didn’t accidentally **block the merchant** on that card (Mercury lets you block/unblock merchants per card). citeturn0search8

## 3) Make sure you’re using the right Mercury card type for a subscription
Cursor is a subscription purchase. Mercury supports card-based subscriptions in general, but if your account has multiple card products, try:
- **IO/credit card** (if you have it) instead of debit, or
- another network/card product you have available.

(For context: Mercury debit cards are Mastercard and issued by partner banks like Choice Financial Group / Column, per Mercury’s own FAQ.) citeturn1search0

## 4) Eliminate “easy” Stripe Checkout failure causes
These can cause instant declines even when you have plenty of money:
- **Billing ZIP/address mismatch** (AVS) — enter the billing ZIP that Mercury has on file for the card/account.
- **Name mismatch** (less common, but sometimes matters).
- **Multiple rapid retries** can trigger issuer fraud models → temporary “no” even with funds.

Stripe’s docs are blunt: many declines are issuer-side and require issuer/bank action, especially for generic declines. citeturn0search9turn0search3

## 5) What to do based on what you see

### A) Mercury shows `do_not_honor` / generic issuer decline
Call/message Mercury support and ask them to **remove the block / approve the merchant**. Stripe describes `do_not_honor` as an issuer refusal where the practical resolution is contacting the issuing bank. citeturn0search4turn0search1

### B) Mercury shows *nothing logged*
That usually means Stripe/Checkout never sent it to the issuer (or rejected it before authorization). In that case:
- Try another payment method offered (some Cursor users report workarounds like wallet-based payments when available), and/or
- Email Cursor support and ask for the **Stripe decline_code and Radar reason** (if any), plus whether they allow debit/prepaid for this product.

(Cursor’s own forum has multiple threads of people unable to subscribe due to declines, so it’s not just you.) citeturn0search6turn0search0

### C) Mercury says it’s being declined due to card controls
Then it’s almost always: **merchant lock mismatch**, **merchant blocked**, or **category/policy restriction**. Fix by using a **fresh, unlocked card** and confirming no blocks.

## 6) Copy/paste message to send to Mercury + Cursor (gets you unstuck faster)
Send both parties this (edit the blanks):

- Date/time of attempt (with timezone)
- Amount
- Card last 4
- Merchant shown (descriptor) on the decline screen (if any)
- Whether Mercury logged an authorization attempt
- Ask Mercury: “Can you see the issuer decline reason / any fraud block for this merchant and allow it?”
- Ask Cursor: “What is the Stripe `decline_code` + any Radar block reason for the payment attempt?”

---

If you tell me **(1)** what Mercury shows for the attempt (decline reason or nothing logged) and **(2)** whether you’re using Mercury **debit vs IO/credit**, I’ll tell you the most likely root cause and the exact next step.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]


## See Also
- [[chatgpt/chatgpt_card-decline-issue]]
- [[chatgpt/chatgpt_coachella-decline-or-recovery]]
- [[chatgpt/chatgpt_content-collaboration-decline]]
- [[chatgpt/chatgpt_polite-work-decline-template]]
- [[chatgpt/chatgpt_ac-crackling-troubleshooting]]
