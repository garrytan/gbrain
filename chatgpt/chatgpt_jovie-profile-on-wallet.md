---
title: "Jovie Profile on Wallet"
type: essay
created: 2026-05-24
updated: 2026-05-24
source: chatgpt-export
conversation_id: 6a12a209-f62c-83e8-b076-e22329945744
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Jovie Profile on Wallet

> Conversation ID: 6a12a209-f62c-83e8-b076-e22329945744
> Created: 2026-05-24T07:00:26Z
> Updated: 2026-05-24T07:15:44Z
> Messages: 6

---

## User

Can we build this for Jovie so that you get a Jovie profile on your Apple Wallet? 

---

## Assistant

Mr. White, yes. I’ll map this into a concrete Jovie Apple Wallet profile pass, covering feasibility, user flow, PassKit requirements, signing, hosting, updates, and MVP scope.

---

## Assistant

Yes, Mr. White. This is very buildable for Jovie.

## Product shape

A **Jovie Apple Wallet profile pass** would work like a lightweight digital profile card:

- **Front of pass**
  - Jovie logo
  - Profile photo / avatar
  - Name
  - `@handle`
  - “JOVIE PROFILE”
  - QR code

- **QR code**
  - Opens the user’s public Jovie profile, for example:  
    `https://jov.ie/tim`  
  - Or a share-tracking URL, for example:  
    `https://jov.ie/p/tim?src=wallet`

- **Back of pass**
  - Full profile URL
  - Bio
  - Social links
  - “Open in Jovie”
  - Optional referral/share metadata

Apple supports **generic Wallet passes**, which fit this use case well because they are intended for passes that do not map to tickets, boarding passes, coupons, or store cards. Apple’s Wallet pass docs also support real-time pass updates. citeturn838844search1turn838844search9

## Best implementation path

### Option A — fastest: use WalletWallet as the pass generator

This is closest to the page you’re viewing. Jovie would send JSON to WalletWallet’s API and receive a signed `.pkpass` file back. Their docs show a `POST /api/pkpass` endpoint that returns a ready-to-distribute Apple Wallet pass, with fields for QR value, logo text, primary fields, secondary fields, header fields, back fields, colors, logo, thumbnail, strip image, and location triggers. citeturn739800view0

Basic Jovie payload:

```json
{
  "barcodeValue": "https://jov.ie/tim?src=wallet",
  "barcodeFormat": "QR",
  "logoText": "Jovie",
  "organizationName": "Jovie",
  "primaryFields": [
    { "label": "PROFILE", "value": "Tim White" }
  ],
  "secondaryFields": [
    { "label": "HANDLE", "value": "@tim" }
  ],
  "headerFields": [
    { "label": "JOVIE", "value": "PROFILE" }
  ],
  "backFields": [
    { "label": "Profile", "value": "https://jov.ie/tim" },
    { "label": "Share", "value": "Scan the QR code to open this Jovie profile." }
  ],
  "color": "#000000",
  "logoURL": "https://jov.ie/logo-wallet.png",
  "thumbnailURL": "https://jov.ie/u/tim/avatar.png"
}
```

Jovie should call this from the **Jovie backend**, not directly from the browser, because the API key needs to remain private.

Flow:

```text
User taps “Add Jovie to Apple Wallet”
        ↓
Jovie backend validates logged-in user
        ↓
Jovie backend creates/updates pass payload
        ↓
WalletWallet returns .pkpass
        ↓
Browser downloads .pkpass
        ↓
iPhone shows “Add to Apple Wallet”
```

WalletWallet’s current pricing page lists a free tier for 1,000 passes/month and a Pro tier with 100,000 passes/month, live updates, push notifications, location triggers, logo/thumbnail/strip/icon support, and custom cert options. citeturn540046view6

### Option B — first-party PassKit implementation

This gives Jovie maximum control. You would generate and sign `.pkpass` bundles yourself.

Required pieces:

1. Apple Developer account.
2. Apple Pass Type ID.
3. Pass Type ID certificate.
4. Backend pass generator.
5. Pass signing pipeline.
6. Optional pass update web service.
7. Optional APNs integration for installed-pass updates.

Apple’s docs state that pass distribution/update requires registering a Pass Type ID and creating a Pass Type ID certificate. citeturn540046view1 Apple also describes a pass as a signed bundle containing the JSON pass description, images, and optional localizations. citeturn838844search15

For a first-party build, the backend would create:

```text
pass.json
icon.png
logo.png
thumbnail.png
manifest.json
signature
```

Then zip them into:

```text
jovie-profile.pkpass
```

This is more work than using WalletWallet, but better if Jovie wants full infrastructure ownership.

## Recommended MVP

Build this in Jovie as a profile feature:

```text
Profile → Share → Add to Apple Wallet
```

MVP fields:

| Area | Content |
|---|---|
| Logo | Jovie |
| Primary | User’s display name |
| Secondary | `@handle` |
| Header | “PROFILE” |
| QR | Public Jovie profile URL |
| Thumbnail | Avatar |
| Back | Bio, profile URL, share explanation |

Backend data model:

```ts
type WalletPass = {
  id: string;
  userId: string;
  provider: "apple";
  serialNumber: string;
  profileUrl: string;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date;
};
```

Endpoints:

```text
POST /api/wallet/apple/profile
GET  /api/wallet/apple/profile.pkpass
POST /api/wallet/apple/profile/refresh
```

For WalletWallet, store the returned `X-Serial-Number` so Jovie can update an existing pass later. Their docs say the serial number is returned in the response header and is used for future `PUT /api/pkpass/<serial>` updates. citeturn739800view0

## High-leverage features

### 1. Dynamic pass updates

If a user changes their avatar, handle, name, or profile URL, Jovie can push an update to the installed pass. Apple supports updateable passes through a pass web service, and WalletWallet exposes a `PUT /api/pkpass/<serial>` path for updating installed passes. citeturn838844search0turn739800view0

### 2. Conference mode

This could be useful for events:

- “Open my Jovie”
- “Scan to connect”
- “Currently at: SF Tech Week”
- Temporary event badge variant
- Lock-screen surfacing near an event location

WalletWallet supports location triggers on Pro, and Apple Wallet supports contextual pass relevance. citeturn739800view0

### 3. Referral loop

The QR can route through a tracking link:

```text
https://jov.ie/p/tim?src=apple_wallet
```

Track:

- Wallet adds
- Profile scans
- Follows/connections created from wallet scans
- Referrals generated from wallet passes

### 4. Claimable offline identity

This makes Jovie more tangible. A user can say: “Scan my Wallet pass.” That is a strong real-world bridge for profile discovery.

## Constraints

- Apple Wallet pass design is structured. It is not a free-form mini webpage.
- The pass should use a QR code for the profile open/share action.
- Push updates require backend state and either Apple’s pass web service or a vendor that handles it.
- For production, Jovie should keep all signing credentials and API keys server-side.
- For full first-party branding/control, use Jovie’s Apple Developer Pass Type ID certificate.

## Recommendation

Ship **Option A first** using WalletWallet or a similar `.pkpass` API. Treat it as a fast product test:

```text
Jovie Profile → Apple Wallet → QR profile sharing → scan analytics
```

Then move to first-party PassKit once the feature proves usage or becomes core to Jovie’s identity layer.

---

## User

Is there a reason we wouldn't just ship passkit from the get-go and not have to rely on another provider? I feel like that would be the better move, right? And then we should also be able to surface this in the Jovi app. Then you have your profile, should be like an add Apple Wallet thing. And then in the chat, we should even, you know, when Jovi encourages you to share it, we should, you know, be like, hey, a good way to share this is to put it in your Apple Wallet or something, you know what I mean? And then we should explore how it can be used for like, you know, way to share. Yeah, like it should be a way to share your profile, and then we should also look if there's like a way to like share getting paid, you know? If like you can get paid right from the Apple Wallet, that might be a good move too. But I guess the profile is probably enough.

---

## Assistant

I’ll sanity-check current PassKit capabilities and separate the strategic product call from platform constraints, especially around profile sharing versus getting paid directly from Wallet.

---

## Assistant

Yes, Mr. White. I think your instinct is right: **ship first-party PassKit from the start** if this is going to be part of Jovie’s identity/share layer.

The third-party provider path only makes sense for a throwaway experiment. A Jovie Wallet profile is strategic enough that owning the pass infrastructure is probably worth the upfront work.

## Why first-party PassKit is the better move

### Advantages

| Area | First-party PassKit advantage |
|---|---|
| Brand | The pass feels native to Jovie, not rented infrastructure. |
| Control | Jovie owns pass design, signing, updates, serial numbers, revocation, and analytics. |
| Privacy | User profile data does not need to pass through another vendor. |
| Reliability | No dependency on someone else’s API, pricing, rate limits, or product direction. |
| Product depth | Easier to wire into the Jovie app, chat flows, sharing prompts, profile updates, and future monetization. |
| Defensibility | Wallet identity becomes part of Jovie’s product surface, not a commodity integration. |

Apple’s pass model fits this well: a Wallet pass is a signed bundle containing JSON, images, and optional localization files, and the pass can be distributed from Jovie’s own server. citeturn106500search12turn259305view0

## The only real reasons to avoid first-party

There are a few legitimate reasons to use a provider first:

1. **Faster first prototype**
   - A third-party API can get a demo live quickly.

2. **Pass signing complexity**
   - Jovie needs Apple Wallet certificates, signing, manifest generation, and `.pkpass` packaging.

