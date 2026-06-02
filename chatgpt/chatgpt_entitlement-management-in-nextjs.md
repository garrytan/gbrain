---
conversation_id: 699370e7-5720-8333-ac4b-10cd12caa8ad
created: 2026-02-16
links:
- '[[chatgpt-clusters/coding_web_dev]]'
message_count: 6
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Entitlement Management in Next.js
type: guide
updated: 2026-02-16
---

# Entitlement Management in Next.js

> Conversation ID: 699370e7-5720-8333-ac4b-10cd12caa8ad
> Created: 2026-02-16T19:35:04Z
> Updated: 2026-02-16T22:29:51Z
> Messages: 6

---

## User

what is the best way to handle entitlements in a next js app. we have pricing tables across teh app and stripe entitlements and then we have lists of features on the landing page. how should we think about managing these list of featues. we use statsig for feature flags. should we ahvea constants file of featuers or anything like that. or a central doc to lsit them out? generally just want to be able clearly avoid "hey your pricing table says Feature X is pro plan only but ive been using it on free for 3 months. or vise verse" like making sure the marketing pages, stripe, stasitg, and the code, are all aligned

---

## Assistant

Mr. White,

You’re solving a **source-of-truth problem**, not a Stripe problem or a Statsig problem.

The mistake most teams make:  
- Marketing defines features in copy  
- Stripe defines price tiers  
- Engineers gate via flags  
- Nobody owns the canonical mapping  

That’s how you get entitlement drift.

Below is the clean, scalable way to structure this.

---

# 1️⃣ Separate the Concepts Clearly

You have **three different systems**, and they should not overlap responsibilities:

| System | Responsibility |
|--------|---------------|
| **Stripe** | Billing (who paid for what plan) |
| **Statsig** | Feature rollout / experimentation |
| **Your App** | Entitlements (who can use what) |

Stripe ≠ entitlements.  
Statsig ≠ pricing tiers.

Your app should own entitlements.

---

# 2️⃣ Create a Canonical Feature Registry (Single Source of Truth)

Yes — you should have a **central features registry** in your codebase.

Example:

```ts
// core/features.ts

export const FEATURES = {
  ADVANCED_ANALYTICS: {
    id: "advanced_analytics",
    displayName: "Advanced Analytics",
    description: "Granular performance insights",
    plans: ["pro", "enterprise"],
  },
  EXPORT_CSV: {
    id: "export_csv",
    displayName: "CSV Export",
    description: "Download data as CSV",
    plans: ["pro", "enterprise"],
  },
} as const
```

This file becomes:

- Used by your pricing table
- Used by entitlement logic
- Used by internal documentation
- Used to generate landing page feature lists

Marketing should not manually rewrite plan features.

---

# 3️⃣ Define Plans Centrally

```ts
export const PLANS = {
  FREE: { id: "free" },
  PRO: { id: "pro" },
  ENTERPRISE: { id: "enterprise" },
}
```

Now Stripe price IDs map to these plans:

```ts
// billing/stripeMap.ts
export const STRIPE_PRICE_TO_PLAN = {
  "price_123": "free",
  "price_456": "pro",
}
```

Stripe is just a payment → plan resolver.

---

# 4️⃣ Build an Entitlement Resolver (Core Layer)

Never gate features directly with:

- Stripe subscription
- Statsig flag
- Random conditionals

Instead:

```ts
function hasFeature(user, featureId) {
  const plan = getUserPlan(user)
  const feature = FEATURES[featureId]

  if (!feature) return false
  return feature.plans.includes(plan)
}
```

All UI, API routes, and server actions call this.

This becomes your enforcement layer.

---

# 5️⃣ Where Statsig Fits

Statsig should control:

- Gradual rollouts
- A/B testing
- Internal preview features

It should NOT define plan logic.

Proper layering:

```ts
if (
  hasFeature(user, "advanced_analytics") &&
  statsig.checkGate("advanced_analytics_enabled")
) {
  showFeature()
}
```

Plan gating first.  
Experiment gating second.

---

# 6️⃣ Drive the Pricing Table from Code (Not Marketing Copy)

Your pricing table should read from the same registry:

```ts
const proFeatures = Object.values(FEATURES).filter(f =>
  f.plans.includes("pro")
)
```

Now:

- Landing page
- Dashboard pricing modal
- Upgrade prompts

All reflect the same data.

No drift possible.

---

# 7️⃣ Optional: Add Feature Metadata

If you want sophistication:

```ts
{
  id: "advanced_analytics",
  category: "analytics",
  public: true,
  deprecated: false,
  experimental: false,
}
```

