---
title: "Tap to pay tips"
type: guide
created: 2025-09-04
updated: 2025-09-04
source: chatgpt-export
topic: business-jovie
message_count: 6
tags: [chatgpt, knowledge, business-jovie]
---
**Topic:** [[chatgpt-knowledge/_topics/business-jovie]]

# Tap to pay tips

> **Source:** ChatGPT conversation
> **Date:** 2025-09-04T08:35:36Z
> **Messages:** 6
> **Topic:** business-jovie

## Question

Can we make jovie enable tap to pay for creator tips from other peoples phones?

## Answer

Short answer: **Yes—via Tap to Pay, but it happens on the creator’s phone (the “merchant” device), not the tipper’s.** The payer taps their card/phone **onto the creator’s phone**.

## Fastest path (no app build)
- **Stripe Connect + “Tap to Pay with Stripe” app.** Onboard creators to your Stripe Connect platform; they download Stripe’s app and take contactless tips that pay out to their Connect account. No hardware. Minimal dev work. citeturn0search0

## Integrated path (own UX)
- **iPhone:** Add **Tap to Pay on iPhone** using Stripe Terminal **iOS SDK** (or Adyen). You must use a supported PSP; Apple exposes Tap to Pay via partner SDKs. citeturn0search9turn0search6  
- **Android:** Add **Tap to Pay on Android** using Stripe Terminal **Android/React Native SDK**. Works on many NFC-enabled Android devices. citeturn0search1turn0search5turn0search10

## What you’ll need
- **KYC + payouts:** Use **Stripe Connect** (Standard/Express) to verify creators and route funds.  
- **In-person pricing & PCI:** Handled by your PSP’s in-person (Terminal) rates and compliance; PIN entry is supported when needed. citeturn0search5turn0search17
- **Availability:** Tap to Pay is broadly available; details/regions depend on provider (Stripe, Square, Adyen). citeturn0search7turn0search4

## Recommended rollout for Jovie
1) **MVP in days:** Enable **Connect**, tell creators “Tap to Pay with Stripe” is supported for Jovie tips; we supply the amount + memo via deep link/QR, they collect on their iPhone/Android. citeturn0search0  
2) **Phase 2:** Ship **native Tap to Pay** inside Jovie’s mobile apps (iOS/Android) using Stripe Terminal SDKs, with creator tipping presets, split fees, receipts, and analytics. citeturn0search9turn0search5

If you want, I’ll draft the Stripe Connect + Tap-to-Pay MVP checklist next (accounts, webhooks, fee structure, receipts, QR/deep-link flow).

## Question

Ahh so useless til we have a native app

## Answer

Correct — without a **native iOS or Android app**, you can’t really make Tap to Pay seamless inside Jovie.  

The only stopgap is routing creators through **Stripe’s own “Tap to Pay with Stripe” app** (or Square/Adyen equivalents). That would technically let them take tips today, but the experience won’t feel branded or integrated with Jovie.  

Once Jovie ships a mobile client, you can:
- **Embed Tap to Pay** via Stripe Terminal SDKs (iOS + Android).  
- **Own the flow** (pre-filled tip amounts, split fees, receipts).  
- **Track analytics** inside Jovie dashboards.  

Until then: “possible, but clunky.” Want me to sketch what an MVP flow looks like with just Stripe’s app, so at least Jovie creators could start testing Tap to Pay immediately?

## Question

And a PWA cant?

## Answer

No, Mr. White — a **PWA can’t do Tap to Pay**.  

Reason:  
- **Apple & Google don’t expose NFC payments to the web.** Web apps (even PWAs) can’t access the secure NFC payment APIs needed for contactless transactions.  
- **Tap to Pay APIs are OS-level, SDK-only.** They require Apple’s “Tap to Pay on iPhone” or Google’s “Tap to Pay on Android,” which you can only reach through a partner PSP SDK (Stripe, Square, Adyen, etc.).  

So:  
- **Native app = required** to actually do “card tap on phone.”  
- **PWA** can only handle tip flows that end in **Apple Pay / Google Pay** (user double-clicks their own phone), not receiving a tap from someone else’s card/phone.  

Do you want me to outline a roadmap where you start with **web/PWA tip flows (Apple Pay/Google Pay)** and then upgrade to **native Tap to Pay** once you ship mobile apps? That way creators can at least start collecting in-person tips before Jovie has a native app.
