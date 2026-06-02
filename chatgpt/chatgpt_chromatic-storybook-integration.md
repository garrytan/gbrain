---
title: "Chromatic Storybook Integration"
type: guide
created: 2025-08-17
updated: 2025-08-17
source: chatgpt-export
conversation_id: 68a258ed-353c-8331-806f-d645d34c2a82
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Chromatic Storybook Integration

> Conversation ID: 68a258ed-353c-8331-806f-d645d34c2a82
> Created: 2025-08-17T22:34:21Z
> Updated: 2025-08-17T22:47:38Z
> Messages: 6

---

## User

chromatic storybook

---

## Assistant

​Chromatic is a cloud-based visual testing and UI review tool designed to work seamlessly with Storybook. It captures snapshots of your components' stories and compares them against baselines to detect visual regressions.

### Key Features

- **Pixel-Perfect Visual Testing**: Automatically detects even the smallest UI changes across browsers and devices. citeturn0search0

- **CI Integration**: Runs visual tests in your CI pipeline, managing baselines across branches and users. citeturn0search0

- **Visual Tests Addon**: Allows running visual tests directly within Storybook, providing immediate feedback during development. citeturn0search13

- **Smart Baseline Management**: Accept or reject visual changes, with baselines syncing automatically to the cloud. citeturn0search13

- **Figma Integration**: Link stories to Figma components, enabling designers to view live components within their design workspace. citeturn0search6

### Getting Started

1. **Install the Chromatic CLI**:

   ```bash
   npm install --save-dev chromatic
   ```


