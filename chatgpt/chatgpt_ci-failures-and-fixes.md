---
title: "CI Failures and Fixes"
type: guide
created: 2026-02-20
updated: 2026-02-20
source: chatgpt-export
conversation_id: 6998f198-7130-832e-98d2-57e7e3de6fe7
message_count: 2
tags: [chatgpt, import, code]
---
# CI Failures and Fixes

> Conversation ID: 6998f198-7130-832e-98d2-57e7e3de6fe7
> Created: 2026-02-20T23:43:21Z
> Updated: 2026-02-20T23:44:15Z
> Messages: 2

---

## User

Summarize the CI failures in this GitHub Actions run and list precise fixes for Storybook A11y, Vite optimizeDeps, missing Next/Image loader width and images. Include short code/config snippets.

---

## Assistant

Mr. White — here’s what’s breaking in this run (Storybook A11y job) and how to fix it with concrete config/code.

## What failed (from the log)
- **Storybook A11y job exits 1**: “Accessibility violations detected…” (details truncated in GH UI), plus **12 test files / 32 tests failed**.
- **Vite/Vitest flakiness**: Vite **optimized a new dep at runtime** (`@floating-ui/react`) and **reloaded during tests** → “Vite unexpectedly reloaded a test… add … to `optimizeDeps.include`”.
- **React test warnings/errors**
  - `An update to Root inside a test was not wrapped in act(...)`
  - `Invalid hook call…` followed by
  - `Failed to fetch dynamically imported module … sb-vitest/deps/react-18-….js` (likely caused by the reload + dependency prebundle churn).
- **Next/Image config issue**
  - `Image … quality "85" which is not configured in images.qualities [75]. Please update your config to [75, 85].`
- You also asked about **missing Next/Image width/loader/images**: common CI Storybook failures are (a) `next/image` requires `width`/`height` (unless `fill`), (b) Storybook needs a safe loader/unoptimized behavior, (c) static assets not served in Storybook.

---

## Precise fixes

### 1) Stop Vite reloads in Storybook tests (`optimizeDeps.include`)
Add the dependency Vite discovered to **Storybook’s Vite config** (not just your app’s).

**.storybook/main.ts**
```ts
import type { StorybookConfig } from "@storybook/nextjs";

const config: StorybookConfig = {
  framework: "@storybook/nextjs",
  async viteFinal(config) {
    config.optimizeDeps ??= {};
    config.optimizeDeps.include ??= [];
    config.optimizeDeps.include.push("@floating-ui/react");
    return config;
  },
};

export default config;
```

If you also run Vite directly for Storybook, mirror it in **apps/web/vite.config.ts**:
```ts
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    include: ["@floating-ui/react"],
  },
});
```

---

### 2) Fix the Next/Image quality + width/height + loader behavior in Storybook
#### 2a) Allow `quality={85}` (your log’s explicit error)
**apps/web/next.config.js** (or `next.config.mjs`)
```js
/** @type {import('next').NextConfig} */
module.exports = {
  images: {
    qualities: [75, 85],
  },
};
```

#### 2b) Ensure every `<Image>` has `width/height` or `fill`
Bad (often fails in CI):
```tsx
<Image src="/avatars/default-user.png" alt="User" />
```

Good:
```tsx
<Image src="/avatars/default-user.png" alt="User" width={48} height={48} />
// or:
<div style={{ position: "relative", width: 48, height: 48 }}>
  <Image src="/avatars/default-user.png" alt="User" fill sizes="48px" />
</div>
```

#### 2c) Make Storybook not choke on Next/Image optimization
In Storybook, it’s typical to disable optimization (fast + avoids loader quirks).

**.storybook/preview.ts**
```ts
import * as NextImage from "next/image";

Object.defineProperty(NextImage, "default", {
  configurable: true,
  value: (props: any) => <img {...props} />, // simplest, reliable for Storybook
});
```

If you prefer keeping `<Image>` semantics, you can instead force `unoptimized`:
```ts
value: (props: any) => <NextImage.default {...props} unoptimized />
```

---

### 3) Fix “missing images” in Storybook (static assets)
Your failing src is `"/avatars/default-user.png"`. Make sure Storybook serves your `public/` directory.

**.storybook/main.ts**
```ts
const config = {
  staticDirs: ["../public"], // adjust path if .storybook isn't at repo root
};
export default config;
```

Also verify the file is actually at:
- `apps/web/public/avatars/default-user.png` (if Storybook runs from `apps/web`)
- or root `public/avatars/default-user.png` (if Storybook runs from repo root)

If your Storybook runs inside `apps/web`, use:
```ts
staticDirs: ["./public"]
```

---

### 4) Fix the `act(...)` warning (usually in Storybook interaction tests)
If a story `play()` triggers state updates, wrap interactions and any async waits in `act`.

**Example story**
```tsx
import { act } from "react-dom/test-utils";
import { userEvent, within } from "@storybook/test";

export const Default = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await act(async () => {
      await userEvent.click(c.getByRole("button", { name: /save/i }));
    });
  },
};
```

If you’re using `@testing-library/react`, you can also rely on its `act` integration, but CI warnings often mean *some* update escaped (timeouts, debounced state, animation frames). In those cases:
- add `await` for the update to settle (`findBy…`, `waitFor`)
- mock timers if you debounce

---

### 5) Fix the “Invalid hook call” + dynamic import fetch failures (React duplication / prebundle churn)
This combo is commonly caused by **multiple React copies** in a workspace or by Vite prebundling changing mid-run.

**Hardening steps:**
1) Ensure a single React version across the workspace (pnpm overrides):
**package.json**
```json
{
  "pnpm": {
    "overrides": {
      "react": "18.2.0",
      "react-dom": "18.2.0"
    }
  }
}
```

2) Dedupe / verify:
```bash
pnpm -r why react
pnpm -r why react-dom
```
If you see multiple trees, fix the dependency that pins a different version.

3) Add Vite optimizeDeps include (done above) to prevent the reload that led to:
`Failed to fetch dynamically imported module … sb-vitest/deps/react-18-…`

---

## If you want the fastest path to the *actual* a11y violations
The GH UI says output is truncated. Click **“View raw logs”** or **“Download log archive”** in that job and search for `axe` / `violation` / `Help:`. The remediation is then component-specific (labels, contrast, aria-*).

If you paste the **raw “A11y Results Summary”** section here, I’ll map each violation → the exact DOM node/story and the minimal fix.
