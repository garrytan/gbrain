---
title: "Design Spacing Assistance"
type: guide
created: 2026-05-14
updated: 2026-05-15
source: chatgpt-export
conversation_id: 6a064829-f7cc-83e8-9bca-595ed0b2e0fc
message_count: 3
tags: [chatgpt, import, code, long-form]
---
# Design Spacing Assistance

> Conversation ID: 6a064829-f7cc-83e8-9bca-595ed0b2e0fc
> Created: 2026-05-14T22:09:48Z
> Updated: 2026-05-15T05:43:33Z
> Messages: 3

---

## User

Our public profiles still look materially bad. jov.ie/tim These things are like squashed and shit and stuff like that. I just don't know how to properly protect the spacing on all screen rights and stuff to be an explicit prompt to help do that and generate a design, or you should generate a design as an image version. You should just have it pixel dip it and loop them all the time. Help me out a little bit about it. 

---

## Assistant

I’ll inspect the live profile and frame this as a responsive design-system fix, then produce an executable spec/prompt with breakpoint protections, screenshots, and pixel-diff QA loops.

---

## Assistant

Mr. White, treat this as **responsive-layout hardening**, then design polish.

The live page is a simple public profile stack: background image, avatar image, name, artist/location metadata, alert CTA, new-release card, and bottom nav. That means the fix should protect a small set of reusable modules rather than hand-tweak `jov.ie/tim` only. citeturn279201view0

## Copy-paste prompt for Cursor / engineer

```text
Audit and harden the Jovie public profile page layout, starting with /tim.

Goal:
Make the profile visually stable across all screen widths, with no squashed images, clipped text, overlapping sections, broken spacing, horizontal overflow, or bottom-nav collision.

Current page modules:
- Cover/background image
- Circular avatar
- Name, role, location
- Alert CTA module
- New release module
- Bottom navigation

Design principles:
1. Mobile-first. The 360–430px range is the primary layout.
2. Every image must preserve aspect ratio. No stretched or squeezed images.
3. Every section must have explicit min/max sizing.
4. Spacing must use fluid tokens, not random breakpoint overrides.
5. Text containers must be allowed to wrap safely.
6. Cards and CTAs must never compress below their readable minimum.
7. Fixed bottom nav must respect iOS safe-area insets.
8. Page content must have enough bottom padding so the nav never covers content.
9. The layout must pass screenshot tests at multiple viewport widths.

Responsive breakpoints to test:
- 320x568
- 360x740
- 375x667
- 390x844
- 414x896
- 430x932
- 768x1024
- 1024x768
- 1280x800
- 1440x900

Implementation requirements:
- Add a shared public-profile layout shell.
- Add CSS design tokens:
  --page-pad: clamp(16px, 4vw, 32px)
  --section-gap: clamp(16px, 3vw, 28px)
  --card-pad: clamp(14px, 3vw, 24px)
  --avatar-size: clamp(88px, 22vw, 144px)
  --cover-height: clamp(220px, 42svh, 520px)
  --content-max: 720px
- Use aspect-ratio for avatar, artwork, media cards, and any square/circular image.
- Use object-fit: cover and object-position for profile/cover images.
- Add min-width: 0 to flex/grid children containing text.
- Add overflow-wrap: anywhere where usernames, track names, merch names, or long locations could overflow.
- Avoid fixed heights for cards with dynamic text.
- Use min-height instead of hard height for CTA/card components.
- Ensure all CTA buttons have a minimum 44px tap target.
- Ensure page wrapper has:
  padding-left/right: max(var(--page-pad), env(safe-area-inset-left/right))
  padding-bottom: calc(nav height + env(safe-area-inset-bottom) + 24px)
- Ensure fixed bottom nav has:
  padding-bottom: max(12px, env(safe-area-inset-bottom))

Acceptance criteria:
- No horizontal scrolling at any tested width.
- No image distortion.
- No text clipping.
- No CTA/button overlap.
- No content hidden behind bottom nav.
- Profile header looks intentional at 320px, 390px, 768px, and desktop.
- Visual diff tests are added and fail CI if layout regresses.
```

