---
title: "Refactoring Tests Guidelines"
type: guide
created: 2026-02-20
updated: 2026-02-20
source: chatgpt-export
conversation_id: 6998a931-3764-832b-ab1c-aed6d9ad3bd1
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Refactoring Tests Guidelines

> Conversation ID: 6998a931-3764-832b-ab1c-aed6d9ad3bd1
> Created: 2026-02-20T18:34:38Z
> Updated: 2026-02-20T18:36:39Z
> Messages: 4

---

## User

should tests be recatored sub 300 lines the same way we do components

---

## Assistant

Mr. White — generally, yes.

### Short answer  
Refactor tests for **clarity and signal**, not an arbitrary line limit. The same reasoning you use for components (cohesion, readability, maintainability) applies to tests.

---

## When to Refactor a Test File

Refactor if:

1. **Multiple behaviors are being tested**  
   One file covering unrelated flows → split by feature or scenario.

2. **Hard to scan and understand intent**  
   If you can’t quickly answer “what behavior does this suite validate?”, it’s too large or poorly structured.

3. **Heavy duplication**  
   Repeated setup → extract factories, builders, or shared test helpers.

4. **Massive describe blocks**  
   Deep nesting is a smell. Prefer flat, scenario-driven structure.

---

## When *Not* to Refactor

- File is long but logically cohesive (e.g., one complex feature).
- Splitting would fragment context and increase cognitive load.
- Refactor would introduce excessive abstraction (over-engineered test utilities).

---

## Tests ≠ Components

Tests optimize for:

- **Readability over DRY**
- **Explicitness over abstraction**
- **Behavior documentation over elegance**

You refactor components to reduce duplication and complexity.  
You refactor tests to reduce confusion and brittleness.

---

## Practical Heuristics

Instead of “sub-300 lines,” use:

- One **feature per test file**
- One **behavior per describe block**
- One **expectation cluster per test**
- Avoid >3 levels of nesting
- Avoid test helpers that hide intent

If a file is 600 lines but cleanly structured and obvious — fine.  
If it’s 180 lines and unreadable — refactor.

---

## Strong Guideline

If a new engineer cannot:
- Read the file in <5 minutes
- Understand what the system guarantees
- Safely add a new test

…it needs restructuring.

---

If you’d like, show me one of your larger test files and I’ll give you a direct structural critique.

---

## User

write me a /refactor-tests skill to identify offenders and refactor til there are none. make it deterministic and optimize it for opus 4.6 in claude code.

---

## Assistant

Mr. White — here is a deterministic `/refactor-tests` skill optimized for **Claude Opus 4.6 in Claude Code**.

This is designed to:
- Eliminate oversized / low-cohesion test files
- Remove structural smells
- Enforce objective criteria
- Produce stable, repeatable output

No subjective judgment. Only rule-based transformations.

---

# `/refactor-tests` Skill

## Purpose

Systematically refactor test files until **zero structural violations remain**, based on deterministic rules.

---

# Core Philosophy

Tests are refactored for:

1. Single feature ownership  
2. Flat structure  
3. Explicit setup  
4. Minimal duplication  
5. Deterministic organization  

No aesthetic refactors.  
No semantic changes.  
No behavioral modifications.

---

# Deterministic Rules

A file is an offender if **any** of the following are true:

### Rule 1 — File Size
- > 300 LOC  
- OR > 15 test cases (`it` / `test` blocks)

### Rule 2 — Multiple Feature Domains
If top-level `describe` blocks reference unrelated domains (different modules/components/services).

Split by feature.

### Rule 3 — Nesting Depth
More than 3 levels of `describe`.

Flatten.

### Rule 4 — Hidden Intent
If setup logic:
- > 20 lines inside a single test
- OR duplicated in 3+ tests

Extract to deterministic factory/helper.

### Rule 5 — Multiple Behavioral Categories in One File
If tests include:
- Success path
- Error path
- Edge case
- Integration scenario

And exceed 12 tests total → split into:
- `feature.success.test.ts`
- `feature.failure.test.ts`
- `feature.edge.test.ts`

---

# Deterministic Refactor Strategy

## Phase 1 — Inventory

For each test file:

1. Count LOC
2. Count test blocks
3. Identify describe depth
4. Identify duplicate setup blocks
5. Classify test categories:
   - success
   - failure
   - edge
   - integration

Output structured JSON summary.

---

## Phase 2 — Refactor Until Clean

Repeat until no violations remain:

### Step A — Split by Feature

If multiple top-level domains exist:
- Create new test file per domain
- Move associated describe blocks intact

### Step B — Split by Behavior Category

If >12 tests and mixed categories:
- Create category-specific files
- Preserve test order within category

### Step C — Flatten Structure

If depth >3:
- Collapse nested describe
- Convert context to test names:
  
Before:
```
describe("User")
  describe("when logged in")
    describe("with expired token")
```

After:
```
describe("User - logged in - expired token")
```

### Step D — Extract Setup

If setup duplication detected:

Create:
```
test/factories/user.factory.ts
```

Move repeated logic into:
```
createTestUser(overrides?)
```

Replace duplicated blocks.

---

# File Naming Convention (Deterministic)

Given: `user.service.test.ts`

Split as:

- `user.service.success.test.ts`
- `user.service.failure.test.ts`
- `user.service.edge.test.ts`
- `user.service.integration.test.ts`

Alphabetical ordering enforced.

---

# Structural End State Requirements

All test files must satisfy:

- ≤ 300 LOC
- ≤ 15 test blocks
- ≤ 3 describe depth
- No duplicated setup >2 occurrences
- Single feature domain per file
- Behavioral grouping isolated if >12 tests

If any violation remains → repeat process.

---

# Strict Constraints

- Do NOT modify assertions.
- Do NOT merge tests.
- Do NOT change test semantics.
- Do NOT remove coverage.
- Do NOT alter snapshot values.
- Do NOT reformat unrelated code.

Only structural transformation.

---

# Determinism Guarantees

- Always split before flattening.
- Always flatten before extracting setup.
- Always extract setup before renaming files.
- Always alphabetical file output.
- Always preserve original test order.

No randomness.  
No judgment calls.  
No heuristics.

---

# Claude Opus 4.6 Optimization Notes

Designed for Opus strengths:

- Large context restructuring
- Deterministic code rewriting
- Multi-file transformations
- Pattern detection
- High structural discipline

Avoids:
- Fuzzy classification
- Ambiguous grouping
- Aesthetic rewriting

---

# Invocation Format

```
/refactor-tests
scope: ./src
mode: enforce
report: true
```

Modes:

- `audit` → generate violation report only
- `enforce` → apply refactors until clean

---

# Example Output (Audit Mode)

```json
{
  "offenders": [
    {
      "file": "user.service.test.ts",
      "loc": 482,
      "tests": 23,
      "violations": [
        "file_size",
        "mixed_behavior_categories",
        "duplicate_setup",
        "deep_nesting"
      ]
    }
  ],
  "status": "needs_refactor"
}
```

---

# Example Output (Enforce Mode)

```json
{
  "status": "clean",
  "files_created": [
    "user.service.success.test.ts",
    "user.service.failure.test.ts"
  ],
  "factories_created": [
    "test/factories/user.factory.ts"
  ],
  "remaining_offenders": 0
}
```

---

If you want, I can also generate:

- A stricter enterprise variant (≤200 LOC)
- A startup velocity variant (≤400 LOC, fewer splits)
- Or a version tuned for Jest vs Vitest specifically


**Topic:** [[chatgpt-clusters/code_review]]
