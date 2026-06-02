---
title: "Architecture Enforcement Strategy"
type: note
created: 2026-03-07
updated: 2026-03-07
source: chatgpt-export
conversation_id: 69ab9fd0-e574-832d-98ad-6cc3ff5cda7d
message_count: 2
tags: [chatgpt, import, long-form]
---
# Architecture Enforcement Strategy

> Conversation ID: 69ab9fd0-e574-832d-98ad-6cc3ff5cda7d
> Created: 2026-03-07T03:48:07Z
> Updated: 2026-03-07T03:49:38Z
> Messages: 2

---

## User

Yo, so I need to do some basic pre-commit hooks, and then we have Sentry, Seer, and CodeRabbit, NCI, and then we have like some type checks and unit tests and basic smoke tests where we go. And then night we test and stuff like that. I'm trying to catch specifically issues with AI agents. They should be using the pooled connection from Neon, which is already set in Doppler. So they shouldn't have to manage any polling. It should all happen because we're using that pooled connection URL. And then we should be using the HTTP driver with Drizzle for Neon. And I'm trying to catch mismatches where it's like raw SQL or attempts to use pooling on top of the pooled URL or attempts to use like the wrong driver, not the HTTP driver and stuff. Like, and make sure that like everything across the board is properly using a single implementation of Neon through the pooled connection URL that's already set in Doppler. And then that's part one. And then part two is Tanstack Query, Tanstack Pacer, and Tanstack Virtual, Tanstack. I think that's all of them. And then Nux, and just making sure that nothing is creating separate methods of doing things that could or should be batched into Tanstack Query call or utilizing Tanstack Pacer or something to make sure that we don't have multiple implementations, which I guess is stuff that should all be in the agents MD file, and I think already is, but we're still getting like issues here and there. And so I wanna find a way to what would be the recommended way to deal with that.

---

## Assistant

Mr. White,

The recommended approach is to treat this as **architecture enforcement**, not “best-effort review.” Put the policy in `AGENTS.md`, then back it with **hard static checks** that fail locally and in CI.

### What to enforce

For Neon + Drizzle:

- Neon’s **pooled connection string** already routes through PgBouncer, and Neon recommends pooled connections by default for app traffic. Using another pool on top of that is the class of mistake you want to block. Neon also documents that **migrations should use a direct connection**, not the pooled one. citeturn0search0turn0search4
- Drizzle’s Neon support is via `neon-http` and `neon-websockets`. If your standard is **HTTP only**, make that an org rule and ban the websocket variant everywhere except an explicitly approved file if you ever need it. citeturn0search1turn0search5

For TanStack:

- TanStack Query is built around **query keys + promise-based query functions**. That makes it a good “single path” for server-state reads. citeturn1search6turn1search0
- TanStack Pacer is explicitly for **debouncing, throttling, rate limiting, queuing, and batching**. Its batching utilities are intended to group operations by size/time/custom trigger. citeturn0search2turn1search15turn1search2
- If “Nux” means **nuqs**, its docs say TanStack Router already has built-in type-safe search param support and nuqs is mainly for cases where you need it. citeturn0search7turn1search3

### Recommended structure

Use a **single blessed implementation** and make every other path illegal.

#### 1) One DB entrypoint
Create one file such as:

- `src/server/db/client.ts`

That file is the **only** place allowed to:
- read the Neon env var from Doppler
- initialize `@neondatabase/serverless`
- initialize Drizzle
- export the approved `db`

Everything else imports from that module only.

Then ban:
- `pg`
- `postgres`
- `Pool`, `Client`, `pg.Pool`
- direct `sql\`\`` or raw Neon client creation outside the approved DB module
- `drizzle-orm/neon-serverless` websocket driver if your standard is HTTP only
- any second DB factory

#### 2) One data-access pattern
Use:
- repository/service functions on the server
- Query option factories on the client

Example shape:
- `src/server/repos/users.ts`
- `src/features/users/queries.ts`

Components should call:
- `useQuery(userQueries.detail(id))`
- `useMutation(userMutations.update())`

Ban:
- ad hoc `fetch` / `axios` / custom client calls inside components
- ad hoc caching layers
- duplicate request batching utilities when the use case belongs in Query or Pacer
- custom list virtualization when TanStack Virtual is already the standard

### How to enforce it

Use **three layers**.

#### Layer 1: ESLint for fast feedback
Use `no-restricted-imports` and `no-restricted-syntax`.

Examples of what to block:
- importing `pg`, `postgres`, `@neondatabase/serverless`, or `drizzle-orm/neon-serverless` outside `src/server/db/**`
- `new Pool(...)`
- `new Client(...)`
- direct env access like `process.env.DATABASE_URL` outside the DB module
- `fetch(...)` in UI components except approved query/mutation files
- `useQuery({ queryFn: ... })` inline in components if you want all query defs centralized in `queries.ts`