## CSS guardrail snippet

Use this as the layout foundation:

```css
.publicProfile {
  --page-pad: clamp(16px, 4vw, 32px);
  --section-gap: clamp(16px, 3vw, 28px);
  --card-pad: clamp(14px, 3vw, 24px);
  --avatar-size: clamp(88px, 22vw, 144px);
  --cover-height: clamp(220px, 42svh, 520px);
  --content-max: 720px;

  min-height: 100svh;
  overflow-x: clip;
  padding-left: max(var(--page-pad), env(safe-area-inset-left));
  padding-right: max(var(--page-pad), env(safe-area-inset-right));
  padding-bottom: calc(88px + env(safe-area-inset-bottom));
}

.publicProfile__content {
  width: min(100%, var(--content-max));
  margin-inline: auto;
  display: grid;
  gap: var(--section-gap);
}

.publicProfile__cover {
  position: relative;
  height: var(--cover-height);
  border-radius: 0 0 28px 28px;
  overflow: hidden;
}

.publicProfile__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 32%;
  display: block;
}

.publicProfile__avatar {
  width: var(--avatar-size);
  aspect-ratio: 1;
  border-radius: 999px;
  overflow: hidden;
  flex: 0 0 auto;
}

.publicProfile__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.publicProfile__text,
.publicProfile__card,
.publicProfile__cta {
  min-width: 0;
}

.publicProfile__title,
.publicProfile__subtitle,
.publicProfile__meta,
.publicProfile__cardTitle {
  overflow-wrap: anywhere;
}

.publicProfile__card,
.publicProfile__cta {
  padding: var(--card-pad);
  min-height: 72px;
  border-radius: 20px;
}

.publicProfile__bottomNav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
}
```

`clamp()` is the right primitive here because it gives a value a minimum, preferred, and maximum bound; `object-fit` controls how images resize inside their boxes; and `env(safe-area-inset-*)` protects UI from device safe areas such as bottom insets. citeturn793127search0turn139958search0turn793127search2

## Pixel-diff loop prompt

```text
Add Playwright visual regression coverage for the public profile page.

Create screenshot tests for /tim at:
320x568, 360x740, 375x667, 390x844, 414x896, 430x932, 768x1024, 1024x768, 1280x800, 1440x900.

Before each screenshot:
- Wait for images to load.
- Disable animations/transitions.
- Assert document.documentElement.scrollWidth <= window.innerWidth.
- Assert all visible img elements have non-zero naturalWidth/naturalHeight.
- Assert no core module overlaps the fixed bottom nav.

Core modules:
- cover
- avatar
- profile text
- alert CTA
- new release card
- bottom nav

Fail CI when:
- horizontal overflow exists
- screenshot diff exceeds threshold
- a core module is clipped
- bottom nav covers content
```

## Design-image prompt

Use this when generating a visual mockup:

```text
Create a high-fidelity responsive UI mockup for a Jovie public artist profile page.

Show three frames side-by-side:
1. Mobile: 390x844
2. Tablet: 768x1024
3. Desktop: 1440x900

Content:
- Artist name: Tim White
- Role: Artist
- Location: Los Angeles, CA
- Alert CTA: "New music, events and merch" with a "Get alerts" button
- New Release card: "Dont Look Down", Single, Out Now, Listen Now
- Bottom nav: Home, Music, Alerts, More

Visual requirements:
- Premium music-profile feel
- Clean, spacious, app-like
- Strong image treatment with no stretching
- Cover image cropped intentionally
- Circular avatar overlaps the cover/header area
- Mobile layout is the primary design
- Cards have generous padding
- Buttons are easy to tap
- Text never touches screen edges
- Bottom nav respects safe area
- Desktop uses a centered max-width content column or tasteful two-column expansion
- Avoid dense stacking, cramped cards, tiny buttons, or clipped text

The design must clearly demonstrate protected spacing across all three screen sizes.
```

The practical fix: build the layout constraints first, then run pixel-diff tests continuously. A single pretty mockup will still break unless the code protects aspect ratios, min widths, safe areas, and bottom-nav spacing.
