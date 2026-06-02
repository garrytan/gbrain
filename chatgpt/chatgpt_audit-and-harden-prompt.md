---
title: "Audit and Harden Prompt"
type: essay
created: 2026-04-24
updated: 2026-04-24
source: chatgpt-export
conversation_id: 69eba44d-ae24-83e8-8b42-681ed4079f0e
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Audit and Harden Prompt

> Conversation ID: 69eba44d-ae24-83e8-8b42-681ed4079f0e
> Created: 2026-04-24T17:11:42Z
> Updated: 2026-04-24T17:22:54Z
> Messages: 4

---

## User

audit this prompt then ahrden it. optimzie for claude code max paralellization and depth. i dont want to miss anything.

---

## Assistant

Mr. White, I’ll audit the prompt for execution gaps and harden it into a Claude Code-ready orchestration prompt with parallel workstreams, agent contracts, schemas, merge gates, bounded writes, invariants, and verification checks.

---

## Assistant

I’ve already spotted dependency issues: coverage-dependent analysis must wait for coverage output, artifact-creating commands need explicit write allowances, and taxonomy should follow raw enumeration rather than block it.

---

## Assistant

Mr. White, the current prompt is already strong: it defines the deliverable, scope, read/write boundaries, ranking rubric, inventory axes, and verification checks. The main weaknesses are execution determinism, merge safety, taxonomy bottlenecking, ambiguous “read-only” language, incomplete primitive definitions, and missing machine-readable output contracts. It also says “No commits” earlier and later includes “Step 6 — Commit,” which should be resolved explicitly. fileciteturn0file0

Claude Code-specific hardening: use **Agent** terminology rather than older “Task” terminology, restrict worker tools, keep workers read-only where possible, and use background subagents for high-output work like coverage/test parsing. Anthropic’s docs note that Task was renamed to Agent, subagents can be tool-restricted, support plan/read-only-style permission modes, and are useful for isolating high-volume operations. citeturn215324view0

## Audit: what I would change

| Area | Risk in current prompt | Hardened fix |
|---|---|---|
| Parallelism | Step 1 taxonomy blocks most downstream work. | Split into parallel raw discovery first, then a short taxonomy synthesis barrier. |
| Completeness | “Pages/APIs/DB/tests” are listed, but Next.js special files, middleware, metadata routes, emails, analytics, env gates, workflows, packages, and auth primitives can slip through. | Define an exhaustive primitive taxonomy and require zero-orphan validation. |
| Writes | Says read-only, but branch rename, pnpm install, coverage, `.context`, final doc, and commit are writes. | Declare exact allowed writes and stop before commit unless explicitly approved. |
| Evidence | Final rows can become inferred summaries. | Require every claim to have source evidence: path, symbol, line/range when available. |
| Merge safety | Markdown-only partials are hard to validate. | Require JSONL machine artifacts plus Markdown summaries. |
| Coverage | Coverage commands may fail without Doppler/env. | Run coverage best-effort, record failure reason, continue with static test mapping. |
| Ownership | “Every table appears in exactly one capability” can be false for shared tables. | Require exactly one **primary** owner, allow secondary consumers. |
| Agent collisions | 9 workers write to same `.context/inventory` tree. | One worker, one file. Coordinator/synthesis is the only final writer. |
| Validation | Checks are good but informal. | Add executable count manifests and diff guardrails. |
| Review/commit | Step 6 commit conflicts with “No commits.” | Stop for human review; commit only after explicit instruction. |

## Hardened Claude Code prompt

Paste this into Claude Code:

