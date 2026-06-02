---
title: "AI dev workflow optimization"
type: essay
created: 2025-08-22
updated: 2025-08-22
source: chatgpt-export
conversation_id: 68a895ff-8214-8328-9064-a94224c2152a
message_count: 24
tags: [chatgpt, import, code, long-form]
---
# AI dev workflow optimization

> Conversation ID: 68a895ff-8214-8328-9064-a94224c2152a
> Created: 2025-08-22T16:14:40Z
> Updated: 2025-08-22T21:58:38Z
> Messages: 24

---

## User

Ive experimented with claude, codex, codger, builder.io, windsurf, cursor, chatgpt's work with app feature, copilot, linear agents, and a few other tools.

I find that the most effective workflow is something like using windsurf as my primary IDE. Ill use claude code in terminal with flags to not prompt me for questions, and that how i do most coding that is hands on. Then ill use cascade in windsurf with GPT5 low or high reasoning to identify complex issues, plan features, and audit the code base and then open linear issues for me. Then in linear I'll assign codegen or cursor background agents to issues. claude on github.com is setup to auto code review anything. And then I'll have have claude in the cli run and check PRs to see what can be merged, and merge them on my behalf. CI runs to make sure things pass tests.

This is mostly there in terms of allowing me to have an army of AI agents working on my behalf.  Codegen is like 10 bucks a month for unlimited runs and gpt5 in windsurf is pretty cheap right now. Claude code i use with the 100/mo plan and that's decent, using usage base billing makes it unaffordable.

That's basically my current setup and occasionally ill open chatgpt app and have it audit sql files and edit them for me or audit my ci iml files etc. and ill have it generate linear issue descriptions for me sometimes or talk through features and come up with prompts for claude and linear etc.

My question is, how can im improve this? Am i overlooking any tools? Can i make this setup tighter? Can i automate it even more? Can i de-risk it anymore?

---

## Assistant

Got it, Mr. White — you’ve basically built your own *personal AI dev shop*. You’ve got Claude, Cursor, GPT-5, Windsurf, Linear, codegen, CI, etc. all running in parallel. That’s already pretty tight. Here’s where you can refine it further:

---

## 1. **Tighten Workflow Integration**
- **Single source of truth for issues:** Right now you’re bouncing between Claude, Windsurf, Cursor, etc. Make sure **Linear is the canonical truth**. Everything flows in/out of it (audits, feature planning, bug reports, PR reviews).
- **Automated issue enrichment:** Use Claude/GPT-5 to *auto-expand Linear issues* (add acceptance criteria, link related tickets, suggest test cases). Cursor/codegen can then execute with less human babysitting.
- **CI feedback loop into Linear:** Hook CI to automatically comment on or reopen issues when builds break. Claude-in-CLI could then instantly propose a patch PR.

---

## 2. **Reduce AI Drift / Risk**
- **Guardrails via test-first workflows:** Before any agent writes production code, auto-generate unit/e2e tests for the feature. This way codegen’s output is boxed in.
- **Static analysis pass:** Add a step where an AI agent (Claude/GPT-5) runs lint/security audits before merge. Think of it as your "red team agent."
- **Kill manual merges:** Instead of Claude merging PRs directly, have it *tag PRs as auto-mergeable* once tests + audits pass. Let GitHub Actions do the actual merge. De-risks a rogue AI merge.

---

## 3. **Automate the Glue**
- **Agent routing system:** Instead of manually deciding "this goes to Cursor" or "this goes to Claude CLI," build a thin orchestrator script (Zapier/Make/ custom bot) that routes tasks:
  - Small fix → codegen
  - Large refactor → Cursor
  - Audit/plan → GPT-5 in Windsurf
- **Pre-prompt libraries:** Store modular prompt templates (SQL audits, CI audits, RLS checks, etc.) so you’re not re-crafting each time. Could live as Markdown in repo + consumed by agents.

---

## 4. **Expand Coverage**
- **Dependency upgrade bot:** Have GPT-5 auto-open PRs weekly for npm/pip/composer updates, with Claude reviewing + testing.
- **UX regression sweeps:** Spin up Percy/Chromatic + AI vision diff. Claude/GPT-5 can interpret diffs and open UI issues in Linear.
- **Observability agent:** An AI that watches logs/errors in prod (PostHog, Sentry, Supabase logs), summarizes anomalies, and files Linear issues. Cuts down firefighting time.

