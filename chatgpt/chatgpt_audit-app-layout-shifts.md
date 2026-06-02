---
title: "Audit app layout shifts"
type: guide
created: 2025-08-23
updated: 2025-08-23
source: chatgpt-export
conversation_id: 68aa13da-2174-832e-a7f1-2b2af9c28c0a
message_count: 2
tags: [chatgpt, import, code]
---
# Audit app layout shifts

> Conversation ID: 68aa13da-2174-832e-a7f1-2b2af9c28c0a
> Created: 2025-08-23T19:17:47Z
> Updated: 2025-08-23T19:18:33Z
> Messages: 2

---

## User

What's an easy way that I can audit my whole app for scenarios where I'm due to layout shift, particularly in situations where an error message or a validation message display and then cause the layout to shift, or when a button changes states to like a loading state, and the loading text or the spinner or something cause layout shift, and also in situations where beyond layout shift the other thing that I want to look for is situations where someone's display name is incredibly long and the text moves outside of the box it's in rather than being truncated or wrapped properly, or situations where a button with certain text shifts to two lines and therefore makes the button do a layout shift when it changes states, or situations where content can't fit within a button and therefore the button design falls apart because there's no padding anymore or whatever, stuff like that. How can I just run off? I'd like to check on that. I have stories set up for most of the components. Can I just ask Cloud Code or Windsurf to audit the stories? And if so, give me a prompt.

---

## Assistant

Mr. White — yes, you can have Windsurf/Claude Code audit your Storybook. Use this prompt verbatim.

```
You are a senior UI QA engineer. Task: add automated “layout-shift & overflow” checks across our Storybook.

Context
- Tech: Next.js + Tailwind + Storybook.
- We already have stories for most components.
- Goal: catch CLS-like shifts and overflow/warp when content/state changes.

Deliverables
1) Storybook Test Runner (Playwright) suite that, for every story:
   - Renders baseline → flips common states (error/validation banners, loading, disabled, pressed, success).
   - Injects “torture” content variants into text props:
     • Very long names (2–300 chars), long unbroken strings/URLs, CJK, Arabic/RTL, emoji/ZWJ, mixed punctuation.
     • Localized expansions (e.g., German lengthening).
   - Captures bounding boxes (getBoundingClientRect) of key elements (root container, primary button(s), title, inputs).
   - Asserts Δwidth/Δheight ≤ 1px for state flips that are meant to be non-shifting (e.g., spinner text swap, validation inline).
   - Asserts no horizontal overflow (el.scrollWidth ≤ el.clientWidth) unless the component is explicitly scrollable.
   - Asserts no vertical overflow cut-off (el.scrollHeight ≤ el.clientHeight) unless scrolling is intended.
   - Asserts text truncation rules:
     • Buttons: single line, no wrap; enforce text-ellipsis or min-width; fail if line breaks.
     • Display names: either line-clamp or ellipsis; fail if text escapes container.
   - For responsive cases, test at xs/sm/md/lg viewports.

2) Shared test utilities:
   - `tortureStrings.ts`: export array of pathological strings.
   - `measure.ts`: helpers to snapshot rects, compute deltas, and assert thresholds.
   - `states.ts`: helpers to toggle story args/controls for `loading`, `error`, `validationMessage`, etc.

3) Storybook decorators/argTypes:
   - Add global controls for `loading`, `errorMessage`, `longTextMode` so the same suite can exercise most stories without custom code.
   - Provide default `validationMessage` containers that reserve space (min-h based on 1 line) to avoid shifts.

4) CI wiring:
   - Add `pnpm test:stories:qa` (runs @storybook/test-runner with Playwright).
   - Optional visual regression: wire Chromatic/Percy on the QA set; block PR if diff > 1% or any test fails.
   - Make the job fail fast on lint/type errors before running tests.

Implementation sketch
- Install: `@storybook/test`, `@storybook/test-runner`, `@playwright/test`, `@testing-library/dom`.
- Create `tests/story-layout.spec.ts` that discovers all stories via `stories.json` and iterates them.
- Before/after measurement:
   ```ts
   const before = rectOf(el);
   await toggleState('loading', true); // or setArgs via test-runner API
   const after = rectOf(el);
   expect(delta(after.height, before.height)).toBeLessThanOrEqual(1);
   ```
- Overflow guards:
   ```ts
   expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
   expect(el.scrollHeight).toBeLessThanOrEqual(el.clientHeight);
   ```
- Button text rules:
   - Query `[data-role="primary-button"]`; assert computed `white-space: nowrap` and no `\n` in text.
- Add long-text injection by cycling `tortureStrings` into `displayName`, `title`, `buttonLabel`, etc., via story args.

Coding standards
- Use Tailwind utilities for prevention: `min-h-[1.25rem]` for message slots, `whitespace-nowrap`, `text-ellipsis overflow-hidden`, `line-clamp-*`, `break-words` (or `break-all` for URLs), `min-w-[...px]` on buttons.
- Prefer reserving space for transient UI (spinners/messages) with fixed-height containers to eliminate shifts.

Output
- Open a PR:
  - `tests/story-layout.spec.ts`
  - `tests/utils/{tortureStrings,measure,states}.ts`
  - Storybook preview with global controls/decorators
  - CI job `layout-qa.yml` added to pipeline
- Run and fix any failing components; annotate each fix as “CLS/Overflow hardening”.

Finally, generate a report listing components/stories that failed, the failing assertion, and a minimal code diff suggestion (Tailwind classes or CSS fix) for each.
```

Quick extras:
- Use `line-clamp`/`ellipsis` and fixed-height “message slots” to avoid shifts.
- For buttons: enforce `whitespace-nowrap`, a `min-w`, and reserve spinner space with `relative` + `absolute` spinner overlay so text doesn’t move.


## See Also
- [[chatgpt/chatgpt_fix-layout-shifts]]
- [[chatgpt/chatgpt_dst-shifts-daylight-usage]]
- [[chatgpt/chatgpt_request-for-more-shifts]]
- [[chatgpt/chatgpt_ai-code-quality-audit]]
- [[chatgpt/chatgpt_audit-and-harden-prompt]]
