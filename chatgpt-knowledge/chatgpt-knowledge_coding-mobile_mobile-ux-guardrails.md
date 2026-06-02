---
title: "Mobile UX Guardrails"
type: guide
created: 2026-04-29
updated: 2026-04-29
source: chatgpt-export
topic: coding-mobile
message_count: 6
tags: [chatgpt, knowledge, coding-mobile]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-mobile]]

# Mobile UX Guardrails

> **Source:** ChatGPT conversation
> **Date:** 2026-04-29T06:38:44Z
> **Messages:** 6
> **Topic:** coding-mobile

## Question

One of the number one mobile UX issues that happens is when you're on like different iPhone screens or mobile screens and you change focus, then you get like horizontal scrolling, even if a page is like exact 100% HW or something. So is there like a guardrail or a lint rule that can like prevent that at all like viewports for everything from like an iPhone 12 to like a current iPhone at every screen size?

## Answer

I’ll ground this in practical guardrails: what CSS/layout rules catch it early, what automated viewport tests actually prove it, and what linting can and cannot prevent.

## Answer

Yes, Mr. White. Best guardrail is **automated Playwright tests**, plus a few lint/style rules.

### What to enforce

1. **Avoid `width: 100vw` on normal sections**
Use:

```css
width: 100%;
max-width: 100%;
```

`100vw` can cause horizontal overflow because it may include scrollbar width. citeturn534559search16

2. **Global CSS guardrail**

```css
html,
body {
  max-width: 100%;
  overflow-x: clip;
}

* {
  box-sizing: border-box;
}

img,
video,
canvas,
svg {
  max-width: 100%;
  height: auto;
}
```

3. **Stylelint rule**
Use Stylelint with a custom rule or `declaration-property-value-disallowed-list`:

```json
{
  "rules": {
    "declaration-property-value-disallowed-list": {
      "width": ["/100vw/"],
      "min-width": ["/100vw/"]
    }
  }
}
```

Allow exceptions only for intentional full-bleed components.

4. **Real CI test: no horizontal overflow**
This is the important one.

```ts
import { test, expect } from '@playwright/test';

const widths = [320, 360, 375, 390, 393, 402, 414, 428, 430];

for (const width of widths) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');

    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });

    expect(overflow).toBe(false);
  });
}
```

Use iPhone-ish logical widths: iPhone 12 is commonly 390px wide, iPhone 15 is 393px wide, newer larger iPhones hit around 430px CSS width. citeturn534559search8turn534559search11

### Best setup for Jovie

Add a CI check called:

```bash
pnpm test:mobile-overflow
```

Run it against:
- homepage
- artist profile
- release page
- checkout/tipping flow
- dashboard pages
- any modal/drawer open states

Also test after focus states:

```ts
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
```

Focus rings, drawers, fixed buttons, and translated cards are common overflow offenders.

The lint rule prevents obvious mistakes. The Playwright check proves the page actually fits.

## Question

What this for Jovie?

## Answer

I’ll map this to a practical Jovie guardrail: one CI test that catches real overflow, plus a style rule that prevents the most common CSS causes.

## Answer

Mr. White, for **Jovie**, I’d make this a **release-blocking mobile overflow test**.

The goal: every important Jovie page must pass this invariant:

```ts
document.documentElement.scrollWidth <= document.documentElement.clientWidth
```

That catches the actual bug: invisible horizontal overflow caused by `100vw`, fixed elements, focus rings, drawers, carousels, transforms, or oversized children.

I do not have the current Jovie repo selected in this chat, so here is the drop-in version I’d add.

## 1. Add a mobile overflow Playwright test

Create:

```ts
// tests/mobile-overflow.spec.ts
import { test, expect } from '@playwright/test';

const mobileWidths = [
  320, // very small legacy width
  360,
  375, // older iPhone logical width
  390, // iPhone 12/13/14-ish
  393,
  402,
  414,
  428,
  430, // large modern iPhone logical width
];

const routes = [
  '/',
  '/login',
  '/signup',

  // Replace these with real Jovie routes:
  '/artist/demo',
  '/release/demo',
  '/dashboard',
  '/dashboard/releases',
  '/dashboard/settings',
];

async function expectNoHorizontalOverflow(page: any) {
  const result = await page.evaluate(() => {
    const el = document.documentElement;

    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      bodyScrollWidth: document.body?.scrollWidth,
      bodyClientWidth: document.body?.clientWidth,
      overflow: el.scrollWidth - el.clientWidth,
    };
  });

  expect(result.overflow, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(0);
}

for (const width of mobileWidths) {
  for (const route of routes) {
    test(`no horizontal overflow: ${route} @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });

      await page.goto(route, {
        waitUntil: 'networkidle',
      });

      await expectNoHorizontalOverflow(page);

      // Catch focus-ring / input-focus overflow.
      const focusable = page.locator(
        'a, button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
      );

      const count = await focusable.count();
      const limit = Math.min(count, 20);

      for (let i = 0; i < limit; i++) {
        await page.keyboard.press('Tab');
        await expectNoHorizontalOverflow(page);
      }
    });
  }
}
```

Playwright supports viewport control and mobile/device emulation, including browser behavior like viewport, screen size, user agent, and touch support. citeturn338806search1turn338806search16

## 2. Add a second test for open states

Most mobile overflow bugs happen when something is opened: nav menu, modal, drawer, share sheet, upload modal, checkout/tip flow, settings menu.

```ts
// tests/mobile-open-states-overflow.spec.ts
import { test, expect } from '@playwright/test';

async function noOverflow(page: any) {
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth - document.documentElement.clientWidth;
  });

  expect(overflow).toBeLessThanOrEqual(0);
}

test.descr

*(Answer truncated — 7341 chars total)*
