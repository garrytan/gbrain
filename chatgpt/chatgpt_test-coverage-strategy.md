---
title: "Test Coverage Strategy"
type: note
created: 2026-05-10
updated: 2026-05-10
source: chatgpt-export
conversation_id: 6a010823-3460-83e8-89f8-d54eb64cafc4
message_count: 4
tags: [chatgpt, import, long-form]
---
# Test Coverage Strategy

> Conversation ID: 6a010823-3460-83e8-89f8-d54eb64cafc4
> Created: 2026-05-10T22:35:17Z
> Updated: 2026-05-10T23:39:20Z
> Messages: 4

---

## User

I just heard something that Gary Tan said, and it was like, basically, he's saying now, he's working with Jesus Agamotto and stuff, that you've got to get to 80-90% tests, or you just don't know what's going to happen. I think that's probably good advice. I'm not sure.

What do we think about me giving a prompt to CloudCorp right now that just says, "Look at the code base. Look at our test coverage. If it's not unique, 90%, get it to 80-90%"? What do we think about that? Is that something I should do? Is it going to be efficient? Should I use CodeCop or something else? How should I think about this? 

---

## Assistant

Mr. White, the high-level idea is correct. The naive implementation is dangerous.

“Get to 80–90% coverage” by itself often creates:
- Snapshot spam
- Brittle UI tests
- Mock-heavy nonsense
- Tests that assert implementation details
- Slower shipping
- False confidence

You can absolutely burn weeks and thousands of dollars of tokens generating garbage coverage.

The important distinction is:

> High-confidence coverage on critical paths
vs.
> High line coverage percentages

Those are not the same thing.

For Jovie specifically, I would optimize for:
- regression prevention
- autonomous agent safety
- refactor safety
- deploy confidence
- UX stability

not vanity percentages.

A better framing is:

## What actually matters

You want:
- near-100% coverage on core business logic
- high coverage on critical flows
- strong integration coverage
- E2E coverage on revenue + onboarding paths
- visual regression coverage on major UI surfaces
- type safety + runtime validation
- performance and jank regression detection

You do NOT need:
- 90% coverage on dumb UI wrappers
- exhaustive testing of Tailwind classes
- tests for trivial getters/setters
- massive mock pyramids

For a modern AI-first app, the real moat is:
- deterministic systems
- reproducible behavior
- safe autonomous shipping

Gary’s point is directionally correct because AI-generated code dramatically increases entropy. If agents are shipping constantly, weak tests become existential.

For your setup specifically — ROOTFLOW + GStack + autonomous agents — you need tests more than a normal startup does.

Because eventually:
- dozens of agents are touching code daily
- changes compound
- regressions become invisible
- velocity collapses without guardrails

So yes:
You should aggressively improve coverage.

But not with a blind “hit 90%” order.

Instead:

## Recommended strategy

### Phase 1 — Audit

Have Claude Code / Codex:
1. analyze current coverage
2. categorize by:
   - unit
   - integration
   - E2E
   - visual
3. identify:
   - untested critical paths
   - flaky tests
   - useless tests
   - duplicate tests
   - dead code
4. generate a risk map

This is the important step most people skip.

---

### Phase 2 — Prioritize by risk

Highest priority:
- auth
- onboarding
- billing
- AI chat orchestration
- release generation
- artist import
- fan alerts
- task execution
- DB mutations
- background jobs
- routing/state systems
- anything agent-touchable

Lower priority:
- presentational UI
- static marketing sections
- tiny utility wrappers

---

### Phase 3 — Establish testing architecture

You need layered testing:

#### Unit tests
Fast.
Pure logic only.

#### Integration tests
Most valuable layer for startups.

Test:
- DB + API + UI together
- server actions
- workflows
- mutations

#### E2E tests
Playwright.
Only for:
- mission critical flows
- happy path
- highest-value regressions

#### Visual regression
Very important for Jovie because your product quality bar is aesthetic and interaction-heavy.

Catch:
- layout shift
- overflow
- spacing regressions
- flicker
- skeleton mismatch
- dropdown bugs
- dark mode regressions

---

### Phase 4 — Enforce standards

Then establish hard rules:

PR cannot merge if:
- coverage decreases on touched files
- E2E fails
- visual regression fails
- Lighthouse budget regresses
- type coverage regresses
- new feature lacks tests

That is much more valuable than global 90%.

---

## Should you tell Claude Code to do this?

Yes.

But the prompt matters enormously.

Bad prompt:
> “Get coverage to 90%.”