---

## 5. **Cost & Efficiency**
- **Claude cost control:** Since usage billing blows up, batch “big brain” audits into one structured run instead of piecemeal queries. Or use GPT-5 high-reasoning cascade for audits — it’s cheaper per unit of depth right now.
- **Agent benchmarking:** Track success rate per tool (Cursor vs. codegen vs. Claude CLI). Drop or downgrade the underperformers.

---

## 6. **Future De-Risk**
- **Chaos testing agent:** Periodically inject controlled “bad PRs” (breaking schema, mis-wiring auth, etc.) and make sure your army catches them. Simulates real drift.
- **Knowledge continuity:** Have GPT-5 auto-summarize key decisions (e.g., why schema uses creator_profiles vs artist_profiles) into a “project bible” doc. Prevents losing context when you spin up new agents.

---

**TL;DR:**  
You’re not missing any major tools — you’re missing *meta-automation*. Build an orchestrator, push Linear as the central hub, and add safety nets (tests, static analysis, observability). That way your “army of agents” behaves more like a disciplined military unit than a loose militia.

---

Do you want me to draft you a **system blueprint** (like a flow diagram: Linear at center, agents around it, CI/test/security loops) so you can see the whole machine at a glance?

---

## User

Jest or vitest

---

## Assistant

**Short answer:** **Vitest** for unit/integration; **Playwright** for e2e. Keep **Jest** only if you’re locked into legacy Jest-only libs or RN.

**Why Vitest (for you):**
- **Speed & DX:** ~2–10× faster cold/HHMR; instant watch.  
- **ESM/TS first-class:** Works cleanly with modern toolchains; fewer config hacks than Jest.  
- **Mocking parity:** `vi.mock` API mirrors Jest; easy port.  
- **Coverage:** V8 coverage is fast & stable.  
- **Storybook/RTL:** Works fine with React Testing Library and Storybook’s test runner.

**When to choose Jest instead:**
- You rely on **Jest-only plugins** (rare now).  
- **React Native** or **older CommonJS** stacks that break on ESM.  
- You need **JSDOM quirks** from long-lived suites you don’t want to touch.

**Recommended setup for Jovie:**
- **Vitest** + **happy-dom** (faster) for component/unit; swap to **jsdom** only if a lib requires it.  
- **Playwright** for e2e (you already run CI gates).  
- **Test pyramid:** unit (Vitest) >> integration (Vitest) >> e2e (Playwright); auto-fail PRs on any red.  
- **Auto-gen tests first:** Have GPT-5/Claude create tests from Linear AC *before* codegen writes features.

**Minimal migration (Jest → Vitest):**
1. Replace `jest` deps with `vitest`, `@vitest/coverage-v8`, `happy-dom`.  
2. Search/replace: `jest.` → `vi.`; `jest.fn` → `vi.fn`.  
3. Update globals: enable `globals: true` in `vitest.config.ts`.  
4. Swap `setupTests.ts` imports (`@testing-library/jest-dom` still fine).  
5. Keep `playwright` e2e unchanged.

**CI tips:**
- Run **Vitest in watch** locally; **--run --coverage** in CI.  
- Shard Playwright tests; block merges until Vitest + lint + typecheck + Playwright pass.  
- Have Claude tag PRs “auto-mergeable” after green; let GH Actions merge.

Bottom line, Mr. White: **Vitest** matches your speed-first, agent-driven workflow with fewer config headaches.

---

## User

Static generation with edge runtime?

---

## Assistant

**Short answer, Mr. White:**  
Static Generation doesn’t “run” on any runtime. It ships files. Edge Runtime only matters for code that executes per-request (middleware, route handlers, dynamic RSC). So: **SSG + CDN for speed; Edge only where you need per-request logic.**

