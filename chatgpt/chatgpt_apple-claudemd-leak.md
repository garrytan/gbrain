---
conversation_id: 69f9cd8e-03cc-83e8-8825-bb32d4dcf2ef
created: 2026-05-05
links:
- '[[chatgpt-clusters/coding_ai_ml]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Apple Claude.md Leak
type: guide
updated: 2026-05-05
---

# Apple Claude.md Leak

> Conversation ID: 69f9cd8e-03cc-83e8-8825-bb32d4dcf2ef
> Created: 2026-05-05T10:59:26Z
> Updated: 2026-05-05T17:31:36Z
> Messages: 4

---

## User

the apple claude.md file leaked recently. can you find it and then extract antyhing we should be use orrecommend a rewrite of ours based on it?

---

## Assistant

I’ll verify the reported Apple CLAUDE.md source, distinguish public evidence from commentary, then extract reusable patterns without copying proprietary text. Since your file isn’t attached, I’ll provide an original rewrite template you can adapt.

---

## Assistant

I found public reports and reproductions; the high-signal pattern is compact, module-specific rules covering gotchas, invariants, feature flags, persistence, component usage, and release exclusion checks.

---

## Assistant

Mr. White, I found it. Public screenshots from Aaron Perris show Apple Support v5.13 shipped with `CLAUDE.md` files, and his follow-up says v5.13.1 removed them. Apple has not issued an official public confirmation, so treat the exact content as likely-but-unverified. citeturn367530search0turn367530search8turn243013view0

The useful part is the **format**, not Apple’s private details. The two files were reportedly short module guides: one for conversational support with AI/human backends, and one for a shared UI component library. The reported patterns were: “real-time stream choice,” “service-provider concurrency model,” “backend abstraction,” “conditional compilation flags,” “participant roles,” “known structural gotchas,” “UI-only component rules,” “preset factories,” “platform variants,” “docs/previews required.” citeturn968102view2turn243013view0turn257909view0

Anthropic’s own guidance supports the same conclusion: `CLAUDE.md` should contain concise, persistent project context, build/test commands, conventions, architecture decisions, and rules Claude would otherwise need re-explained; Anthropic also says shorter files are followed more reliably and suggests targeting under 200 lines per file. citeturn165615view0

## What we should use

Use Apple’s **module-specific “gotcha sheet” style**:

1. **Keep root `CLAUDE.md` short.** It should orient Claude, define hard rules, and point to scoped docs.
2. **Move detail into scoped files.** Use `apps/web/CLAUDE.md`, `packages/ui/CLAUDE.md`, `.claude/rules/*.md`, or skills.
3. **Document invariants, not essays.** “Never import shadcn primitives directly” is more useful than a long design-system explanation.
4. **Capture architecture seams.** Auth boundary, DB boundary, UI wrappers, server/client boundary, background jobs, billing.
5. **Add “do not touch casually” sections.** Migrations, auth, payments, production env, analytics/events, generated files.
6. **Require verification.** Typecheck, lint, focused tests, build before claiming done.
7. **Treat AI instruction files as internal architecture docs.** Exclude them from deployed artifacts, Docker images, npm packages, mobile bundles, and logs. Apple’s real mistake was packaging hygiene. citeturn243013view0turn257909view0

## Recommended Jovie rewrite

Since you did not attach the current file, I’d replace the root `CLAUDE.md` with a compact controller file like this and move the big rules into scoped docs.