3. **Update infrastructure**
   - If passes should update when a user changes their avatar, name, handle, or profile URL, Jovie needs a pass update web service. Apple documents this as a server that registers, updates, and unregisters passes on devices. citeturn106500search6turn106500search10

4. **Operational ownership**
   - Jovie becomes responsible for pass versioning, expired passes, revoked profiles, deleted users, image caching, and certificate rotation.

Those are solvable. For a real product feature, they are also the correct problems to own.

## Recommended decision

**Build PassKit directly.**

Use WalletWallet only as inspiration for the UX, not as infrastructure.

The Jovie version should be:

```text
Jovie Profile
→ Add to Apple Wallet
→ Wallet pass with QR/deep link
→ Scan opens Jovie profile
→ Jovie tracks source, conversion, and share graph
```

## Pass type

Use a **generic Wallet pass** for v1. Apple describes generic passes as the right style for passes that do not fit boarding passes, coupons, event tickets, or store cards. A profile card fits that category. citeturn106500search4turn259305view3

I would avoid pretending this is a loyalty card, membership card, or payment card in v1. Make it explicitly:

```text
JOVIE PROFILE
```

## In-app surface

In the Jovie app, this should be a native CTA:

```text
Profile
Share
Add to Apple Wallet
```

On iOS, the app can use `PKAddPassesViewController` to show the pass and prompt the user to add it to Wallet. Apple also provides `PKAddPassButton` for showing that a pass is available in an app or App Clip. citeturn106500search1turn106500search16

Native flow:

```text
User opens Jovie profile
→ taps Share
→ taps Add to Apple Wallet
→ Jovie app requests .pkpass from Jovie backend
→ app presents PKAddPassesViewController
→ user approves adding the pass
```

Apple requires the user to explicitly approve adding a pass to Wallet. citeturn259305view0

## Web surface

Also support this on mobile web:

```text
jov.ie/me
→ Add to Apple Wallet
→ download .pkpass
→ iOS opens Wallet add sheet
```

Jovie’s server should serve the pass with the correct Wallet MIME type:

```text
application/vnd.apple.pkpass
```

Apple specifically says Mail and Safari expect that MIME type for pass data. citeturn259305view0

## Chat surface

This is where it gets interesting. Jovie should recommend the Wallet pass contextually.

Example prompts inside chat:

> “A good way to share this is to add your Jovie profile to Apple Wallet. Then people can scan your profile from your lock screen.”

> “Want a faster way to share your Jovie profile in person? Add it to Apple Wallet.”

> “You can add this profile to Apple Wallet and use it like a digital profile card.”

Use it when the user intent is:

- “How do I share my profile?”
- “How do I get more people to see this?”
- “How do I network at this event?”
- “How do I send this to someone?”
- “How do I make this easier to share in person?”

The chat should not spam the CTA. It should appear when sharing is already the goal.

## What should be on the pass

### Front

| Field | Value |
|---|---|
| Logo | Jovie |
| Header | PROFILE |
| Primary | Display name |
| Secondary | `@handle` |
| Auxiliary | Role, tagline, or short status |
| Thumbnail | Avatar |
| Barcode | QR code to profile URL |

Example:

```text
Jovie

PROFILE

Tim White
@tim

Founder
Scan to open profile
```

### QR destination

Use a tracking URL, not the raw profile URL:

```text
https://jov.ie/p/tim?src=apple_wallet
```

Or better:

```text
https://jov.ie/w/tim
```

Then resolve server-side.

That lets Jovie track:

- Wallet pass installs
- Wallet profile scans
- Scan-to-follow conversion
- Scan-to-message conversion
- Scan-to-payment conversion later
- Event/location campaigns later

### Back of pass

Back fields:

```text
Profile
https://jov.ie/tim

About
Founder of Jovie

Share
Show this pass and let someone scan the QR code.

Open in Jovie
https://jov.ie/tim?open_app=1
```

## System architecture

```text
iOS app / web
   ↓
POST /api/wallet/apple/profile-pass
   ↓
Jovie backend
   ↓
Profile service
   ↓
Pass generator
   ↓
Signer using Apple Pass Type certificate
   ↓
.pkpass returned to app/browser
   ↓
Apple Wallet add sheet
```

### Core backend components

| Component | Responsibility |
|---|---|
| Pass generator | Builds `pass.json`, images, manifest, and `.pkpass`. |
| Signing service | Signs pass bundle with Jovie Pass Type certificate. |
| Pass registry | Stores user ID, serial number, pass type ID, auth token, install state. |
| Update service | Handles Apple Wallet pass update callbacks. |
| Analytics service | Tracks add attempts, installs, scans, profile opens, downstream actions. |
| Image service | Produces Wallet-safe avatar/logo assets. |

### Data model