### How to think about it
- **SSG (build or ISR)** → outputs static HTML/JSON, cached on CDN. No runtime involved on hit. citeturn0search4  
- **Edge Runtime** → lightweight V8 isolates for request-time work (personalization, auth gates, middleware, API/route handlers). Limited Node APIs. citeturn0search0turn0search6
- You **can mix**: static pages + Edge route for on-demand revalidate, A/B, geolocation, etc. But setting `export const runtime = 'edge'` on a page doesn’t make SSG “faster”; it just constrains server code if that page renders dynamically. citeturn0search9turn0search14

### App Router recipe for Jovie profiles (sub-100 ms)
- Make profile pages **static by default** with `generateStaticParams` and data `fetch(..., { next: { revalidate: N } })` (ISR). citeturn0search3turn0search1  
- Use an **Edge route handler** only for on-demand revalidation (`/api/revalidate`) or lightweight personalization; keep the page itself static. citeturn0search8  
- Watch **ISR pricing/limits** if you regenerate at scale; reads/writes hit Vercel’s durable cache. Tune `revalidate` windows. citeturn0search19turn0search2

### When to actually use Edge on pages
Use `runtime='edge'` only if the page must read request headers/cookies or personalize at request time. Otherwise keep it static and let the CDN do its job. (Middleware is always Edge.) citeturn0search7turn0search10

### Gotchas
- Edge Runtime ≠ full Node: no fs, no `require`, some libs break. Validate deps are ESM/Web API friendly. citeturn0search6
- Don’t expect “static on edge runtime” to exist as a mode; static is already edge-cached. Discussions calling this out are common. citeturn0search14turn0search17

**Bottom line:** Keep Jovie public profiles **SSG + ISR**; use **Edge** only for small, request-time logic (revalidation, geolocation tweaks, auth checks). That’s the fastest and least fragile path.

---

## User

Can we (and should we?) have our ci stop all checks if the type check fails? Or the lint fails? We dont really need to run the whole ci if there's lint errors that will need to be fixed and the whole thing retriggered anyway right? Or am i missing something 

---

## Assistant

Yes, Mr. White—fail early. Make **lint → typecheck → build → tests** a gated chain so downstream jobs never start if an upstream gate fails.

### What to do
- **Separate jobs** and gate with `needs`.  
- **Block on lint + typecheck**; only then run build/unit/e2e.  
- Enforce **zero warnings**: `eslint --max-warnings=0`.  
- Add **concurrency** to cancel superseded runs.  
- Mirror these checks in **branch protection** so merges require them.

### Minimal GitHub Actions layout
```yaml
name: CI
on: [push, pull_request]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: 'pnpm' }
      - run: pnpm i --frozen-lockfile

  lint:
    needs: install
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm lint --max-warnings=0

  typecheck:
    needs: [install, lint]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm typecheck # e.g., tsc --noEmit

  build:
    needs: [install, lint, typecheck]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm build

  unit:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test:unit --run --coverage

  e2e:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test:e2e
```

### Extra tightening
- **Pre-commit hooks**: Husky/Lefthook + `lint-staged` to catch basics before CI.  
- **Matrix fail-fast**: if you shard tests, set `strategy.fail-fast: true` in those jobs.  
- **PR auto-merge**: let your agent tag “auto-mergeable” only when `lint` + `typecheck` + `unit` pass; GitHub does the merge.  

You’re not missing anything—this is the clean, fast path.

---

## User

If auto merging is enabled and status checks are required, am i good? Or do i have to set up some additional auto mergable tagging

---

## Assistant

Short answer: you’re good, Mr. White. **Native Auto-merge + required status checks** is sufficient—no special “auto-mergeable” tag needed.

What to set:
- **Branch protection** on `main`: require your checks (lint, typecheck, build, tests), require reviews, and “require branches to be up to date.”
- **Enable Auto-merge** in repo settings. On each PR, click **Enable auto-merge** (or have your agent do it via API). It’ll merge automatically once checks + reviews pass.

When you’d add labels/tags:
- Only if you want policy control (e.g., *merge only if label = `automerge`* or different rules per label). That needs a bot (e.g., Mergify) or a tiny GitHub Action that merges when a label is present.

Bonus:
- If multiple PRs stack up, use **Merge Queue**. It respects required checks, batches safely, and avoids flaky double-runs.

TL;DR: **Native auto-merge + required checks = enough.** Add labels/automation only for extra policy or bot-driven control.

---

## User

Tell me about Merge Queue