```md
# CLAUDE.md

This file guides Claude Code when working in the Jovie repository.

## Operating Principles

- Make the smallest correct change.
- Inspect existing patterns before creating new ones.
- Prefer server-side code, typed contracts, and existing package boundaries.
- Do not invent commands, env vars, routes, tables, services, or design tokens.
- Do not hide failing checks. Report exact failures and the likely cause.
- Ask before destructive operations: data deletion, irreversible migrations, credential changes, dependency replacement, auth/payment changes, or production-impacting scripts.

## Repo Workflow

1. Read the relevant files before editing.
2. State the plan for multi-file or risky changes.
3. Edit only files needed for the task.
4. Run the most focused verification available.
5. Summarize changed files, checks run, and remaining risks.

Use `pnpm`. Inspect `package.json`, workspace config, and app/package-local scripts before running commands.

## Architecture Rules

- Use Next.js App Router patterns only.
- Prefer Server Components for data reads.
- Use Server Actions or Route Handlers for mutations where the repo already does so.
- Use client components only for interactivity, browser APIs, local state, or client-only libraries.
- Do not introduce Pages Router APIs.
- Do not move auth, DB, billing, or secrets logic into client components.

## Auth

- Follow the existing Clerk integration.
- Use server-side auth helpers in server code.
- Use client auth hooks only inside `'use client'` components.
- Do not bypass route protection, middleware, organization scoping, or user ownership checks.
- Do not create test-only auth shortcuts unless explicitly requested.

## Data Layer

- Follow the existing database adapter and ORM/query patterns.
- Do not introduce a second DB client for convenience.
- Do not bypass tenant/user scoping.
- Do not use service-role/admin credentials in application paths.
- For schema changes: create migrations, preserve data, and explain rollback risk.

## UI System

- shadcn/ui primitives are implementation details.
- Product code imports Jovie wrappers, not raw primitives.
- Generated primitives live under the established primitives folder.
- Use existing tokens for color, spacing, radius, typography, shadows, and motion.
- Do not hardcode arbitrary colors, one-off spacing systems, or new component APIs without checking existing components.
- Preserve light/dark mode.
- Components should be accessible by default: labels, focus states, keyboard behavior, ARIA when needed.

## Component Rules

- Atoms: visual primitives and stable low-level wrappers.
- Molecules: composed UI with limited local behavior.
- Organisms/patterns: product-specific composition.
- Shared UI components contain no business logic, data fetching, auth checks, or service calls.
- Add examples/previews/states when adding reusable components: default, loading, empty, error, disabled, mobile.

## API and Integrations

- Validate external inputs with the repo’s existing validation pattern.
- Keep provider-specific code behind service adapters.
- Do not leak provider objects across package boundaries.
- Log useful operational context without secrets or PII.
- For webhooks, verify signatures before parsing business logic.

## Payments

- Treat billing code as high-risk.
- Keep Stripe logic server-side.
- Verify webhook signatures.
- Do not change price IDs, entitlements, subscription states, or customer mapping without explicit approval.

## Secrets and Configuration

- Use Doppler or the existing secret-management path.
- Do not commit `.env`, local settings, tokens, credentials, screenshots with secrets, or generated secret dumps.
- Do not add secrets to `CLAUDE.md`, `AGENTS.md`, `CODEX.md`, `.claude/`, `.cursor/`, `.codex/`, docs, tests, or fixtures.
- If a secret appears in the repo, stop and report it.

## Files Claude Should Treat Carefully

- Auth middleware and route guards
- Database schema and migrations
- Billing/subscription code
- Production deployment config
- Design tokens and primitives
- Generated files
- Analytics/event schemas
- Security, permissions, and RLS/tenant-scoping logic

## Verification

Before claiming completion, run the narrowest relevant checks:

- Typecheck for TypeScript/API changes
- Lint/format for edited packages
- Unit or integration tests for changed logic
- Build for routing, config, or cross-package changes

If checks are unavailable or fail for unrelated reasons, say so clearly.

## Scoped Instructions

Look for more specific instructions before editing:

- `apps/*/CLAUDE.md`
- `packages/*/CLAUDE.md`
- `.claude/rules/*.md`
- `.agents/skills/*`
- Package README files
- Existing nearby tests and examples

More local instructions override this file for their scope.
```

## Files I’d add next

```txt
.claude/rules/ui.md
.claude/rules/auth.md
.claude/rules/db.md
.claude/rules/security.md
.claude/rules/release.md
apps/web/CLAUDE.md
packages/ui/CLAUDE.md
packages/db/CLAUDE.md
```

The root file should stay short. Put stack-specific gotchas into those scoped files.

## Build hygiene to add immediately

Add these patterns to `.dockerignore`, package publish excludes, deploy ignores, and CI artifact scans:

```gitignore
CLAUDE.md
AGENTS.md
CODEX.md
.claude/
.cursor/
.codex/
.agents/
*.local.json
mcp.json
.env
.env.*
```

For CI, add a final artifact scan after build and before deploy:

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"

matches="$(
  find "$TARGET" \
    \( -name 'CLAUDE.md' \
    -o -name 'AGENTS.md' \
    -o -name 'CODEX.md' \
    -o -name 'mcp.json' \
    -o -name '*.local.json' \
    -o -path '*/.claude/*' \
    -o -path '*/.cursor/*' \
    -o -path '*/.codex/*' \
    -o -path '*/.agents/*' \
    \) -print
)"

if [ -n "$matches" ]; then
  echo "AI/dev-only artifacts found in build output:"
  echo "$matches"
  exit 1
fi
```

My recommendation: use the rewrite above, split the current large agent instructions into scoped files, and add the artifact scan before the next production deploy.


**Topic:** [[chatgpt-clusters/coding_ai]]
