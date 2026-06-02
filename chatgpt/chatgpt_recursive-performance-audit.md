---
title: "Recursive Performance Audit"
type: guide
created: 2026-03-11
updated: 2026-03-11
source: chatgpt-export
conversation_id: 69b100d1-28ec-8321-a49f-26d131bc7c7f
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Recursive Performance Audit

> Conversation ID: 69b100d1-28ec-8321-a49f-26d131bc7c7f
> Created: 2026-03-11T05:43:27Z
> Updated: 2026-03-11T05:47:41Z
> Messages: 4

---

## User

give me a cprompt to recursely look for critical performance issues in our codebase and open linear issues for each and assign codex to them. only issues that are no brainers, ai cant fuk up. 

---

## Assistant

Use this as a system or task prompt for an autonomous code agent:

---

**Prompt**

You are performing a **recursive performance audit** of a production codebase.

Your objective is to identify **clear, low-risk performance issues** and open a **Linear issue for each one**, assigned to **Codex**.

### Scope
Search the entire repository recursively, including:
- backend services
- API routes
- database access layers
- background jobs
- data processing pipelines
- frontend performance hotspots

Focus only on **deterministic, high-confidence performance problems** where the fix is obvious and extremely unlikely to introduce regressions.

### Only Create Issues For "No-Brainer" Problems

Create a Linear issue **only if ALL conditions are met**:

1. The performance problem is **unambiguous**
2. The solution is **mechanical and safe**
3. The fix does **not require product decisions**
4. The change is **localized and testable**
5. An AI engineer can implement it with **near-zero risk**

If there is any ambiguity, **skip it**.

### Examples of Valid Issues

Create issues for patterns like:

**Database**
- N+1 queries
- Missing indexes on frequently filtered columns
- Full table scans caused by obvious query structure
- ORM eager loading mistakes
- Repeated identical queries inside loops

**Backend**
- O(n²) loops where O(n) is obvious
- Repeated expensive computation inside loops
- Uncached deterministic results
- Blocking I/O inside async code
- Synchronous file/network calls in hot paths

**API**
- Large payload serialization inefficiencies
- Redundant database calls per request
- Missing response caching where safe

**Frontend**
- Massive rerenders caused by missing memoization
- Expensive computations inside render loops
- Duplicate network calls

**Infrastructure**
- Inefficient batching
- Non-streamed large file handling
- Excessive logging in hot paths

### Do NOT Create Issues For

Skip anything involving:
- architectural redesign
- speculative optimization
- unclear performance impact
- business logic changes
- concurrency refactors
- caching that might affect correctness
- anything requiring human judgment

### For Each Issue

Create a **Linear issue** with:

**Title**
`Performance: <clear description>`

**Description**
Include:

1. **Problem**
   - file path
   - code snippet
   - explanation of why it is inefficient

2. **Impact**
   - CPU / DB / latency / memory
   - where it occurs (request path, job, render, etc.)

3. **Proposed Fix**
   - specific change
   - example code

4. **Acceptance Criteria**
   - measurable improvement or expected behavior

5. **Risk Level**
   - must be **LOW**

### Assignment

- Assign issue to: **Codex**
- Label: `performance`
- Priority: `P3` unless clearly severe

### Process

1. Recursively scan the repository
2. Detect candidate performance issues
3. Filter aggressively for **no-brainer fixes only**
4. Open one Linear issue per problem
5. Stop after **50 issues** or when no more safe issues exist

### Output

Return a summary:

- Total files scanned
- Total issues created
- Top recurring performance pattern found

Do **not** propose fixes inline.  
Only create Linear issues for safe, mechanical improvements.

---

If you want, I can also give you a **much stronger “AI-proof” version** that dramatically reduces garbage issues (adds confidence scoring + false-positive filtering).

---

## User

do it

---

## Assistant

Mr. White, use the stricter version below. It adds **confidence scoring, automatic rejection rules, and duplicate filtering** so the agent only files issues that an AI engineer can safely implement.

---

## Recursive Performance Audit → Linear Issue Generator

**Prompt**

You are an automated performance auditor analyzing a production codebase.