---

## Assistant

Alright, Mr. White — **Merge Queue** is GitHub’s answer to the “herding cats” problem when lots of PRs are waiting to land.  

---

## 🚦 What It Does
- **Serializes merges**: Instead of 10 PRs racing to merge after CI passes, they enter a queue.  
- **Re-tests with base branch**: Each PR (or batch) is *rebased/merged* against the latest `main` and re-run through required checks before hitting main.  
- **Auto-merges cleanly**: Once a queued PR passes checks, it’s merged automatically. If it fails, it’s kicked out and the queue keeps flowing.

---

## 🛠️ How It Works
1. You enable **merge queue** under repo → Settings → Branches → Protection → “Require merge queue.”  
2. PRs must have:
   - Required reviews ✅  
   - Required status checks ✅  
   - Auto-merge enabled ✅  
3. Developer hits **Merge when ready** → PR gets added to the queue.  
4. GitHub creates a **temporary “merge group branch”** (your PR + latest main) → runs CI.  
   - If CI passes → PR merges.  
   - If CI fails → PR dropped, queue continues.  

---

## 🧩 Benefits
- **No broken main**: Always tested with the latest main, not stale green commits.  
- **No “merge train wrecks”**: Prevents multiple PRs merging at once and breaking each other.  
- **CI efficiency**: Supports batching (test 2–3 PRs together in one CI run).  

---

## ⚠️ Trade-offs
- **Slightly slower merges**: PRs wait their turn + rerun CI.  
- **Queue jams**: One failing PR can block others until it’s kicked.  
- **CI cost**: More reruns (but way safer for production).  

---

## 🎯 For your setup
Since you’re already:
- Blocking merges on lint/type/test,  
- Using auto-merge,  
- Shipping frequently…

→ **Merge Queue** is a natural upgrade. It’ll stop “green PRs” from breaking `main` when merged together, which is exactly what you want for your “agents auto-merging on my behalf” workflow.  

---

Want me to sketch you a **merge strategy flow** (PR enters → preflight checks → merge group branch → main) in a diagram so you can visualize how it’d look in your current CI chain?

---

## User

Just tell me how to setup merge queue

---

## Assistant

Got you, Mr. White. Here’s the fast setup.

### 1) Turn it on (repo settings)
1. **Settings → Branches → Branch protection rules → Edit `main` (or add)**
2. Check:
   - **Require a pull request before merging**
   - **Require approvals** (at least 1, if you want)
   - **Require status checks to pass before merging** → select your checks (lint, typecheck, build, unit, e2e)
   - **Require merge queue** (this replaces “require up to date”)
3. Save.

### 2) Make CI run for the queue
Add the `merge_group` event so Actions run on GitHub’s temporary test branch:
```yaml
# .github/workflows/ci.yml
on:
  pull_request:
  merge_group:   # ✅ required for Merge Queue
```
(Keep your jobs the same—just ensure the required checks are produced on both `pull_request` and `merge_group`.)

### 3) Enable auto-merge on PRs
- On each PR, click **Enable auto-merge** (pick squash/merge/rebase).
- Or let your agent call the GitHub API to enable auto-merge when checks + review exist.

### 4) Use it
- Click **Merge when ready** → PR enters the queue.
- GitHub creates a **merge group** branch (PR + latest `main`), runs your required checks, then merges if green. If red, it drops the PR and the queue continues.

### Tips
- **Required checks must be identical** for PRs and merge group runs (names must match).
- Keep CI fast: shard Playwright, use `concurrency` to cancel superseded runs.
- If you batch PRs, configure that in **Settings → Branches → Merge queue** (if available in your plan).

That’s it—once `merge_group` is wired and required checks are set, the queue just works.

---

## User

Constantly getting PRs open that fail nom check (lint, test, build). Can we and should we add this to a recommit hook?

---

## Assistant

Yes, Mr. White—add **fast checks on `pre-commit`** and **heavier checks on `pre-push`**. This stops bad PRs at the source without slowing you down.

### What to run where
- **pre-commit (fast, file-scoped):** format, eslint --fix, type-aware lint if quick.
- **pre-push (repo-scoped):** typecheck, unit tests, build (or a lightweight build smoke).

