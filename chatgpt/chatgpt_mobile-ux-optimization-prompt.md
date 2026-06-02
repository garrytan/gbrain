---
title: "Mobile UX Optimization Prompt"
type: guide
created: 2026-02-15
updated: 2026-02-15
source: chatgpt-export
conversation_id: 6991ffae-2438-8332-bbca-4a2855a4d9bc
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Mobile UX Optimization Prompt

> Conversation ID: 6991ffae-2438-8332-bbca-4a2855a4d9bc
> Created: 2026-02-15T17:19:25Z
> Updated: 2026-02-15T17:20:12Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_000000001bd071f8b28244fbc2ed6a2d', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 154149, 'width': 708}
Hey, I want you to look at the UX issues and on here primarily I’m seeing that like the size of the Headline is an optimized for and like generally there’s nuts there’s not mobile specific classes for the each one needs to and each train shit to make this look really good on mobile and then also I’m noticing that the hamburger menu when you click it it gets clipped on the top and you only see the sign up button and then finally on mobile. It seems like the logo that should be top left is not showing up. I want you to give me a prompt for Claude code that I can get it to iteratively work on improving this and making it world class and you ask, I actually like it to go and do the work then spin up like playwright or whatever tool that has access to take a screenshot and then look at the screenshot and then reevaluate to determine if there’s any issues that need to be fixed and then loop through until it looks like a world class mobile landing page now obviously that’s not a very deterministic goal so I fear that it’s it’s if I just prompt that directly it’s gonna have trouble so I’d like you to figure out a prompt that will give it more deterministic about eval’s our goals so that it can effectively run on its own achieve that and then move on and then finally within that I need you to also at the end tack on these/ship/command that we have which has built-in full series of verifications and stuff before opening up PR

---

## Assistant

Mr. White, here’s a Claude Code prompt you can paste that’s **iterative**, **screenshot-driven**, and **more deterministic** via explicit mobile UX acceptance criteria + a scoring rubric + hard stop conditions.

```text
You are an expert front-end + UX engineer. Your job is to make this landing page look world-class on mobile.

Repo context:
- This is a marketing landing page deployed on Vercel.
- Primary target: mobile Safari (iOS).
- You MUST use an automated, repeatable loop: change code → run Playwright → take screenshots → evaluate against criteria → repeat.

Non-negotiable issues to fix (from current mobile state):
1) Headline typography is not mobile-optimized (oversized/poor line breaks). Add mobile-specific styles (responsive typography, spacing, container widths).
2) Hamburger menu is clipped at the top when opened; only “Sign up” is visible. The menu overlay/drawer must be fully visible and scroll-safe.
3) Top-left logo is missing on mobile. It must appear, be aligned, and not collide with safe areas.

Operating rules:
- Work in small commits; don’t refactor unrelated code.
- Prefer CSS fixes (responsive classes/media queries), then minimal layout changes.
- Avoid regressions on desktop/tablet.

------------------------------------------------------------
A) Define “world-class mobile” as ACCEPTANCE CRITERIA (deterministic)
------------------------------------------------------------
Use these exact criteria. For each iteration, score PASS/FAIL and give notes.

Viewport targets (test all):
- iPhone SE (375x667)
- iPhone 14/15 (390x844)
- iPhone 14/15 Pro Max (430x932)

Global:
G1. No horizontal scrolling at any target viewport (PASS if scrollWidth == innerWidth).
G2. No clipped UI in header/nav/menu (PASS if all header/menu content visible, not cut by viewport top or safe area).
G3. Above-the-fold (first screen) contains: logo (top-left), primary CTA visible, headline fully readable (no awkward orphan words).
G4. Tap targets: header buttons and hamburger ≥ 44px min hit area (approx ok, but verify visually and via bounding boxes).
G5. Safe-area aware: header respects iOS notch (use env(safe-area-inset-*)) where relevant.

Typography & layout:
T1. Headline size/line-height: readable and balanced on mobile:
    - target: 28–40px font-size depending on viewport
    - line-height ~1.05–1.15
    - max 2–4 lines; avoid single-word last line if possible
T2. Subheadline is legible (no low-contrast gray-on-black failures) and not cramped.
T3. Spacing rhythm: consistent padding (16–24px typical), no huge dead zones.

Navigation/menu:
N1. Logo visible in header at all viewports.
N2. Hamburger opens a full menu without clipping; content is scrollable if needed.
N3. Menu can be closed easily; close button visible and reachable.
N4. Opening menu does not shift layout unexpectedly; body scrolling handled properly (lock scroll if overlay).

Visual polish:
V1. Header alignment looks intentional (baseline alignment, no jitter).
V2. No overlapping elements (menu over CTA, etc).
V3. Contrast meets common-sense accessibility (don’t ship faint text).

Stop conditions:
- Stop when ALL criteria G1–G5, T1–T3, N1–N4, V1–V3 are PASS for all 3 viewports.
- Hard cap: 8 iterations. If still failing, summarize remaining fails and propose next steps.

------------------------------------------------------------
B) Playwright-based visual evaluation loop (required)
------------------------------------------------------------
Set up or use existing Playwright. Add a script that:
1) Starts the dev server (or uses already-running one).
2) Visits the landing page route.
3) Sets each viewport listed above.
4) Captures:
   - full-page screenshot
   - above-the-fold screenshot (first viewport height)
   - screenshot with hamburger menu open
5) Saves screenshots to /tmp/ux-audit/iter-XX/<viewport>/...

Also gather basic metrics:
- document.documentElement.scrollWidth vs window.innerWidth
- bounding boxes of: logo, hamburger button, headline, primary CTA
- whether any bounding box has y < 0 when menu open (indicates clipping)

Output an “Iteration Report” each loop:
- PASS/FAIL table for each criterion
- screenshot paths
- the exact code/files changed

------------------------------------------------------------
C) Implementation guidance (what to change)
------------------------------------------------------------
Prioritize fixes in this order:
1) Header/logo rendering on mobile (ensure it’s not conditionally hidden by breakpoint, z-index, or overflow).
2) Menu overlay/drawer clipping (likely: position/fixed + top + safe-area + overflow + z-index; ensure menu container uses max-height: 100vh and padding-top: env(safe-area-inset-top)).
3) Typography + spacing (mobile-first classes, clamp() for headline, container padding, max-width, better line breaks).
Use Tailwind or CSS-in-modules consistent with this repo. Add mobile-specific classes rather than one-size-fits-all.

------------------------------------------------------------
D) Now do the work
------------------------------------------------------------
1) Inspect current header/nav components and identify why logo is missing on mobile.
2) Implement minimal fixes.
3) Run Playwright script and capture screenshots.
4) Evaluate against acceptance criteria and report PASS/FAIL.
5) Repeat until stop condition met.

When finished:
- Provide a concise summary of the final changes.
- Provide the final screenshot set paths.

FINAL STEP (MANDATORY):
Run the ship verification command(s) we use before opening a PR:
- /ship
```

If you want, paste your actual ship command (some teams use `./ship`, `pnpm ship`, or `just ship`) and I’ll rewrite the last line so it’s exact.


**Topic:** [[chatgpt-clusters/coding_mobile]]