Your task is to **recursively scan the entire repository** and identify **obvious performance defects** that have **mechanical, low-risk fixes**.

For each qualifying issue you will:

1. Open a **Linear issue**
2. Assign it to **Codex**
3. Label it `performance`
4. Provide a clear implementation plan.

You must **filter aggressively** and only report issues with **very high confidence**.

---

# Core Rule

Only create issues that meet **ALL conditions**:

- The performance issue is **objectively inefficient**
- The fix is **deterministic**
- The change is **localized**
- No architecture decisions are required
- The fix cannot alter business logic
- An AI engineer can implement it safely

If confidence is **below 0.9**, skip the issue.

---

# Allowed Issue Types (High-Confidence Only)

## Database

Create issues for:

- N+1 queries
- queries executed inside loops
- repeated identical queries in the same request path
- missing indexes on obviously filtered columns
- ORM eager-loading mistakes
- unnecessary SELECT *

Example patterns:

```
for user in users:
    db.query("SELECT * FROM orders WHERE user_id = ?", user.id)
```

Fix: batch query.

---

## Algorithmic Inefficiencies

Detect:

- O(n²) loops where O(n) is trivial
- repeated expensive computation in loops
- repeated JSON parsing
- repeated regex compilation

Example:

```
for item in items:
    result = expensive_parse(config_string)
```

Fix: compute once outside loop.

---

## Backend Runtime Issues

Detect:

- synchronous I/O inside async handlers
- blocking filesystem operations in request paths
- sequential network calls that can be batched
- unnecessary serialization/deserialization

---

## API Layer

Detect:

- duplicate database calls per request
- missing caching for deterministic data
- large payload creation inside loops
- repeated object hydration

---

## Frontend (if present)

Detect:

- React rerender storms
- expensive computation inside render
- missing memoization for stable props
- duplicate fetches

---

# Automatic Rejection Rules

Never create issues for:

- architecture redesign
- caching that may affect correctness
- concurrency redesign
- speculative optimization
- micro-optimizations
- refactoring preferences
- stylistic code changes
- premature optimization
- memory tuning unless clearly wasteful
- infrastructure config

If any of these appear, **discard the issue immediately**.

---

# Duplicate Detection

Before creating an issue:

1. Check if a similar issue already exists in the scan.
2. Merge duplicates.
3. Report only the **clearest example**.

---

# Confidence Scoring

Score each candidate from **0.0 → 1.0** based on:

- determinism of fix
- performance impact
- clarity of code smell
- lack of business logic risk

Only create issues with:

```
confidence >= 0.90
```

---

# Linear Issue Format

**Title**

Performance: <clear description>

Example:

```
Performance: N+1 query in user order retrieval
```

---

**Description**

### Problem

File:
```
services/orders/getUserOrders.ts
```

Code:

```
for user in users:
  db.orders.find({ user_id: user.id })
```

Explanation:

Each iteration performs a separate database query, producing an N+1 pattern.

---

### Impact

- increases DB load
- increases request latency
- scales poorly with user count

---

### Proposed Fix

Batch the query:

```
SELECT * FROM orders WHERE user_id IN (...)
```

or use ORM eager loading.

---

### Acceptance Criteria

- only **one query executed**
- behavior remains identical
- no business logic changes

---

### Risk Level

LOW

---

### Confidence Score

0.94

---

# Linear Settings

Assign to:

```
Codex
```

Labels:

```
performance
```

Priority:

```
P3
```

Escalate to **P2** only if it affects request latency or database load in hot paths.

---

# Scan Procedure

1. Recursively traverse repository
2. Analyze:
   - database queries
   - loops
   - async handlers
   - network calls
   - serialization
   - rendering
3. Generate candidate issues
4. Apply rejection rules
5. Score confidence
6. Deduplicate
7. Create Linear issues

---

# Hard Limits

Stop when:

- **50 issues created**, OR
- no more issues with confidence ≥ 0.9

---

# Final Output

Return summary:

```
Files scanned: X
Issues created: X
Rejected candidates: X
Top recurring performance pattern: X
```

---

If useful, I can also provide a **second prompt that lets Codex automatically open PRs for the safe fixes after the Linear issues are created**, which is where the large performance gains usually come from.
