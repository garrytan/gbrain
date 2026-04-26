# GBrain Shippable Standard — Quality Criteria

This is the project's canonical quality bar. Every shipping change is checked
against these 6 gates before merge. Failures classified `blocking` halt the
ship; `warning` failures land but get tracked.

**Enforcement:** `bun run preship` chains two stages:

1. **Static gate scan** ... `scripts/check-shippable.sh` walks the 6 gates
   against the diff. Fast, local, no DB. Catches contract drift, empty
   catches, missing schema_version, raw SQL bypasses.
2. **E2E** ... `scripts/preship-e2e.sh` runs Tier 1 mechanical tests when
   feasible. Catches integration regressions (stale assertions, schema
   drift, real-DB behavior) that the static scan can't. Order of attempts:
     - DATABASE_URL set + reachable → run `bun run test:e2e` against it
     - Docker available + responsive → spin test container, run, tear down
     - Neither → SKIP loudly, exit 0 (CI is authoritative; do NOT merge red)

The static gate alone is not enough ... PRs #17-19 demonstrated this:
all three landed green-on-gate but red-on-E2E because the gate doesn't
exercise the migration runner. `bun run preship` is now a single
command that closes that loop locally when possible and surfaces the
gap loudly when it can't.

To run only the static gate (e.g., for a docs-only PR), use
`bun run preship:gate-only`. To force-skip E2E (cosmetic PRs only),
set `GBRAIN_PRESHIP_SKIP_E2E=1`. To turn the soft-skip into a hard
fail (CI environments), set `GBRAIN_PRESHIP_REQUIRE_E2E=1`.

The pre-ship skill (`skills/pre-ship-check/SKILL.md`) still walks the
gates as agent judgment for the categories the static scan can't decide
mechanically (PROOF, SCOPE, INTEGRATION-architectural). Wired into
`/ship`'s pre-landing review phase.

**Scope of checking:** gates run on lines ADDED in the current diff, not
on whole files. Pre-existing patterns in modified files are not the fork's
debt to fix in this PR ... they belong to whoever introduced them. Files
byte-identical to `upstream/master` are fully exempted (the fork inherits
upstream's quality, doesn't need to rewrite it). Override modes for
audit-style scans:
- `GBRAIN_SHIPPABLE_FULL_FILE=1` — flag every issue in changed files,
  not just newly-added lines (use when cleaning up inherited debt).
- `GBRAIN_NO_UPSTREAM_EXEMPT=1` — disable the upstream-byte-identical
  exemption (use for upstream-bound PRs where you DO want to clean up
  upstream patterns before submitting).

**Scope:** This file is the project-specific instance of the global Quality
Gate framework documented in `~/.claude/CLAUDE.md`. Gates here apply to
GBrain code (TypeScript engine, skills, scripts). Gate the bar, not the
journey — these answer "is it shippable?", not "is it perfect?"

---

## Category: CONTRACT (public API stability)
## Criteria:
  - Every public type that's part of an agent-consumable contract has a `schema_version: '<n>'` field. Agents need this to know when output shape changed.
  - Edge-case behavior for N=0, N>cap, missing input, malformed input is documented in the function/method header. If undocumented, the implicit answer is "undefined behavior" and reviewers reject.
  - Default values for cap/limit parameters are explicit, named constants (not magic numbers in the function body).
  - When changing a public interface, the change is breaking ONLY if no consumer would silently misbehave. Otherwise add a new field and deprecate the old.
## Severity: blocking
## Source: dream-cycle review 2026-04-24 (missing schema_version on PromotionReport, silent listPages limit:500 cap)
## Last triggered: 2026-04-24

---

## Category: IDEMPOTENCY (mutation safety)
## Criteria:
  - If this operation runs N times in a row, the resulting state equals running it once. State-mutating ops are keyed against duplicate writes (idempotency key, ON CONFLICT, hash-of-content lookup, or equivalent).
  - Re-running on already-processed input produces a no-op or a structured "already processed" response, not a duplicate row / appended block / re-fired side effect.
  - Migrations and bulk operations are resumable from interrupt — if killed mid-run, the next invocation picks up cleanly.
  - When idempotency is genuinely impossible (e.g. external API call without idempotency support), the docstring says so explicitly and the caller can opt out.