2. **Authenticate and Create a Project**:

   Sign in to [Chromatic](https://www.chromatic.com/) and create a new project to obtain your project token.

3. **Publish Your Storybook**:

   ```bash
   npx chromatic --project-token=<your-project-token>
   ```


4. **Install the Visual Tests Addon**:

   ```bash
   npx storybook@latest add @chromatic-com/storybook
   ```


5. **Run Visual Tests**:

   Start Storybook and navigate to the Visual Tests panel to run tests and review results.

By integrating Chromatic into your workflow, you can ensure UI consistency and catch visual bugs early in the development process. 

---

## User

vercel and posthog

---

## Assistant

You're asking about **Vercel and PostHog**—assume you're referring to how to use the two together for analytics and feature flagging. Here's a focused overview of how they integrate, including the key capabilities, setup steps, and considerations.

---

##  What Are They?

### **Vercel**
A modern frontend cloud platform, particularly well-suited for Next.js deployments. It provides seamless builds, global deployment, serverless functions, and more.

### **PostHog**
An open-source product analytics and feature-flag platform that offers in-depth tracking, session replays, heatmaps, custom events, and robust integration capabilities. It's highly customizable and privacy-respecting. citeturn0search0turn0search7turn0search6

---

##  Why Use PostHog Instead of Vercel Web Analytics?

| Feature | Vercel Web Analytics | PostHog |
|--------|----------------------|---------|
| Setup Ease | Extremely simple, privacy-focused | More technical onboarding |
| Tracking Depth | Basic metrics (e.g. page views) | Advanced (auto-capture, heatmaps, recordings) |
| Feature Flags | Not supported | Fully supported |
| Integrations | Limited | Broad (CDPs, warehouses, CRMs, more) |
| Customization | Basic dashboards | Highly customizable, open-source citeturn0search6 |

---

##  How to Integrate PostHog with Vercel (Especially Next.js)

### 1. **Basic Setup (Client & Server Analytics)**
Use PostHog’s JS and Node SDKs to capture events and analytics in both client-side and server-side environments.

- **Client Side**  
  Within a Next.js App Router or pages setup, initialize PostHog via React provider—commonly in a `providers.js` or similar—and wrap your app layout. citeturn0search0turn0search7

- **Server Side**  
  Use the `posthog-node` package in server components or API routes to capture backend events (e.g., page loads, feature flag evaluations). citeturn0search0

### 2. **Feature Flags via PostHog**
Leverage feature flags with the Flags SDK and PostHog adapter—great for A/B tests or rollout logic.

```javascript
import { flag } from 'flags/next'
import { postHogAdapter } from '@flags-sdk/posthog'

export const exampleFlag = flag({
  key: 'example-flag',
  defaultValue: false,
  adapter: postHogAdapter.isFeatureEnabled(),
  identify: { distinctId: 'user_distinct_id' },
})
```

Then use it in your page components to conditionally render content. citeturn0search1turn0search4

### 3. **Reverse Proxying PostHog**
To bypass ad blockers and improve performance, route PostHog analytics through Vercel as a reverse proxy. Modify `vercel.json`:

```json
{
  "rewrites": [
    { "source": "/ph/(.*)", "destination": "https://us.i.posthog.com/$1" }
  ]
}
```

Then initialize PostHog with `api_host: '/ph/'` in your client or server code. citeturn0search2turn0search8

### 4. **Vercel’s AI & Error Tracking Enhancements**
PostHog now supports advanced observability features:

- Automatically captures AI SDK events, spans, and traces.
- Use PostHog's functions (e.g., `shutdown()`) with Vercel’s `waitUntil` API so events are reliably sent from serverless functions. citeturn0search1

---

##  Real-World Tip: Common Challenges

> “No analytics are captured in production on Vercel—works fine in dev.”  
> Likely due to ad blockers or needing reverse proxy setup. citeturn0search3

---

##  Summary Workflow

1. **Install PostHog SDKs**: `posthog-js` for client, `posthog-node` for server.
2. **Initialize Providers**: Wrap your app (React client) and configure backend instrumentation.
3. **Set Feature Flags**: Build flags in PostHog, use with the Flags SDK and adapter.
4. **Deploy with Proxy**: Add `vercel.json` rewrites to shield against ad blockers.
5. **Enhance Observability**: Implement AI observability and error tracking via PostHog with `shutdown()` patterns and `waitUntil`.
6. **Deploy**: Push your Next.js code to Vercel and test both tracking and flagging functionality.

---

Let me know if you'd like deep-dives into code implementation for any of these areas—client instrumentation, feature flag logic, proxy setup, or AI observability integration.

---

## User

give me an ai prompt to switch our feature flags to posthog and implement it for core basics as a yc lean solo founder startup. were currently using statsig sow ed have to remove it

---

## Assistant

Got it, Mr. White. Here’s a single-shot AI prompt you can drop into your code agent to migrate **Statsig → PostHog** and wire up core feature flags for a lean YC-style Next.js+Vercel stack.

---

# AI PROMPT — “Migrate Feature Flags from Statsig to PostHog (Next.js + Vercel)”

**Goal:** Remove Statsig and implement PostHog feature flags (server-evaluated + client-hydrated) with a minimal, fast, privacy-sane setup. Include a reversible rollout plan, reverse proxy to evade blockers, and CI checks.

## Constraints
- Framework: Next.js (App Router), TypeScript.
- Host: Vercel.
- Keep the diff tight, DX clean, and perf-first (edge-safe where possible).
- No Storybook/Chromatic work here.
- Minimize churn in callsites: provide a thin adapter so `isEnabled('flag')`-style usage continues to work.

## Deliverables
1. **Remove Statsig**
   - Uninstall Statsig deps.
   - Delete/replace Statsig init and helpers.
   - Codemod (or grep-based change) to swap `statsig.checkGate(...)` and dynamic configs to new helpers (see §Adapters).
   - Commit “chore(flags): remove statsig”.

2. **Install & Initialize PostHog**
   - Add deps: `posthog-js`, `posthog-node`.
   - Create `/lib/posthog/server.ts`:
     - Export a singleton `posthogServer` (from `posthog-node`) with:
       - `apiKey` from `POSTHOG_API_KEY`.
       - `host` from `POSTHOG_HOST` (default `https://us.i.posthog.com`).
       - Set short `feature_flag_request_timeout_ms` (e.g. 1000–1500 ms) and enable in-memory flag cache.
     - Helper: `getServerFlag(key: string, distinctId: string, props?: Record<string, any>) → Promise<boolean | string | object>`.
   - Create `/lib/posthog/client.ts`:
     - Initialize `posthog-js` with `POSTHOG_PUBLIC_KEY`, `api_host` pointing at our proxy path (see §Proxy), `enable_recording: false` by default.
     - Support **bootstrapped flags** via server-injected payload to avoid FOUC.

3. **Reverse Proxy (blocker-resistant)**
   - Add **non-obvious** proxy path (e.g. `/phx/…`) in `next.config.js` rewrites to PostHog Cloud assets/ingest.
   - Set `skipTrailingSlashRedirect: true`.
   - Use that path as `api_host` on client.  
   - Commit “feat(flags): add PostHog reverse proxy”.

4. **Environment Variables (Vercel + .env)**
   - `POSTHOG_API_KEY` (server)
   - `POSTHOG_PUBLIC_KEY` (client)
   - `POSTHOG_HOST` (optional; default Cloud US)
   - `POSTHOG_PROXY_PATH=/phx`
   - Update Vercel Project Env (Production/Preview/Dev). Provide a README snippet.

5. **Adapters (keep callsites stable)**
   - New file `/lib/flags.ts` exporting:
     - `isEnabled(key, ctx?)` → server-first evaluation (uses `posthog-node`); falls back to bootstrapped/client if needed.
     - `getVariant(key, ctx?)` → returns variant string or JSON payload.
     - `FlagProvider` React component to:
       - Read server-evaluated flags in RSC, serialize as `window.__PH_FLAGS__`.
       - On client, call `posthog-js` with `bootstrap: { featureFlags: … }`.
     - `identifyUser(distinctId, props)` that calls `posthogServer.identify` on server and `posthog.identify` on client as needed.
   - Migrate dynamic configs from Statsig to **JSON payload flags** (same keys). Preserve default behaviors.

6. **Server-side Evaluation Pattern**
   - In a shared RSC util, compute:
     - `distinctId` from session/user ID or anonymous cookie.
     - `flags = await posthogServer.getAllFlags(distinctId, { $set: userProps })`.
   - Inject `flags` into the page layout via `FlagProvider` to eliminate client flash.
   - Provide example usage in a sample server component and a client component.

7. **Kill-Switch & Safe Defaults**
   - Add `CRITICAL_ROLLOUT` example flag demonstrating:
     - 0% default, 1%, 10%, 50%, 100% staged rollout.
     - Immediate “off” behavior without redeploy.
   - Add timeouts + try/catch wrappers so rendering never blocks on PostHog.

8. **Analytics Opt-In (Optional)**
   - Keep analytics disabled by default (we’re only implementing flags).
   - Leave a toggleable env `POSTHOG_ENABLE_ANALYTICS=false`.

9. **Tests & CI**
   - Unit tests for `isEnabled`/`getVariant` with mocked PostHog.
   - Add a CI check that ensures `POSTHOG_*` envs exist for Preview/Prod (fail with helpful message).
   - Commit “test(flags): cover server/client evaluation and bootstrapping”.

10. **Docs for Ops**
    - `docs/feature-flags.md`:
      - How to create flags (boolean, multivariate/JSON).
      - How to target by user properties.
      - How to stage rollouts.
      - How to add a new flag in code (server + client).

## Code Sketches

**`next.config.js` (proxy):**
```ts
const nextConfig = {
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: '/phx/static/:path*', destination: 'https://us-assets.i.posthog.com/static/:path*' },
      { source: '/phx/:path*',        destination: 'https://us.i.posthog.com/:path*' },
    ];
  },
};
module.exports = nextConfig;
```

**`/lib/posthog/server.ts`:**
```ts
import { PostHog } from 'posthog-node';

const key  = process.env.POSTHOG_API_KEY!;
const host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

export const posthogServer = new PostHog(key, {
  host,
  // keep server fast & resilient
  flushAt: 20,
  flushInterval: 500,
  requestTimeout: 1500,
  featureFlagsPollingInterval: 30000,
  enable: true,
});

export async function getServerFlag<T = boolean | string | object>(
  key: string,
  distinctId: string,
  props?: Record<string, any>
): Promise<T | undefined> {
  try {
    if (props) await posthogServer.identify({ distinctId, properties: props });
    const value = await posthogServer.getFeatureFlag(key, distinctId, props);
    return value as T | undefined;
  } catch {
    return undefined;
  }
}
```

**`/lib/posthog/client.ts`:**
```ts
import posthog from 'posthog-js';

const apiHost = process.env.NEXT_PUBLIC_POSTHOG_PROXY_PATH || '/phx';
const key     = process.env.NEXT_PUBLIC_POSTHOG_PUBLIC_KEY!;

export function initPosthog(bootstrap?: Record<string, any>) {
  if (typeof window === 'undefined' || (posthog as any).__initialized) return;
  posthog.init(key, {
    api_host: apiHost,
    loaded: (ph) => { (ph as any).__initialized = true; },
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    bootstrap: bootstrap ? { featureFlags: bootstrap } : undefined,
    request_timeout: 1500,
  });
  return posthog;
}
```

**`/lib/flags.tsx`:**
```tsx
'use client';
import React, { useEffect } from 'react';
import { initPosthog } from './posthog/client';

export function FlagProvider({ flags, children }: { flags: Record<string, any>, children: React.ReactNode }) {
  useEffect(() => { initPosthog(flags); }, [flags]);
  return <>{children}</>;
}
```

**Server usage (RSC layout):**
```tsx
// app/layout.tsx (server)
import { posthogServer } from '@/lib/posthog/server';
import { FlagProvider } from '@/lib/flags';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const distinctId = /* userId or anon cookie */;
  const flags = await posthogServer.getAllFlags(distinctId, { $set: {/* user props */} }).catch(() => ({}));
  return (
    <html>
      <body>
        {/* client will bootstrap with these to avoid FOUC */}
        <FlagProvider flags={flags}>{children}</FlagProvider>
      </body>
    </html>
  );
}
```

**Client usage:**
```tsx
'use client';
import posthog from 'posthog-js';
export function NewUI() {
  const enabled = posthog.isFeatureEnabled('new_ui'); // instant thanks to bootstrap
  return enabled ? <NewComponent/> : <OldComponent/>;
}
```

**Dynamic config/variant example:**
```ts
const variant = await posthogServer.getFeatureFlag('pricing_test', distinctId);
// e.g. 'A' | 'B' or a JSON payload if configured
```

## Migration Notes
- Map each Statsig gate/config → PostHog feature flag (boolean or multivariate with JSON payload). Preserve keys where possible.
- Default to **off** in Cloud; use staged rollout rules (1%→10%→50%→100%) for safety.
- For SSR consistency, prefer server evaluation; client uses bootstrapped flags to match SSR.
- Keep a temporary compatibility shim if you need to land in multiple PRs.

## Acceptance Criteria
- Removing Statsig produces no TS errors.
- Flags evaluate server-side in RSC without blocking render > ~1500 ms.
- No client-side flash on first paint (bootstrapping proven).
- Proxy path works (events/flags resolve even with common blockers).
- Example flag successfully rolled from 0% → 100% in PostHog without redeploy.
- CI fails if required PostHog env vars are missing.

---

**Implementation is aligned with PostHog docs for Next.js/Vercel setup, reverse proxying, server/client SDKs, bootstrapping, timeouts, and migration from Statsig.** See: Vercel+Next.js feature flags guide, reverse proxy on Vercel/Next rewrites, feature flag install/creation, Node & JS SDK usage, request timeouts/bootstrapping, and Statsig migration guidance. citeturn0search0turn0search1turn0search2turn0search3turn0search6turn0search8turn0search9turn0search13turn0search16turn0search4

If you want, I can tailor the codemod to your current Statsig call patterns and wire this into your existing app layout.


## See Also
- [[chatgpt/chatgpt_chromatic-meaning-explained-2]]
- [[chatgpt/chatgpt_chromatic-meaning-explained]]
- [[chatgpt/chatgpt_percy-vs-chromatic-vs-playwright]]
- [[chatgpt/chatgpt_ai-command-palettes-integration]]
- [[chatgpt/chatgpt_analytics-integration-advice]]
