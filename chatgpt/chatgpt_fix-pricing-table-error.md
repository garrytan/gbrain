---
conversation_id: 68a28ecb-361c-832e-8949-982ce9e30933
created: 2025-08-18
links:
- '[[chatgpt-clusters/business_startup]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Fix pricing table error
type: note
updated: 2025-08-18
---

# Fix pricing table error

> Conversation ID: 68a28ecb-361c-832e-8949-982ce9e30933
> Created: 2025-08-18T02:24:18Z
> Updated: 2025-08-18T02:25:54Z
> Messages: 2

---

## User

Read https://clerk.com/docs/raw/nextjs/components/billing/pricing-table.mdx

im getting
TypeError: this.clerkjs.unmountPricingTable is not a function
    at Object.unmountPricingTable [as unmount] (webpack-internal:///(app-pages-browser)/./node_modules/@clerk/clerk-react/dist/index.mjs:865:22)
    at ClerkHostRenderer.componentWillUnmount (webpack-internal:///(app-pages-browser)/./node_modules/@clerk/clerk-react/dist/chunk-5DPFCWRO.mjs:517:20)
    at Object.react_stack_bottom_frame (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:23624:22)
    at runWithFiberInDEV (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:873:30)
    at safelyCallComponentWillUnmount (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:12528:11)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13400:15)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13306:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13306:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13306:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13306:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13430:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13430:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13405:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13405:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13389:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13430:11)
    at recursivelyTraverseDeletionEffects (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13236:9)
    at commitDeletionEffectsOnFiber (webpack-internal:///(app-pages-browser)/./node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js:13430:11)

---

## Assistant

Mr. White — this error screams “version mismatch.”

Clerk’s `<PricingTable />` in `@clerk/nextjs` / `@clerk/clerk-react` calls `clerkjs.unmountPricingTable()` under the hood. If the **runtime Clerk.js** your app loads is older (or pinned) and doesn’t have that method, you get `TypeError: this.clerkjs.unmountPricingTable is not a function`. The official docs show the component usage and were updated Aug 12, 2025, which aligns with newer Clerk.js APIs. citeturn11view0

### Fix (do all of these)
1. **Upgrade all Clerk SDKs together:**
   ```bash
   pnpm add @clerk/nextjs@latest @clerk/clerk-react@latest @clerk/clerk-js@latest
   # or npm/yarn equivalent
   ```
   Clerk’s current compatibility table lists **Clerk.js ≥ 5.61.0** and **@clerk/nextjs ≥ 6.15.0** for latest features. citeturn10view0

2. **Unpin the browser Clerk.js version** (common culprit):
   - In your envs, **remove** `NEXT_PUBLIC_CLERK_JS_VERSION` (or any var forcing an old Clerk.js) **or** set it to a recent version (≥ 5.61.0). Clerk documents how envs affect SDK behavior. citeturn8search2turn8search0

3. **Don’t load Clerk.js manually.**
   - Ensure there’s **no `<script src="...clerk.js">`** in `_document.tsx`/`Head`. Let `<ClerkProvider>` manage loading so versions stay in sync. (Mismatch between a manually loaded Clerk.js and your package versions triggers this exact failure.)

4. **Use the documented import:**
   - Next.js (App Router):
     ```tsx
     // app/pricing/page.tsx
     import { PricingTable } from '@clerk/nextjs';
     export default function Page() { return <PricingTable />; }
     ```
     (No custom mount/unmount logic needed.) citeturn11view0

5. **Blow away artifacts & rebuild:**
   ```bash
   rm -rf node_modules pnpm-lock.yaml # or package-lock/yarn.lock
   pnpm i
   pnpm build && pnpm dev
   ```

### Why this works
- Newer `@clerk/nextjs`/`@clerk/clerk-react` expect a Clerk.js with `mountPricingTable`/**`unmountPricingTable`**. The “Available versions” page establishes minimum versions for feature parity; aligning SDKs removes the missing-method crash. citeturn10view0

If it still crashes after the upgrades, send me:
- your `package.json` Clerk deps,
- whether `NEXT_PUBLIC_CLERK_JS_VERSION` is set anywhere,
- and confirm there’s only one `<ClerkProvider>` in the tree.

(Reference for the component you linked, confirming expected usage and recent update.) citeturn11view0


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