## Severity: blocking
## Source: dream-cycle review 2026-04-24 (naive `compiled_truth + semanticNote` re-appends on every cycle)
## Last triggered: 2026-04-24

---

## Category: OBSERVABILITY (visibility into what happened)
## Criteria:
  - Bulk operations (>1s typical runtime, or >100 items) stream progress through `src/core/progress.ts`. Silent multi-minute operations are forbidden.
  - Errors carry structured context: at minimum `{ class, code, message }`, plus `hint` and `docs_url` where applicable. No bare `throw new Error("string")` in agent-facing code paths.
  - Catch blocks are never empty. If you genuinely want to swallow an error, the comment above explains why and the swallowed error is at minimum logged at debug level. The pattern `} catch { /* skip */ }` is a code smell.
  - Audit-worthy operations (writes, mutations, external API calls) emit a JSONL audit trail line. Pattern follows `src/core/minions/shell-audit.ts`.
## Severity: blocking (empty catches), warning (missing progress on borderline-bulk ops)
## Source: dream-cycle review 2026-04-24 (silent 500-page scan, empty catch in collectEvidence)
## Last triggered: 2026-04-24

---

## Category: INTEGRATION (composes with existing primitives)
## Criteria:
  - New features reach into the project's documented primitives, they don't duplicate or bypass them. Specifically: brain reads/writes go through `BrainEngine`, maintenance phases compose into `runCycle` (`src/core/cycle.ts`), background work goes through Minions (`src/core/minions/`), and progress through `src/core/progress.ts`.
  - When the natural fit is "new phase in an existing pipeline," the change ADDS the phase, doesn't fork the pipeline.
  - Public APIs follow the Contract-First pattern: types defined in `src/core/operations.ts` or equivalent, then CLI + MCP both generated from that single source.
  - Trust boundary respected: `OperationContext.remote=true` callers are gated tighter than `remote=false` (CLI). Security-sensitive ops default to strict.
## Severity: blocking
## Source: dream-cycle review 2026-04-24 (added as sibling autopilot step instead of `phase: 'promotion'` in runCycle)
## Last triggered: 2026-04-24

---

## Category: PROOF (real-data validation)
## Criteria:
  - Has been run end-to-end against real production-shape data, not just unit-test fixtures. PR description names the data set or environment.
  - For brain operations specifically: dry-run on the Supabase brain (project `rlgonegzlxakquoiyzqq`), report numbers in PR. "Tested on real brain" without numbers is not enough.
  - For algorithms with thresholds, dials, or scoring: include the actual threshold-vs-output curve from real data. If the default settings produce zero useful output on a real brain, the algorithm is wrong.
  - For mutations: ran with `--dry-run` first, verified the proposed mutation list looks sane, then ran without dry-run on a non-production target if such exists.
## Severity: blocking
## Source: dream-cycle review 2026-04-24 (live dry-run returned 0 promotables — exact-text grouping fails on real brain)
## Last triggered: 2026-04-24

---

## Category: SCOPE (docs match reality)
## Criteria:
  - Function/module docstrings describe what the code actually does, not what we hope it does. Aspirational docs are technical debt.
  - Claims about security, performance, or completeness are honestly bounded. "Best-effort regex filter for phone numbers and SSN-shaped strings" not "PHI detection."
  - When something is a known limitation (won't scale past N, doesn't handle case Y), the docstring says so. Surfacing limitations costs nothing; hiding them costs trust.
  - Anti-patterns and "do not use this for X" are documented in the SKILL.md / module header, not buried in code review history.
## Severity: warning
## Source: dream-cycle review 2026-04-24 ("PHI detection" claim from 5 regex patterns is over-claiming)
## Last triggered: 2026-04-24

---

## Maintenance

Per `~/.claude/CLAUDE.md` Quality Gate rules:
- Criteria that catch a real issue: update `Last triggered` to today's date.
- Criteria triggered 3+ times: promote severity warning → blocking, OR mark "always check" in the gate-runner.
- Criteria never triggered after 10+ evaluations: surface for pruning. Don't keep dead gates.
- New failure pattern found in production: add a new gate or extend an existing one. Cite the incident in `Source`.

When gates change, also update `skills/pre-ship-check/SKILL.md` so the runner reflects the current bar.