```md
# Jovie Feature Registry Deep Audit — Max-Parallel, Evidence-First Execution

You are Claude Code running at the repository root.

Optimize for maximum safe parallelization, deep coverage, and zero missed primitives. Use Agent subagents aggressively for independent read-heavy discovery work. Prefer completeness over speed. Do not rely on prior conversation memory or previously stated counts unless the repo evidence confirms them.

## Mission

Rewrite `/docs/FEATURE_REGISTRY.md` into the single authoritative source of truth for every feature/capability in the repo, with coverage, flags/gates, docs, tests, and owned implementation primitives.

Final deliverable:

- Rewritten `/docs/FEATURE_REGISTRY.md`
- Scratch artifacts under `.context/inventory/**`
- No product code changes
- No commits unless the user explicitly says: `commit feature registry`

## Non-negotiable operating rules

1. Evidence first.
   Every final registry claim must be traceable to repo evidence:
   - file path
   - symbol/function/export/table/route/flag name when applicable
   - line number or grep/search evidence where available
   - confidence: high / medium / low

2. One-writer rule.
   Worker agents may write only their assigned scratch files under `.context/inventory/**`.
   Only the coordinator/synthesis phase may write `/docs/FEATURE_REGISTRY.md`.

3. Allowed writes only:
   - `.context/inventory/**`
   - coverage output directories generated by existing test tooling
   - `/docs/FEATURE_REGISTRY.md`
   - branch rename to `itstimwhite/feature-audit`
   - dependency installation artifacts only if required by `pnpm install --frozen-lockfile`

4. Forbidden changes:
   - no edits to app code
   - no edits to tests
   - no edits to schemas/migrations
   - no edits to package scripts/configs
   - no edits to `.gitignore`, CI, env files, or Claude settings
   - no deletion/remediation of orphaned code
   - no commit without explicit user approval

5. Do not force expected counts.
   The prompt mentions historical counts: 158 pages, 263 API routes, 30 server actions, 111 DB tables, 1,373 test files, 77 E2E specs, 17 Statsig flags.
   Treat those as hints only. Recompute actual counts from the repo and report mismatches.

6. Shared primitives.
   Every primitive must have exactly one primary capability owner.
   Shared/cross-cutting primitives may also list secondary capabilities.
   Never duplicate a primitive as primary-owned by two capabilities.

7. Unknowns are explicit.
   If a primitive cannot be confidently mapped, place it in `Appendix: Orphans / Triage Needed`.
   Do not silently omit it.

8. Stop condition.
   After writing `/docs/FEATURE_REGISTRY.md`, run validation and present the summary.
   Stop before committing unless the user explicitly approves.

---

# Phase 0 — Bootstrap and safety checks

Run sequentially:

```bash
pwd
git status --short
git branch --show-current
mkdir -p .context/inventory/raw .context/inventory/mapped .context/inventory/validation
```

If the current branch is not `itstimwhite/feature-audit`, run:

```bash
git branch -m itstimwhite/feature-audit
```

Check whether `.context/` is gitignored:

```bash
git check-ignore .context || true
```

If `.context/` is not ignored, do not edit `.gitignore`. Record this in `.context/inventory/validation/gitignore-note.md`.

Install dependencies only if needed for coverage or scripts:

```bash
pnpm install --frozen-lockfile
```

Record all bootstrap results in:

```text
.context/inventory/00-bootstrap.md
```

---

# Phase 1 — Start coverage jobs immediately, in background

Launch these as background Agent/Bash work where possible. They must not block raw inventory agents.

## Coverage worker A — Unit coverage

Goal: produce file-level unit coverage.

Try Doppler first:

```bash
doppler run -- pnpm --filter web vitest run --coverage --reporter=json
```

If Doppler/env fails, retry without Doppler:

```bash
pnpm --filter web vitest run --coverage --reporter=json
```

Then parse all available coverage artifacts, preferring:

- `apps/web/coverage/coverage-final.json`
- `apps/web/coverage/coverage-summary.json`
- any lcov or json-summary files actually produced

Emit:

```text
.context/inventory/raw/coverage-unit.json
.context/inventory/raw/coverage-unit.md
```

Schema:

```json
{
  "filepath": "string",
  "lines_pct": "number|null",
  "branches_pct": "number|null",
  "functions_pct": "number|null",
  "statements_pct": "number|null",
  "covered_lines": "number|null",
  "total_lines": "number|null",
  "source": "coverage-final|coverage-summary|lcov|static|failed",
  "failure_reason": "string|null"
}
```

Coverage failure is not fatal. Record failure reason and continue.

## Coverage worker B — E2E/spec mapping

Parse all Playwright/E2E specs and configs.

Read:

- `apps/web/tests/e2e/**/*.spec.ts`
- `apps/web/tests/**/*.spec.ts`
- `apps/web/playwright.config*.ts`
- any package-level Playwright config
- CI workflows that run Playwright

Extract:

- `page.goto(...)`
- `page.route(...)`
- `request.get/post/put/patch/delete(...)`
- route literals
- API literals
- imported test helpers
- `describe(...)` / `test(...)` titles
- smoke/full/nightly tier if inferable

Emit:

```text
.context/inventory/raw/coverage-e2e.json
.context/inventory/raw/coverage-e2e.md
```

Schema:

```json
{
  "spec_file": "string",
  "test_titles": ["string"],
  "describe_titles": ["string"],
  "routes_visited": ["string"],
  "api_calls": ["string"],
  "mocks_or_intercepts": ["string"],
  "tier": "smoke|full|nightly|unknown",
  "evidence": [{"path":"string","line":0,"text":"string"}]
}
```

---

# Phase 2 — Raw discovery wave, max parallel

Launch all independent discovery agents in parallel. Do not serialize them. Each worker writes one JSONL file and one Markdown summary. Each worker must use only Read/Grep/Glob/Bash and its assigned scratch path.

Every raw JSONL record must follow this base schema:

```json
{
  "primitive_id": "string",
  "primitive_type": "page|layout|route_handler|api_endpoint|server_action|db_table|db_enum|db_relation|cron|workflow|webhook|flag|entitlement|env_gate|test|doc|component|package|email_template|analytics_event|middleware|special_route|script|unknown",
  "name": "string",
  "path": "string",
  "line_start": 0,
  "line_end": 0,
  "route": "string|null",
  "http_methods": ["GET"],
  "auth_gate": "string|null",
  "access_model": "Free+|Pro+|Growth+|Max|Admin|Dev-only|Public|Unknown|null",
  "status_hint": "Shipped|Shipped (flagged)|In rollout|Planned|Unknown|null",
  "flag_or_gate": ["string"],
  "integrations": ["Stripe|Clerk|Statsig|Resend|Vercel|Supabase|Postgres|Other"],
  "suggested_capabilities": ["string"],
  "primary_capability_hint": "string|null",
  "secondary_capability_hints": ["string"],
  "confidence": "high|medium|low",
  "evidence": [{"path":"string","line":0,"symbol":"string","text":"string"}],
  "notes": "string"
}
```

## Worker 1 — Canonical docs and product taxonomy

Read:

- `docs/FEATURE_REGISTRY.md`
- `docs/PRODUCT_CAPABILITIES.md`
- `docs/API_ROUTE_MAP.md`
- `docs/CRON_REGISTRY.md`
- `docs/SCHEMA_MAP.md`
- `docs/LIB_MODULE_INDEX.md`
- `docs/STATSIG_FEATURE_GATES.md`
- `docs/TESTING_STRATEGY.md`
- `AGENTS.md`
- `CLAUDE.md` if present

Emit:

```text
.context/inventory/raw/01-doc-taxonomy.jsonl
.context/inventory/raw/01-doc-taxonomy.md
```

Capture:
- existing capability names
- existing status/access vocabulary
- change management rules
- canonical source lists
- any claimed counts
- inconsistencies or stale documentation

## Worker 2 — Next.js pages and app router surfaces

Read:

- `apps/web/app/**/page.tsx`
- `apps/web/app/**/layout.tsx`
- `apps/web/app/**/template.tsx`
- `apps/web/app/**/loading.tsx`
- `apps/web/app/**/error.tsx`
- `apps/web/app/**/not-found.tsx`
- `apps/web/app/**/default.tsx`
- `apps/web/app/**/opengraph-image.*`
- `apps/web/app/**/twitter-image.*`
- `apps/web/app/**/sitemap.*`
- `apps/web/app/**/robots.*`
- route groups, parallel routes, intercepted routes, dynamic routes

Emit:

```text
.context/inventory/raw/02-pages.jsonl
.context/inventory/raw/02-pages.md
```

For each route, infer:
- public/private/admin/dev
- auth mechanism
- entitlement gate
- capability hint
- important imported components/actions/APIs

## Worker 3 — API route handlers

Read:

- `apps/web/app/api/**/route.ts`
- `apps/web/app/api/**/route.tsx`
- any route handlers outside `apps/web/app/api`

Emit:

```text
.context/inventory/raw/03-api-routes.jsonl
.context/inventory/raw/03-api-routes.md
```

For each route:
- route path
- exported HTTP methods
- auth checks
- webhook signature checks
- external integrations
- DB tables used
- flags/env gates
- capability hint
- P0/P1 risk notes

## Worker 4 — Server actions

Search for:

- `"use server"`
- `server action`
- exported async functions used by forms/actions
- action modules outside `app`

Emit:

```text
.context/inventory/raw/04-server-actions.jsonl
.context/inventory/raw/04-server-actions.md
```

For each action:
- function name
- file
- callers if inferable
- auth/entitlement checks
- DB tables
- integrations
- capability hint

## Worker 5 — Database schema, relations, migrations, seeds

Read:

- `packages/db/schema/**`
- migrations if present
- seeds if present
- DB client/query helper modules

Emit:

```text
.context/inventory/raw/05-db.jsonl
.context/inventory/raw/05-db.md
```

For each table/enum/relation:
- primary capability hint
- secondary capability hints
- CRUD paths if inferable
- PII/payment/security sensitivity
- orphan risk

## Worker 6 — Cron, workflows, queues, webhooks, scheduled jobs

Read:

- `vercel.json`
- `.github/workflows/**`
- webhook route handlers
- queue/job modules
- scheduled scripts
- package scripts that run jobs

Emit:

```text
.context/inventory/raw/06-jobs-webhooks.jsonl
.context/inventory/raw/06-jobs-webhooks.md
```

Capture:
- schedule/trigger
- route/script
- capability
- auth/signature verification
- failure risk
- monitoring/logging if present

## Worker 7 — Flags, Statsig, entitlements, env gates

Read:

- `apps/web/lib/flags/**`
- `apps/web/lib/flags/contracts.ts`
- `apps/web/lib/flags/registry.ts`
- `apps/web/lib/entitlements/registry.ts`
- all env access patterns: `process.env.*`
- config modules that gate features

Emit:

```text
.context/inventory/raw/07-flags-entitlements-env.jsonl
.context/inventory/raw/07-flags-entitlements-env.md
```

For each flag/gate:
- exact key
- default
- rollout state if inferable
- capability hint
- code references
- whether it must appear exactly once in final registry

## Worker 8 — Tests: unit/integration/static mapping

Read:

- `apps/web/tests/**`
- `**/*.test.ts`
- `**/*.test.tsx`
- `**/*.spec.ts`
- `**/*.spec.tsx`
- coverage artifacts from Phase 1 if ready
- vitest config

Emit:

```text
.context/inventory/raw/08-tests-unit.jsonl
.context/inventory/raw/08-tests-unit.md
```

For each capability hint:
- unit test files
- integration test files
- coverage % where available
- no-test gaps
- critical-path gap notes

## Worker 9 — Tests: E2E/Playwright mapping

Read:

- E2E/spec mapping from Phase 1 if ready
- Playwright specs/configs directly if Phase 1 is still running

Emit:

```text
.context/inventory/raw/09-tests-e2e.jsonl
.context/inventory/raw/09-tests-e2e.md
```

For each capability hint:
- E2E spec files
- routes touched
- APIs touched
- smoke/full/nightly tier
- missing critical-path tests

## Worker 10 — Developer docs

Read:

- `/docs/**`
- `AGENTS.md`
- `CLAUDE.md`
- package READMEs
- JSDoc/TSDoc around capability entry points

Emit:

```text
.context/inventory/raw/10-devdocs.jsonl
.context/inventory/raw/10-devdocs.md
```

For each capability hint:
- dev doc paths
- doc freshness/staleness signals
- missing dev docs

## Worker 11 — User docs

Read:

- `apps/docs/**`
- any public docs app/package
- help/support docs if present

Emit:

```text
.context/inventory/raw/11-userdocs.jsonl
.context/inventory/raw/11-userdocs.md
```

For each capability hint:
- user doc paths
- missing docs for user-facing features
- N/A for admin/internal/dev-only

## Worker 12 — Other apps and shared packages

Read:

- `apps/extension/**`
- `packages/ui/**`
- `packages/*/**`
- shared components/hooks/utilities
- browser extension capabilities
- design system primitives used as features

Emit:

```text
.context/inventory/raw/12-other-apps-packages.jsonl
.context/inventory/raw/12-other-apps-packages.md
```

## Worker 13 — Auth, security, privacy, trust primitives

Read broadly for:

- Clerk/auth helpers
- middleware
- role checks
- admin checks
- Stripe webhook signature checks
- CSRF/replay protection
- public profile privacy
- PII handling
- rate limiting
- abuse controls

Emit:

```text
.context/inventory/raw/13-security-trust.jsonl
.context/inventory/raw/13-security-trust.md
```

Flag P0/P1 risks explicitly.

## Worker 14 — Notifications, email, messaging, analytics, observability

Read broadly for:

- email templates
- Resend/mail providers
- notification preferences
- analytics events
- Statsig event logging
- Sentry/logging/monitoring
- audit logs

Emit:

```text
.context/inventory/raw/14-comms-analytics-observability.jsonl
.context/inventory/raw/14-comms-analytics-observability.md
```

---

# Phase 3 — Count manifest and taxonomy synthesis

After Phase 2 raw discovery completes, run a coordinator synthesis.

Create:

```text
.context/inventory/20-count-manifest.json
.context/inventory/20-count-manifest.md
.context/inventory/21-capability-taxonomy.json
.context/inventory/21-capability-taxonomy.md
```

## Count manifest must include actual repo counts for:

- app pages
- layouts/templates/default/loading/error/not-found files
- special metadata/image/sitemap/robots routes
- API route handler files
- exported HTTP methods
- server actions
- middleware files
- DB tables
- DB enums
- cron jobs
- webhooks
- GitHub workflows
- Statsig flags
- entitlements
- env gates
- unit/integration test files
- E2E specs
- docs files
- packages/apps scanned

Include exact shell commands or grep patterns used to compute each count.

## Capability taxonomy

Produce 70–120 capabilities unless repo evidence strongly supports fewer/more.

Each capability must have:

```json
{
  "capability_id": "stable-kebab-case",
  "capability": "Human Name",
  "tier": "P0|P1|P2|P3",
  "status": "Shipped|Shipped (flagged)|In rollout|Planned|Unknown",
  "access_model": "Free+|Pro+|Growth+|Max|Admin|Dev-only|Public|Unknown",
  "description": "one sentence",
  "business_rationale": "why this tier",
  "primary_primitive_patterns": ["string"],
  "known_flags_gates": ["string"],
  "source_docs": ["path"]
}
```

## Tier rubric

Commit this rubric into the final doc:

- P0 — Revenue & trust-critical: billing, tips, Stripe Connect, Clerk auth, public profile render, webhook signature verification, account/session integrity, payment-affecting entitlement gates.
- P1 — Core product flows: release management, smart links, onboarding, pre-saves, dashboard, email notifications, creator identity/profile setup, core fan/creator flows.
- P2 — Supporting features: insights, chat, audience CRM, tour dates, shop, social links, integrations, analytics views, secondary automations.
- P3 — Internal/admin/dev: admin panel, investor portal, dev tools, demo routes, UI gallery, test fixtures, internal diagnostics.

If a capability spans tiers, assign the highest tier justified by user/business risk.

---

# Phase 4 — Parallel capability mapping wave

Launch these mapping agents in parallel. Each reads:

- `.context/inventory/21-capability-taxonomy.json`
- relevant raw JSONL files
- coverage outputs if ready

Each emits mapped JSON plus Markdown.

## Mapper 1 — Pages/routes to capabilities

Input:
- `02-pages.jsonl`
- taxonomy

Output:

```text
.context/inventory/mapped/31-pages-map.json
.context/inventory/mapped/31-pages-map.md
```

## Mapper 2 — APIs/actions/webhooks/jobs to capabilities

Input:
- `03-api-routes.jsonl`
- `04-server-actions.jsonl`
- `06-jobs-webhooks.jsonl`
- taxonomy

Output:

```text
.context/inventory/mapped/32-apis-actions-jobs-map.json
.context/inventory/mapped/32-apis-actions-jobs-map.md
```

## Mapper 3 — DB/schema/package primitives to capabilities

Input:
- `05-db.jsonl`
- `12-other-apps-packages.jsonl`
- taxonomy

Output:

```text
.context/inventory/mapped/33-db-packages-map.json
.context/inventory/mapped/33-db-packages-map.md
```

## Mapper 4 — Flags/entitlements/env gates to capabilities

Input:
- `07-flags-entitlements-env.jsonl`
- taxonomy

Output:

```text
.context/inventory/mapped/34-flags-gates-map.json
.context/inventory/mapped/34-flags-gates-map.md
```

## Mapper 5 — Tests and coverage to capabilities

Input:
- `08-tests-unit.jsonl`
- `09-tests-e2e.jsonl`
- `coverage-unit.json`
- `coverage-e2e.json`
- taxonomy

Output:

```text
.context/inventory/mapped/35-tests-coverage-map.json
.context/inventory/mapped/35-tests-coverage-map.md
```

## Mapper 6 — Docs to capabilities

Input:
- `10-devdocs.jsonl`
- `11-userdocs.jsonl`
- taxonomy

Output:

```text
.context/inventory/mapped/36-docs-map.json
.context/inventory/mapped/36-docs-map.md
```

## Mapper 7 — Security/trust/analytics cross-cutting map

Input:
- `13-security-trust.jsonl`
- `14-comms-analytics-observability.jsonl`
- all mapped files if useful
- taxonomy

Output:

```text
.context/inventory/mapped/37-risk-crosscutting-map.json
.context/inventory/mapped/37-risk-crosscutting-map.md
```

---

# Phase 5 — Validation wave, parallel

Launch validation agents in parallel. Each writes one file under `.context/inventory/validation/`.

## Validator 1 — Route/page completeness

Compare actual `apps/web/app/**` route surfaces against mapped capability ownership.

Output:

```text
.context/inventory/validation/41-route-completeness.md
```

Must list:
- covered routes
- uncovered routes
- duplicate-owned routes
- unknown/dynamic route handling

## Validator 2 — API/action completeness

Compare all route handlers and server actions against mapped ownership.

Output:

```text
.context/inventory/validation/42-api-action-completeness.md
```

## Validator 3 — DB completeness

Compare all schema tables/enums/relations against mapped ownership.

Output:

```text
.context/inventory/validation/43-db-completeness.md
```

Every table needs one primary owner. Secondary consumers are allowed.

## Validator 4 — Flag/gate completeness

Compare all Statsig flags, entitlements, and env gates against mapped ownership.

Output:

```text
.context/inventory/validation/44-flag-gate-completeness.md
```

Every Statsig flag and entitlement must appear in exactly one primary capability row.

## Validator 5 — Tests/docs completeness

Check that every P0/P1 capability has:
- unit/integration coverage status
- E2E coverage status
- dev doc status
- user doc status or N/A justification

Output:

```text
.context/inventory/validation/45-tests-docs-completeness.md
```

## Validator 6 — Final diff/write-scope guard

Run:

```bash
git status --short
git diff --name-only
```

Before final doc write, record baseline.

Output:

```text
.context/inventory/validation/46-write-scope.md
```

---

# Phase 6 — Final synthesis into `/docs/FEATURE_REGISTRY.md`

The main coordinator/synthesis agent now reads every artifact:

- `.context/inventory/00-bootstrap.md`
- `.context/inventory/raw/*`
- `.context/inventory/20-count-manifest.*`
- `.context/inventory/21-capability-taxonomy.*`
- `.context/inventory/mapped/*`
- `.context/inventory/validation/*`
- existing `/docs/FEATURE_REGISTRY.md`

Rewrite `/docs/FEATURE_REGISTRY.md` in place.

## Required final document structure

```md
# Feature Registry

## Purpose

Explain that this is the canonical capability registry for Jovie.

## Canonical Sources

List the canonical source files/directories used for:
- routes/pages
- APIs/actions
- DB/schema
- flags/entitlements
- tests/coverage
- docs
- jobs/webhooks
- packages/apps

## Change Management

Preserve and extend the existing Change Management section.
Add:
- every new route/API/table/flag must map to a capability
- every P0/P1 capability must declare test/doc status
- every registry update must preserve primary primitive ownership
- guardrails are follow-up work

## Inventory Snapshot

Include actual recomputed repo counts from `20-count-manifest`.

Include historical claimed counts only if they differ, under “Historical count comparison”.

## Tier Rubric

Include the P0/P1/P2/P3 rubric exactly, with any repo-specific clarifications.

## P0/P1 Testing Backlog

Prioritized backlog table.

Columns:
- Priority
- Capability
- Tier
- Gap
- Evidence
- Recommended hardening action
- Suggested first E2E/manual flow

Sort by:
1. P0 before P1
2. revenue/trust/payment/auth/public-profile risks first
3. no E2E before partial E2E
4. no docs before stale docs

## Capability Registry

Main table columns:

| Capability | Tier | Status | Access model | Flag / Gate | Unit test % | E2E coverage | Dev doc | User doc | Owner primitives |
|---|---|---|---|---|---|---|---|---|---|

Rules:
- `Capability` uses stable human-readable names.
- `Tier` is P0/P1/P2/P3.
- `Status` is Shipped / Shipped (flagged) / In rollout / Planned / Unknown.
- `Access model` is Free+ / Pro+ / Growth+ / Max / Admin / Dev-only / Public / Unknown.
- `Flag / Gate` lists Statsig keys, env vars, entitlements, or “none”.
- `Unit test %` uses coverage when available; otherwise “no coverage data”, “no tests”, or “unknown”.
- `E2E coverage` lists spec files or “gap: no E2E”.
- `Dev doc` is path(s), “missing”, or “N/A”.
- `User doc` is path(s), “missing”, or “N/A”.
- `Owner primitives` links to the corresponding details block.

## Capability Drill-downs

For every capability, include a collapsible section:

<details>
<summary id="capability-id">Capability Name — P0/P1/P2/P3</summary>

### Summary

- Status:
- Access model:
- Flag / Gate:
- Description:
- Business rationale:
- Confidence:

### Owned primitives

| Type | Name/Route/Symbol | Path | Evidence | Notes |
|---|---|---|---|---|

Include:
- page routes
- layouts/templates/special routes
- API endpoints and methods
- server actions
- DB tables/enums
- cron/jobs/workflows
- webhooks
- components/packages
- email templates
- analytics events
- flags/entitlements/env gates
- tests
- docs

### Coverage

| Coverage type | Evidence | Gap |
|---|---|---|

### Hardening gaps

List concrete missing or weak coverage/docs/security checks.

</details>

## Orphans / Human Triage Needed

List every primitive that could not be confidently assigned.

Columns:
- Primitive type
- Name/route/symbol
- Path
- Why unmapped
- Suggested owner capability
- Confidence

## Guardrails Follow-up TODO

Do not implement guardrails in this task. Document recommended follow-up:
- CI check for new route/API/table/flag without registry entry
- PR template checklist
- AGENTS.md update
- registry schema validator
- pre-commit or pnpm script
- optional generated registry source-of-truth

## Validation Appendix

Include:
- route completeness summary
- API/action completeness summary
- DB completeness summary
- flag/gate completeness summary
- tests/docs completeness summary
- write-scope summary
- known limitations
```

---

# Phase 7 — Final verification

After writing `/docs/FEATURE_REGISTRY.md`, run:

```bash
git diff -- docs/FEATURE_REGISTRY.md
git status --short
```

Then perform these checks and write results to:

```text
.context/inventory/validation/99-final-verification.md
```

Required checks:

1. P0 capabilities all have explicit test/doc gap status.
2. Every page route has one primary capability or appears in Orphans.
3. Every API route handler has one primary capability or appears in Orphans.
4. Every server action has one primary capability or appears in Orphans.
5. Every DB table has one primary capability or appears in Orphans.
6. Every Statsig flag has one primary capability or appears in Orphans.
7. Every entitlement has one primary capability or appears in Orphans.
8. Every P0/P1 user-facing capability has user doc status: path, missing, or N/A with reason.
9. No files outside allowed write scope were changed.
10. Final doc includes a prioritized P0/P1 hardening backlog.

If a check fails, fix `/docs/FEATURE_REGISTRY.md` if possible.
If it cannot be fixed without code changes or human input, document the limitation in the Validation Appendix.

---

# Final response to user

Report:

- actual count summary
- number of capabilities found
- number of P0/P1 capabilities
- top 10 hardening gaps
- orphan count by primitive type
- files changed
- whether commit was skipped

Do not commit.

End with:

“Ready for review. Say `commit feature registry` if you want me to create the commit.”
```

## Optional extra hardening

Run Claude Code with a coordinator subagent or settings that restrict worker tools. Claude Code supports subagent tool allowlists and permission rules, so the safest setup is read/grep/glob/bash for discovery workers and write access only for scratch/final synthesis. citeturn215324view0turn215324view1


## See Also
- [[chatgpt/chatgpt_improve-and-harden-prompt-part1]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part2]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part3]]
- [[chatgpt/chatgpt_improve-and-harden-prompt-part4]]
- [[chatgpt/chatgpt_codex-audit-prompt]]
