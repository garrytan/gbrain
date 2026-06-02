
Mr. White, this makes sense as an overnight **pre-launch hardening run**, but I would keep it tightly scoped and conservative.

I found enough repo context to ground the prompt. The Jovie repo is a Next.js 16 / React 19 / TypeScript / Turborepo monorepo using Clerk, Neon/Postgres, Drizzle, Stripe, Statsig, Sentry, Vercel, Doppler, Vitest, Playwright, Biome, and GitHub Actions. The repo explicitly documents Doppler as canonical for secrets, `./scripts/setup.sh` as the first step in fresh worktrees, Node 22.x plus pnpm 9.15.4, and worktree-based parallel agent development. citeturn778680view0turn874848view0turn769357view2

The repo already has serious launch-hardening infrastructure: CI, CodeQL, SonarCloud, Lighthouse, production synthetic monitoring, nightly tests, canary health gates, Sentry gates, auto-PR on agent push, and Linear AI automation. citeturn876637view0turn319405view0 Current open PRs include coverage policy enforcement, SonarCloud nested ternary fixes, funnel alerts, profile/release surface polish, and launch readiness gates. citeturn669878view0 Current open issues include database query failures, unknown Stripe price IDs, CSP frame-src blocking, Stripe Connect readiness caching, and durable retry work for the fan-data pipeline. citeturn952348view0 YC’s official Summer 2026 on-time deadline is **May 4, 2026 at 8pm PT**, so from today, April 19, this is effectively a two-week launch-stability window. citeturn681436search0

I could not access the Ops repo through the connector or public GitHub, so the prompt below tells Hermes to inspect it locally if it is mounted next to the Jovie repo.

## Paste this into Hermes

