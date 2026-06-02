---
title: "Set Node Version Cascade"
type: essay
created: 2026-01-23
updated: 2026-01-23
source: chatgpt-export
topic: misc
message_count: 26
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Set Node Version Cascade

> **Source:** ChatGPT conversation
> **Date:** 2026-01-23T05:19:29Z
> **Messages:** 26
> **Topic:** misc

## Question

set node version in cascade

## Answer

Mr. White — quick check before I give you the exact steps.

What do you mean by **Cascade** here?

Most common possibilities:
1. **GitHub Actions (CI/CD)** → setting Node via `actions/setup-node`
2. **Vercel / Netlify / Render** → setting Node via config or env
3. **A specific framework or tool named “Cascade”** (less common)
4. **Monorepo toolchain** where Node version needs to cascade across packages

Tell me **which platform/tool** you’re referring to and I’ll give you the precise, minimal config (no fluff).

## Question

cascade panel in windsurf

## Answer

Got it, Mr. White — **Windsurf → Cascade panel**.

Here’s the clean, factual way to set the **Node.js version Cascade uses**.

---

## Option 1 (Best / Canonical): `.nvmrc`
Cascade **automatically respects `.nvmrc`** at the repo root.

```bash
# .nvmrc
20.11.1
```

Then:
- Restart Windsurf
- Re-open the repo
- Cascade will run all Node commands with that version

**This is the preferred approach.**  
It cascades consistently to humans, CI, and tooling.

---

## Option 2: `package.json` → `engines`
Cascade also reads `engines.node`.

```json
{
  "engines": {
    "node": ">=20.11.0 <21"
  }
}
```

Works, but **less strict** than `.nvmrc`.

---

## Option 3: Explicitly tell Cascade (ad-hoc)
Inside the **Cascade panel**, you can pin it manually:

```text
Use Node.js 20.11.1 for this project.
```

This works for the current session, but:
- ❌ Not source-controlled
- ❌ Easy to drift
- ❌ Not ideal for teams

Use only for quick experiments.

---

## What Cascade actually does under the hood
- Uses your local Node installation
- Respects `.nvmrc` → `nvm`, `fnm`, or system Node
- Falls back to system Node if unspecified

If Node isn’t installed:
```bash
nvm install 20.11.1
```

---

## Recommendation (facts, not vibes)
**Use `.nvmrc` + restart Windsurf.**  
That’s the only solution that is deterministic and production-grade.

If you want, tell me:
- macOS vs Linux
- `nvm`, `fnm`, or neither  

I’ll give you the exact setup to make Cascade 100% deterministic.

## Question

## Error Type
Runtime Error

## Error Message
Rendered more hooks than during the previous render.

Next.js version: 16.1.1 (Turbopack)

## Answer

Mr. White — this is a **React rules-of-hooks violation**, not a Next.js or Turbopack bug.

### What the error means (precisely)
> **“Rendered more hooks than during the previous render”**  
React detected that **the number or order of hooks changed between renders**.

Hooks **must be called unconditionally and in the same order on every render**. No exceptions.

---

## The 3 causes that account for ~99% of cases

### 1. ❌ Hook inside a conditional
```tsx
if (user) {
  const [state, setState] = useState() // ❌
}
```

✅ Fix:
```tsx
const [state, setState] = useState()
if (!user) return null
```

---

### 2. ❌ Early return before hooks
```tsx
if (!data) return null
const [x, setX] = useState() // ❌ sometimes never runs
```

✅ Fix:
```tsx
const [x, setX] = useState()
if (!data) return null
```

---

### 3. ❌ Hook inside a loop / map
```tsx
items.map(item => {
  const ref = useRef() // ❌
})
```

✅ Fix:
- Lift hook to parent
- Or extract a child component

---

## Next.js 16–specific gotcha (very common)

### ❌ Mixing Server & Client logic
```tsx
// missing "use client"
useState() // ❌ causes inconsistent execution
```

✅ Fix:
```tsx
"use client"

import { useState } from "react"
```

If this component (or any parent) uses:
- `useState`
- `useEffect`
- `useContext`
- `useRef`

…it **must** be a Client Component.

---

