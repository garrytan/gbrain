---
title: "Chromatic Storybook Integration"
type: guide
created: 2025-08-17
updated: 2025-08-17
source: chatgpt-export
topic: writing-content
message_count: 6
tags: [chatgpt, knowledge, writing-content]
---
**Topic:** [[chatgpt-knowledge/_topics/writing-content]]

# Chromatic Storybook Integration

> **Source:** ChatGPT conversation
> **Date:** 2025-08-17T22:34:21Z
> **Messages:** 6
> **Topic:** writing-content

## Question

chromatic storybook

## Answer

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

## Question

vercel and posthog

## Answer

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
- Use PostHog's functions (

*(Answer truncated — 4112 chars total)*

## Question

give me an ai prompt to switch our feature flags to posthog and implement it for core basics as a yc lean solo founder startup. were currently using statsig sow ed have to remove it

## Answer

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
     - `identifyUser(distinctId, props)` that calls `post

*(Answer truncated — 9170 chars total)*