Now you can:

- Hide experimental features from pricing
- Auto-generate docs
- Detect orphaned features

---

# 8️⃣ Add a Validation Layer (Highly Recommended)

Write a simple CI script that:

- Ensures every feature has at least one plan
- Ensures no Stripe price exists without a plan
- Warns if a plan has zero features

This prevents silent mistakes.

---

# 9️⃣ Central Doc?

You should not maintain a separate Google Doc as the source of truth.

Docs should be **generated from the registry**.

If marketing needs a table:

Generate it.

If you manually maintain documentation, it will drift.

---

# 10️⃣ Architectural Rule of Thumb

**Stripe answers: "Did they pay?"**  
**Your entitlement layer answers: "What can they do?"**  
**Statsig answers: "Should we expose this yet?"**

Never mix those concerns.

---

# 11️⃣ The Real Failure Mode to Avoid

The common mistake is:

```ts
if (user.plan === "pro")
```

Scattered everywhere.

That creates:

- Plan logic in 20 files
- Impossible migrations
- Legacy plan hell

Instead, always gate by feature:

```ts
hasFeature(user, "export_csv")
```

Plans become an implementation detail.

---

# Final Architecture Summary

**One canonical registry in code.**  
Everything reads from it.  
Nothing manually duplicated.  

Stripe → maps to Plan  
Plan → maps to Features  
Statsig → overlays rollout  

That eliminates entitlement drift.

---

If you'd like, I can outline a slightly more advanced structure that scales cleanly past 50+ features and multiple legacy pricing tiers.

---

## User

ok i need you to reaudit this plan for best practices. and then create a prompt i can give claude code to work on this. i want it to leverage the new swarm mode and run it autonamously while im out. at the end it should run /ship which is our proprietary slash command for claude

---

## Assistant

Mr. White,

I’ll do two things:

1. **Re-audit the architecture at a higher bar (enterprise / scaling ready)**
2. Give you a **production-grade Claude Code prompt** optimized for autonomous Swarm execution ending with `/ship`

---

# 🔎 Re-Audit: What’s Missing / What Breaks at Scale

Your current direction is correct, but here’s what needs tightening to avoid future drift.

---

## 1️⃣ Feature Registry Is Necessary — But Not Sufficient

A simple `FEATURES` constant works early on.

It breaks when:

- You introduce **grandfathered plans**
- You add **add-ons**
- You sell usage-based upgrades
- Enterprise gets custom entitlements
- You deprecate features

You need **entitlements as a first-class domain model**, not just a constant map.

---

## 2️⃣ Plans Should Not Directly Own Features

Instead of:

```ts
feature.plans = ["pro"]
```

Invert it.

Plans grant entitlements.  
Entitlements unlock features.

Why?

Because eventually:

- Multiple plans grant same entitlement
- Enterprise overrides exist
- Add-ons grant single entitlements
- Promotions grant temporary entitlements

Better model:

```
Plan → Entitlements → Features
```

---

## 3️⃣ Introduce Explicit Entitlement Objects

Example:

```ts
// core/entitlements.ts

export const ENTITLEMENTS = {
  ANALYTICS_ADVANCED: {
    id: "analytics_advanced",
    features: ["advanced_analytics"],
  },
  CSV_EXPORT: {
    id: "csv_export",
    features: ["export_csv"],
  },
}
```

Then:

```ts
export const PLAN_ENTITLEMENTS = {
  free: [],
  pro: ["analytics_advanced", "csv_export"],
  enterprise: ["analytics_advanced", "csv_export"],
}
```

Now:

- Stripe → Plan
- Plan → Entitlements
- Entitlements → Features

This prevents future pricing migrations from becoming catastrophic.

---

## 4️⃣ Entitlement Resolution Must Be Server-Authoritative

Never trust client-side gating.

All API routes should call:

```ts
assertHasFeature(user, "advanced_analytics")
```

If you rely on UI gating, users will bypass it.

---

## 5️⃣ Statsig Must Never Determine Plan Access

Statsig should only layer on top:

```
Entitlement check → Statsig gate → Render
```

Never:

```
Statsig gate → Feature access
```

Feature flags are rollout controls — not billing logic.

---

## 6️⃣ You Need Entitlement Observability

Add logging:

- Log every denied feature access
- Log mismatches between plan + feature expectation

This prevents silent 3-month drift.

---

## 7️⃣ Pricing Page Must Be Generated From Registry

No static marketing list.

Your pricing table should:

- Import the same entitlement mapping
- Generate feature lists automatically
- Fail build if feature referenced in copy doesn’t exist