### Minimal setup (Husky + lint-staged + Vitest)
```bash
pnpm add -D husky lint-staged
pnpm dlx husky init
```

**package.json**
```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest --run",
    "build:smoke": "next build -n || vite build --emptyOutDir false"
  },
  "lint-staged": {
    "*.{ts,tsx,js,jsx}": ["eslint --fix"],
    "*.{md,css,json}": ["prettier --write"]
  }
}
```

**.husky/pre-commit**
```bash
#!/usr/bin/env sh
. "$(dirname "$0")/_/husky.sh"
pnpm lint-staged
```

**.husky/pre-push**
```bash
#!/usr/bin/env sh
. "$(dirname "$0")/_/husky.sh"
pnpm typecheck || exit 1
pnpm test:unit || exit 1
pnpm build:smoke || exit 1
```

### Monorepo speed-ups (optional)
- Use **turbo/nx** to run **only affected** packages: `turbo run typecheck test build --filter=...[HEAD^]`.
- Cache `node_modules` and `.turbo` in CI; keep hooks fast locally.

### Belt & suspenders
- Keep **required checks** in branch protection (lint, typecheck, unit, build) + **Merge Queue**.
- In agents: block PR creation if a local “smoke” (`pnpm typecheck && pnpm test:unit -t smoke`) fails.

Bottom line: **Yes, add hooks.** Fast fixes on commit, real gates on push. This will drastically reduce failing PR spam.

---

## User

Write a rule for codeine's rule file

---

## Assistant

Got it, Mr. White. Assuming by **Codeine** you mean your *code policy/rules engine* (similar to Rome, Biome, or custom YAML/JSON rulesets for enforcing lint/build/test gates), here’s how you’d express a rule that **blocks commits/PRs if lint, typecheck, or build fails**.  

---

### Example: `.codeine.yml`
```yaml
rules:
  # Run ESLint before allowing commit
  lint:
    run: "pnpm lint --max-warnings=0"
    stage: "pre-commit"
    fail_on_error: true

  # Run TypeScript typecheck before push
  typecheck:
    run: "pnpm typecheck"
    stage: "pre-push"
    fail_on_error: true

  # Smoke build before push (catch config/TS errors early)
  build:
    run: "pnpm build:smoke"
    stage: "pre-push"
    fail_on_error: true

  # Optional: Unit tests must pass before push
  unit-tests:
    run: "pnpm test:unit --run"
    stage: "pre-push"
    fail_on_error: true
```

---

### What this does
- **On commit:** only lint runs (fast, file-scoped).  
- **On push:** typecheck, smoke build, and unit tests must all pass.  
- If any fail → block the push and stop you from polluting PRs with broken code.  

---

Do you want me to **wire this into your existing Husky/lint-staged setup**, so Codeine + Git hooks are synced, or keep them separate (Codeine as the single source of truth)?

---

## User

codegen

---

## Assistant

Here’s a **Codeine** rule to orchestrate your **codegen** agent end-to-end and keep it safe.

