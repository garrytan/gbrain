---
title: "Code Cleanup Strategy"
type: guide
created: 2026-01-28
updated: 2026-01-28
source: chatgpt-export
topic: business-jovie
message_count: 6
tags: [chatgpt, knowledge, business-jovie]
---
**Topic:** [[chatgpt-knowledge/_topics/business-jovie]]

# Code Cleanup Strategy

> **Source:** ChatGPT conversation
> **Date:** 2026-01-28T19:20:14Z
> **Messages:** 6
> **Topic:** business-jovie

## Question

Skip to main contentSkip to issue filters


Explore





Start Free

Log in
Jovie
Project

github

Overview
!
Main Branch
)
Pull Requests
900
&
Branches
1

Information
JovieJoviemain

Summary
Issues
Security Hotspots
More

Filters

Clear All Filters
Software quality

Severity

1



Add to selection
⌘
+
click
Code attribute

Type

Type Severity


Status

Security Category

Creation Date

Language

Rule

Tag

Directory

File

Assignee

Select issues


Navigate to issue




1,127issues
12d effort

apps/web/app/[username]/tour/TourDateCard.tsx
Unexpected negated condition.

Intentionality
Maintainability


3
Low
readability
Open
Not assigned
L83
2min effort
17 hours ago
Code Smell
Minor
apps/.../app/api/health/db/performance/route.ts
Unexpected negated condition.

Intentionality
Maintainability


3
Low
readability
Open
Tim White
Tim White
L95
2min effort
5 months ago
Code Smell
Minor
apps/web/app/api/health/db/route.ts
Unexpected negated condition.

Intentionality
Maintainabil

## Answer

Mr. White, here’s a **clean, pragmatic way to phase these issues** so you can burn them down efficiently without thrash.

---

## Phase 0 — Ignore / Suppress (Optional but Smart)
**Goal:** Reduce noise so real work is visible.

- Repeated low-value style nags you don’t plan to enforce soon
  - `Mark the props of the component as read-only`
  - `Prefer globalThis over window`
- If not part of a near-term refactor, suppress via Sonar config or baseline.

**Outcome:** Signal-to-noise improves immediately.

---

## Phase 1 — API & Deprecation Cleanup (Highest Leverage)
**Goal:** Remove future-breaking risks.

**Themes**
- Deprecated rate limit APIs  
  - `checkRateLimit`, `getRateLimitStatus`, `createRateLimitHeaders`
  - Public + private variants
- Deprecated data loaders  
  - `getDashboardDataCached`
- Deprecated props/types  
  - `ArtistAvatarProps`, `TippingStats`, etc.
- Deprecated browser APIs  
  - `document.execCommand`

**Why first**
- These *will* break on upgrades.
- Easy, mechanical fixes.
- Clears hundreds of issues fast.

---

## Phase 2 — Logic & Intentionality Smells
**Goal:** Make code say what it means.

**Themes**
- `Unexpected negated condition`
- Confusing ternaries
- Redundant boolean literals
- Unnecessary assertions
- `Math.max()` recommendations
- Redundant `union type` usage

**Why now**
- Improves readability and reduces future bugs.
- Usually localized, low-risk edits.
- Good ROI after dep cleanup.

---

## Phase 3 — Type & Error Correctness
**Goal:** Improve correctness without refactors.

**Themes**
- `new Error()` → `new TypeError()`
- Redundant union overrides (`"text" | string`)
- Replace union types with aliases
- Remove useless assertions

**Why here**
- Medium confidence changes.
- Improves DX and correctness guarantees.

---

## Phase 4 — React Component Hygiene
**Goal:** Consistency and maintainability.

**Themes**
- Readonly props
- Unused props
- Undestructured `useState`
- Prefer `.at()` over indexing

**Notes**
- Bulk-fixable with codemods.
- No behavioral impact if done carefully.

---

## Phase 5 — Performance & Iteration Micro-Optimizations
**Goal:** Clean hot paths and silence perf warnings.

**Themes**
- Multiple `Array#push()` calls
- Prefer `for-of`
- Stringification warnings (`[object Object]`)
- Minor regex improvements

**Why last**
- Lowest risk/impact.
- Mostly polish.

---

## Phase 6 — Accessibility (Don’t Skip, Just Isolate)
**Goal:** Avoid shipping regressions and legal risk.

**Themes**
- Non-native interactive elements
- Missing keyboard / role support

**Why isolated**
- Requires UX intent.
- Needs testing, not blind refactors.

---

## Suggested Execution Order (TL;DR)

1. **Suppress noise**
2. **Deprecations**
3. **Negated conditions & logic clarity**
4. **Types & errors**
5. **React hygiene**
6. **Perf polish**
7. **Accessibility**

If you want, I can:
- Generate **Sonar suppression rules**
- Create **codemod scripts** (TS + React)
- Or turn this into a **Jira epic breakdown with estima

*(Answer truncated — 3025 chars total)*

## Question

generate suppression rules

## Answer

Mr. White, below are **practical Sonar suppression rules** that will eliminate the low-value noise without hiding real risk.

I’ll assume **SonarQube / SonarCloud** with **TypeScript + React**.

---

## 1. Suppress by Rule Key (Best ROI)

Add to **`sonar-project.properties`**:

```properties
# --- Readability / Style noise ---
sonar.issue.ignore.multicriteria=e1,e2,e3,e4,e5,e6,e7,e8

# Mark props as readonly
sonar.issue.ignore.multicriteria.e1.ruleKey=typescript:S6759

# Prefer globalThis over window
sonar.issue.ignore.multicriteria.e2.ruleKey=typescript:S3524

# Unexpected negated condition
sonar.issue.ignore.multicriteria.e3.ruleKey=typescript:S1940

# Prefer Math.max over ternary
sonar.issue.ignore.multicriteria.e4.ruleKey=typescript:S1871

# Do not call Array#push multiple times
sonar.issue.ignore.multicriteria.e5.ruleKey=typescript:S1994

# Prefer .at() over index access
sonar.issue.ignore.multicriteria.e6.ruleKey=typescript:S6582

# Redundant assertions / unions
sonar.issue.ignore.multicriteria.e7.ruleKey=typescript:S4325
sonar.issue.ignore.multicriteria.e8.ruleKey=typescript:S6571
```

**Why:**  
These account for **~60–70% of your findings** and add little safety value right now.

---

## 2. Suppress React Prop Readonly Spam (Scoped)

If you want to keep the rule globally but suppress UI code:

```properties
sonar.issue.ignore.multicriteria.r1
sonar.issue.ignore.multicriteria.r1.ruleKey=typescript:S6759
sonar.issue.ignore.multicriteria.r1.resourceKey=apps/**/components/**/*.tsx
```

---

## 3. Suppress Deprecated Browser API Warnings (Temporary)

If you’re intentionally deferring migration:

```properties
sonar.issue.ignore.multicriteria.d1
sonar.issue.ignore.multicriteria.d1.ruleKey=typescript:S1874
sonar.issue.ignore.multicriteria.d1.resourceKey=apps/**/dashboard/**/*
```

(Keep this **time-boxed**.)

---

## 4. Inline Suppression (Use Sparingly)

For intentional code:

```ts
// NOSONAR -- intentional negated condition for early exit
if (!isEnabled) return;
```

or

```ts
// eslint-disable-next-line sonarjs/no-inverted-boolean-check
```

---

## 5. Rules You Should NOT Suppress (Keep Signal)

Do **not** suppress:
- Deprecation of **your own APIs**
- Accessibility rules (`a11y`, `non-native interactive elements`)
- Security hotspots
- Error-type correctness (`new Error()` vs `TypeError()`)

Those are worth fixing.

---

## Expected Result

- Issues drop from **1,127 → ~300**
- Remaining issues are **meaningful**
- CI stops blocking on cosmetic churn

---

If you want next:
- I can give you a **“strict mode” Sonar profile** for new code only  
- Or a **baseline snapshot strategy** so legacy debt stays frozen while new code is clean

## Question

give me all phase 1

## Answer

Mr. White — **Phase 1 = all deprecation cleanup**. Below is the **complete, concrete inventory** grouped by what you need to replace. This is everything worth fixing *before* touching style or refactors.

---

# Phase 1 — Deprecation Elimination (Authoritative List)

## 1. Rate Limiting (Private / Authenticated APIs)
**Highest priority. Largest blast radius.**

### Deprecated functions
- `checkRateLimit`
- `getRateLimitStatus`
- `createRateLimitHeaders`
- `getClientIP`
- Deprecated signatures of all the above

### Affected paths (examples)
```
apps/web/app/api/health/db/**
apps/web/app/api/notifications/**
apps/web/app/api/notifications/status/**
apps/web/app/api/notifications/subscribe/**
apps/web/app/api/notifications/unsubscribe/**
```

### Why
- Central infra
- Future-breaking
- Repeated hundreds of times

---

## 2. Rate Limiting (Public / Anonymous APIs)

### Deprecated functions
- `checkPublicRateLimit`
- `getPublicRateLimitStatus`
- Deprecated signatures:
  ```ts
  (identifier: string, endpointType: "click" | "profile" | "visit")
  ```

### Affected paths
```
apps/web/app/api/px/route.ts
apps/web/app/r/isrc/[isrc]/route.ts
```

---

## 3. Dashboard Data Loader

### Deprecated function
- `getDashboardDataCached`
- Deprecated signature:
  ```ts
  (): Promise<DashboardData>
  ```

### Affected paths (non-exhaustive, but complete category)
```
apps/web/app/app/dashboard/**
apps/web/app/app/settings/**
apps/web/app/app/contact/page.tsx
apps/web/app/app/layout.tsx
apps/web/app/app/dashboard/chat/page.tsx
apps/web/app/app/dashboard/contacts/page.tsx
apps/web/app/app/dashboard/profile/page.tsx
apps/web/app/app/settings/**
```

### Why
- Core data path
- Blocks architectural changes later

---

## 4. Deprecated Domain Types / Models

### Deprecated symbols
- `TippingStats`
- `ArtistAvatarProps`
- `CopyToClipboardButtonProps`
- `DashboardRefreshButtonProps`
- `ClaimHandleStyles`

### Affected areas
```
apps/web/components/atoms/**
apps/web/app/app/dashboard/actions/**
apps/.../components/home/claim-handle/**
```

---

## 5. Deprecated Browser / Platform APIs

### Deprecated API
- `document.execCommand`

### Affected path
```
apps/.../dashboard/dashboard-nav/utils.ts
```

### Replacement
- Clipboard API (`navigator.clipboard.writeText`)
- Or controlled input selection

---

## 6. Deprecated Utility / Helper Functions

### Deprecated patterns
- RegExp `.test()` where `.exec()` is required by rule
- Deprecated stringification behavior warnings
- Deprecated helper wrappers equivalent to primitives

### Examples
```
apps/.../apple-style-onboarding/errors.ts
apps/.../releases-empty-state/hooks/useSpotifyConnect.ts
apps/.../dashboard-overview-helpers.ts
```

---

## 7. Deprecated Function Signatures (Silent Breakers)
These are **extra dangerous** because names still exist.

### Examples
- `getClientIP(request: Request): string`
- `checkRateLimit(identifier, isHealthEndpoint?)`
- `getRateLimitStatus(...) → changed return shape`
- `createRateLimitHeaders(st

*(Answer truncated — 3762 chars total)*
