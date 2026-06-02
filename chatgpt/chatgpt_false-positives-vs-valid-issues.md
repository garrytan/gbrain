---
title: "False Positives vs Valid Issues"
type: note
created: 2026-01-23
updated: 2026-01-23
source: chatgpt-export
conversation_id: 6973acd3-36f0-832d-bf83-6a3423191c0c
message_count: 4
tags: [chatgpt, import]
---
# False Positives vs Valid Issues

> Conversation ID: 6973acd3-36f0-832d-bf83-6a3423191c0c
> Created: 2026-01-23T17:16:15Z
> Updated: 2026-01-23T17:17:22Z
> Messages: 4

---

## User

are these false positives or valid issues

---

## Assistant

Mr. White: **mostly valid issues**, with a few that can be “acceptable exceptions” depending on context.

From what’s shown on this page, you’re looking at a lot of **accessibility ARIA rule** code smells plus a handful of **JS/TS maintainability/perf** ones.

### Usually valid (you should fix)
- **“Use `<img alt=...>` instead of role='img' / role='presentation'”**  
  If you’re using a `div/span` with `role="img"` or `role="presentation"` as a stand-in for an actual image, that’s typically worse for accessibility and often unnecessary. Prefer a real `<img alt="...">` (or `alt=""` if decorative).
- **“Use `<button>` / `<input type=...>` instead of `role="button"`”**  
  `role="button"` on a `div` is commonly a11y-buggy (keyboard, focus, semantics). Use a real `<button>`.
- **“Use `<output>` instead of `role="status"`”**  
  Often valid when you’re displaying computed output. But if it’s truly a live region for async updates, `role="status"` / `aria-live="polite"` may be appropriate (see “sometimes false positive” below).
- **“Use `<select>/<datalist>` instead of `role="listbox"`” and “Use `<option>` instead of `role="option"`”**  
  Valid *if* you’re trying to model a native select. However, many teams intentionally build custom combobox/listbox UIs for styling/async search; then ARIA is appropriate, and Sonar can be overly rigid.

### Often “acceptable exception” / sometimes false positive
- **Custom combobox / listbox / option patterns (React headless UI, Radix, Downshift, etc.)**  
  If you’re implementing the **WAI-ARIA combobox/listbox pattern correctly** (keyboard, active-descendant, labeling, focus management), Sonar’s “use `<select>`” recommendation can be a *false positive in practice*. Native `<select>` can’t do async search, rich rendering, virtualization, etc.
- **`role="dialog"` vs `<dialog>`**  
  `<dialog>` support is decent now, but many apps still use `role="dialog"` for better control/portals/animations/focus traps. If you have proper `aria-modal`, labeling, and focus management, this can be an acceptable exception.
- **“Extract nested ternary”**  
  This is style/maintainability—*valid* but not a “bug.” If it’s readable and tested, it’s not urgent.
- **“Prefer `node:crypto` over `crypto` / `node:path` over `path`”**  
  Usually valid modernization, but low impact. Not a false positive—just low priority.
- **“ALLOWED_VENMO_HOSTS should be a Set” / similar constants as Set**  
  Valid micro-optimization + clarity. If the list is tiny and never performance-sensitive, it’s optional.
- **“Do not use Array index in keys”**  
  Valid when list items can reorder/insert/remove (causes UI bugs). If the list is **static and never reorders**, it can be acceptable.

### A quick way to decide per issue
- If it’s **replacing ARIA roles with native elements** *and you can* use the native element without losing required behavior → **valid, fix it**.
- If it’s a **custom complex widget** (combobox, virtualized list, fancy select) where native elements won’t work → **likely a Sonar false positive / acceptable exception**, but only if your ARIA implementation is correct.
- If it’s **style/readability/perf nits** → valid but **prioritize lower**.

If you click one or two specific issues (especially the combobox/listbox ones) and paste the relevant JSX snippet here, I’ll tell you **for that exact case** whether it’s genuinely wrong or a reasonable exception.

---

## User

im using next.js and radix primitives

---

## Assistant

Mr. White: with **Next.js + Radix**, a bunch of those a11y rules are **likely “false positive / acceptable exception”** *as phrased*, but they still point to places where you should verify the semantics.

How to treat the main buckets:

- **`role="button"` / clickable `div`**  
  If it’s coming from Radix `asChild` + you passed a `div/span`, that’s **valid to fix**: use a real `<button>` (or make your child a `<button>`). This one is rarely a good exception.

- **`role="img"` / `presentation`**  
  If you’re using `next/image` or an `<img>` already, and Sonar is complaining, it’s often because the actual rendered element in that component is a non-`img` wrapper with a role. In Radix, check `asChild` usage again. Usually **valid**: prefer a real `<img>` with correct `alt` (or `alt=""` if decorative). If it’s an icon, consider `aria-hidden="true"` on the SVG and label the button instead.

- **`role="listbox"` / `role="option"` / “use `<select>`”**  
  With Radix Select/Combobox-like patterns, **this is commonly a false positive**. Radix intentionally uses ARIA patterns to implement custom UI. Don’t rewrite to `<select>` unless you truly can.

- **`role="dialog"` vs `<dialog>`**  
  With Radix Dialog, **ignore Sonar**. Radix’s approach is standard; `<dialog>` isn’t required.

- **`role="status"` vs `<output>`**  
  If it’s Radix Toast / live announcements, Sonar can be off. Keep `aria-live` patterns where appropriate.

**Practical rule:**  
For Radix components, if the child element you supply via `asChild` is semantically correct (button for triggers, etc.), you’re usually fine. Most “use native element instead of ARIA role” warnings are Sonar not recognizing the library pattern.

If you want, paste **one example warning + the JSX around that line** (especially anything with `asChild`) and I’ll tell you *exactly* whether to suppress it, refactor the child element, or adjust ARIA/alt.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