```yaml
# .codeine.yml
rules:
  # 1) Auto-run codegen when a Linear issue gets the "codegen" label
  codegen_from_linear:
    when:
      - event: linear.issue_labeled
        label: codegen
    env:
      ISSUE_KEY: "${LINEAR.issueKey}"
      ISSUE_TITLE: "${LINEAR.title}"
    run:
      - "git checkout -b chore/codegen-${ISSUE_KEY}"
      - "codegen run --issue=${ISSUE_KEY} --no-prompt --apply"   # your agent/CLI
      - "pnpm lint --fix --max-warnings=0"
      - "pnpm typecheck"
      - "pnpm test:unit --run"
      - "pnpm build -n || vite build --emptyOutDir false"
    on_success:
      - "git add -A && git commit -m 'codegen: ${ISSUE_TITLE} (#${ISSUE_KEY})'"
      - "gh pr create --fill --label codegen --title 'codegen: ${ISSUE_TITLE}' --body 'Auto-generated by Codeine from Linear ${ISSUE_KEY}'"
      - "gh pr merge --auto --squash"   # relies on required checks + auto-merge
    on_failure:
      - "git restore -SW ."
      - "gh issue comment ${ISSUE_KEY} --body '❌ Codegen preflight failed (lint/type/tests/build). See CI logs.'"
      - "gh issue edit ${ISSUE_KEY} --add-label needs-human --remove-label codegen"

  # 2) Guardrails on PRs created by codegen
  guard_codegen_prs:
    when:
      - event: pull_request.opened
        label: codegen
    require_checks:
      - lint
      - typecheck
      - unit
      - build
    constraints:
      max_changed_files: 60
      require_tests_changed: true          # ensure tests updated/added
      forbidden_paths:
        - "infra/**"
        - ".github/workflows/**"           # no pipeline edits by codegen
    on_violation:
      - "gh pr comment $PR --body '⚠️ Policy: tests missing / too many files / forbidden paths touched.'"
      - "gh pr label $PR --add needs-human --remove codegen"
      - "gh pr close $PR"

  # 3) Optional: block PR creation if local smoke fails
  pre_pr_smoke:
    when:
      - event: local.pre_pr
    run:
      - "pnpm lint --max-warnings=0"
      - "pnpm typecheck"
      - "pnpm test:unit -t smoke --run || pnpm test:unit --run"
      - "pnpm build -n || vite build --emptyOutDir false"
    on_failure:
      - "exit 1"
```

**What this gives you**
- Label a Linear issue `codegen` → branch + codegen run → preflight checks → PR → **native auto-merge** once required checks pass.
- Hard guardrails: tests required, file-change limits, and no pipeline/infra edits by bots.
- Local smoke rule (optional) to stop junk PRs before they exist.

---

## User

Organization rules
Specify any additional rules you want the agent to follow across all repositories in this organization. These rules will be applied to all agent runs unless overridden by repository-specific rules.

---

## Assistant

Got it, Mr. White. Here’s a tight **org-wide Codeine rules** template you can drop in (e.g., `.codeine.org.yml`). Repo rules can override any block.

