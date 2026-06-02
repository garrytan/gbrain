---
title: "Glitch Testing Help"
type: guide
created: 2026-05-11
updated: 2026-05-11
source: chatgpt-export
conversation_id: 6a015c7b-1bbc-83e8-84a7-6c6aa7242706
message_count: 2
tags: [chatgpt, import, code]
---
# Glitch Testing Help

> Conversation ID: 6a015c7b-1bbc-83e8-84a7-6c6aa7242706
> Created: 2026-05-11T04:35:07Z
> Updated: 2026-05-11T04:37:38Z
> Messages: 2

---

## User

{'asset_pointer': 'sediment://file_00000000e51871fd84ee404b5e9a9ffe', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 1536, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 171697, 'width': 709}
How do I catch this glitch in testing 

---

## Assistant

Mr. White, catch this with a **mobile visual regression test for the nav-open state**, plus a **layout invariant** that fails when the header CTA leaks into the top safe-area.

This screenshot looks like a fixed/sticky `Start Free Trial` CTA is still rendering above the mobile menu and getting clipped near the iOS status bar.

### 1. Add mobile browser projects

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 13'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 100,
    },
  },
});
```

Playwright device presets simulate things like user agent, screen size, viewport, and touch behavior, and Playwright supports running separate browser/device projects in one config. citeturn180137view1turn180137view2

### 2. Test the exact broken state

Add stable test IDs:

```html
<button data-testid="mobile-menu-button">Menu</button>
<a data-testid="header-cta">Start Free Trial</a>
<nav data-testid="mobile-menu">...</nav>
```

Then test the menu-open viewport:

```ts
// tests/mobile-menu.spec.ts
import { test, expect } from '@playwright/test';

test('mobile menu open state has no clipped header CTA', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('mobile-menu-button').click();

  const menu = page.getByTestId('mobile-menu');
  await expect(menu).toBeVisible();

  // Catches the exact bug: the desktop/header CTA should disappear when the mobile menu is open.
  await expect(page.getByTestId('header-cta')).toBeHidden();

  // Catches visual/layout regressions: clipping, overlap, bad z-index, wrong safe-area spacing.
  await expect(page).toHaveScreenshot('mobile-menu-open.png', {
    fullPage: false,
    maxDiffPixels: 100,
  });
});
```

Playwright’s `toHaveScreenshot()` creates a baseline screenshot on first run and compares later runs against it, so this kind of clipped-button regression becomes a failing PR check. citeturn180137view0

### 3. Add a geometry assertion for the top safe-area

This catches the bug even if the screenshot diff threshold is too forgiving:

```ts
test('no Start Free Trial button leaks into top safe area when menu is open', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('mobile-menu-button').click();

  const leakedCtas = await page
    .getByText(/start free trial/i)
    .evaluateAll((els) =>
      els.filter((el) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const overlapsTopBand = rect.top < 70 && rect.bottom > 0;
        return visible && overlapsTopBand;
      }).length
    );

  expect(leakedCtas).toBe(0);
});
```

### 4. Run the same test across the risky states

Cover these cases:

```ts
for (const scrollY of [0, 200, 800]) {
  test(`mobile menu open after scrollY=${scrollY}`, async ({ page }) => {
    await page.goto('/');
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.getByTestId('mobile-menu-button').click();

    await expect(page).toHaveScreenshot(`mobile-menu-open-scroll-${scrollY}.png`, {
      fullPage: false,
      maxDiffPixels: 100,
    });
  });
}
```

The likely triggers here are `position: fixed`, `z-index`, `overflow`, header state after scroll, and iOS safe-area spacing.

### 5. Make CI deterministic

Generate the baseline once:

```bash
npx playwright test --update-snapshots
```

Then run snapshots on every PR:

```bash
npx playwright test --project=mobile-safari
```

Keep the screenshot baseline environment consistent. Playwright notes that screenshot rendering can vary by OS, browser version, hardware, headless mode, and related environment details. citeturn180137view0

### 6. Add one real iOS/simulator pass before release

For notch/status-bar/safe-area bugs, add a simulator or real-device visual check. WebdriverIO’s visual service supports mobile browser screenshots on Android emulators, iOS simulators, and real devices through Appium. citeturn382578view0

The highest-value test is:

```txt
Mobile Safari → homepage → open nav → screenshot viewport → assert header CTA hidden
```

That would have caught this screenshot.