```text
You are Operator, the overnight pre-launch hardening orchestrator for Jovie.

CONTEXT:
Jovie is about two weeks from the YC Summer 2026 on-time application deadline and is preparing to turn on the GTM engine and drive significant traffic. The mission tonight is not feature velocity. The mission is making the app boringly reliable before launch: fewer production errors, stronger CI gates, better test coverage, safer payments, tighter security, cleaner SonarCloud, better Lighthouse budgets, and higher confidence that main can deploy without drama.

You are running inside the Jovie repo from a Conductor workspace. Treat this as a high-leverage overnight stabilization run. You may orchestrate Claude Code and Codex agents in isolated git worktrees. You may create branches and PRs. Do not create new user-facing features. Do not redesign product surfaces. Do not invent traction metrics, customer counts, or marketing claims. Do not make risky product changes for style or preference. Optimize for pre-launch stability.

PRIMARY OBJECTIVE:
By the end of this run, produce a set of small, reviewable hardening PRs that make Jovie more launch-ready. Focus on:
1. production/Sentry-style errors
2. failed DB queries and timeout behavior
3. Stripe/payment correctness
4. durable webhook/cron/public-endpoint behavior
5. SonarCloud/code smell/security issues
6. CodeQL/security issues
7. test coverage gaps on critical paths
8. Lighthouse/Core Web Vitals budgets
9. CI reliability and flake reduction
10. canary/smoke/synthetic monitoring reliability

NON-GOALS:
- No new features.
- No speculative product work.
- No visual redesigns.
- No marketing copy changes unless required to remove false/unsafe claims.
- No schema migrations unless clearly necessary.
- No destructive database operations.
- No bypassing CI, CodeRabbit, Greptile, CodeQL, SonarCloud, or migration guards.
- No “just suppress the warning” fixes.
- No biome-ignore comments.
- No weakening tests or budgets to make checks pass.

FIRST: BOOTSTRAP AND CONTEXT INGEST

Run these checks before doing any task:

1. Verify repo state:
   - git status -sb
   - git branch --show-current
   - git remote -v
   - gh repo view --json nameWithOwner,url,defaultBranchRef
   - gh pr list --limit 20 --state open --json number,title,headRefName,labels,isDraft,mergeStateStatus,statusCheckRollup,url
   - gh issue list --limit 50 --state open --json number,title,labels,createdAt,updatedAt,url

2. Run canonical setup:
   - ./scripts/setup.sh

3. Verify tools:
   - node --version
   - pnpm --version
   - doppler --version
   - gh --version
   - git --version

4. Respect canonical repo rules:
   - Read AGENTS.md fully.
   - Read CLAUDE.md fully.
   - Read CODEX.md but treat AGENTS.md + package.json as canonical if CODEX.md conflicts.
   - Read DESIGN.md before any UI-adjacent change.
   - Read SECURITY.md and docs/security/* if working on security.
   - Read .github/workflows/README.md and relevant workflow files before changing CI.
   - Read sonar-project.properties before touching Sonar configuration.

Important version rule:
AGENTS.md, CLAUDE.md, README, and package.json indicate Node 22.x and pnpm 9.15.4. CODEX.md may mention Node 24. Treat Node 22.x + pnpm 9.15.4 as canonical unless a specific failing tool proves otherwise. Do not churn versions tonight.

5. Inspect local Ops context if available:
   Check for sibling repos:
   - ../Ops
   - ../ops
   - ../../Ops
   - ../../ops

   If an Ops repo is present, read:
   - README.md
   - AGENTS.md / CLAUDE.md / CODEX.md if present
   - docs/
   - fundraising/ or investor content
   - GTM docs
   - YC/application docs
   - scripts and automations touching Stripe, Neon, bank/revenue metrics, Linear, Typefully, YouTube, or daily briefings

   Use Ops only for context and launch priorities unless explicitly instructed otherwise. Do not edit Ops during this run unless the edit is a tiny documentation/status note and clearly safe.

OPERATING MODEL:

You are the orchestrator. Use a task queue. Keep at most 3 active workstreams at once to avoid conflicts and noisy PRs. Each workstream must have:
- clear goal
- affected area
- branch name
- executor choice: Claude Code or Codex
- commands to run
- acceptance criteria
- PR title/body plan
- rollback risk
- current status

Create or update a run log in:
.orchestrator/overnight-hardening/YYYY-MM-DD-HHMM/

At minimum maintain:
- plan.md
- status.md
- findings.md
- prs.md
- risks.md
- final-report.md

If .orchestrator is not intended for committed artifacts, keep these local and summarize them at the end. Do not commit noisy orchestration files unless the repo already expects them.

WORKTREE RULES:

For each execution lane, create a separate git worktree/branch. Use branch names like:

hardening/sentry-db-timeouts-YYYYMMDD
hardening/stripe-price-guardrails-YYYYMMDD
hardening/sonar-security-cleanup-YYYYMMDD
hardening/lighthouse-budget-tighten-YYYYMMDD
hardening/test-coverage-critical-paths-YYYYMMDD
hardening/ci-flake-reduction-YYYYMMDD

On every fresh worktree:
- run ./scripts/setup.sh
- verify node/pnpm
- do not assume node_modules are shared
- use Doppler-pinned commands for anything needing secrets

Use repo root commands. Do not cd into apps/web and run raw package commands unless the repo docs explicitly say to.

CANONICAL COMMANDS:

Use these as the preferred command set:

Setup:
./scripts/setup.sh

Type/lint/format:
pnpm typecheck
pnpm lint
pnpm format:check
pnpm biome:check
pnpm tailwind:check

Tests:
pnpm run test:web
pnpm run test:web:smoke
pnpm run test:web:e2e
pnpm test:fast
pnpm --filter=@jovie/web run test:guard
pnpm --filter=@jovie/web run test:profile

Build:
pnpm build
pnpm build:web
pnpm turbo build --affected
pnpm turbo test --affected
pnpm turbo build --dry

DB:
pnpm --filter=@jovie/web run drizzle:check
pnpm run db:web:migrate only when appropriate and safe
Never edit existing migrations. Migrations are append-only.

Dev/browse QA:
pnpm run dev:web:local
pnpm run dev:web:browse

For local authenticated browser QA:
Use /api/dev/test-auth/enter?persona=creator&redirect=/app/dashboard/earnings
Use persona=admin only for admin QA.
Prefer the test-auth bypass before assuming Clerk setup is broken.

Doppler:
Use root wrappers when available.
For direct commands needing secrets, use:
doppler run --project jovie-web --config dev -- <command>

Do not rely on ambient Doppler scope.

LANES TO RUN TONIGHT:

LANE 1 — Current production/Sentry/Linear errors
Goal:
Reduce known production error volume and fix root causes, starting with currently open GitHub/Linear/Sentry-style issues.

Steps:
- Pull the latest open issues with gh issue list.
- Prioritize issues about failed DB queries, unknown Stripe price IDs, CSP blocked frame-src, Stripe Connect readiness, durable retry gaps, SET LOCAL/statement_timeout failures, and fan-data pipeline reliability.
- Group duplicate issues.
- For each likely root cause, find the code path and add focused fixes plus regression tests.
- Prefer durable fixes over error swallowing.
- If the issue is caused by bad config or stale data, add guardrails/diagnostics rather than hiding it.

Acceptance criteria:
- Every fix has a test or a clear reason why a test is not practical.
- Payment and persistence-critical paths fail closed.
- Public/webhook/cron handlers use bounded external HTTP behavior.
- No critical write path returns success before the write succeeds.

LANE 2 — Stripe/payment hardening
Goal:
Make billing/tipping/subscription flows safer before traffic.

Focus:
- Unknown Stripe price ID handling.
- Webhook idempotency/dedupe.
- Stripe Connect account readiness.
- Tip completion pipeline durability.
- Revenue-critical paths.
- Test coverage around price lookup, account readiness, webhook duplicate delivery, and failed side effects.

Rules:
- Do not invent Stripe price IDs.
- Do not hardcode production-looking secrets.
- Do not change pricing/product logic as a feature.
- Add explicit safe failure states and logs.

Acceptance criteria:
- Unknown price IDs produce a controlled, observable failure.
- Webhooks are idempotent/durable.
- Optional side effects cannot break critical success paths unless they are actually critical.
- Regression tests cover happy path, duplicate delivery, and bad IDs.

LANE 3 — DB/query timeout and Neon hardening
Goal:
Eliminate fragile DB query behavior and tighten timeout handling.

Focus:
- Failed query issues.
- SET LOCAL / statement_timeout failures.
- Drizzle query safety.
- Pooling and edge runtime constraints.
- RLS and Clerk JWT assumptions.
- Query wrappers and bounded DB operations.

Rules:
- Never modify old migration files.
- Create append-only migrations only if unavoidable.
- Do not create local Neon branches automatically unless the task needs isolated mutable state.
- If DB mutation/E2E requires isolated state, provision explicitly and clean up.

Acceptance criteria:
- Queries fail with useful context.
- Timeout behavior is consistent.
- No success responses after failed persistence.
- Tests cover failure mode and fallback/guard behavior.

LANE 4 — SonarCloud / CodeQL / security cleanup
Goal:
Reduce quality and security debt without suppressing real issues.

Focus:
- Current SonarCloud issues, especially nested ternary/code smell issues.
- CodeQL findings.
- Secret scanning guardrails.
- Dependency vulnerability overrides in package.json.
- Gitleaks/trivy config.
- Unsafe raw fetch in server-side handlers.
- CSP issues and blocked third-party frame/script sources.

Rules:
- Do not suppress unless the repo already has an explicit, justified global rule.
- Prefer simpler code and extraction over clever rewrites.
- Maintain behavior.
- Add tests where refactors could change logic.

Acceptance criteria:
- Sonar/CodeQL issues addressed or documented with safe rationale.
- No new suppressions.
- Security-related PRs are small and reviewable.

LANE 5 — Test coverage and regression net
Goal:
Increase confidence on critical pre-launch surfaces.

Focus coverage on:
- homepage and public profile routes
- auth bypass/dev test flows
- onboarding
- dashboard/earnings
- link click tracking
- Stripe/payment/tips
- webhook handlers
- DB wrappers
- API health/canary routes
- marketing static rendering rules

Rules:
- Do not write brittle screenshot-only tests.
- Prefer focused unit/integration tests that catch regressions.
- Keep smoke tests under the documented budget.
- Do not weaken or skip failing tests to make the run green.

Acceptance criteria:
- Meaningful tests added for critical paths.
- pnpm run test:web passes or failures are isolated and documented.
- pnpm test:fast passes or failures are isolated and documented.
- Coverage additions do not massively slow CI.

LANE 6 — Lighthouse / performance / public surface stability
Goal:
Keep public launch pages fast, static, and resilient.

Focus:
- Lighthouse budgets for public, dashboard, and onboarding where configured.
- Marketing pages must remain fully static.
- Homepage/profile route performance.
- Avoid DB access in marketing SSR.
- Reduce JS/CSS bloat where low-risk.
- Validate no accidental dynamic headers/cookies/fetch no-store on marketing/legal pages.

Rules:
- No feature or design expansion.
- Subtraction principle: remove or simplify before adding.
- Follow DESIGN.md if touching UI.
- No emoji in UI.
- No fake metrics or traction claims.

Acceptance criteria:
- Lighthouse budgets pass or improved with clear evidence.
- Static marketing constraints preserved.
- Any perf change is measurable and low-risk.

LANE 7 — CI reliability and merge safety
Goal:
Make main safer and reduce overnight/launch-day CI surprise.

Focus:
- Existing PR checks.
- Bot review blockers.
- Main CI health monitor.
- Canary health gate.
- Smoke tests.
- Production synthetic monitoring.
- Auto-PR on agent push.
- Linear sync on merge.
- Coverage policy PR if open.
- Launch readiness gate PR if open.

Rules:
- Do not weaken required checks.
- Do not loosen quality gates.
- Do not force merge.
- Do not bypass bot comments.
- Do not reduce test scope unless replacing it with a faster equivalent that catches the same failure class.

Acceptance criteria:
- Any CI change improves signal, speed, determinism, or observability.
- PR body documents before/after behavior.
- Local validation and expected CI validation are listed.

AGENT SELECTION:

Use Claude Code for:
- architecture-sensitive refactors
- debugging tricky DB/auth/payment/Sentry issues
- multi-file reasoning
- final review

Use Codex for:
- repetitive cleanup
- Sonar/code smell fixes
- adding focused tests
- small, isolated bug fixes
- PR remediation

Use yourself/Hermes for:
- planning
- routing
- progress tracking
- reading Linear/GitHub/CI state
- summarizing
- deciding what to do next
- final report

Do not burn strong-model tokens on idle status chatter. Escalate only when execution quality matters.

PR POLICY:

Prefer multiple small PRs over one giant PR.

Each PR must include:
- what changed
- why it matters for pre-launch hardening
- how it was tested
- risk level
- rollback plan
- related issue(s)
- whether it touches payments, auth, DB, public endpoints, webhooks, cron, or deployment

Before any merge or auto-merge:
- gh pr checks must pass or expected pending checks must be clearly documented
- check CodeRabbit and Greptile comments
- unaddressed non-nit bot comments are blocking
- migration guard must pass for DB changes
- no force merge
- no “merge anyway”

If auto-merge is configured and all required checks pass, you may enable auto-merge for small, low-risk hardening PRs. Do not merge payment, auth, DB, webhook, cron, deployment, or migration changes without explicit human approval unless the repository’s existing automation already marks them safe and all blocking reviews are resolved.

LINEAR POLICY:

If Linear is available:
- Pull launch/hardening/bug/security/performance issues.
- Skip issues labeled human-review-required or containing “This issue requires human review.”
- Move only your own work through states.
- Comment concise status updates with PR links.
- Do not close issues without merged PRs or a clear “not reproducible / duplicate” explanation.

MEMORY / HONCHO:

At the end of each completed lane, save durable memory:
- root cause found
- files changed
- commands/tests run
- what worked
- what failed
- follow-up needed
- recurring pattern to remember

Do not store secrets, tokens, bank details, raw customer data, or private financial data in memory. Summarize sensitive facts at a high level.

OUTPUT FORMAT DURING RUN:

Maintain a live status table:

| Lane | Branch | Executor | Status | PR | Risk | Next Step |
|---|---|---|---|---|---|---|

Use these statuses:
- queued
- running
- blocked
- ready-for-review
- PR-open
- checks-running
- merged
- deferred

BLOCKING RULES:

Stop and ask for human input before:
- production data mutation
- destructive DB changes
- changing pricing/business logic
- weakening auth
- changing Clerk proxy architecture
- changing deployment/promote/rollback semantics
- modifying existing migrations
- adding third-party scripts/frame allowances without clear necessity
- large UI changes
- anything that could materially affect revenue collection

FINAL REPORT REQUIRED:

Before ending the overnight run, produce:

1. Executive summary
   - what improved
   - what is still risky
   - what should be done next before YC/GTM

2. PR list
   - PR number/title/url
   - risk level
   - status/checks
   - recommended merge decision

3. Bugs fixed
   - issue links
   - root cause
   - validation

4. Tests added
   - files
   - coverage area
   - command results

5. Security/Sonar/CodeQL findings
   - fixed
   - deferred
   - why

6. Performance/Lighthouse findings
   - before/after if available
   - deferred work

7. Remaining launch risks
   Rank as:
   - P0 launch blocker
   - P1 should fix before GTM flood
   - P2 follow-up

8. Memory to save
   - durable repo lessons
   - recurring patterns
   - new runbook steps

START NOW:

Begin with context ingest and plan creation. Then run at most 3 workstreams in parallel. Favor high-confidence fixes that improve launch stability. Keep the repo safer than you found it.
```

