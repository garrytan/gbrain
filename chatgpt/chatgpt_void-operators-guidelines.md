---
title: "Void Operators Guidelines"
type: guide
created: 2026-01-05
updated: 2026-01-05
source: chatgpt-export
conversation_id: 695c4fd9-1ae4-8330-82da-da6d9ba036e4
message_count: 4
tags: [chatgpt, import, code]
---
# Void Operators Guidelines

> Conversation ID: 695c4fd9-1ae4-8330-82da-da6d9ba036e4
> Created: 2026-01-05T23:57:13Z
> Updated: 2026-01-05T23:59:09Z
> Messages: 4

---

## User

Hey fam, should I allow void operators or not?

---

## Assistant

Mr. White — short answer: **usually no**, unless you have a very specific reason.

Because “void operator” can mean different things depending on language/context, here’s the decision logic that works in **most codebases**:

### If you mean **functions/operators returning `void`**
- ✅ **Allow** when the operation is **purely side-effect driven** (logging, mutation, I/O).
- ❌ **Avoid** when the result could be **meaningfully validated, chained, or tested**.

**Rule of thumb:**  
If a caller might reasonably ask *“did this work?”*, `void` is the wrong choice.

### If you mean **operator overloading that returns `void`** (e.g., C++)
- ❌ **Generally a bad idea**
- Breaks:
  - Composability
  - Intuition
  - Standard operator expectations
- Makes code harder to reason about and debug

### If you mean the **`void` operator in JavaScript** (`void expr`)
- ❌ **Avoid in application code**
- Legit uses are rare (bookmarklets, very low-level hacks)
- Obscures intent compared to explicit patterns

### What to prefer instead
- Return:
  - `bool` (success/failure)
  - `Result` / `Either`
  - The mutated object (`this` pattern)
- Makes code:
  - More testable
  - More composable
  - Easier to reason about

### Hard rule
> **If an API decision forces a caller to guess state instead of observing it, don’t use `void`.**

If you want, tell me:
- Language
- Where this rule would be enforced (linting? code review? public API?)

I’ll give you a precise yes/no with justification.

---

## User

SonarCube is flagging it, and currently Biome is configured to auto-add void operators for ignored return values. What, in a modern startup, would be the recommended way to deal with them? Should I tell Sonar to fuck off, or should I tell Biome to fuck off?

---

## Assistant

Mr. White — don’t let these tools fight each other. Pick one consistent convention.

In a modern TS/JS startup, I’d recommend: **tell Biome to stop auto-inserting `void` for ignored promises/returns**, and configure Sonar so you’re enforcing *intent* (await/handle errors) rather than *syntax* (`void`).

### Why: `void` is a leaky “I know what I’m doing” marker
`void someAsync()` is mainly used to silence “floating promise” warnings. It doesn’t *handle* anything; it just says “I’m intentionally ignoring this.” In real codebases it tends to:
- hide accidentally unhandled failures
- make refactors riskier (you stop noticing you’re ignoring something)
- create tool churn like you’re seeing

### Recommended policy (practical + clean)

#### 1) Default: **don’t ignore promises**
- Prefer `await`
- Or explicitly **capture** with a helper: `fireAndForget(fn)` that logs/handles rejection.

Example pattern:
```ts
export function fireAndForget(p: Promise<unknown>, ctx?: string) {
  p.catch(err => {
    console.error("Uncaught async task", ctx, err);
  });
}
```
Usage:
```ts
fireAndForget(syncToCRM(userId), "syncToCRM");
```
This is clearer than `void syncToCRM(userId)` and safer.

#### 2) If you truly want “best-effort” background work
- Put it behind a queue/job runner, or at least a single utility as above.
- The point: **centralize** the decision to ignore.

#### 3) For sync return values (non-Promise)
- Don’t use `void` as a discard marker. Just don’t assign it.
- If you need intent, use naming + comments, not `void`.

### Tool decisions

#### Tell **Biome** to stop auto-adding `void`
Auto-inserting `void` bakes a controversial style choice into your formatter. Formatters should be boring. This is not.

What you want instead:
- Biome formats
- A lint rule (Biome/ESLint/TS) enforces “no floating promises” or equivalent
- A small allowlist mechanism (the helper) for intentional fire-and-forget

#### Tell **Sonar** what your convention is
Either:
- allow the helper pattern, and keep Sonar strict on floating promises / ignored results, or
- if Sonar is specifically whining about the *presence* of `void`, align it with your convention by disallowing `void`-discard.

### The clean “startup standard”
1. **No `void`-discard in codebase** (except maybe rare edge cases)
2. **No floating promises**
3. **One `fireAndForget` helper** (with logging/monitoring hook)
4. CI enforces it; formatter doesn’t invent it

If you paste the exact Sonar rule key/message and your Biome setting snippet, I’ll tell you the exact config changes to make so they stop conflicting.
