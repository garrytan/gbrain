---
title: "NFC in PWA for Jovi"
type: note
created: 2026-02-15
updated: 2026-02-15
source: chatgpt-export
conversation_id: 69920531-0980-8328-a3b0-7aaad9c71eb9
message_count: 2
tags: [chatgpt, import]
---
# NFC in PWA for Jovi

> Conversation ID: 69920531-0980-8328-a3b0-7aaad9c71eb9
> Created: 2026-02-15T17:42:12Z
> Updated: 2026-02-15T17:43:12Z
> Messages: 2

---

## User

What um what access do I have to NFC over um in a progressive web app for Jovi? So it's a linkinbio product that I'm like trying to think if there's a way that we could have someone, like, tap their phone to share a vCard with the Jovi profile on it, or like, can we prompt the user to save, to automatically add, is there a way we can download or prompt the user, like download a vCard to the iPhone or like prompt the user to add the, add their Jovi profile as their homepage on their like iOS contact card for who they are, so that every time they tap someone to share, it automatically includes that. And then, is there anything that we can do with that where it's like, if I bring up like the tip page or something, and then I tap that to another iPhone, can I get that iPhone to like pop up that page, or is there anything we could do like that to cool, create some cool features, or would it have to be native?

---

## Assistant

Mr. White — in a **progressive web app** (PWA) you can do some NFC-ish things on **Android**, but on **iPhone/iOS** you basically can’t access NFC from the web at all.

## What you can do in a PWA today

### 1) Android (Chrome / some Chromium browsers): **Web NFC exists**
- You *can* read/write **NDEF** messages to **physical NFC tags** from a secure context (HTTPS) using the **Web NFC API**. citeturn0search4turn0search1turn0search16  
- Web NFC’s scope is **tags**, NDEF only (not “tap phone to phone” magic, not low-level NFC, not HCE). citeturn0search13turn0search4

**Practical product use on Android PWA:**
- Sell/ship an NFC sticker/card for creators.
- Your PWA can **program** the tag to:
  - open `https://jovi.link/<handle>` (URL record)
  - or open a special “tip” URL with tracking params

### 2) iPhone / iOS (Safari + iOS “installed web app”): **No Web NFC**
- iOS Safari does **not** support Web NFC (including when “installed” as a PWA). citeturn0search16turn0search5turn0search2

**But iPhones *can* still react to NFC tags at the OS level:**
- iPhones support “background tag reading” in the OS (Core NFC feature), which can read NDEF from tags and then launch an appropriate action (commonly: open a URL). citeturn0search6turn0search19turn0search15

So: on iPhone, your web app can’t *control* NFC, but a physical NFC tag can still open your website.

---

## Your specific ideas: what’s possible

### “Tap phone to share a vCard with the Jovi profile on it”
**Best cross-platform approach (no native):**
- Put an NFC tag in a card/sticker that stores a **URL** to either:
  1) the Jovi profile page, and/or
  2) a hosted `.vcf` (vCard) download endpoint like `https://jovi.link/<handle>.vcf`

**Reality check on iOS behavior:**
- iOS background NFC is basically “URL-first” for automatic handling; vCard NDEF isn’t reliably auto-recognized by the system the way URL is. citeturn0search3turn0search15  
So store a **URL** on the tag, and let the web page offer “Add Contact”.

### “Can we prompt the user to automatically add a contact / save a vCard to iPhone?”
You can:
- Generate a `.vcf` and offer it as a download / share-sheet action.
- On iOS, the user will still have to **tap** and confirm import (you can’t silently write into Contacts from a web app).

(That limitation is basically by design; the web sandbox doesn’t get contact-write privileges.)

### “Add their Jovi profile as their homepage on their iOS contact card… so every time they share it includes that”
You can’t auto-edit their “My Card” from a PWA.

What you *can* do:
- Provide a vCard that includes URL fields (website/social/custom label pointing to Jovi), so when they import/update, their card includes the link.
- Provide very fast UX: “Download contact card” → iOS import flow → done.

### “If I bring up the tip page and tap that to another iPhone, can I make it pop up that page?”
**Phone-to-phone NFC from the web:** effectively **no**.
- Web NFC is for **tags**, not peer-to-peer “tap another phone” launching a page, and iOS doesn’t expose Web NFC anyway. citeturn0search13turn0search16turn0search5

**Alternatives that *do* work well:**
- **QR code** on the tip screen (fast, universal)
- “Tap” experience via a **physical NFC tag** (ring/card/sticker) that opens the tip URL on both iOS + Android
- If you go native, you can explore deeper NFC behaviors via Core NFC (and potentially Apple’s newer NFC/SE platform for specific “card-like” experiences, but that’s not a web/PWA thing). citeturn0search0turn0search6

---

## “Cool features” that fit a link-in-bio product (and don’t require native)

1) **Creator NFC card/sticker**
- Tag contains: `https://jovi.link/<handle>?src=nfc`
- Landing page offers:
  - Open profile
  - Add to contacts (download vCard)
  - Tip button

2) **One-tap “Add me” funnel**
- If opened from NFC: show a single CTA: **“Add my contact”**
- Then secondary CTAs: follow, tip, save to home screen

3) **Android-only bonus**
- On Android, your PWA can include “Program my Jovi tag” (write the user’s URL to a blank tag) using Web NFC. citeturn0search4turn0search1turn0search16

---

## When you’d need native
You’ll want native if you need any of these:
- Write NFC tags on **iPhone**
- Any kind of **phone-to-phone NFC** interaction you control
- Deeper NFC modes beyond “tag opens URL”
- Anything that feels like a “wallet / tap credential / tap-to-share identity” experience on iOS (that’s outside PWA capabilities). citeturn0search0turn0search13

If you tell me your target split (**iOS-heavy vs Android-heavy**) and whether you’re willing to ship **a physical NFC card/sticker**, I can recommend the cleanest “tap” flow and the exact records/URLs to encode.
