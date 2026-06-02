---
title: "Tech Stack Overview"
type: guide
created: 2026-01-04
updated: 2026-01-04
source: chatgpt-export
topic: design-ux
message_count: 8
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Tech Stack Overview

> **Source:** ChatGPT conversation
> **Date:** 2026-01-04T18:17:53Z
> **Messages:** 8
> **Topic:** design-ux

## Question

oai/apps/hasSeenNoAuthImagegenNux	false	
oai/apps/imageGenProgressUpsellV2	{"lastSeenUpsellAt":null,"lastUsedImageGen":1767403803,"lastMessageId":"97c4225e-91b4-4eca-9bde-aa36ae40f14c","lastCanBeSeen":false}	
oai/apps/l1239dk1/7a8d45ff	true	
oai/apps/l1239dk1/7f2c4aa2	"github-1030964787"	
oai/apps/l1239dk1/8fa94c1e	{"72f869d8":{"contentId":"72f869d8","prompt":"1. Build a Bodyspec MCP tool (e.g., `tools/bodyspec-mcp.ts`) that exchanges user credentials for scan history and returns the normalized scan array (`date`, `weight`, `body_fat_percentage`, `bone_mass`, etc.).\n2. Add a Next.js route such as `apps/web/src/app/api/import/bodyspec/route.ts` that invokes the MCP tool, handles auth (Clerk session + Bodyspec token), and forwards the JSON result.\n3. Update `DexaUploadStep` to offer “Connect to Bodyspec” alongside PDF upload and feed the returned scans into `updateData({ extractedScans, scanCount, filename })`.\n4. Extend `completeOnboarding` (and any bulk import path) to set `data_sou

## Answer

Mr. White — based on what you pasted, they’re running a pretty standard modern “Next.js + Supabase + Vercel” product stack, with iOS parity work underway.

### Web / Backend
- **Next.js (App Router)**: You’ve got routes like `apps/web/src/app/api/.../route.ts`, which is the App Router API convention.
- **TypeScript**: Everything shown is TS (`.ts`, `.tsx`), plus shared types.
- **Serverless API on Vercel**: Strong signal from “Vercel AI Gateway”, plus the Next.js route structure.
- **Auth: Clerk**: Explicit mention: “Clerk session”.
- **Database / Backend: Supabase**
  - Shared types from `packages/supabase/src/types.ts`
  - Storage helpers: `apps/web/lib/storage/photos.ts` → using **Supabase Storage** for photo uploads.

### AI / Document parsing
- **OpenAI (currently direct) → moving to Vercel AI Gateway**
  - They mention swapping `new OpenAI({ apiKey })` for requests through the **Gateway**.
  - Mentions of **caching headers** + **provider fallback** = classic gateway usage.
- **PDF processing / OCR fallback**: `pdf-lib` is explicitly called out as a workaround they want to remove once the gateway handles vision/OCR fallback.

### Frontend
- **React + React Hook Form**: Explicit (`React Hook Form`, `MetricField.tsx`).
- **Component-based UI** in `apps/web/components/...` and page at `apps/web/app/(authenticated)/log/page.tsx`.

### Testing
- **Playwright**: Explicit (“Add Playwright tests…”).
- **Cypress and/or Playwright**: They say “Cypress/Playwright visual regression tests” — could be either or both, but at least one is in use.

### Mobile
- **iOS native (Swift)**:
  - Paths like `apps/ios/LogYourBody/...`
  - Swift service referenced: `Services/AnalyticsService.swift`
  - They’re porting calculations from Swift into shared TS utilities.

### Integrations / Data sources
- **Bodyspec integration** via an “MCP tool”:
  - A custom tool (`tools/bodyspec-mcp.ts`) to exchange creds and normalize scan history.
  - Imports get tagged as `data_source: 'DEXA'`, suggesting they track source provenance in analytics/sync.

### Repo / Monorepo structure
- Looks like a **monorepo** with multiple apps + shared packages:
  - `apps/web`, `apps/ios`, `packages/supabase`, `tools/...`, `docs/...`

If you want, paste a bit more (e.g., `package.json` deps, `vercel.json`, or the root folder tree) and I can tell you what they’re likely using for styling (Tailwind vs something else), state/query (TanStack Query, SWR), and CI (GitHub Actions, etc.).

## Question

How do I get auto squash and merge to be set by default so no manual intervention is needed for passing prs

## Answer

Mr. White — this is a **GitHub repo + org configuration** issue. You can make **squash-and-merge the default with zero manual clicks**.

---

## 1. Set squash merge as the only allowed merge method (repo-level)

In **entity["company","GitHub","code hosting platform"]**:

**Repo → Settings → General → Pull Requests**
- ✅ Enable **Squash merging**
- ❌ Disable **Merge commits**
- ❌ Disable **Rebase merging**
- ✅ (Optional) “Default to squash merging” (if shown)

Result: every PR can *only* be squash-merged.

---

## 2. Enable auto-merge (this removes manual intervention)

Same page or **Settings → Pull Requests**:
- ✅ Enable **Auto-merge**

Now maintainers can enable auto-merge once per PR, or you can enforce it automatically (next step).

---

## 3. Require status checks + reviews (Branch Protection)

**Settings → Branches → Branch protection rules**
Create / edit rule for `main` (or equivalent):

- ✅ Require pull request reviews before merging  
  - Set required reviewers (usually 1)
- ✅ Require status checks to pass before merging  
  - Select CI checks (tests, lint, build)
- ✅ Require branches to be up to date (recommended)
- ❌ Allow force pushes
- ❌ Allow deletions

This ensures **only passing PRs auto-merge**.

---

## 4. Make auto-merge truly automatic (no human click)

### Option A — GitHub Action (recommended)
Use an action like:
- `peter-evans/enable-pull-request-automerge`

Trigger it when:
- All required checks pass
- PR is approved
- Author is trusted (optional)

This **auto-enables auto-merge** so no one has to click anything.

### Option B — GitHub rulesets (newer org feature)
If you’re on a GitHub plan that supports **Rulesets**:
- Create a ruleset for the default branch
- Enforce:
  - Required checks
  - Required reviews
  - Merge method = squash
- Combine with auto-merge enabled

---

## 5. Org-wide default (if you manage many repos)

**Org Settings → Repository defaults**
- Default merge method: **Squash**
- Disable merge commits & rebase globally

This applies to all new repos.

---

## End state (what you want)
- PR opened
- CI passes
- Review approved
- **Automatically squash-merged**
- No buttons clicked

If you want, tell me:
- GitHub plan (Free / Team / Enterprise)
- Whether you already use GitHub Actions

I’ll give you a drop-in YAML that enforces this perfectly.

## Question

Does statsig have a toolbar or something we can use to toggle gates

## Answer

Mr. White — **yes** Statsig does have a UI where you can manage and *toggle gates* (feature flags) without deploying code. It’s built into their **Statsig Console** and lets you turn flags on/off, adjust rollout percentages, add overrides, etc. — all in real time. citeturn0search0turn0search9

### How it works

- **Statsig Console (web UI)** — You log into the console and under **Feature Management → Feature Gates** you see a list of your gates. From there you can:
  - Enable or disable a gate
  - Adjust targeting rules
  - Change rollout percentages
  - Add user overrides or bypass lists  
  That effectively acts as the toolbar or dashboard for toggling gates in production without code redeploys. citeturn0search0

- **Scheduled rollouts & overrides** — The interface supports scheduling and override lists so you can fine-tune exposures without writing code. citeturn0search0

### Additional tooling

- **Feature Gate exposure views** — The console also shows who is passing/failing a gate so you can validate toggles. citeturn0search0

- **SDK integrations** — Toggling in the UI affects what your app sees via Statsig’s client and server SDKs — no code deployments needed for gate value changes. citeturn0search9

There isn’t a separate “toolbar extension” like a browser plugin, but the Statsig Console *is* the dedicated dashboard for toggling and controlling feature gates in real time. citeturn0search0

## Question

Ok so I have to change screens or have two monitors to see results?

## Answer

Mr. White — **by default, yes**.

With **entity["company","Statsig","feature management platform"]**, gate changes happen in the **Statsig Console**, so you either:
- switch tabs/screens, or  
- run two monitors (console + app)

There is **no built-in in-app overlay or toolbar** that floats on top of your product like LaunchDarkly’s old dev toolbar.

### Your practical options (ranked)

#### 1. Console + refresh (default, zero work)
- Toggle gate in Statsig Console
- Refresh app
- Works fine, just context-switchy

#### 2. Statsig **local overrides / debug mode** (best for dev)
- SDKs support **local gate overrides** (code or query-param driven)
- Example use cases:
  - Force a gate on/off locally
  - Simulate user attributes
- This avoids the console entirely while developing

This is how most serious teams work day-to-day.

#### 3. Build a lightweight **internal dev panel** (common at scale)
- Small internal-only UI:
  - Shows current gate values
  - Lets you flip local overrides
- Reads from Statsig SDK, writes overrides client-side
- 1–2 hours of work, massive DX improvement

#### 4. Admin / QA environment with shared gates
- QA toggles gates in console
- Devs test against QA/staging
- Still requires screen switching, but less frequent

### What Statsig does *not* give you
- ❌ No in-app floating toolbar
- ❌ No browser extension that injects a toggle UI
- ❌ No real-time visual feedback panel in the product itself

### Bottom line
- **Prod / QA:** console + refresh is expected
- **Dev:** use **local overrides** or build a tiny dev panel
- If you want zero context switching, you must add it yourself

If you want, tell me:
- client SDK (React, Next.js, server-only, etc.)
- how many gates you usually touch per session

I’ll outline the cleanest dev-panel pattern for your stack.