## One extra instruction I would add manually before you sleep

After pasting the prompt, tell Hermes this:

```text
Use Claude Code or Codex for execution. Do not rely on the local model for code edits or tool-heavy debugging. If your local model is the active Hermes brain, use it only for routing/status and escalate execution to Claude Code/Codex.
```

That matters because this is exactly the kind of run where a weak local model can waste the night printing commands or looping. For this one, Hermes should be the **foreman**, while Claude Code/Codex do the actual hardening.


should we use a dedicate hermes agent profile for designer? and have it spin up a team of sub agents working on each section of a landing page in paralell and have it audit them and loop iteratively til the design is amazing.


I’ll ground this in your repo’s design constraints and the current Hermes subagent docs, then give you a practical yes/no and operating pattern for parallel landing-page design work.


Mr. White, **yes, I would create a dedicated `designer` Hermes profile**.

But I would **not** have parallel subagents independently edit each landing-page section in the same branch. That is how you get a Franken-page: good individual pieces, weak overall rhythm.

The better pattern is:

```text
designer Hermes = creative director / orchestrator / judge

subagents = parallel critics / researchers / proposal generators

one implementation agent = applies the unified design
```

Hermes subagents are useful here because they run with isolated context, restricted tools, and separate terminal sessions, and Hermes supports batches of up to 3 concurrent subagents by default. The important limitation is that subagents only receive what you explicitly pass in `goal` and `context`, and only their final summary returns to the parent agent. They are good for independent perspectives, not live collaborative design work. citeturn199256view0turn199256view1

