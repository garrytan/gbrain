---
title: "QR Screen Enhancements"
type: note
created: 2026-05-21
updated: 2026-05-21
source: chatgpt-export
conversation_id: 6a0f7e71-f63c-83e8-81b2-98a432666c9c
message_count: 2
tags: [chatgpt, import, code]
---
# QR Screen Enhancements

> Conversation ID: 6a0f7e71-f63c-83e8-81b2-98a432666c9c
> Created: 2026-05-21T21:51:46Z
> Updated: 2026-05-21T21:51:58Z
> Messages: 2

---

## User

on the qr screen add a pill selector for Profile & Pay. pay just deeplinks the qr code to the payment screen so they can get paid in person. then add a tap and hold to save the qr codex to the photos app or to share the qr code or their link via the native share menu so they can print it or airdrop it etc.

---

## Assistant

Add three core changes:

## 1. QR Mode Pill Selector

Current screen becomes a segmented pill toggle at the top.

### Layout
```text
[ Profile ] [ Pay ]
```

- Default: `Profile`
- Animated sliding pill background
- Same radius language as the rest of Shell V1
- Sticky top alignment under header

### Behavior

#### Profile Mode
QR points to:
```txt
jov.ie/artistname
```

This is the existing behavior.

#### Pay Mode
QR points directly to:
```txt
jov.ie/artistname/pay
```

or:
```txt
jov.ie/pay/artist-id
```

depending on routing architecture.

Purpose:
- In-person tipping
- Merch table
- DJ booth
- Bar/club environments
- Busking/live events
- Faster than Venmo username search

This materially increases real-world utility and gives artists a reason to permanently display the QR.

---

## 2. Long Press Interaction

The QR itself should behave like native mobile media.

### Interaction
Tap:
- Opens fullscreen clean QR preview

Tap & Hold:
Opens native action sheet:
- Save Image
- Share
- Copy Link
- AirDrop
- Print

### Native APIs

#### iOS
Use:
```ts
navigator.share()
```

Fallback:
- Clipboard API
- download blob

#### Save to Photos
Generate QR PNG client-side:
- high resolution
- transparent + dark/light variants
- export at print-safe dimensions

Likely:
```txt
2048x2048
```

---

## 3. Share Sheet UX

The native share payload should include:

### Profile Mode
```txt
https://jov.ie/artistname
```

plus generated QR PNG.

### Pay Mode
```txt
https://jov.ie/artistname/pay
```

plus QR PNG.

This allows:
- AirDrop to venue staff
- Printing table tents
- Saving to camera roll
- Posting on IG stories
- Sending to promoters
- Merch stand displays

---

## Design Notes

### QR Container
- Large centered square
- Heavy whitespace
- Premium monochrome styling
- Subtle animated glow/accent matching artist theme
- No clutter around QR

### Under QR
Minimal metadata only:
```text
timwhite.jov.ie/pay
```

Maybe:
```text
Scan to tip
```

in Pay mode.

---

## Important Product Insight

This is bigger than “sharing a QR.”

You are turning Jovie into:
- the artist’s payment endpoint
- the artist’s physical-world identity layer

That creates:
- habitual use
- venue visibility
- fan onboarding
- recurring scans
- stronger retention
- more payment volume
- more list growth

The QR becomes:
```text
Linktree + Venmo + artist card
```

in one physical artifact.

Very strong MVP feature.
