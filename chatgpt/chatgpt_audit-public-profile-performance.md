---
title: "Audit public profile performance"
type: note
created: 2026-01-28
updated: 2026-01-28
source: chatgpt-export
conversation_id: 697a6e68-7898-832c-a219-2a9e97e91ce9
message_count: 2
tags: [chatgpt, import]
---
# Audit public profile performance

> Conversation ID: 697a6e68-7898-832c-a219-2a9e97e91ce9
> Created: 2026-01-28T20:15:37Z
> Updated: 2026-01-28T20:16:32Z
> Messages: 2

---

## User

audit public profiles for cold start issues. ensure theyre properly using edge and ssg and suspense and PPR and anything else that could/should be enabled to minimze cold start and improve load times. this is the core of the product. public profiles should load 100ms or less.

imrpove this prompt. optimize it for codex 5.2. prompt has full context of the codebase and guardrails so no need to add that

---

## Assistant

Here’s a tighter, Codex-5.2-optimized version—clear objectives, explicit constraints, and an execution checklist. No fluff.

---

**Task:** Audit all **public profile routes** for cold-start risk and sub-100ms load performance.

**Goal:** Public profiles must consistently load in **≤100ms p95**. This is core product functionality.

**What to audit and enforce:**
- **Rendering strategy**
  - Verify correct use of **Edge Runtime** where applicable.
  - Enforce **Static Site Generation (SSG)** for all eligible public profile data.
  - Eliminate unnecessary SSR or Node runtimes.
- **Data fetching**
  - Ensure fetches are static, cached, and deduplicated.
  - Validate cache headers, revalidation strategy, and ISR where needed.
- **React / Next.js optimizations**
  - Proper use of **Suspense** boundaries (data + UI).
  - Correct application of **Partial Prerendering (PPR)**.
  - No blocking waterfalls in the critical path.
- **Bundle & execution**
  - Minimize JS shipped to the client.
  - Remove unused dependencies from public profile routes.
  - Confirm tree-shaking and code-splitting are effective.
- **Cold start elimination**
  - Identify and remove any code paths that trigger cold starts.
  - Flag serverless functions, edge fallbacks, or dynamic imports that regress latency.

**Deliverables:**
1. A list of **violations or risks** preventing sub-100ms loads.
2. **Concrete code-level fixes** (files, patterns, replacements).
3. A short **checklist of enforced invariants** for public profiles going forward.
4. If tradeoffs exist, choose **performance over flexibility** and document why.

**Constraints:**
- Assume full codebase context is available.
- Follow existing guardrails.
- Optimize for **real-world latency**, not theoretical purity.

**Definition of done:**  
No cold starts. No unnecessary SSR. Public profiles are effectively static, edge-served, and fast by default.

---
