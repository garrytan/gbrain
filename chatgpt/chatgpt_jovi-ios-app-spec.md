---
conversation_id: 69d9aaf4-d604-83e8-acba-9d404a883250
created: 2026-04-11
links:
- '[[chatgpt-clusters/coding_mobile]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- long-form
title: Jovi iOS App Spec
type: note
updated: 2026-04-11
---

# Jovi iOS App Spec

**Related:** [[coding_mobile]]

> Conversation ID: 69d9aaf4-d604-83e8-acba-9d404a883250
> Created: 2026-04-11T02:00:23Z
> Updated: 2026-04-11T02:02:50Z
> Messages: 6

---

## User

So we have the Jovi. And I want to just spec out what the minimal mobile app would be for it. So I'm thinking, like, the minimal mobile app is literally like, it's got a splash screen that has a Jovi logo on it. And it loads a literal QR code to your profile. And then underneath it, it says jobi.ai slash Tim, or whatever your profile is. And maybe tapping that copies it to clipboard. And that's it. And it's just like your identity. And that's like literally it. It's got auth and like all of the stuff set up to do auth and like be ready for, you know, proper architecture and stuff to build out the app and be able to start managing like the task list and everything, but we won't actually build any of that for now. We'll just plan architecture-wise for that to be how it goes. And this will be Swift, native iOS app, and it'll live in the repo. That's all it's going to do to start. And then we're just going to like spec that out and build that shell in the mono repo as like side work for an AI agent in downtime when we have extra credits, just so that when we decide to start shipping iOS apps, there's less overhead for us to get there. But we want to like ship these small applets as small as we possibly can and then add features in small PRs rather than trying to like do everything at once.

---

## Assistant

I’m drafting this as a lean product/engineering spec with a repo-ready shell, defaulting to `jobi.ai/{handle}` as the profile URL unless you want a different route. I’ll keep scope tight: one screen, auth-ready foundation, and clear PR slices.

---

## Assistant

Mr. White, I drafted the spec in the canvas.

Core recommendation:
- Ship a real native iOS shell in SwiftUI
- Keep V1 to one screen
- Put auth/session, config, networking, and feature boundaries in place now
- Add everything else in small PRs

The product surface for V1:
- splash / launch branding with Jovi logo
- one identity screen
- QR code for `jobi.ai/{handle}`
- visible URL under it
- tap URL to copy
- simple copied feedback

The architecture direction:
- `App` layer for bootstrap and root state
- `Core` for auth, session, networking, config, logging
- `Features/Identity` for this first screen
- `DesignSystem` for shared assets and theme
- root states like `launching`, `unauthenticated`, `loadingProfile`, `ready`, `error`

The rollout I mapped:
- PR 1: app target + shell + static placeholder screen
- PR 2: QR generation + copy interaction
- PR 3: auth/session foundation
- PR 4: real profile URL fetch
- PR 5: tests, logging, config hardening

The immediate first build target should be:
- static `jobi.ai/tim`
- QR rendering
- copy-to-clipboard
- service protocols and root state wired in

That gives an AI agent a very small first PR with almost no ambiguity and keeps future iOS work cheap.

I can turn this into a concrete implementation checklist or a repo-ready technical design doc next.

---

## User

And then for Clarke to use whatever they need it Klahre components are or whatever ships the fastest and then we should attempt to have our UI either will be like completely completely native Swift iOS liquid class iOS 26 Nikoloz or it’ll be whatever or look close to our Webb eye and it should be dark mode only for now


---

## Assistant

I’m treating this as a visual/implementation constraint update: ship fast, prefer native Apple components, dark mode only, and keep web-style matching as a light skin rather than a full custom UI system.

---

## Assistant

Mr. White, I’d lock in these spec changes:

- Clarke should use whatever ships fastest. Default to native SwiftUI and Apple system components first. Drop to UIKit only where SwiftUI is slower or awkward. Avoid building a custom component library in V1.
- Visual direction should be native iOS first. Jovi branding should sit on top of that through logo, spacing, typography choices, and color tokens. Do not chase exact web parity in the first pass.
- Dark mode only for V1.
- Design rule: “feel like a real iOS app, branded as Jovi,” instead of “recreate the web app in iOS.”
- Web-style UI should only be copied where it is cheap and important for brand continuity.

I would update the architecture language to this:

**UI policy**
- Use native Apple controls wherever possible
- Prefer speed of shipping over design-system purity
- Keep a thin theme/token layer so the app can evolve later
- No light mode support yet
- No bespoke animations or heavy custom surfaces in the initial shell

**Practical implementation**
- `ColorScheme.dark` only
- one theme file for colors, spacing, radius, typography
- `IdentityView` built with standard SwiftUI views
- QR card can be slightly branded, but still structurally native
- copy feedback should use the simplest native pattern available

My recommendation is clear: choose native iOS as the default path, not web mimicry. That gives you the fastest build, the lowest maintenance burden, and the cleanest base for later features.

Here is the exact spec sentence I’d add:

“V1 UI should prioritize native iOS implementation speed and system conventions. The app should use standard SwiftUI/UIKit components wherever possible, apply Jovi branding through a thin theme layer, and support dark mode only. Exact web UI parity is out of scope unless a specific element is trivial to replicate.”

And I’d add this implementation rule:

“Any custom UI must justify itself by improving launch speed, scannability of the QR identity screen, or future extensibility. Otherwise use the platform default.”

The cleanest first PR still remains:
- app target
- branded launch screen
- one dark-mode identity screen
- QR rendering
- tappable URL copy
- root state + auth/session interfaces

The next useful artifact is a repo-ready engineering checklist with file structure and acceptance criteria for Clarke.


**Topic:** [[chatgpt-clusters/coding_mobile]]
