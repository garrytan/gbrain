---
title: "Page Design Audit"
type: note
created: 2026-01-16
updated: 2026-01-16
source: chatgpt-export
conversation_id: 696a9755-2d50-8331-a7c9-de907ae5a39b
message_count: 2
tags: [chatgpt, import]
---
# Page Design Audit

> Conversation ID: 696a9755-2d50-8331-a7c9-de907ae5a39b
> Created: 2026-01-16T19:53:59Z
> Updated: 2026-01-16T19:54:33Z
> Messages: 2

---

## User

audit this page design

---

## Assistant

Mr. White — here’s an audit of the **“Step 2 of 3: Claim your handle”** page (focused on UX, UI, accessibility, and conversion).

## What’s working
- **Clear primary task**: “Claim your handle” is unambiguous.
- **Instant availability feedback** (“Available”) is the right kind of reassurance at the right moment.
- **Single primary CTA** (“Continue”) keeps the flow moving.

## Biggest issues to fix
### 1) Handle input is visually confusing
Right now you show `@` as a separate element and also render the handle preview (`@handle`) above, while the input value is `timwhite`. That’s three representations of the same thing.

**Fix:** Make a single input that visually includes the `@` as a prefix (inside the input), and remove the extra `@handle` preview unless it serves a distinct purpose (e.g., showing the final URL).

### 2) The “Available” state needs clearer semantics
“Available” is good, but:
- It should be tied to the input with a clear icon + color + message.
- It needs explicit states: **checking… / available / taken / invalid / error**.

**Fix:** Add “Checking…” while typing + debounce. If taken, show the best 3 alternatives (one-click select).

### 3) Missing rules + consequences
Users need constraints *before* they fail validation:
- allowed characters
- min/max length
- can it be changed later?
- case sensitivity

**Fix (inline microcopy under the field):**
“3–20 characters. Letters, numbers, underscores. No spaces. You can change this later.”

### 4) “Continue” should be conditionally enabled
If the handle is invalid or still “checking”, the CTA should be disabled (with a tooltip or helper text explaining why).

### 5) Navigation + hierarchy feels noisy
You have multiple “Skip to main content”, a hamburger menu, a back button, and the Tanstack devtools button visible. In an onboarding step, this is distraction.

**Fix:** In onboarding, reduce chrome:
- keep Back + brand
- hide hamburger (or move to later)
- hide devtools in production builds entirely

## Accessibility / semantics improvements
- The input has an aria-label (good), but ensure:
  - Status text (“Available”) is announced with `aria-live="polite"`.
  - Error messages are linked via `aria-describedby`.
  - The `@` prefix isn’t read twice by screen readers.
- Ensure focus order: title → input → status/help → Continue → Back.

## UI polish suggestions (quick wins)
- Add a subtle **handle URL preview** *only if relevant*: `jovie.com/@timwhite`
- Add a short reassurance line: “Your handle is how people find you.”
- Provide **auto-suggestions** when taken.
- Use consistent capitalization: “Claim your handle” vs “Continue”.

## Conversion/behavior tweaks
- If `timwhite` is available, consider auto-advancing only when the user clicks Continue (don’t auto-submit).
- Track drop-off at this step; handles can be unexpectedly high friction. Suggestions reduce churn.

If you want, paste a screenshot (or share the CSS/layout) and I’ll give **specific spacing/type scale** recommendations and a revised component layout.


**Topic:** [[chatgpt-clusters/design_ux]]
