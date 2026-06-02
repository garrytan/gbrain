---
title: "Turborepo SSR Slowdown"
type: note
created: 2026-02-04
updated: 2026-02-04
source: chatgpt-export
conversation_id: 6982bfe5-a46c-8330-93c0-5d2193b14396
message_count: 2
tags: [chatgpt, import, code]
---
# Turborepo SSR Slowdown

> Conversation ID: 6982bfe5-a46c-8330-93c0-5d2193b14396
> Created: 2026-02-04T03:41:27Z
> Updated: 2026-02-04T21:20:41Z
> Messages: 2

---

## User

turbo repo dev server ssr pages sslow

---

## Assistant

Mr. White — sounds like **Turborepo dev server + SSR pages are slow**. This is a *very* common combo problem. Facts, not fluff:

---

## The usual causes (ranked by likelihood)

### 1. **No effective caching during dev**
- SSR pages re-run **on every request**
- In dev, **Turborepo caching is mostly irrelevant** for runtime SSR
- Result: cold Node execution + data fetching every refresh

**Key point:** Turborepo speeds *builds*, not SSR request time.

---

### 2. **Monorepo dependency graph overhead**
- Large shared packages (UI, utils) imported into SSR routes
- Dev bundler (Next/Vite) does extra module resolution
- HMR invalidates too much → full server reloads

**Symptom:** One small change → entire server recompiles.

---

### 3. **Next.js SSR + `transpilePackages`**
If you’re using Next in a monorepo:
- `transpilePackages` or `next-transpile-modules`
- Forces Babel/SWC work **on every request in dev**
- Brutal for SSR latency

---

### 4. **Shared env / config re-evaluation**
- Shared config packages (`@repo/config`)
- Dynamic imports or runtime logic in config
- Re-executed per request

SSR + dynamic config = slow by default.

---

### 5. **Dev-only logging & instrumentation**
- Console logging in shared packages
- Sentry / OpenTelemetry enabled in dev
- These hit **every SSR request**

---

## High-impact fixes

### ✅ 1. Stop expecting Turborepo to fix SSR
Use it for:
- builds
- lint
- tests

**Not** request-time performance.

---

### ✅ 2. Make SSR pages static *in dev*
If using Next:
```ts
export const dynamic = "force-static"
```
or
```ts
export const revalidate = 60
```

Even fake caching massively improves dev speed.

---

### ✅ 3. Shrink what SSR imports
Bad:
```ts
import { everything } from "@repo/ui"
```

Good:
```ts
import Button from "@repo/ui/button"
```

Tree-shaking is weaker in dev.

---

### ✅ 4. Disable package transpilation in dev
Only transpile shared packages in **production builds**, not dev:
```js
if (process.env.NODE_ENV === "production") {
  transpilePackages: ["@repo/ui"]
}
```

---

### ✅ 5. Run SSR app outside Turbo during dev
Common winning setup:
```bash
pnpm --filter web dev
```
Turbo adds overhead for watch + task orchestration you don’t need.

---

## Reality check
> Turborepo + SSR + dev mode  
is **fundamentally slower** than prod.

The goal is *acceptable latency*, not prod parity.

---

If you want, tell me:
- framework (Next / Remix / custom)
- dev command
- whether SSR pages hit DB or APIs

I’ll give you a **targeted fix list**, not guesses.


## See Also
- [[chatgpt/chatgpt_electron-app-turborepo-setup]]
- [[chatgpt/chatgpt_explain-turborepo]]
- [[chatgpt/chatgpt_test-turborepo-locally]]
- [[chatgpt/chatgpt_turborepo-changelog]]
- [[chatgpt/chatgpt_turborepo-env-setup]]