```yaml
# .codeine.org.yml
version: 1

defaults:
  env:
    NODE_VERSION: "20"
    MAX_PR_FILES: 60
    MAX_PR_LINES: 1500
    REQUIRED_CHECKS: [lint, typecheck, unit, build]
    ALLOWED_BOT_PATHS: ["apps/**", "packages/**", "src/**", "tests/**"]
    FORBIDDEN_BOT_PATHS: [
      ".github/workflows/**",
      "infra/**",
      "scripts/release/**",
      "supabase/migrations/**",
      "db/migrations/**"
    ]

policies:
  # 0) Global safety nets for all agent runs
  agent_global_sandbox:
    when: [{ event: agent.run }]
    run:
      - "node -v"
      - "pnpm -v || npm -v"
      - "git config --global user.name 'bot' && git config --global user.email bot@local"
    constraints:
      deny_network: false         # flip to true if needed
      allow_processes: ["node", "pnpm", "npm", "git", "bash"]
      max_runtime_minutes: 30
      max_disk_write_mb: 500
    on_violation: ["exit 1"]

  # 1) Pre-flight before any agent opens a PR
  pre_pr_guardrails:
    when: [{ event: agent.before_pr }]
    run:
      - "pnpm i --frozen-lockfile"
      - "pnpm lint --max-warnings=0"
      - "pnpm typecheck"
      - "pnpm test:unit --run"
      - "pnpm build -n || vite build --emptyOutDir false"
      - "git status --porcelain"
    constraints:
      require_clean_git: true
      require_tests_changed: true
      max_changed_files: "${MAX_PR_FILES}"
      max_changed_lines: "${MAX_PR_LINES}"
      allowed_paths: "${ALLOWED_BOT_PATHS}"
      forbidden_paths: "${FORBIDDEN_BOT_PATHS}"
    on_failure:
      - "codeine.comment '❌ Preflight failed (lint/type/tests/build or policy). Fix then retry.'"
      - "exit 1"

  # 2) Secret & license scanning on all agent diffs
  compliance_scan:
    when: [{ event: agent.before_pr }]
    run:
      - "gitleaks detect --no-banner --redact || true"
      - "license-checker --summary || true"
    on_failure:
      - "codeine.comment '🔒 Secret/license violation detected.'"
      - "exit 1"

  # 3) PR policy applied to every repo
  pr_policy:
    when: [{ event: pull_request.opened }, { event: pull_request.synchronize }]
    require_checks: "${REQUIRED_CHECKS}"
    constraints:
      max_changed_files: "${MAX_PR_FILES}"
      max_changed_lines: "${MAX_PR_LINES}"
      title_patterns:
        - "^(feat|fix|chore|docs|refactor|perf|test): "
      block_labels:
        - "do-not-merge"
        - "needs-human"
      forbid_draft_timeout_hours: 72
    on_violation:
      - "codeine.label add needs-human"
      - "codeine.comment '⚠️ PR violates org policy (size/title/labels/checks).'"
      - "codeine.block"

  # 4) Auto-merge policy (GitHub native merge queue + checks)
  auto_merge_gate:
    when: [{ event: pull_request.ready_for_review }]
    conditions:
      - "all_checks_green == true"
      - "has_required_reviews == true"
      - "labels ~ /automerge|safe-to-merge/"
      - "no_labels ~ /do-not-merge|needs-human/"
    actions:
      - "gh pr merge --auto --squash || true"

  # 5) Infrastructure & pipeline edits require human review
  infra_lockdown:
    when: [{ event: pull_request.opened }]
    paths: [".github/workflows/**", "infra/**", "scripts/release/**"]
    actions:
      - "codeine.require_human_review"
      - "codeine.label add needs-human"
      - "codeine.comment '🔧 Infra/pipeline changes require human approval.'"

  # 6) Schema/migration protocol
  db_migration_policy:
    when: [{ event: pull_request.opened }]
    paths: ["supabase/migrations/**", "db/migrations/**"]
    run:
      - "pnpm db:lint || true"
      - "pnpm test:migration:dryrun || true"
    constraints:
      require_docs_changes: ["docs/schema.md"]
      require_tests_changed: true
    on_violation:
      - "codeine.comment '🗄️ Migration needs docs + migration tests.'"
      - "codeine.block"

  # 7) Dependency bump bot guardrails
  deps_policy:
    when: [{ event: pull_request.opened, label: "deps" }]
    constraints:
      max_changed_files: 30
      forbid_major_bumps: true
    run:
      - "pnpm audit --audit-level=high || true"
      - "pnpm test:unit --run"
    on_violation:
      - "codeine.comment '📦 Dependency policy violation (major bump or too large).'"
      - "codeine.block"

  # 8) Runtime constraints for Edge/serverless targets
  edge_compat_check:
    when: [{ event: agent.before_pr }]
    run:
      - "pnpm run edge:scan || true"   # custom script: detect Node-only APIs
    on_failure:
      - "codeine.comment '🌐 Edge compatibility issues detected (Node APIs found).'"

  # 9) Observability thread (optional)
  observability_triage:
    when: [{ event: schedule.cron, cron: "*/30 * * * *" }]
    run:
      - "node tools/obs-summarize.js"   # Sentry/PostHog/logs → markdown
    actions:
      - "codeine.linear.create_issues from ./out/obs-findings.md label=observability"

  # 10) Cost guardrails for AI agents
  ai_cost_caps:
    when: [{ event: agent.run }]
    constraints:
      max_tokens: 400000    # per run
      disallow_models:
        - "extremely-expensive-model-vX"
    on_violation:
      - "codeine.comment '💸 Cost cap exceeded or model not allowed.'"
      - "exit 1"
```

**Notes**
- Keep **required checks** in GitHub branch protection matching `REQUIRED_CHECKS`.  
- Repos can override via `.codeine.yml` (same keys).  
- Wire your custom scripts (`db:lint`, `test:migration:dryrun`, `edge:scan`) gradually—stub with no-ops first.

Want me to tailor this to your current repo names/scripts so it runs without edits?

---

## User

It can be markdoc not yml like a claude or windsurf rule.

Just listen the smoke test requirements before opening a pr. But ensure it always opens a pr when done. Also mention ycombinator best practices, linear design inspiration, apple level ux polish and copywriting.

---

## Assistant