This catches most drift cheaply in pre-commit.

#### Layer 2: Semgrep or custom AST rules for architectural violations
This is the main recommendation.

ESLint is good for syntax and imports. **Semgrep or a custom TypeScript AST check** is better for rules like:

- “pooled Neon URL must never be wrapped in another pool”
- “only `drizzle(neon(process.env...))` from the approved module is allowed”
- “no raw SQL unless inside `/repos` or `/migrations`”
- “no direct data fetching in React/Vue components”
- “Pacer batching required for these call sites”
- “TanStack Virtual required for large list components”

For your case, I would add a dedicated script such as:

- `pnpm lint:arch`

and make that the main blocker in CI.

#### Layer 3: CI tiering
Use different depth by stage.

**Pre-commit**
- eslint
- typecheck on changed packages
- `lint:arch` on changed files
- unit tests related to changed files

**PR required checks**
- full `lint`
- full `lint:arch`
- full typecheck
- unit tests
- smoke tests
- CodeRabbit/Seer review pass

**Nightly**
- deeper semgrep set
- integration tests
- migration sanity checks
- query-performance or batching regressions
- longer smoke flows

### The highest-value rules for your DB problem

These are the specific checks I would implement first.

#### Fail if any file outside `src/server/db/**` imports:
- `pg`
- `postgres`
- `@neondatabase/serverless`
- `drizzle-orm/neon-serverless`

#### Fail if code contains:
- `new Pool(`
- `new Client(`
- `postgres(`
- `neonConfig.`
- direct `process.env.*DATABASE*` access outside the DB module

#### Fail if Drizzle Neon is initialized with anything except your approved HTTP path
Drizzle supports both HTTP and websocket drivers for Neon. Your rule should allow one and reject the other. citeturn0search1turn0search5

#### Fail if migrations use the pooled URL
Neon’s docs are clear that pooled connections can cause migration issues; use a direct connection for migration tooling. citeturn0search4turn0search12

### The highest-value rules for TanStack drift

#### Query rules
Require:
- query key factories
- query functions in dedicated files
- mutations in dedicated files

Ban:
- direct `fetch` in components
- direct server calls in render code
- duplicate cache layers
- duplicate retry/backoff logic when Query already owns the request lifecycle

TanStack Query expects a promise-returning query function tied to a query key. That gives you a clean structural rule to enforce. citeturn1search6turn1search0

#### Pacer rules
Create a shortlist of cases where Pacer is mandatory:
- user-input search
- bursty write coalescing
- webhook fan-in
- batch API calls
- rate-limited external providers

Then fail on:
- manual `setTimeout`/`clearTimeout` debounce helpers in app code
- lodash debounce/throttle if Pacer is the standard
- bespoke queue/batch utilities when Pacer is already adopted

TanStack Pacer explicitly covers those utility classes and batching patterns. citeturn0search2turn1search15turn1search2

#### Virtualization rules
For designated list/table paths, require TanStack Virtual and ban homegrown virtualization.

### What to put in `AGENTS.md`

Keep it short and machine-checkable.

Example policy headings:
- **Database Access**
- **Server State**
- **Batching / Debouncing / Rate Limiting**
- **Virtualization**
- **URL/Search Param State**
- **Forbidden Imports**
- **Approved Modules**
- **CI Gates**

Include:
- the one approved DB module path
- the one approved query factory pattern
- the one approved batching library
- exact forbidden imports
- exact exceptions directory list

### What Sentry / CodeRabbit / Seer should do

Use them as secondary protection.

- **CodeRabbit / Seer**: comment on violations and link to the policy file
- **Sentry**: catch runtime symptoms that escaped static rules, such as connection misuse, duplicated calls, unbatched request storms, and N+1-like request patterns

They help. They should not be the primary control. Primary control is static failure before merge.

### Priority order

1. **Single DB entrypoint**
2. **Restricted imports**
3. **`lint:arch` with Semgrep or AST**
4. **Single TanStack Query factory pattern**
5. **Mandatory Pacer for approved use cases**
6. **Nightly integration and smoke coverage**

### Bottom line

The correct move is:

- define one blessed implementation per concern
- ban all alternate implementations
- enforce it with static checks
- keep humans and AI agents inside narrow rails

That is the reliable way to stop AI agents from inventing “almost right” patterns.

If you want, I can draft a concrete `AGENTS.md` policy plus a first-pass `eslint` + `semgrep` rule set for Neon/Drizzle and TanStack.
