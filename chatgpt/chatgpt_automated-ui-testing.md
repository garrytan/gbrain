---
title: "Automated UI testing"
type: guide
created: 2025-08-21
updated: 2025-08-21
source: chatgpt-export
conversation_id: 68a6cb7c-c954-8329-bf13-4170eaf54fa4
message_count: 2
tags: [chatgpt, import, code]
---
# Automated UI testing

> Conversation ID: 68a6cb7c-c954-8329-bf13-4170eaf54fa4
> Created: 2025-08-21T07:32:21Z
> Updated: 2025-08-21T07:33:30Z
> Messages: 2

---

## User

So I'm looking at like some of the molecules in our storybook and we have like a loading button and it's basically just a button that says processing with the spinner. Well in some situations like when we have a tip button and we have the tip button loading, the loading state the processing the word processing is clipped and the loaders completely off the button. Same thing for a small spinner and loading state and then we have one if we wrote please wait it breaks it up into two lines and there's like no padding. And you know there's just a couple like our normal loading one the spinners half on the button half off it. What is the way that I can either instruct AI to look for those type of issues on each one of the molecules or create tests that look for issues like that? I just like I'm unfamiliar with testing in general and I'm unfamiliar with like how to even describe those types of issues and how you would go about finding them other than for me to just like I'm just wondering if there's like an automated way or an easier way to find issues like this rather than me just sitting here and clicking through and manually looking at each one of these molecules and taking notes and stuff.

---

## Assistant

Got it, Mr. White. Here’s the fastest, least-manual way to catch and prevent those layout gremlins.

# Plan (do all 4)
1) **Lock the Button contract (CSS rules)**
- `inline-flex items-center justify-center gap-2 whitespace-nowrap leading-none`
- Fixed hit area: `min-h-[40px] px-4` (scale with size prop)
- Prevent wrap/clip: `whitespace-nowrap text-ellipsis overflow-hidden`
- Spinner container: fixed box `w-4 h-4 shrink-0` so layout doesn’t jump
- Loading state: `data-[state=loading]` + `aria-busy="true"`; disable pointer events but keep width

2) **Add “nasty” stories per size/variant**
- Labels: `Tip`, `Processing…`, `Please wait`, very long text, emoji, CJK
- States: default/hover/pressed/focus/disabled/loading + with/without left/right icon
- Edge sizes: XS + icon-only
- Constrain width stories: `w-24`, `w-40`, etc., to expose overflow

3) **Automated visual checks (Storybook ➜ Playwright screenshots)**
- Use **@storybook/test-runner** + **Playwright** and assert screenshots:
  - baseline per story (`toHaveScreenshot()`)
  - run in CI; any pixel diff fails PR
- Optional: plug **Chromatic** or **Percy** for hosted VRT + PR gating

4) **Programmatic “no-overflow/no-clip” assertions**
- In Playwright, for each story:
  - Ensure no element has `scrollWidth > clientWidth` or `scrollHeight > clientHeight`
  - Ensure spinner is fully inside button (get bounding boxes; spinner rect must be within button rect)

---

# Minimal test examples

## A. Storybook test (Playwright via test-runner)
```ts
// button.spec.ts
import { test, expect } from '@playwright/test';

const stories = [
  'molecules-button--loading-tip',
  'molecules-button--loading-please-wait',
  'molecules-button--xs-icon-only-loading',
  'molecules-button--long-text-constrained',
];

for (const id of stories) {
  test(`no visual regressions: ${id}`, async ({ page }) => {
    await page.goto(`http://localhost:6006/iframe.html?id=${id}`);
    const btn = page.locator('[data-testid=button]');
    await expect(btn).toHaveScreenshot(`${id}.png`, { maxDiffPixelRatio: 0.01 });
  });

  test(`no overflow/clip: ${id}`, async ({ page }) => {
    await page.goto(`http://localhost:6006/iframe.html?id=${id}`);
    const btn = page.locator('[data-testid=button]');
    const box = await btn.boundingBox();
    const spin = page.locator('[data-testid=spinner]');
    const sbox = await spin.boundingBox();
    expect(box && sbox && sbox.x >= box.x && sbox.y >= box.y &&
           sbox.x + sbox.width <= box.x + box.width &&
           sbox.y + sbox.height <= box.y + box.height).toBeTruthy();

    const hasOverflow = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=button]') as HTMLElement;
      return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
    });
    expect(hasOverflow).toBeFalsy();
  });
}
```

## B. Button CSS contract (Tailwind-y utility sketch)
```tsx
<button
  data-testid="button"
  data-state={loading ? 'loading' : 'idle'}
  aria-busy={loading ? 'true' : 'false'}
  className={cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap leading-none',
    'min-h-10 px-4 rounded-xl disabled:opacity-60 disabled:pointer-events-none',
    size === 'xs' && 'min-h-8 px-3 text-sm',
  )}
>
  {loading && <span data-testid="spinner" className="w-4 h-4 inline-block" />}
  <span className="truncate">{label}</span>
</button>
```

---

# Add-on checks (quick wins)
- **Axe**: run @axe-core/playwright in the same tests (a11y + label/aria sanity).
- **Snapshots for text metrics**: assert computed `line-height`, `white-space: nowrap`, and presence of `gap` so “Please wait” never wraps.
- **Device matrix**: run tests at `320×640`, `375×812`, `1024×768` to catch small-width issues.

---

# One-shot AI prompt to fix & guard

> **“Scan all Button-like components (Button, LoadingButton, IconButton) and refactor to a single Button with a `loading` prop. Enforce a strict layout contract: `inline-flex`, `items-center`, `justify-center`, fixed spinner box (`w-4 h-4`), `gap-2`, `leading-none`, `whitespace-nowrap`, `truncate`, size tokens for `min-h`/`px`. Use `data-[state=loading]` and `aria-busy`. Remove any absolute/floating spinner styles that can escape the button. Add Storybook stories that cover: short/long labels, ‘Processing…’, ‘Please wait’, emoji/CJK, constrained widths, icon-only, xs/sm/md/lg, disabled+loading. Add Playwright tests with @storybook/test-runner: (1) `toHaveScreenshot` per story; (2) programmatic overflow/clip checks comparing bounding boxes and scroll vs client sizes; (3) axe a11y checks. Fail PR on any diff or overflow. Document the contract in the Button README and migrate all call sites.”**

Run this once; from then on, PRs fail the moment a spinner or text spills off the button.


## See Also
- [[chatgpt/chatgpt_automated-audience-building]]
- [[chatgpt/chatgpt_automated-job-application-setup]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part1]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part2]]
- [[chatgpt/chatgpt_automated-label-printing-solution-part3]]