## Fast way to locate the bug (do this)
1. Find the component named in the stack trace
2. Check for:
   - `if (...) useX()`
   - `return` before hooks
   - Hooks in `map`, `for`, `try/catch`
3. Verify `"use client"` is present

---

## Hard rule (memorize this)
> **All hooks must run on every render, in the same order.**

React doesn’t forgive this. Ever.

---

If you paste **the component code**, I’ll pinpoint the exact line and give you the minimal diff to fix it.

## Question

is there a biome rule i can use to catch this?

## Answer

Yes, Mr. White — **Biome can catch this**, but with limits. Facts only.

---

## ✅ What Biome *can* catch
Biome implements **React Rules of Hooks** via:

```json
{
  "linter": {
    "rules": {
      "react": {
        "useHookAtTopLevel": "error",
        "useHookInLoop": "error"
      }
    }
  }
}
```

These **will flag**:
- Hooks inside `if`
- Hooks inside loops (`map`, `for`)
- Hooks inside nested blocks

This catches **most static violations**.

---

## ❌ What Biome cannot catch (by design)
Biome **cannot detect render-path–dependent hooks**, e.g.:

```tsx
if (cond) return null
useEffect(() => {}) // ❌ runtime-only violation
```

Why:
- Requires **control-flow + render semantics**
- Only detectable at runtime or by ESLint’s hooks plugin

---

## ✅ Best-practice setup (production-grade)

### 1. Use Biome **and** ESLint hooks rule
Biome is fast; ESLint is stricter here.

```bash
npm i -D eslint eslint-plugin-react-hooks
```

```js
// eslint.config.js
export default [
  {
    plugins: {
      "react-hooks": require("eslint-plugin-react-hooks")
    },
    rules: {
      "react-hooks/rules-of-hooks": "error"
    }
  }
]
```

This rule **will catch the exact error you’re seeing** before runtime.

---

## Bottom line (no fluff)
- ✅ Biome: catches **structural** hook misuse
- ❌ Biome: misses **early-return render path issues**
- ✅ ESLint hooks rule: **required** to fully prevent this class of bug

If you want, tell me:
- App Router vs Pages Router
- Monorepo or single app  

I’ll give you a **zero-redundancy Biome + ESLint config** that doesn’t overlap or slow CI.

## Question

will refacoting the large components fix this

## Answer

Short answer, Mr. White: **yes — if you refactor the right way.**  
Long answer (still concise): **refactoring fixes this *only* when it enforces hook invariants.**

---

## Why large components cause this error
Big components tend to accumulate:
- Early returns
- Feature flags
- Conditional branches
- Inline `map()` logic

All of those make it easy to accidentally change **hook order between renders**.

Refactoring **reduces the surface area** where that can happen.

---

## Refactor patterns that *actually* fix it

### ✅ 1. Extract conditional UI into child components
**Before (bug-prone):**
```tsx
if (showModal) {
  useEffect(() => {}) // ❌
}
```

**After (safe):**
```tsx
{showModal && <Modal />}
```

```tsx
function Modal() {
  useEffect(() => {})
}
```

Hooks are now **unconditional inside `Modal`**.

---

### ✅ 2. Move early returns *below* hooks
**Before:**
```tsx
if (!data) return null
useState()
```

**After:**
```tsx
useState()
if (!data) return null
```

This alone fixes many cases.

---

### ✅ 3. One concern per component
If a component does:
- Data fetching
- Layout
- Feature gating
- Animations

…it’s too large.

Split into:
- **Controller component** (hooks + state)
- **Pure presentational components** (no hooks)

---

## Refactors that do **NOT** fix it

### ❌ Just “cleaning up” code
- Renaming variables
- Reordering JSX
- Moving hooks around *without* changing control flow

The bug will survive.

---

## Hard rule to follow while refactoring
> **Every render must execute the same hooks, in the same order.**

If your refactor makes that obviously true by inspection, it will fix the error.

---

## Practical checklist (use this)
When refactoring a large component:
- [ ] All hooks are at the top level
- [ ] No `return` before hooks
- [ ] No hooks in conditionals or loops
- [ ] Conditional UI → child components
- [ ] `"use client"` present if hooks exist