Good prompt:
> “Audit the codebase and build a world-class risk-based testing strategy focused on autonomous shipping confidence, regression prevention, UX stability, and agent-safe iteration. Improve meaningful coverage toward 80–90% on critical systems while avoiding low-value or brittle tests. Prioritize integration tests over trivial unit coverage. Remove flaky or redundant tests. Add visual regression and E2E coverage for critical flows. Generate a coverage heatmap and risk report before modifying tests.”

That changes the outcome dramatically.

---

## Claude Code vs Codex vs others

For this specific task:

### Best overall
- urlClaude Codehttps://www.anthropic.com/claude-code

Reason:
- strongest large-scale repo understanding
- best architectural reasoning
- strongest at refactors + test planning
- good at Playwright
- good at integration thinking

### Best supporting stack
Use:
- Claude Code for orchestration/planning
- GPT-5/Codex for targeted implementation bursts
- GStack QA after every major change
- Playwright heavily

---

## One extremely important warning

If you unleash autonomous agents on coverage without constraints, they WILL:
- mock everything
- snapshot everything
- inflate metrics
- create thousands of fragile tests

You need explicit rules like:
- avoid implementation-detail assertions
- prefer behavior testing
- minimize mocks
- avoid snapshot spam
- avoid testing framework internals
- prefer integration over isolated component tests
- every test must protect a real regression scenario

Otherwise you get enterprise sludge.

---

## My actual recommendation for Jovie

Target:
- 85%+ meaningful coverage on critical systems
- 100% coverage on core business logic
- strong integration suite
- hardened Playwright suite
- visual regression coverage
- aggressive flake elimination

Do not chase raw global 90% immediately.

You are optimizing for:
- autonomous velocity
- safe iteration
- deploy confidence
- deterministic behavior

That is the real metric.

---

## User

Phase 0 complete. All 8 tasks done. Here's the wrap-up summary.

## Phase 0 Delivered

**Strategy document** (approved): `/Users/timwhite/.claude/plans/system-instruction-you-are-working-sleepy-wilkinson.md`

**New files (4):**
- `docs/TEST_RISK_REGISTER.md` — hand-curated taxonomy, 12 surfaces with YAML front-matter (blast/reversibility/visibility scores, target coverage, key line ranges)
- `docs/TEST_COVERAGE_HEATMAP.md` — auto-generated, ranked by risk score
- `scripts/audit-test-coverage.ts` — generator (~720 LOC TypeScript, runs via tsx, zero new deps)
- `.github/workflows/test-coverage-audit.yml` — nightly cron 06:00 UTC, lints clean via actionlint

**Modified files (4):**
- `apps/web/vitest.config.fast.mts` — `coverage.thresholds` scaffolding for critical globs (set to 0 in Phase 0, raised to register targets in Phase 2)
- `docs/TESTING_GUIDELINES.md` — new "Risk-Based Testing" section linking the heatmap
- `docs/CRON_REGISTRY.md` — new "GitHub Actions Schedule" section
- `package.json` — `test:coverage:report` + `test:coverage:diff` root scripts

## Baseline (today's coverage)

Overall: **59.9%** lines (42,707 / 71,265). Status: **6 RED, 5 YELLOW, 1 GREEN**.

Surprising finding: existing tests already touch most critical surfaces 60–85% — the gap is *which paths* are covered, not *whether* tests exist. Stripe webhooks already sit at 82.2% line / 82.4% branch despite having no dedicated test file. The right move shifts from "write from scratch" to "verify the right branches are hit" for several rows.

## Priority Queue (what to write next, in order)

1. **Webhook signatures** — 51.5% → 85% target (gap 33.5pp at risk 29.1)
2. **Entitlements registry** — 74.2% → 95% (legacy aliases `founding→pro`, `growth→max`)
3. **Investor portal token validation** — `proxy.ts:249-453`, 68.2% → 90%
4. **Clerk auth proxy routing** — `proxy.ts:1028-1402`, 68.2% → 85%
5. **Audience block + fingerprint** — `proxy.ts:97-246`, 68.2% → 85%

## Verified end-to-end
- `pnpm run test:coverage:report` regenerates the heatmap idempotently
- `pnpm run test:coverage:diff` returns exit 0 (no regression on RED surfaces vs snapshot)
- Stale-row detector working (no false positives)
- Workflow YAML clean (actionlint exit 0)
- Vitest config still parses with thresholds attached

## What's next (per the approved plan)
- Phase 1 (weeks 2–3): the 8 removal categories + top 10 critical test additions. The heatmap's priority queue is the order.
- Phase 2 (weeks 4–6): visual regression expansion to dashboard/billing, integration tier promoted to PR-gated, Stryker `break: 60`, vitest thresholds raised to register targets.

