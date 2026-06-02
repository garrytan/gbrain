---
conversation_id: 6a06990d-6dc8-83e8-a919-66a35cceca85
created: 2026-05-15
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Onboarding Flow Design
type: guide
updated: 2026-05-15
---

# Onboarding Flow Design

**Related:** [[design_ux]]

> Conversation ID: 6a06990d-6dc8-83e8-a919-66a35cceca85
> Created: 2026-05-15T03:54:54Z
> Updated: 2026-05-15T05:30:43Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000f3b071f88a9e7d6bf86d322c', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1330, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1692492, 'width': 2048}
I want you to design our new onboarding flow with me.

I love this. i want to use exactly this for how we display qr codex in the chat and how we show your artist profile when its ready.

can you help me spec this as a plan i can hand off to a coding agent. interview me for what i want and look at our recent convos to figure out what the killer experience is. i want cinematic transitions between app states. 



---

## Assistant

Mr. White, this should become Jovie’s **product theater** pattern: chat on one side, cinematic live preview on the other, and the QR/profile reveal as the payoff moment.

From recent Jovie direction, the killer flow is:

**Artist enters `/start` → JovieChat interviews them → Spotify/catalog import starts → Jovie builds the artist profile → the profile appears in a phone theater → QR appears beside it → artist scans or shares → Jovie recommends the first revenue/fan action.**

The first “wow” should be: **“Your artist profile is alive.”**  
The second should be: **“Here’s the QR that turns any scan into a fan.”**  
The third should be: **“Approve the first move.”**

## Core product pattern

Use the Codex screen almost directly as the model:

### Left side: action card

Dark canvas. One headline. One subline. One QR card. Minimal controls.

For Jovie:

**State A — Profile preview ready**

Headline:  
**Your artist profile is ready**

Subline:  
Scan to view it on your phone.

Card:
- QR code
- `jov.ie/{handle}`
- segmented tabs or small controls:
  - **Profile**
  - **Tip**
  - **Drop Alerts**
  - **Release**

Primary desktop action:
**Publish profile**

Secondary:
**Copy link**

### Right side: phone theater

The phone shows the actual artist profile. It should feel alive, not like a screenshot.

Phone states:
1. Blank glass / soft loading
2. Artist identity fades in
3. Release artwork expands
4. Primary CTA appears
5. Fan capture drawer slides up
6. QR pulse connects left QR → phone preview

This becomes the visual language for every major onboarding milestone.

## Recommended onboarding spine

### 1. `/start`

The page is an app shell, not a landing page.

Left:
- JovieChat onboarding mode
- Chat asks for artist name, Spotify link, or release link
- No traditional form-first onboarding

Right:
- Empty cinematic phone stage
- Placeholder copy: **Build your artist profile**
- Subtle glowing phone silhouette or blurred album art placeholder

Default prompt:

> Paste a Spotify link or type your artist name.

### 2. Artist found

Jovie searches Spotify/catalog data.

Visual:
- Phone stage shows album art fragments
- Songs stack into a mini catalog
- The chat says something like:
  > Found the catalog. Building your profile now.

Required data:
- Artist name
- Handle
- Profile image
- At least one DSP/music source

Keep this deterministic. The chat can feel magical, but the completion rules should stay strict.

### 3. Catalog imported

Jovie maps songs into release surfaces.

Visual:
- Songs collapse into profile modules
- Smart links appear
- Upcoming/recent releases appear
- Drop Alerts module appears

Microcopy:
> Imported your catalog.  
> Jovie is turning it into a live profile.

### 4. Profile ready reveal

This is the Codex-inspired moment.

Full-screen transition into the QR/profile theater.

Left:
- **Your artist profile is ready**
- QR code
- `jov.ie/{handle}`
- Profile / Tip / Alerts / Release segmented control

Right:
- iPhone mockup with the live artist profile
- Actual artwork, name, release, CTA
- Dominant CTA inside phone: **Listen**, **Get alerts**, or **Support**

Desktop CTA:
**Publish profile**

Secondary:
**Copy link**

### 5. Scan path demo

After the profile is ready, show the fan path.

The QR glows once. The phone transitions:

**QR scan → artist profile → primary CTA → fan capture → thank-you**

This should happen in 5–7 seconds with almost no text.

Possible fan flow:
- Fan scans QR
- Profile opens
- Fan taps **Get alerts**
- Confirmation appears:
  > You’ll hear from {artist} when the next drop goes live.