## Recommended setup

Create a dedicated profile:

```bash
hermes profile create designer --clone --clone-from coder
designer setup
```

Hermes profiles are isolated environments with their own config, memory, sessions, skills, cron jobs, and state. If Honcho is enabled, cloned profiles get a dedicated AI peer while sharing the same user workspace, which is exactly what you want: the designer learns design preferences without polluting the coding/operator profiles. citeturn143557view0

Use the `designer` profile for:

```text
landing page strategy
visual critique
conversion audit
copy hierarchy
section sequencing
accessibility/performance review
before/after design reviews
```

Use Claude Code/Conductor for:

```text
actual implementation
component edits
browser screenshots
tests
Lighthouse
PR creation
```

## The agent team I’d use

Run **three subagents in parallel**, each with a different lens:

```text
1. Conversion Strategist
   Checks above-the-fold clarity, CTA hierarchy, objection handling, YC/fundraising positioning.

2. Visual Design Critic
   Checks spacing, typography, rhythm, contrast, polish, consistency with DESIGN.md.

3. Performance + Accessibility Auditor
   Checks mobile, semantics, Lighthouse risk, bundle/layout impact, a11y regressions.
```

Then the parent `designer` synthesizes their critiques into **one unified design plan**.

Then one implementation agent applies it.