Nothing committed — files staged for your review. The first nightly run of `.github/workflows/test-coverage-audit.yml` will auto-refresh the heatmap once this lands on main.

---

## Assistant

This is legitimately strong. The important thing is that the output shows architectural thinking instead of “coverage farming.”

The biggest green flags:

- risk register exists
- blast radius scoring exists
- thresholds are scaffolded but not weaponized yet
- heatmap is generated automatically
- regression diffing exists
- nightly audit exists
- priority queue is branch-gap driven
- integration-heavy surfaces floated to the top naturally

That is how mature orgs do this.

The most important sentence in your update is this:

> “The gap is which paths are covered, not whether tests exist.”

That means your repo already has decent testing culture. You’re now entering the harder and more valuable phase:
- branch integrity
- edge cases
- regression-proofing
- auth hardening
- mutation resistance

That’s where real confidence comes from.

A few observations:

## 1. Your webhook finding is exactly what mature coverage audits uncover

82% line coverage with missing dedicated tests usually means:
- incidental coverage
- happy-path transit coverage
- weak negative-path guarantees

Meaning:
- signatures probably pass during broader flows
- replay attacks
- malformed payloads
- timestamp drift
- idempotency collisions
- body tampering
- duplicate event handling

may still be weak.

That’s why branch coverage matters more than line coverage for infra/security code.

Good prioritization.

---

## 2. Your proxy.ts concentration is a code smell

You have:
- investor portal token validation
- auth routing
- audience fingerprinting

all inside a massive proxy surface.

That file is becoming:
- high blast radius
- hard to reason about
- difficult for agents
- difficult for mutation testing

Long-term:
split by domain boundary.

Likely:
- auth proxy
- audience middleware
- investor portal middleware
- bot/fingerprint middleware
- entitlement resolution

Coverage work will expose architecture seams naturally.

Use this effort to identify extraction candidates.

---

## 3. The “thresholds at 0 first” move was correct

A lot of teams immediately:
- set hard gates
- break CI
- create resentment
- incentivize garbage tests

You avoided that.

Good sequencing:
1. observe
2. map
3. diff
4. stabilize
5. enforce

That is correct.

---

## 4. Your next major unlock is mutation testing

This is where fake confidence dies.

When you introduce:
- urlStryker Mutation Testinghttps://stryker-mutator.io/

you’ll discover:
- assertions that assert nothing
- tests that execute code but verify nothing meaningful
- dead branches
- fake mocks
- swallowed exceptions

For an AI-heavy codebase, mutation testing becomes extremely valuable because AI-generated tests often overfit implementation details.

A 60 mutation score target is a reasonable starting point.

---

## 5. Add flake tracking immediately

Before your suite grows further.

Track:
- retry counts
- duration variance
- intermittent failures
- browser-specific failures
- timeout hotspots

Because once agents start adding Playwright aggressively, flakes metastasize.

You want:
- flaky test quarantine
- automatic flake detection
- deterministic CI

early.

---

## 6. Visual regression is probably more important for Jovie than raw unit coverage

Because your differentiation is:
- polish
- motion
- interaction quality
- perceived performance
- premium feel

Meaning:
- layout shifts
- overflow
- hydration flicker
- skeleton mismatch
- animation jitter
- dropdown layering
- mobile viewport regressions

are existential product issues.

Most startups underinvest here.

You probably should:
- snapshot major app shells
- snapshot auth states
- snapshot loading states
- snapshot mobile breakpoints
- snapshot sidebar collapsed/expanded
- snapshot chat streaming states
- snapshot waveform/player states

Visual regressions will save you from agent entropy later.

---

## 7. Your next dangerous phase is test runtime explosion

Watch this carefully.

Most orgs accidentally reach:
- 20–40 minute CI
- serial Playwright bottlenecks
- duplicate integration coverage
- expensive E2E overuse

Your ideal pyramid is probably:
- 65% integration
- 25% unit
- 10% E2E

with visual regression orthogonal to that.

Avoid turning everything into Playwright.

---

## 8. I would absolutely land this

This is already beyond what most seed-stage startups have.

You now have:
- observability
- prioritization
- enforcement scaffolding
- automation hooks
- coverage economics
- regression intelligence

That materially changes how safely agents can operate.

You are transitioning from:
“AI coding experiments”
to:
“AI-governed software engineering system.”

That distinction matters a lot.


## See Also
- [[chatgpt/chatgpt_ci-unit-test-strategy]]
- [[chatgpt/chatgpt_test-element-selector-strategy]]
- [[chatgpt/chatgpt_integration-test-coverage]]
- [[chatgpt/chatgpt_test-coverage-for-atoms]]
- [[chatgpt/chatgpt_test-coverage-goal-design]]
