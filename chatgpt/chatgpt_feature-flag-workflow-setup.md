---
title: "Feature Flag Workflow Setup"
type: guide
created: 2026-02-22
updated: 2026-02-22
source: chatgpt-export
conversation_id: 699a7d51-3278-832f-ba60-e0b80222f638
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Feature Flag Workflow Setup

> Conversation ID: 699a7d51-3278-832f-ba60-e0b80222f638
> Created: 2026-02-22T03:52:06Z
> Updated: 2026-02-22T03:56:54Z
> Messages: 4

---

## User

ai agents keep mesing up feature flags. they keep using the wrong stack or adding them weirdly. we are using statsig with the server only sdk and the vercel flags sdk. help me define an ethos and worldcalss workflow for implementing feature flags. 

---

## Assistant

Mr. White,

If agents are corrupting flags, you don’t have a tooling problem — you have a systems design problem. Feature flags must be treated as production infrastructure, not conditional statements.

Below is a tight ethos + world-class workflow for **Statsig (server-only SDK)** + **Vercel Flags SDK**.

---

# I. Feature Flag Ethos

## 1. Flags are Product Infrastructure
- Every flag has:
  - **Owner**
  - **Type**
  - **Lifecycle state**
  - **Kill plan**
- No anonymous flags.
- No permanent “temporary” flags.

---

## 2. One Authority Per Concern

**Statsig (Server SDK) = Source of Truth**
- Experiment assignment
- Gradual rollouts
- User targeting
- Metrics

**Vercel Flags SDK = Runtime Access Layer**
- Server components
- Edge
- App Router

Never mix responsibilities.

Rule:
> Statsig decides. Vercel exposes.

---

## 3. Flags Are Typed, Not Strings

No raw string calls like:

```ts
statsig.checkGate("new_dashboard")
```

All flags must be defined in a **central typed registry**.

---

# II. Canonical Architecture

## Authoritative Flow

```
Statsig (Server SDK)
        ↓
Typed Flag Layer (internal)
        ↓
Vercel Flags SDK wrapper
        ↓
App Code
```

App code NEVER talks to Statsig directly.

---

# III. World-Class Implementation Workflow

## Step 1 — Create a Flag Spec (PRD Level)

Every new flag must include:

- Name
- Type:
  - release
  - experiment
  - ops/kill-switch
- Owner
- Expiration date
- Removal condition
- Fallback behavior

If this doc doesn’t exist → flag cannot be created.

---

## Step 2 — Add Flag to Central Registry

Create a single file:

```
/flags/registry.ts
```

Example:

```ts
export const flags = {
  newDashboard: {
    key: "new_dashboard",
    type: "release",
    owner: "growth-team",
    expires: "2026-04-01",
  },
} as const;
```

No other file defines keys.

---

## Step 3 — Create a Statsig Adapter Layer

```
/flags/statsig.ts
```

```ts
import { statsig } from "@/lib/statsig";
import { flags } from "./registry";

export async function evaluateFlag(user, flag) {
  return statsig.checkGate(user, flag.key);
}
```

Agents are forbidden from calling Statsig directly.

---

## Step 4 — Create a Vercel Flags Wrapper

```
/flags/vercel.ts
```

```ts
import { flag } from "@vercel/flags";
import { evaluateFlag } from "./statsig";
import { flags } from "./registry";

export const newDashboard = flag({
  key: flags.newDashboard.key,
  async decide({ user }) {
    return evaluateFlag(user, flags.newDashboard);
  },
});
```

Now app code only imports:

```ts
import { newDashboard } from "@/flags/vercel";
```

---

# IV. Rules Agents Must Follow

Add this to your engineering spec:

## Absolute Constraints

1. Never call Statsig SDK outside `/flags`
2. Never define raw flag strings
3. Never create flags inside feature folders
4. Never evaluate flags in client components
5. Never introduce a flag without registry entry

If an AI violates one → PR rejected.

---

# V. Rollout Workflow

## 1. Flag Creation
- Create in Statsig dashboard
- Add to registry
- Open PR

## 2. Development Phase
- Default: OFF
- Use staging targeting

## 3. Internal Validation
- Enable for team
- Confirm metrics firing

## 4. Gradual Rollout
- 5%
- 25%
- 50%
- 100%

## 5. Cleanup
- When 100% stable:
  - Remove conditional branches
  - Delete flag from Statsig
  - Delete from registry
  - Remove wrapper

No flag lives > 90 days without review.

---

# VI. Naming Convention

Use intent-based names:

Good:
```
enable_new_checkout_flow
show_ai_summary_card
use_streaming_inference
```

Bad:
```
test_flag
v2_flag
newFeature
```

Prefix by category if needed:

```
exp_checkout_variant_a
ops_disable_payments
rel_new_dashboard
```

---

# VII. Server-Only Discipline (Critical)

Since you’re using Statsig server SDK:

- Flags must resolve server-side.
- Never expose Statsig client key.
- Never hydrate flag decisions client-side unless using a secure evaluated value.

Correct pattern in App Router:

```tsx
const enabled = await newDashboard();
```

Never:

```tsx
if (process.env.NODE_ENV === 'development')
```

---

# VIII. Feature Flag Lifecycle States

Define state machine:

1. Proposed
2. Live (rolling out)
3. Stable
4. Removal Scheduled
5. Deleted

Track this in the registry as metadata.

---

# IX. Observability Requirements

Every experiment flag must include:

- Primary metric
- Guardrail metric
- Kill threshold

If metrics aren’t defined → experiment cannot ship.

---

# X. Anti-Patterns That Break Teams

Avoid:

- Nested flags
- Flag inside flag
- Environment-based flags replacing product flags
- Long-term permission flags
- Flag logic in multiple places