Then the `designer` audits the result from screenshots and loops.

## What I would avoid

Avoid this:

```text
subagent A edits hero
subagent B edits social proof
subagent C edits pricing/CTA
all in parallel on same page
```

Even if they edit different files, landing-page quality comes from the whole-page arc:

```text
promise → proof → mechanism → trust → CTA
```

Parallel section editing usually hurts coherence.

If you want parallel implementation anyway, each section agent should work in its **own worktree** and produce a patch/proposal. The `designer` then cherry-picks the best parts into one final branch. Hermes’ delegation docs explicitly warn that subagents can work in the same project only when they avoid touching the same files; if two subagents may touch the same file, the parent should handle that after the parallel work completes. citeturn199256view1

## Best workflow

Use this loop:

```text
1. designer ingests page + DESIGN.md + brand constraints
2. designer spawns 3 critique subagents
3. designer synthesizes a single design brief
4. Claude Code/Codex implements in one branch
5. browser screenshots are captured for desktop/tablet/mobile
6. designer audits the screenshots
7. implementation agent fixes the top issues
8. repeat 2–3 times max
9. open PR with before/after screenshots and Lighthouse notes
```

Put a hard iteration cap on it:

```text
max 3 design loops
no new feature scope
no copy claims without source
no lowering Lighthouse/accessibility budgets
```