If marketing needs custom wording, add:

```ts
marketingLabel: "Unlimited Exports"
```

But still reference a real entitlement ID.

---

## 8️⃣ Add CI Drift Checks

Automated checks should ensure:

- Every Stripe price ID maps to a plan
- Every plan maps to entitlements
- Every entitlement maps to at least one feature
- No feature exists without entitlement
- No feature referenced in UI missing from registry

Make CI fail loudly.

---

# 🧠 Best-Practice Architecture Summary

Production-grade structure:

```
/core
  features.ts
  entitlements.ts
  plans.ts
  stripe-map.ts
  access-control.ts
```

Single access API:

```ts
hasFeature(user, featureId)
assertHasFeature(user, featureId)
getPlanFeatures(plan)
```

Everything imports from here.

Never check `user.plan` anywhere else.

---

# ⚙️ Now: Claude Code Autonomous Swarm Prompt

Below is a high-precision prompt designed for:

- Autonomous repo audit
- Refactor planning
- Incremental changes
- CI enforcement
- Final `/ship`

You can paste this directly into Claude Code.

---

:::writing{id="82471" variant="standard"}
You are operating in autonomous Swarm mode.

Objective:
Implement a production-grade entitlement architecture in this Next.js codebase that eliminates drift between Stripe billing, Statsig feature flags, pricing pages, and backend access control.

High-Level Requirements:

1. Introduce a canonical entitlement system structured as:

Stripe Price → Plan → Entitlements → Features

2. Create the following core modules:

/core/features.ts  
/core/entitlements.ts  
/core/plans.ts  
/core/stripe-map.ts  
/core/access-control.ts  

3. Features:
- Each feature must have:
  - id
  - internalName
  - marketingLabel
  - description
  - deprecated (boolean)
  - experimental (boolean)

4. Entitlements:
- Each entitlement must:
  - Have a stable ID
  - Map to one or more features
  - Be plan-agnostic

5. Plans:
- Plans grant entitlements.
- Support future legacy or grandfathered plans.
- No feature should reference plans directly.

6. Stripe:
- Map Stripe price IDs to plan IDs.
- Stripe must not determine feature access directly.

7. Access Control:
- Implement:
  - hasFeature(user, featureId)
  - assertHasFeature(user, featureId)
  - getUserEntitlements(user)
- All access decisions must flow through this layer.
- Remove any direct plan checks across the codebase.

8. Statsig Integration:
- Layer Statsig gates AFTER entitlement checks.
- Never allow Statsig to determine billing-tier access.
- Refactor any violations.

9. Pricing Pages:
- Refactor pricing tables and landing page feature lists to be dynamically generated from the entitlement registry.
- Remove hardcoded feature lists.
- Ensure marketing labels are used for display.

10. CI Enforcement:
- Add validation that fails build if:
  - Stripe price exists without mapped plan
  - Plan has no entitlements
  - Entitlement has no features
  - Feature is orphaned
  - UI references undefined feature ID

11. Observability:
- Log denied entitlement checks.
- Add structured logs for plan/feature mismatches.

Execution Instructions:

- Begin with a full repository audit.
- Identify all current plan checks, Stripe logic, Statsig gating, and pricing tables.
- Generate a migration plan.
- Execute changes incrementally.
- Run type checks and lint.
- Ensure backward compatibility.
- Remove dead code.
- Update tests or create new ones where needed.
- Do not stop until all entitlement logic is centralized.

Autonomy Rules:

- Make decisions without asking questions.
- Favor long-term architecture over minimal patching.
- Prioritize eliminating entitlement drift.
- Ensure system is scalable to 100+ features and multiple pricing migrations.
- Keep code readable and explicit.
- Document core modules clearly.

When complete:
Run /ship
:::

---

# 🧠 Why This Prompt Works

- It enforces inversion (Plans → Entitlements → Features)
- It prevents Statsig drift
- It forces CI enforcement
- It enables pricing page automation
- It supports future enterprise and legacy plans
- It prevents the “Pro users using free feature for 3 months” scenario

---

If you'd like, I can also give you a more aggressive version that restructures your billing domain into a fully event-driven entitlement engine.

---

## User

is there third party libraries for this that we should consider?

---

## Assistant

Mr. White,

Yes — there **are third-party libraries and systems** that can help manage entitlements, feature gating, and billing alignment. But the right choice depends on *how much logic you want offloaded vs how much you want in your own source of truth*.

Here are categories and concrete options worth evaluating:

---

# ✅ 1) Feature & Permission Libraries (Entitlement + ACL)