```markdoc
# rule: pre-pr-smoke-and-open-pr

## intent
Run a fast, deterministic **smoke test** before opening a PR. **Always open the PR** afterward (pass or fail) with a structured checklist so it can enter the Merge Queue when ready. Follow **Y Combinator best practices** (ship fast, small diffs, tighten feedback loops), take **Linear**-style design inspiration (clarity, minimalism), and aim for **Apple-level UX polish and copywriting** (concise, humane, on-brand).

## triggers
- on: linear.issue_labeled(codegen|ready) OR local.command("prepare-pr") OR vcs.branch_created("feat/*","fix/*","chore/*")

## env
- NODE_VERSION: 20
- PACKAGE_MANAGER: pnpm

## steps
1. checkout → new branch if needed  
2. install: `pnpm i --frozen-lockfile`  
3. **smoke-lint:** `pnpm lint --max-warnings=0`  
4. **smoke-types:** `pnpm typecheck`  // `tsc --noEmit`  
5. **smoke-tests:** `pnpm test:unit --run -t "smoke|happy|render"`  
6. **smoke-build:** `pnpm build -n || vite build --emptyOutDir false`  
7. **ui-snapshot (fast optional):** `pnpm story:build || true`  
8. summarize results → generate PR body

## policy
- Do **not** reformat large files beyond the change-set.
- Touch **no infra/pipeline** files (e.g., `.github/workflows/**`, `infra/**`) unless the issue explicitly requires it.
- Keep diffs **small & focused** (YC principle: ship in narrow slices).
- Prefer clear names, **no TODOs** without context.
- Copywriting: short, specific, benefit-oriented (Apple-level tone; no filler).

## failure-behavior
- If any smoke step fails, **still open the PR**.
- Add labels: `needs-human`, `smoke-failed`; remove `automerge`.
- Prepend ❌ status to PR title; include failing sections + logs summary in PR body.
- Never enable auto-merge on failed smoke; queue only after green.

## success-behavior
- Labels: `ready-for-review`, `automerge-candidate`.
- Title prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`.
- Auto-enable native **auto-merge** (squash) if required checks are green.

## pr-open
- always: true
- title: |
  {{ status_emoji }} {{ type_prefix }}{{ concise_title }}
- body: |
  ## Summary
  - **Why**: {{ problem_statement }}  
  - **What**: {{ solution_slice }}  
  - **Risk**: {{ risk_note }}  
  - **UX**: Apple-level polish target; copy trimmed for clarity.

  ## Smoke Result
  - Lint: {{ lint_status }}
  - Types: {{ types_status }}
  - Unit (smoke): {{ unit_status }}
  - Build (smoke): {{ build_status }}
  - Storybook (fast): {{ story_status }}

  ## Checklists (YC + Linear-inspired)
  - [ ] Small, reviewable diff (≤ ~300 LOC touched)
  - [ ] Clear, actionable acceptance criteria met
  - [ ] Tests updated/added for changed behavior
  - [ ] UX text is concise & on-brand (no filler)
  - [ ] Screens/flows avoid layout shift & spinners overlap
  - [ ] Public profile path stays <100ms p95 (no regressions)

  ## Notes for Reviewers
  - Logs/excerpts:  
    {{ short_logs }}
  - Follow-ups (if any): {{ followups }}

- labels-default: ["triage"]
- reviewers: ["@owner-or-codeowners"]

## outputs
- status_emoji: "✅" | "❌"
- type_prefix: infer from branch or commit scope
- concise_title: first line of issue title or commit subject

## post-open
- If ❌, post comment with actionable next steps and point to failing smoke stage/logs.
- If ✅, link issue → PR and move Linear ticket to "In Review".

```

**Notes for your agents**
- Treat this as the **org-wide** rule unless a repo overrides steps/commands.
- Keep the smoke set fast (<2–3 min). If it drags, reduce Storybook and run only tagged unit tests.
- The PR body’s checklist bakes in **YC best practices**, **Linear**-style clarity, and **Apple-level** polish/copy requirements.


## See Also
- [[chatgpt/chatgpt_ci-workflow-optimization]]
- [[chatgpt/chatgpt_actor-bio-optimization]]
- [[chatgpt/chatgpt_ai-operations-optimization]]
- [[chatgpt/chatgpt_ai-optimization-strategies]]
- [[chatgpt/chatgpt_angel-round-sheet-optimization]]