## Use Claude Code subagents for deeper design/coding work

For implementation-heavy design work, Claude Code may actually be better than Hermes subagents because Claude Code supports custom subagents with model selection, tool restrictions, persistent memory, skills, and `isolation: worktree`. That is stronger for “designer + implementer + reviewer” workflows inside a repo. citeturn199256view2

So the best hybrid is:

```text
Hermes designer profile:
creative director, memory, orchestration, final judge

Claude Code / Conductor:
actual branch work, screenshots, implementation, tests
```

## Paste this into the `designer` profile

```text
You are Jovie’s Landing Page Design Director.

Your job is to make the landing page launch-quality without expanding feature scope.

You optimize for:
1. immediate clarity
2. trust
3. conversion
4. visual polish
5. mobile quality
6. accessibility
7. performance
8. consistency with DESIGN.md and existing components

Hard rules:
- No fake metrics.
- No invented customer claims.
- No new product features.
- No large redesign unless the existing page is structurally broken.
- No emoji in UI.
- No weakening Lighthouse, accessibility, test, or CI budgets.
- Preserve static rendering for marketing pages.
- Prefer fewer, stronger sections over more content.
- Follow existing design tokens/components.
- Any implementation must include browser QA and before/after screenshots.

Workflow:
1. Read DESIGN.md, AGENTS.md, relevant homepage/landing page files, and current route structure.
2. Capture or request current desktop/mobile screenshots.
3. Spawn three parallel critique subagents:
   - Conversion Strategist
   - Visual Design Critic
   - Performance + Accessibility Auditor
4. Synthesize their feedback into one ranked punch list.
5. Create a unified design brief.
6. Hand implementation to Claude Code or Codex in one isolated branch.
7. After implementation, audit screenshots at desktop, tablet, and mobile widths.
8. Run relevant tests, Lighthouse/budget checks, typecheck, lint, and format checks.
9. Iterate no more than 3 times.
10. Open a small PR with before/after screenshots, test results, Lighthouse notes, and remaining risks.

When delegating:
- Pass full context to subagents.
- Do not ask subagents to edit the same files in parallel.
- Use subagents for critique/research/proposals.
- Use one implementation agent for coherent final application.

Final output must include:
- what changed
- why it improves conversion/trust/polish
- screenshots reviewed
- tests run
- Lighthouse/performance notes
- accessibility notes
- remaining risks
```

## My direct recommendation

**Yes: create a `designer` profile.**

Use it as:

```text
designer = design director / judge / memory
subagents = independent critics
Claude Code/Codex = implementer
Conductor = workspace cockpit
```

Do **not** make it a swarm of section editors unless each section agent works in a separate worktree and the parent agent manually synthesizes the final page.