For tip/pay mode:
- Fan scans QR
- Taps support amount
- Apple Pay success blink
- Thank-you message appears
- Fan capture prompt follows

### 6. First move recommendation

After the profile reveal, Jovie should immediately recommend one action.

Given recent direction, the best default is:

**Ship a Friday drop**

Examples:
- “Create a merch drop from this release”
- “Turn this release into a Drop Alert”
- “Generate a QR for tonight’s show”
- “Create a pre-save page”
- “Collect fans before your next release”

This is where Jovie starts feeling like an AI manager rather than a profile builder.

CTA:
**Approve first move**

## Cinematic transition system

Use app-state transitions, not page changes.

### State machine

```ts
type OnboardingState =
  | "idle"
  | "artist_search"
  | "artist_selected"
  | "catalog_importing"
  | "catalog_imported"
  | "profile_building"
  | "profile_ready"
  | "qr_handoff"
  | "fan_path_preview"
  | "first_move_recommended"
  | "checkout";
```

### Transition language

| From | To | Motion |
|---|---|---|
| Idle | Artist search | Chat input expands, right phone wakes from black |
| Artist search | Catalog importing | Album art tiles drift into view |
| Catalog importing | Profile building | Catalog cards collapse into phone |
| Profile building | Profile ready | Phone locks center, QR card scales in |
| Profile ready | QR handoff | QR emits subtle pulse toward phone |
| QR handoff | Fan path preview | Phone switches from artist/admin preview to fan POV |
| Fan path preview | First move | Chat composer morphs into approval bar |

Motion rules:
- 400–700ms transitions
- Dark background
- Premium easing
- Minimal copy
- One dominant CTA per state
- Respect `prefers-reduced-motion`
- No busy onboarding checklist feeling

## Coding-agent handoff plan

### Objective

Build a cinematic onboarding flow for Jovie where `JovieChat` progressively creates an artist profile, then reveals a Codex-inspired QR/profile theater showing the live artist profile and share QR.

### Target routes

Likely affected areas:

```txt
apps/web/app/onboarding/layout.tsx
apps/web/app/onboarding/page.tsx
apps/web/app/onboarding/checkout/page.tsx
apps/web/components/features/demo/OnboardingDemoSteps.tsx
```

Add or refactor into:

```txt
apps/web/components/onboarding/OnboardingShell.tsx
apps/web/components/onboarding/OnboardingChatPanel.tsx
apps/web/components/onboarding/OnboardingTheater.tsx
apps/web/components/onboarding/QRCodeHandoffCard.tsx
apps/web/components/onboarding/ArtistProfilePhonePreview.tsx
apps/web/components/onboarding/ProfileReadyReveal.tsx
apps/web/components/onboarding/FanPathPreview.tsx
apps/web/components/onboarding/FirstMoveRecommendation.tsx
apps/web/lib/onboarding/onboarding-state.ts
```

### Main components

#### `OnboardingShell`

Full-screen app shell.

Responsibilities:
- Own layout
- Split left chat / right theater
- Route onboarding state into visual state
- Preserve dark cinematic design

#### `OnboardingChatPanel`

JovieChat in onboarding mode.

Responsibilities:
- Collect artist name/link
- Show progress messages
- Trigger state changes
- Surface missing required fields
- Convert final state into checkout/publish path

#### `OnboardingTheater`

Right-side product theater.

Responsibilities:
- Render the correct visual stage
- Animate between states
- Keep phone mockup persistent
- Avoid remounting the whole phone between states

#### `QRCodeHandoffCard`

Codex-inspired QR card.

Props:

```ts
type QRCodeHandoffCardProps = {
  title: string;
  subtitle: string;
  qrValue: string;
  mode: "profile" | "tip" | "alerts" | "release";
  handle: string;
  onCopyLink: () => void;
  onPublish?: () => void;
};
```

Default QR values:
- Profile: `https://jov.ie/{handle}`
- Tip: `https://jov.ie/{handle}/tip`
- Alerts: `https://jov.ie/{handle}?mode=alerts`
- Release: `https://jov.ie/{handle}/{releaseSlug}`

Add tracking:
```txt
?utm_source=onboarding_qr&utm_medium=qr&utm_campaign=profile_setup
```

#### `ArtistProfilePhonePreview`

Phone mockup using real artist data.

Props:

```ts
type ArtistProfilePhonePreviewProps = {
  artistName: string;
  handle: string;
  imageUrl?: string;
  heroArtworkUrl?: string;
  primaryRelease?: {
    title: string;
    artworkUrl?: string;
    releaseDate?: string;
  };
  mode: "profile" | "tip" | "alerts" | "release";
  previewState: "loading" | "ready" | "fan_path" | "success";
};
```

### Required data model

```ts
type OnboardingArtistProfile = {
  artistId?: string;
  name: string;
  handle: string;
  imageUrl?: string;
  spotifyArtistUrl?: string;
  dspConnected: boolean;
  catalogImported: boolean;
  profileComplete: boolean;
  profilePublished: boolean;
  profileUrl: string;
  qrUrl: string;
  primaryRelease?: {
    id: string;
    title: string;
    slug: string;
    artworkUrl?: string;
    releaseDate?: string;
  };
};
```

### Completion rules

Dashboard access should require:

```ts
profileComplete === true
```

Where:

```ts
profileComplete =
  Boolean(name) &&
  Boolean(handle) &&
  Boolean(imageUrl) &&
  dspConnected === true;
```

The flow can show a beautiful preview before completion, but publishing should clearly collect missing required items.

### Analytics events

```txt
onboarding_started
onboarding_artist_search_submitted
onboarding_artist_selected
onboarding_catalog_import_started
onboarding_catalog_import_completed
onboarding_profile_build_started
onboarding_profile_ready
onboarding_qr_revealed
onboarding_qr_mode_changed
onboarding_qr_copied
onboarding_profile_published
onboarding_fan_path_previewed
onboarding_first_move_recommended
onboarding_first_move_approved
onboarding_checkout_started
onboarding_checkout_completed
```

### Acceptance criteria

1. `/start` opens a full-screen dark onboarding shell.
2. User can enter artist name, Spotify artist link, or release link.
3. Jovie progresses through artist search, catalog import, profile build, and profile ready states.
4. Profile-ready state uses the Codex-inspired layout:
   - Left QR/action card
   - Right phone mockup
   - Minimal copy
   - One dominant CTA
5. QR code points to the real public artist profile URL.
6. QR mode can switch between Profile, Tip, Alerts, and Release.
7. Phone preview updates when QR mode changes.
8. Publish action is gated by deterministic profile completeness.
9. All transitions respect `prefers-reduced-motion`.
10. Works on desktop and mobile.
11. Existing checkout/onboarding route still works.
12. Add test IDs for profile mobile preview, QR card, publish CTA, and onboarding state transitions.

## My default product call

Make the onboarding payoff:

**“Your artist profile is ready.”**

Then immediately show:

**QR → fan profile → fan capture → first move recommendation.**

This connects every recent Jovie thread:
- artist profile as the acquisition wedge
- QR as the real-world bridge
- catalog import as the first setup action
- AI manager as the next layer
- merch/drop/opportunity workflow as the paid expansion

## Interview round 1

Answer these and I’ll turn this into a tighter coding-agent spec:

1. Should the first reveal say **“Your artist profile is ready”** or **“Your Jovie is ready”**?

2. When the QR appears, should it open the **public fan profile** by default, or a **mobile owner approval/setup flow** like Codex?

3. What should the first dominant CTA be after the reveal: **Publish profile**, **Share QR**, **Start collecting fans**, or **Approve first move**?

4. Should the first “AI manager” move be **Merch Drop**, **Drop Alerts**, **Pre-save**, or **QR for tonight’s show**?

5. Do you want profile publishing to happen automatically once required fields are complete, or should the artist always click **Publish**?

6. Should the phone preview show a real Jovie public profile UI, or a more cinematic simplified version built only for onboarding?

7. Should checkout happen before publish, after publish, or only when the artist approves the first paid workflow?

8. Which mode should the segmented control default to: **Profile**, **Tip**, **Alerts**, or **Release**?


**Topic:** [[chatgpt-clusters/design_ux]]


## See Also
- [[chatgpt/chatgpt_ai-driven-onboarding-design]]
- [[chatgpt/chatgpt_onboarding-design-simplification]]
- [[chatgpt/chatgpt_onboarding-flow-recommendation]]
- [[chatgpt/chatgpt_onboarding-name-input-design-part1]]
- [[chatgpt/chatgpt_onboarding-name-input-design-part2]]