```ts
type AppleWalletProfilePass = {
  id: string;
  userId: string;
  passTypeIdentifier: string;
  serialNumber: string;
  authenticationTokenHash: string;
  profileUrl: string;
  walletShareUrl: string;
  displayName: string;
  handle: string;
  avatarAssetVersion: string;
  passVersion: number;
  createdAt: Date;
  updatedAt: Date;
  revokedAt?: Date;
};
```

## Updates

When a user changes their:

- avatar
- display name
- handle
- profile URL
- bio
- availability/status

Jovie should update the pass.

Apple supports updating pass content with push notifications through PassKit. citeturn106500search2turn106500search21

For v1, I would support updates for:

```text
display_name
handle
avatar
profile_url
```

Avoid making the pass too dynamic at first. It should feel stable, like a profile card.

## “Getting paid from Apple Wallet”

This is the part to separate carefully.

### What is realistic for v1

The Wallet pass can include a QR code or link that opens a Jovie profile with a payment action:

```text
Scan Wallet pass
→ opens Jovie profile
→ user taps Pay / Tip / Book / Hire
→ Apple Pay checkout in app or web
```

Apple Pay on the web supports payment requests for checkout flows, and Apple documents Apple Pay as a way to accept payments in apps and on websites. citeturn106500search3turn270579search6

That is the clean path.

### What is probably not the v1 path

I would not design v1 around “pay directly from the Wallet pass” as though the pass itself becomes a payment acceptance terminal or payment instrument.

A Wallet pass is primarily a signed pass with fields, images, barcodes, relevance metadata, and update hooks. Apple Pay is a separate payment flow involving payment requests, merchant setup, and payment authorization. citeturn106500search12turn106500search7

### Payment-related options

| Use case | Recommended approach |
|---|---|
| Someone scans my profile and pays me | QR opens Jovie profile → Jovie payment page → Apple Pay / card / ACH. |
| Jovie pays money out to a user | Explore Apple Pay funds disbursement / `PKDisbursementRequest`. |
| User wants a “pay me” wallet card | Pass QR opens a Jovie pay link. |
| Creator tips | Profile page supports tip/payment CTA. |
| Booking/hiring | Profile page supports checkout or deposit. |

Apple does support fund disbursement flows through Apple Pay infrastructure, including `PKDisbursementRequest`, which is for merchant-to-user disbursement such as withdrawing money from an online account. citeturn270579search2turn270579search0 Apple’s merchant integration guide also describes disbursement requests as available through Payment Request API on web and `PKDisbursementRequest` in app. citeturn270579search16

That matters if Jovie eventually has balances, creator earnings, referrals, or payouts. It is separate from the profile pass.

## Product framing

The v1 product should be simple:

> **Your Jovie profile, always in your Wallet.**

Core use cases:

1. **In-person sharing**
   - Open Wallet.
   - Show Jovie pass.
   - Other person scans QR.
   - They land on your profile.

2. **Events**
   - “Add your Jovie profile to Wallet before the event.”
   - “Scan to connect.”
   - Track event-driven profile opens.

3. **Creator/business profile**
   - Scan opens profile with follow, message, book, pay, subscribe, or tip.

4. **Chat recommendation**
   - When Jovie detects sharing intent, suggest adding the profile to Wallet.

5. **Lock-screen relevance later**
   - If Jovie has event/location context, a pass can include relevance metadata. Apple’s pass docs support relevance using date/location information, with constraints. citeturn259305view3

## Build order

### Phase 1 — Profile pass MVP

Ship:

- Apple Wallet Pass Type ID
- Pass certificate
- `.pkpass` generator
- Add to Apple Wallet button in app
- Add to Apple Wallet button on mobile web
- QR to Jovie profile
- Scan analytics
- Basic pass updates for avatar/name/handle

### Phase 2 — Chat integration

Add contextual prompts:

```text
“Add this to Apple Wallet so people can scan your profile in person.”
```

Trigger on:

- share intent
- networking intent
- event prep
- creator/business setup
- profile completion

### Phase 3 — Monetization hooks

Add to profile landing page:

- Pay
- Tip
- Book
- Hire
- Subscribe
- Buy
- Request intro

Do this on the Jovie profile page, not directly inside the Wallet pass.

### Phase 4 — Payouts / Apple Pay disbursement research

Explore:

- Apple Pay merchant setup
- `PKDisbursementRequest`
- processor support
- compliance
- creator/user balances
- instant payout economics

## My recommendation

Ship first-party PassKit.

Make v1 narrowly about **profile sharing**:

```text
Add Jovie Profile to Apple Wallet
→ Scan to open profile
→ Track sharing
→ Use chat to recommend the pass when sharing intent appears
```

Then use the profile landing page as the monetization surface. The Wallet pass becomes the physical-world entry point into the Jovie profile, and payments can come later through Apple Pay, tips, bookings, or payouts.