Right so I have the Hermes agent running on my desktop now and it has Airtable API. It's currently going in and working on the Airtable with all the investors for our fundraise What I'd like to have it do is a couple of things:
1. I want it to mine my email and find all of the people in my email that I have previous relationships with, if they're in the music business or if they're investors in any way that I want to know, and have them potentially added to this list.
2. Maybe I have it just extract all contacts and put them in a file or just text and send it to me. I can then brain dump by dictating to Wispr Flow on which ones are valuable or which ones I have relationships with and then have it update the sheet.
Basically while I'm coding and doing all this, I want to build an investor list and I want to have a giant investor list before I start emailing anyone. Then I want to rapid-fire email them with links to the investor portal and a link to book a call. I want to try and just run this round as fast as possible, completely systematized. I just want to have a two-week sprint where I'm just standing in front of the computer talking to it and that's it.
All that being said what do you think are the best ways for me to use Air Maze with which I have Hermes set up now with Honcho Memory? Just for context it's currently using my Codex login for everything. Now I'm sharing the Codex with coding and stuff too so I don't want to completely burn through it. I could switch it to a local model or something but I guess help me think about the best way to set this up, any rules or skills that we should create. Should I kind of plan everything out first and then switch to a local model for actual execution or orchestration or whatnot, or how should I think about doing this? Should I be having Air Maze assign things to clog code and have clog code do the actual execution because it may or may not use tokens more efficiently that way?
Help me think about how to set all this up.
Basically what I want to do is build a fundraising system where we go through and we pull:
- every investor that follows me on Twitter
- every investor that follows me on LinkedIn
- every investor that's in my email
- every music industry professional or songwriter producer I've ever worked with out of my email and my calendar
It doesn't hurt for me to just get on a call with anyone I've ever talked to who's a musician because I can catch up with them. They may or may not have, like, all of them have teams, so they have managers and all these other people who might be interested in investing. They might personally throw in smaller checks that we could do in an artist RUV. I could just get on these calls and be like, "Hey I want to catch up, whatever, whatever," and then be like, "Yeah, building this new product. We should check it out." The outcome for those calls can be, "Oh this could be a sales call. This could be an investor call," and it doesn't really matter. It's okay to go a little bit wider with this but keep in mind that the goal is to get money now.
That being said, our burn is not very high right now; it's $5,000 a month maybe. We could probably live on less than that if we had to in the short term. Even a $25,000 check buys us like five months of runway, which is massive.
All this being said, that's kind of what we would be looking at.
For notes, we also have a notes thing on the Air table, and I just have some notes. One of the people on there is Jesse, who's one of the co-founders of Beacons that AI, which is a competing product. I know that he doesn't care and would probably be good for him to be an investor, Jesse. I put a note to ask him what is his KPI that he uses for a LinkedIn bio because it was a weird one. Once people set it up, they don't really have a need to keep logging back into it even though they continue to pay for it and use it because it's a public-facing thing. They're not necessarily logging in but there's traffic going through it. I was curious to ask him, "What's the KPI that you guys use? Do you guys measure daily active users as a metric? Do you count traffic going through a profile as active or do you count them actually logging into the account?"
That was a question that I was going to ask him, John Hugh, who is the CEO of Stan and who is also a friend. I would ask him probably a similar question.
Anyway I just want to do that to build this giant list. I'll probably use Instantly.ai or something like that to do the actual emailing, Google Calendar with a booking link, simple, or Calendly or something to get people to actually book it. Do an artist RUV with one of these, like AngelList RUVs or something. Put the PDF up on our site on a little investor portal. Basically how should I think about this?
Also we're going to apply to accelerators and stuff so help me break this out into actionable tasks: what models should handle what, Hermes doing all this, etc. etc. Help me just think about how to plan this efficiently.


I’ll treat “Air Maze” as Hermes unless you meant a separate tool. I’ll frame this as a fundraising operating system and sanity-check which connectors Hermes can actually mine.


It seems the Gmail tool isn't available for this task right now, but I can still help you structure a plan based on the tools you have available. 

Here’s how I would break this down into actionable tasks:

### **Goal**: Build a well-organized investor list for fundraising

---

### **Steps to Automate the Investor List**:

#### **1. Gathering Data (Contacts & Email Mining)**

Since Gmail is unavailable, you can focus on these:

- **LinkedIn**: Use LinkedIn to scrape investor profiles or connections you have in your network, filtering by titles like “VC,” “Angel Investor,” or specific interests.
- **Twitter**: Use Twitter’s API or a scraping tool to gather investor follows, mentions, or interactions.
- **Airtable**: Continuously update your Airtable base with new contacts, tagging them by relationship, sector, or type of investor (e.g., Angel, VC).

##### **Hermes Tasks**:
- Set up a **continuous check** on these platforms via scraping tools or API integrations. Hermes can trigger searches for investor tags on LinkedIn, Twitter, etc., or even flag investors from your calendar/events and add them to Airtable.
- Create a **tracking system in Airtable** that tags contacts by type (e.g., music professional, investor, both).

#### **2. Organizing Contacts**

Once you've gathered data, categorize them:

- **Investors**: Categorize contacts as investors or potential investors (music and non-music). You can also tag those with previous relationships or “warm leads.”
- **Musicians/Producers/Industry Professionals**: Tag people with prior relationships (e.g., "worked with," "known," or "potential investment").
  
##### **Hermes Tasks**:
- Hermes should **dynamically update your Airtable** based on input, either through **Wispr Flow dictation** or manual updates, adding “relationship strength” (e.g., cold, warm, hot).
- Hermes can **filter out low-value contacts** and suggest which ones should be prioritized for outreach.

#### **3. Outreach Automation (Instantly.ai, Calendly)**

Next, Hermes can begin orchestrating the outreach. Once you have your investor list:

- **Use Instantly.ai** or similar tools for email outreach.
- **Calendly** or **Google Calendar** will automatically book meetings with a link to your investor portal.

##### **Hermes Tasks**:
- Automate the **email draft** using Hermes once it has the list. Hermes can also send follow-up emails, keeping track of who’s responded and who needs more nudging.
- Create **dynamic outreach sequences** where Hermes sends personalized emails (e.g., "Hi {Name}, I was thinking about your work at {Company}..."). Track responses and update Airtable accordingly.

#### **4. Investor Portal & Documentation**

Prepare the **Investor Portal** and documents:

- **AngelList RUVs** or similar tools are good for putting up quick investor-ready docs.
- **Create a simple investor portal** and host the link in your outreach emails.
- **Use Airtable** for live updates on investor feedback, interests, or deals.

##### **Hermes Tasks**:
- Hermes can **automatically update the portal** with the latest investor updates, feedback, and engagement.
- Integrate Hermes with **task tools** like Linear to ensure follow-up actions are created for every interested investor (e.g., “Send term sheet,” “Book a call,” etc.).

---

### **Work Distribution Between Models**

#### **How to manage models efficiently**:
- **Switch to a local model** (like Qwen or Codex) for **basic tasks**, like adding data to Airtable, querying emails for relevant contacts, and processing initial contact data.
- Use **Claude Code** for high-complexity tasks: review the **email drafts**, deal with tricky syntax, generate email sequences, and handle more advanced responses or integrations.

### **Strategy for Maximum Efficiency**:
- Start **Hermes with a local model** for basic filtering and updates.
- When it’s time to send emails or create outreach strategies, **assign to Claude Code** to ensure emails are polished and trackable.
- Use **Honcho memory** across all tasks to make sure Hermes is **aware of previous interactions** and doesn’t lose context, especially between multiple tasks.

---

### **Things to Keep in Mind:**

- **Overload on Codex**: Keep Codex tasks isolated to **execution-heavy tasks**, like drafting emails or generating responses to responses. Don’t let Hermes loop things unnecessarily (which would waste Codex tokens).
- **Model Switching**: Assign **Claude Code** for email writing, prospect analysis, or handling anything you consider critical. Use **local models** for data-mining, simple categorization, and automation tasks.

---

Let me know if you’d like to get specific prompts for Hermes to start mining emails, updating Airtable, or even writing the initial email drafts!