One flag = one decision point.

---

# XI. Enforcing AI Discipline

Add a lint rule:

- Disallow direct import from Statsig
- Disallow string literal in `checkGate`
- Restrict flag access to `/flags/*`

Even better:
Create a codegen step that generates:

```ts
export type FlagKey = keyof typeof flags;
```

Agents cannot invent new keys.

---

# XII. The Ethos Summary

1. Centralize
2. Type
3. Isolate
4. Lifecycle-manage
5. Delete aggressively

Feature flags are controlled demolition tools — not configuration toggles.

---

If you’d like, I can:

- Design a strict folder structure optimized for Next.js App Router
- Write a hardened template repo structure
- Or draft a short internal “Feature Flag Constitution” your team/agents must follow

Tell me which direction you want to go.

---

## User

what about tests. for example a test that expects an item to laod that is behind a flag.

---

## Assistant

Mr. White,

Most teams get flags wrong in tests because they treat them as runtime randomness instead of **controllable inputs**.

Flags in tests must behave like:

> Explicit dependencies, not environment state.

Below is the world-class approach for **Statsig (server SDK) + Vercel Flags SDK**.

---

# Core Principle

Tests never talk to:

- Statsig
- Network
- Real flag evaluation
- Percent rollouts

Tests override the **flag layer**, not the SDK.

Your architecture from before enables this cleanly.

---

# I. Testing Philosophy by Layer

You have 3 layers:

1. Statsig Adapter
2. Vercel Flag Wrapper
3. Application Code

Each layer is tested differently.

---

# II. Unit Tests (Application Layer)

If a component loads an item behind a flag:

```tsx
if (await newDashboard()) {
  return <NewDashboard />
}
```

You do **not** enable the flag in Statsig.

You mock the flag module.

---

## Correct Pattern (Vitest / Jest)

```ts
vi.mock("@/flags/vercel", () => ({
  newDashboard: vi.fn(),
}))
```

Then in test:

```ts
import { newDashboard } from "@/flags/vercel"

it("renders new dashboard when flag enabled", async () => {
  newDashboard.mockResolvedValue(true)

  render(await Page())

  expect(screen.getByText("New Dashboard")).toBeInTheDocument()
})
```

And the inverse:

```ts
newDashboard.mockResolvedValue(false)
```

This is deterministic and fast.

---

# III. Never Do This

❌ Do not:

- Initialize Statsig in tests
- Hit real SDK
- Depend on environment variables
- Use actual rollout percentages
- Toggle flags via dashboard for CI

That introduces flakiness.

---

# IV. Testing Strategy Matrix

## 1. Unit Tests
Mock the flag wrapper.

Goal:
Test behavior under both ON and OFF.

Always write both cases.

---

## 2. Integration Tests (Server Layer)

Here you test:

- Statsig adapter logic
- User context shaping
- Edge conditions

Pattern:

Mock Statsig SDK itself.

```ts
vi.mock("@/lib/statsig", () => ({
  statsig: {
    checkGate: vi.fn(),
  },
}))
```

Then test:

```ts
statsig.checkGate.mockReturnValue(true)
```

You are verifying your adapter, not Statsig.

---

## 3. E2E Tests (Playwright / Cypress)

Now you test real behavior.

But you must control the flag explicitly.

Best pattern:

### Use Targeting Overrides

Create a special test user:

```ts
{
  userID: "e2e-test-user",
  email: "e2e@test.com",
  custom: { environment: "e2e" }
}
```

In Statsig:
Target flag to:
```
custom.environment == "e2e"
```

Now tests are deterministic.

---

# V. Golden Rule

Every flag must be testable in 3 ways:

1. Forced ON
2. Forced OFF
3. Production default

If you cannot force it ON/OFF, your architecture is wrong.

---

# VI. Handling “Item Should Load” Example

Suppose:

```tsx
if (await showAiSummary()) {
  return <SummaryCard />
}
```

Your tests:

### Case 1: loads item

```ts
showAiSummary.mockResolvedValue(true)
```

Expect SummaryCard present.

### Case 2: does not load item

```ts
showAiSummary.mockResolvedValue(false)
```

Expect fallback present.

---

# VII. Avoid Snapshot Fragility

When flags change:

Snapshot tests explode.

Instead:

Test intent.

Bad:

```ts
expect(container).toMatchSnapshot()
```

Good:

```ts
expect(screen.queryByText("Summary")).toBeNull()
```

Be precise.

---

# VIII. Preventing Agent Mistakes

Add rule:

Tests must never import:

```ts
@/lib/statsig
```

Only:

```ts
@/flags/vercel
```

You can enforce with ESLint restricted imports.

---

# IX. Advanced: Flag Test Harness

For larger systems, build a test helper:

```ts
export function mockFlag(flag, value) {
  flag.mockResolvedValue(value)
}
```

Or even:

```ts
withFlags({ newDashboard: true }, () => {
  // run test
})
```

This standardizes control.

---

# X. What World-Class Teams Do

- Every PR adding a flag must include:
  - ON test
  - OFF test
- No flag merges without dual-path coverage
- When flag reaches 100%:
  - Remove OFF tests
  - Remove ON branch
  - Delete flag

Flags are temporary by policy.

---

# XI. The Deeper Insight

If your test requires “the dashboard to load” but the flag makes it unpredictable…

That means the flag leaked into global state.

Flags must be explicit inputs, not hidden globals.

---

If you'd like, I can:

- Design a clean `withFlags()` testing utility for your stack
- Show a Playwright pattern for deterministic rollout control
- Or help you write a strict ESLint rule set to prevent agents from bypassing the flag layer

Choose your next move.