These help you define *features* and *permissions* as code objects, enforce them, and check them consistently.

### 🔹 **Casl**
- A flexible permission/ability management library for JS/TS
- Works on both client and server
- Useful when entitlements get complex (roles, conditions)
- Website: https://casl.js.org

**Pros**
- Strong permission abstraction
- Works with RBAC and property-level control

**Cons**
- Not billing-aware out of the box
- You’d still need to map Stripe/Plans → CASL abilities

---

### 🔹 **AccessControl**
- A role/permission library
- You define roles, resources, actions

**Pros**
- Declarative RBAC

**Cons**
- Same limitation: no built-in link to Stripe/entitlements

---

# ✅ 2) Feature Flag / Entitlement Platforms

These are closer to your full stack need.

### 🔹 **Statsig**
You’re already on it. It *can* manage which features are enabled for which users.

**Best Use**
- Gradual rollouts
- A/B testing
- Kill switches

**Not Ideal For**
- Source of truth for billing entitlement
- Pricing page sync

Statsig is a *flag system*, not an entitlement engine — it needs your canonical source.

---

### 🔹 **LaunchDarkly**
Feature flags + targeting + segments.

**Useful**
- Complex rollout logic
- Multi-environment gating

**Limitation**
- You still need a canonical entitlement list.

---

### 🔹 **Unleash**
Open source feature toggle system.

**Useful**
- Self-hosted flagging
- Segmentation

**Limitation**
- Not a billing entitlement engine

---

# ✅ 3) Billing & Entitlement Platforms

These are closer to what you need: map billing to features.

### 🔹 **Paddle (instead of Stripe)**
More built-in entitlements and licensing

**Pros**
- Has product/entitlement abstraction

**Cons**
- You are already Stripe — migrating is nontrivial

---

### 🔹 **RevenueCat**
Mostly for mobile/subscriptions

Not ideal for web apps

---

### 🔹 **Stripe Billing + Stripe Products/Prices**
Stripe will *store metadata* on products/prices, which **you can leverage**.

Example:

```jsonc
{
  "id": "price_123",
  "metadata": {
    "plan": "pro",
    "features": "advanced_analytics,csv_export",
  }
}
```

Then your app reads it and composes the entitlement map.

This gets close to a 3rd-party mapping, but requires coordination.

**Side Effect**
- Doesn’t replace your code-side registry — it augments it

---

# ✅ 4) Identity & Authorization Frameworks

You could offload entitlement checks to a policy engine.

### 🔹 **OPA (Open Policy Agent)**
- Write policies in Rego
- Assert feature access via policy

**Pros**
- Very expressive
- Enterprise-grade

**Cons**
- Adds infrastructure complexity

---

### 🔹 **Casbin**
RBAC + ABAC library.

**Good For**
- Multi-tenant
- Conditional attributes

**Cons**
- Needs mapping from billing domain

---

# ⚠️ What *Not* to Pick (for your current scenario)

❌ Pure feature flags (e.g., only Statsig)  
→ Doesn’t solve entitlement drift alone

❌ Simple RBAC libraries alone  
→ Don’t understand billing

❌ Billing only libraries  
→ Don’t enforce granular feature access

---

# 🧠 Best Third-Party Strategy

**Hybrid approach:**

| Piece | Best Practice |
|-------|--------------|
| Billing source | Stripe (
  *metadata driven if possible*
) |
| Gating + rollout | Statsig |
| Permission model | CASL or Casbin |
| Canonical registry | Your own shared code module |

**Why this works**
- You have one source of truth (your code registry)
- Billing → entitlements backed by Stripe metadata
- Feature rollout controlled safely via Statsig
- Permission enforcement is consistently done via the library

You don’t get drift because there’s no duplicate “copy” of features anywhere.

---

# 🧠 If You Wanted a Closer Off-The-Shelf Engine

Consider building only the **Plan → Entitlements → Features mapping in a JSON/DB schema**.

Many teams adopt a *permissions API pattern*:

| Table | Role |
|-------|------|
| Features | canonical list |
| Entitlements | grouping |
| Plans | grant entitlements |
| PlanFeature | join table |
| Users | plan + entitlements |
| StripeProducts | link to plan |

Then your server runs an authorization API based on the schema.

This can be fully driven by a 3rd-party ACL library like Casl or Casbin.

---

If you want, I can map concrete starter code for combining **Stripe metadata + Statsig + CASL** into a unified entitlement engine and show how to generate your pricing page automatically from that model.


**Topic:** [[chatgpt-clusters/coding_web_dev]]