---

### Bottom line
**Yes**, refactoring large components usually fixes this  
**if and only if** it enforces unconditional hook execution.

If you paste the component, I’ll tell you **exactly** where to split it and why.

## Question

can you give me a prompt to give claude code to find this type of issue

## Answer

Absolutely, Mr. White. Here’s a **copy-paste prompt** that works well with Claude Code for *this exact class of bug*.

---

### Prompt for Claude Code (Hooks Order Bug)

> You are auditing a React / Next.js codebase for **Rules of Hooks violations** that can cause the runtime error:
> **“Rendered more hooks than during the previous render.”**
>
> Your task:
> 1. Scan the provided files and **identify every place where hooks (`useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useContext`, custom hooks)** may execute conditionally or inconsistently between renders.
> 2. Pay special attention to:
>    - Early `return` statements before hooks
>    - Hooks inside `if`, `switch`, ternaries, `try/catch`
>    - Hooks inside loops or `.map()`
>    - Components missing `"use client"` that use hooks
>    - Feature flags, env checks, or prop-based branching
> 3. For each issue found, report:
>    - **File path**
>    - **Exact line(s)**
>    - **Why this breaks hook ordering**
>    - **Minimal safe fix** (prefer component extraction over rearranging hooks)
> 4. If no violations are found, explicitly state that and explain why hook order is guaranteed.
>
> Be strict. Prefer false positives over false negatives. Do not refactor unless necessary to demonstrate a fix.

---

