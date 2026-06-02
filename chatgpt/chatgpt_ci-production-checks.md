---
title: "CI production checks"
type: note
created: 2025-09-01
updated: 2025-09-01
source: chatgpt-export
conversation_id: 68b4f012-24ac-832a-a0f8-5f75f88b5122
message_count: 4
tags: [chatgpt, import]
---
# CI production checks

> Conversation ID: 68b4f012-24ac-832a-a0f8-5f75f88b5122
> Created: 2025-09-01T01:00:12Z
> Updated: 2025-09-01T01:01:50Z
> Messages: 4

---

## User

What checks should be required on production for our CI?

---

## Assistant

Mr. White — here’s a tight, production-gating CI checklist tailored to your Vercel + Neon + Nuxt/TS setup. Require these checks on the **production** branch before deploy (and make them required status checks in GitHub):

# Core correctness
- **Build**: `pnpm build` (Nuxt prod build must succeed).
- **Type check**: `tsc --noEmit` clean.
- **Lint/format**: ESLint + Prettier (no warnings promoted to errors).
- **Unit tests**: Vitest/Jest green; coverage threshold enforced (e.g., ≥80% lines on critical packages).
- **E2E smoke**: Playwright against the **preview URL** (auth, routing, tipping flow, 404, 500 page).

# Security & supply chain
- **Dependency vulns**: OSV/Snyk audit fails on high/critical.
- **Secret scan**: GitHub secret scanning (fail on any newly introduced secret).
- **License compliance**: allowlist only.
- **SBOM + image scan** (if you ship containers anywhere): Syft + Trivy pass.

# Performance & UX budgets
- **Bundle size budget**: fail if any entrypoint/regression > X KB gz (set budgets per route).
- **Lighthouse CI** (preview URL): Perf/Best-Practices/Accessibility/SEO ≥ 90; CLS/LCP budgets met.
- **A11y**: axe-core checks pass on key pages.

# Data & migrations (Neon)
- **Migration dry-run**: apply pending SQL/Drizzle/Prisma migrations on a prod snapshot/shadow DB; block on destructive ops unless flagged `SAFE=true`.
- **Schema drift check**: generated schema matches DB.
- **Backup freshness**: verify last automated backup < 24h (block if stale).
- **Data guardrails**: seed disabled for prod; no `DROP TABLE`/`ALTER COLUMN TYPE` without explicit approval label.

# Observability readiness
- **Env contract**: runtime env validator (e.g., zod/env) passes with *production* variables (Sentry DSN, PostHog key, public base URL, etc.).
- **Error pipeline ping**: Sentry/Log drain test event received.
- **Feature flags**: PostHog flags fetchable (404/401 blocks).

# Deployment safety
- **Preview-to-prod gate**: only deploy if the exact preview commit passed all checks.
- **Blue/green or canary plan**: rollout config present (even if 100/0); health checks defined.
- **Rollback ready**: previous artifact available + one-click rollback script dry-run.

# Governance & repo hygiene
- **Signed commits** (or verified CI merge).
- **Branch up-to-date** with main; **merge queue** satisfied.
- **Conventional commits / changelog** generated (or release notes present).

# Post-deploy required (run automatically and block “completed” status until green)
- **Post-deploy smoke** (prod URL): key route 200s + auth + tipping link works.
- **Error budget guard**: new-release Sentry error rate over N minutes < threshold.
- **DB migration verify**: version table reflects latest.

---

## Suggested GitHub status check names
- `build:nuxt`
- `typecheck:tsc`
- `lint:eslint`
- `test:unit`
- `test:e2e:playwright`
- `sec:osv-audit`
- `sec:secret-scan`
- `license:policy`
- `perf:bundle-budgets`
- `ux:lighthouse`
- `a11y:axe`
- `db:migrate-dryrun`
- `db:schema-drift`
- `db:backup-freshness`
- `obs:env-validate`
- `obs:sentry-ping`
- `flags:posthog-ping`
- `deploy:gate-preview`
- `rollback:ready-check`
- `postdeploy:smoke`
- `postdeploy:error-budget`
- `postdeploy:migration-verify`

If you want, I can output a ready-to-drop GitHub Actions workflow that implements these with sensible defaults for Vercel + Neon.

---

## User

give me exact names of the workflows i should set as required. Keep in mind yc principles

---

## Assistant

Mr. White — set these **required status checks** for the **production** branch:

- `CI / Build` fileciteturn0file2  
- `CI / Unit Tests` fileciteturn0file2  
- `CI / E2E Tests` fileciteturn0file2  
- `CI / Drizzle Check` fileciteturn0file2  
- `CodeQL Security Analysis / Analyze (javascript-typescript)` fileciteturn0file5  
- `CodeQL Security Analysis / Analyze (actions)` fileciteturn0file5  

Notes (YC-style minimalism): keep gates few but meaningful; the auto-merge and promotion flows already key off these exact CI names for prod PRs. fileciteturn0file0turn0file1