## Why this prompt works
- Forces **control-flow analysis**, not just syntax scanning
- Calls out **early returns** (the #1 missed case)
- Biases toward **safe structural fixes**
- Matches how React actually evaluates hooks

If you want, I can:
- Tune this for **App Router**
- Add instructions for **large component decomposition**
- Adapt it for **Claude + Biome + ESLint output**

Just say the word.

## Question

what about improper use of use client. 

## Answer

Good instinct, Mr. White. **Improper `use client` usage absolutely causes this error**—and it’s one of the easiest to miss.

Here’s the precise breakdown.

---

## How `use client` causes “Rendered more hooks than previous render”

### Key fact
> **A component without `"use client"` is a Server Component by default.**

Server Components:
- Do **not** run hooks
- Are stripped of hook calls at build time

If that component **sometimes** becomes a Client Component (via imports or refactors), React sees **different hook execution paths across renders**.

Boom: runtime error.

---

## The 3 dangerous patterns

### ❌ 1. Hook usage without `"use client"`
```tsx
import { useState } from "react"

export function Widget() {
  const [x, setX] = useState(0) // ❌
}
```

If this file lacks:
```tsx
"use client"
```

React may:
- Render it as server-only
- Then hydrate differently on the client

---

### ❌ 2. Conditional client-only imports
```tsx
if (typeof window !== "undefined") {
  const { useEffect } = require("react")
  useEffect(() => {}) // ❌
}
```

This guarantees divergent hook paths.

---

### ❌ 3. Server component wrapping a client component incorrectly
```tsx
// Server component
export default function Page() {
  if (flag) {
    return <ClientComp /> // hooks run
  }
  return null // hooks don't run
}
```

If `ClientComp`’s presence changes between renders, hook count differs.

✅ Fix:
- Move the condition *inside* the client component
- Or render a stable wrapper

---

## Safe patterns (memorize these)

### ✅ Rule 1: Any file with hooks starts with `"use client"`
First line. No comments above it.

```tsx
"use client"
```

---

### ✅ Rule 2: Server Components may **render** client components, but never conditionally across renders
Server → Client boundary must be stable.

---

### ✅ Rule 3: Feature flags live in client components
Never gate client components at the server level unless static.

---

## Linting & enforcement (facts)

### ESLint
```json
"rules": {
  "react-hooks/rules-of-hooks": "error"
}
```

### Biome (partial protection)
```json
"react/useHookAtTopLevel": "error"
```

### ❗ Missing rule
There is **no linter** today that fully enforces correct `use client` boundaries.
This is architectural, not syntactic.

---

## What to do in practice
When you see this error:
1. Find the component
2. Verify `"use client"` is present
3. Ensure it’s not conditionally rendered by a Server Component
4. Move branching **inside** the client component

---

## One-sentence takeaway
> **If a component can ever run hooks, it must *always* be a client component and always render in a stable position.**

If you want, paste the file tree or the component—I'll mark **exactly** where the boundary is wrong.

## Question

should our whole app be client? and marketing and public profiles be server?

## Answer

Mr. White — **your instinct is broadly correct**, but the *why* and *where people screw this up* matter.

Here’s the clean, production-grade answer.

---

## Short answer
- **No**, your *entire* app should **not** be client
- **Yes**, **marketing + public, cacheable pages** should be **server**
- **Yes**, your **app shell / product UI** is usually **client-heavy**

The goal is **clear boundaries**, not purity.

---

## Recommended split (what actually works)

### 🟦 Server Components (default)
Use for:
- Marketing pages
- SEO content
- Public profiles
- Docs, blogs, pricing
- Read-only pages
- Anything cacheable or static

Why:
- Zero JS to the browser
- Fast TTFB
- Great SEO
- No hook issues

These pages should have **no hooks at all**.

---

### 🟩 Client Components (selectively)
Use for:
- Authenticated app UI
- Dashboards
- Editors
- Modals
- Drag/drop
- Forms
- Anything interactive or stateful

Why:
- Hooks required
- Interactivity required
- User-specific state

---

## ❌ Anti-pattern: “whole app = client”
Marking everything `"use client"`:
- Bloats JS
- Slows hydration
- Kills RSC benefits
- Hides architectural bugs (including the one you’re debugging)

It *feels* simpler, but it’s technical debt.

---

## ❌ Anti-pattern: server components deciding if client components exist
This causes your error.

Bad:
```tsx
// Server
{isLoggedIn && <Dashboard />}
```

If `isLoggedIn` can change between renders → 💥

Good:
```tsx
<DashboardShell />
```

```tsx
"use client"
function DashboardShell() {
  if (!isLoggedIn) return null
  return <Dashboard />
}
```

Server boundary stays stable.

---

## The rule that prevents 90% of hook bugs
> **Server components choose structure.  
> Client components choose behavior.**

If the server decides *whether* hooks exist, you will get runtime errors.

---

## A pragmatic architecture (teams that move fast use this)

```
app/
  (marketing)/
    page.tsx        // server only
  (public)/
    profile/[id]/   // server
  (app)/
    layout.tsx      // server shell
    page.tsx        // server
    ClientRoot.tsx  // "use client" boundary
```

```tsx
// ClientRoot.tsx
"use client"
```

Everything interactive lives **below** this.

---

## Bottom line
- Server by default
- Client where needed
- **Never let server logic decide hook existence**
- One stable client boundary per app area

If you want, tell me:
- App Router only?
- Auth method?
- Feature flags (env vs remote)?

I’ll sketch the **exact boundary layout** for your app.

## Question

so our app shell should be server? sidebar with nav server? use button client? breadcrumbs server? actual content in app client?

## Answer

Mr. White — yes, you’re thinking about this **exactly the right way**.  
Here’s the **clean, correct mental model**, with zero hand-waving.

---

## Canonical rule (memorize this)
> **Structure = Server  
> Behavior = Client**

If you apply this consistently, the hook error you hit basically disappears as a class of bug.

---

## Component-by-component (your questions answered)

### ✅ App shell → **SERVER**
**Yes. Absolutely.**

Includes:
- Layout
- Grid
- Regions
- Slots

```tsx
// app/(app)/layout.tsx
export default function AppLayout({ children }) {
  return (
    <Shell>
      <Sidebar />
      <Main>{children}</Main>
    </Shell>
  )
}
```

No hooks. No `"use client"`.

---

### ✅ Sidebar with nav → **SERVER (usually)**
If:
- Links are static
- Active state derived from route
- No local UI state

Then **server** is correct.

```tsx
import { headers } from "next/headers"

export function Sidebar() {
  const path = headers().get("x-pathname")
  return <Nav active={path} />
}
```

No hydration cost.

---

### ⚠️ Buttons → **CLIENT**
Buttons are **behavior**, not structure.

If a button:
- Opens modal
- Mutates state
- Triggers mutation
- Uses `onClick`

➡️ **Client**

```tsx
"use client"
export function SaveButton() {
  return <button onClick={save}>Save</button>
}
```

---

### ✅ Breadcrumbs → **SERVER**
If breadcrumbs are:
- Derived from route params
- Static per request

➡️ **Server**

```tsx
export function Breadcrumbs({ params }) {
  return <Trail segments={params.slug} />
}
```

If they animate or collapse → client.

---

### ⚠️ “Actual content” → **IT DEPENDS**
This is where teams overcorrect.

#### Server content:
- Tables (static)
- Read-only data
- Lists
- Text
- SEO-visible info

#### Client content:
- Editors
- Filters
- Infinite scroll
- Drag/drop
- Selection state
- Optimistic UI

**Split at the interaction boundary**, not the page boundary.

---

## The correct pattern (this matters)

### ❌ Wrong
```tsx
// Server
if (canEdit) {
  return <Editor /> // ❌ server decides hooks exist
}
```

### ✅ Right
```tsx
<EditorShell />
```

```tsx
"use client"
function EditorShell() {
  if (!canEdit) return <ReadOnly />
  return <Editor />
}
```

---

## Why this fixes your runtime error
- Server render is **structurally stable**
- Client components always run hooks
- Hook order never changes
- Hydration is deterministic

---

## One-sentence architecture summary
> **Server components define the frame.  
> Client components bring it to life.**

You’re on the right track.  
If you want, paste one real layout file and I’ll mark **exactly** what should stay server vs client.

## Question

can you give me a prompt to audit the app for violations of this?

## Answer

Absolutely, Mr. White. Here’s a **high-signal audit prompt** you can give to Claude Code to systematically find **server/client boundary violations** that lead to hook-order and hydration bugs.

---

## Prompt: Server vs Client Boundary Audit (Next.js App Router)

> You are auditing a **Next.js App Router** codebase for **improper Server vs Client Component boundaries** that can cause:
> - “Rendered more hooks than during the previous render”
> - Hydration mismatches
> - Unstable client boundaries
>
> **Architecture contract to enforce:**
> - **Server Components** define *structure only* (layout, shell, nav, breadcrumbs).
> - **Client Components** define *behavior* (state, effects, event handlers).
> - Server Components must **never decide whether hooks exist**.
>
> ### Your tasks:
>
> 1. Identify every component that:
>    - Uses React hooks but is missing `"use client"`
>    - Is conditionally rendered by a Server Component
>    - Uses feature flags, auth state, or env checks in a Server Component to decide whether a Client Component renders
>
> 2. Identify Client Components that:
>    - Should be Server Components (no hooks, no handlers, no browser APIs)
>    - Exist only to pass props through (unnecessary hydration)
>
> 3. Flag any of the following **as errors**:
>    - Hooks in files without `"use client"`
>    - Server Components branching on user/session/flags to include or exclude Client Components
>    - Client Components rendered inside conditionals that may change between renders
>    - UI shells or layouts marked `"use client"` without necessity
>
> 4. For each violation, report:
>    - **File path**
>    - **Component name**
>    - **Violation type** (structural vs behavioral boundary)
>    - **Why it’s unsafe**
>    - **Minimal safe fix**, preferring:
>      - Moving conditionals *into* a client component
>      - Extracting a stable client boundary
>      - Converting unnecessary client components back to server
>
> 5. If a component is correctly structured, explicitly confirm why it is safe.
>
> Be strict. Prefer false positives over false negatives.  
> Do not refactor unless necessary to demonstrate a safe boundary.

---

## Optional add-on (recommended)
If you want Claude to go harder:

> Assume the codebase has already experienced production hook-order bugs.  
> Treat any ambiguous boundary as unsafe unless proven stable.

---

## Why this works
- Forces Claude to reason about **render stability**, not syntax
- Aligns with React’s actual execution model
- Catches bugs **linters cannot**
- Produces actionable fixes, not vague advice

If you want, I can:
- Adapt this to **monorepos**
- Add a **“client boundary map” output**
- Optimize it for **large layouts + feature flags**

Just say the word.

## Question

yeah go harder for sure and optimize this for opus 4.5

## Answer

Hell yes, Mr. White — here’s the **“go nuclear” version**, tuned for **Claude Opus 4.5**.  
This assumes the codebase is already guilty until proven innocent.

---

## 🔥 Prompt: Nuclear Server/Client Boundary Audit (Claude Opus 4.5)

> You are performing a **deep architectural audit** of a **Next.js App Router** codebase that has produced **production hook-order and hydration bugs**.
>
> **Assume the code is unsafe by default.**  
> Every Server ↔ Client boundary must be *explicitly justified*.
>
> ---
>
> ## 🚨 Primary failure modes to hunt
> Treat each of the following as **production-blocking defects**:
>
> - Server Components that **decide whether Client Components render**
> - Hooks executing in files without `"use client"`
> - Client Components that **may not render on every pass**
> - Feature flags, auth state, or env checks in Server Components that gate Client Components
> - Layouts or shells marked `"use client"` without strict necessity
> - Components whose client/server role changes across imports
>
> ---
>
> ## 🧠 Architecture contract (non-negotiable)
>
> - **Server Components** define **structure only**
>   - layout
>   - shell
>   - nav
>   - breadcrumbs
>   - read-only content
>
> - **Client Components** define **behavior only**
>   - hooks
>   - state
>   - effects
>   - event handlers
>
> - **Server Components must never decide whether hooks exist**
>
> ---
>
> ## 🎯 Your tasks
>
> ### 1. Build a Client Boundary Map
> For every file that contains `"use client"`:
> - List file path
> - State *why* it must be client
> - Identify all parents up to the nearest layout
> - Flag any parent that conditionally renders it
>
> If justification is weak or missing, mark as **over-hydrated**.
>
> ---
>
> ### 2. Hunt Unstable Render Paths
> Identify all locations where:
> - A Server Component conditionally includes a Client Component
> - The condition depends on:
>   - auth/session
>   - feature flags
>   - env vars
>   - params
>   - async data
>
> Treat these as **hook-order hazards**.
>
> ---
>
> ### 3. Enforce Hook Invariants
> Flag as **critical**:
> - Early returns before hooks
> - Hooks in conditional blocks
> - Hooks in loops, maps, or try/catch
> - Hooks imported dynamically
>
> Assume runtime behavior matters more than syntax.
>
> ---
>
> ### 4. Find Hidden Server→Client Coupling
> Identify cases where:
> - A component is server in one import path and client in another
> - A server file imports a client file only under conditions
> - A client component is indirectly gated by server logic
>
> These are **latent hydration bombs**.
>
> ---
>
> ### 5. Prescribe Minimal, Safe Fixes
> For every violation:
> - Provide file path + component
> - Explain **exactly** why render stability is broken
> - Propose the **smallest possible fix**, preferring:
>   - Stable client boundaries
>   - Moving branching into client components
>   - Converting unnecessary client components to server
>
> Do **not** suggest “mark everything client”.
>
> ---
>
> ## 

*(Answer truncated — 3934 chars total)*

## Question

A codemod strategy to enforce this automatically

## Answer

Alright Mr. White — here’s a **real, enforceable codemod strategy**.  
This is not theory. This is how teams actually **lock this down so it can’t regress**.

---

# Codemod Strategy: Enforce Server / Client Boundaries Automatically

## Goal (explicit)
Prevent:
- Hook-order bugs
- Unstable Server → Client rendering
- Accidental over-hydration
- “Rendered more hooks than previous render” **ever reaching runtime**

We do this by **making invalid states unrepresentable**.

---

## Phase 0 — Define the contract in code (non-optional)

Before touching ASTs, decide this **once**:

### File role rules
| File contains | Must be |
|--------------|--------|
| React hook | `"use client"` |
| Event handler (`onClick`, etc.) | `"use client"` |
| Browser API (`window`, `document`) | `"use client"` |
| Layout / shell / nav / breadcrumbs | **server** |
| Data fetching only | **server** |

Codemods enforce this mechanically.

---

## Phase 1 — Hook → Client codemod (safe, automatic)

### What it does
For every file that:
- Imports any React hook
- Uses a custom hook (`useXxx()`)

➡️ Ensure `"use client"` is the **first statement**

### Implementation (jscodeshift / ts-morph)
Pseudo-logic:

```
For each .tsx file:
  If file contains CallExpression matching /^use[A-Z]/
    AND does not already have "use client"
    THEN insert "use client" as first statement
```

### Why this is safe
- It only *adds* client boundaries
- No behavior changes
- Prevents silent server execution of hooks

This alone eliminates an entire class of bugs.

---

## Phase 2 — Client overreach rollback codemod (critical)

Now we **undo unnecessary client components**.

### What it does
For each `"use client"` file:
- If **no hooks**
- AND no event handlers
- AND no browser APIs

➡️ **Remove `"use client"`**

### Result
- Client components become rare and intentional
- Server is the default again
- JS payload drops
- Boundaries become meaningful

This prevents the “mark everything client” decay.

---

## Phase 3 — Conditional Client Render detector (BLOCKER)

This is the most important one.

### What it detects
In **Server Components only**:

```tsx
{condition && <ClientComponent />}
if (x) return <ClientComponent />
switch (...) { case ...: <ClientComponent /> }
```

Where:
- `ClientComponent` resolves to a `"use client"` file
- `condition` is **not statically constant**

### Codemod action
❌ Do **not** auto-fix  
✅ Insert a **hard error comment** + CI failure

```tsx
// ❌ INVALID: Server component conditionally renders a Client Component.
// Move this condition into a client boundary.
```

Why no auto-fix?
- Requires architectural intent
- Must be handled consciously

This prevents **every hook-order bug you’ve discussed**.

---

## Phase 4 — Mandatory Client Boundary extraction (guided)

For repeated violations, offer a **guided transform**:

### Before (illegal)
```tsx
// Server
{isLoggedIn && <Dashboard />}
```

### Codemod suggests (not auto-applies):
```tsx
<DashboardBoundary />
```

```

*(Answer truncated — 4674 chars total)*

## Question

what is codemod

## Answer

Mr. White — **codemod** is short for **code modification script**.

Here’s the crisp, no-BS definition.

---

## What a codemod is (precise)
A **codemod** is an **automated program that rewrites source code** using the language’s syntax tree (AST), not text search.

Key properties:
- Programmatic
- Repeatable
- Deterministic
- Safe at scale

Think: **“refactor the entire codebase in one command.”**

---

## What codemods are used for (real examples)
- Adding `"use client"` to every file that uses hooks
- Renaming APIs across thousands of files
- Migrating class components → hooks
- Enforcing architectural boundaries
- Removing deprecated patterns safely

Facebook, Meta, Google, Stripe, Vercel use codemods constantly.

---

## Codemod vs regex (important)
| Regex | Codemod |
|-----|--------|
| Text-based | AST-based |
| Breaks on edge cases | Syntax-aware |
| Unsafe | Safe |
| Dumb | Structural |

Regex can’t tell:
```tsx
useEffect()
```
from:
```tsx
function useEffect() {}
```

Codemods can.

---

## How codemods work (high level)

1. Parse source code into an **AST**
2. Walk the tree
3. Match specific patterns
4. Rewrite nodes
5. Print valid code back out

No guesswork.

---

## Common codemod tools (JS/TS)
- **ts-morph** (TypeScript-aware, best for Next.js)
- jscodeshift
- Babel codemods
- SWC codemods (emerging)

For your case: **ts-morph is the right tool**.

---

## Why codemods matter for your problem
Your issue is **architectural**, not stylistic.

Humans:
- Forget rules
- Miss edge cases
- Reintroduce bugs under pressure

Codemods:
- Enforce invariants
- Make illegal states impossible
- Stop regressions forever

This is exactly the right lever.

---

## One-sentence takeaway
> **A codemod is a script that refactors code for you, safely, across the entire repo, using the AST.**

If you want next:
- A **10-minute ts-morph crash course**
- A **real codemod example** for `"use client"`
- A **repo layout for codemods + CI**

Say which and I’ll go straight there.
