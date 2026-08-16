# Convention: calibration loop (v0.36.1.0)

The brain knows your track record and uses it. The calibration loop has
five concrete touchpoints — agents working in this codebase should know
which one applies to their current task.

## Touchpoints

| When you're working on... | Apply this |
|---|---|
| Adding a new advice surface where the brain tells the user something | Voice-gate the output via `gateVoice()` in `src/core/calibration/voice-gate.ts`. Pick a mode: `pattern_statement`, `nudge`, `forecast_blurb`, `dashboard_caption`, `morning_pulse`. Add a new mode only when none of the five fits — extend `VOICE_GATE_MODES` and `DEFAULT_RUBRICS`. |
| Writing user-facing strings about the user's track record | Conversational, not academic. Friend, not doctor. Concrete numbers ("2 of 3 missed") over abstract metrics ("Brier 0.31"). See `DESIGN.md` voice section. Never use the phrase "according to your data." |
| Adding a new cycle phase | Extend `BaseCyclePhase` in `src/core/cycle/base-phase.ts`. Inherits source-scope threading + budget metering + error envelope + progress reporter. Declare `budgetUsdKey` + `budgetUsdDefault`. |
| Adding a new MCP op that reads source-scoped data | Route through `sourceScopeOpts(ctx)` from `src/core/operations.ts`. Type-enforced at the BaseCyclePhase level; manual MCP handlers should do this explicitly. |
| Writing schema for any new calibration-related table | Stamp every row with `wave_version TEXT NOT NULL DEFAULT 'v0.36.1.0'` (or the current wave's version). The `--undo-wave` command reverses precisely by wave_version. |
| Adding a new test fixture page under `test/fixtures/calibration/` | Synthetic only. Use the canonical placeholder names: `alice-example`, `acme-example`, `widget-co`, `fund-a/b/c`, `meetings/2026-04-03`. The CI guard `scripts/check-synthetic-corpus-privacy.sh` catches violations. |

## When to surface a calibration warning

The four doctor checks (in `src/commands/doctor.ts`):

- `abandoned_threads` — informational. Count of high-conviction takes
  (weight >= 0.7) older than 12 months that haven't been superseded or
  linked to a follow-up. Always status='ok' with a count.

- `calibration_freshness` — warns when the active profile is older than
  7 days. Hint: `gbrain calibration --regenerate`.

- `grade_confidence_drift` (CDX-11 mitigation) — placeholder for the
  v0.37+ confidence-vs-accuracy correlation math. v0.36.1.0 reports the
  count of auto-applied verdicts and the "drift math arrives in v0.37+"
  status. Don't add a noise threshold here until the math is in.

- `voice_gate_health` — warns when voice gate failure rate >= 30% over
  the last 7 days. Hint: review `src/core/calibration/voice-gate.ts`
  rubric.

## Auto-resolve posture

Auto-resolve is DISABLED by default (D17). Operator flips it on via
`cycle.grade_takes.auto_resolve.enabled: true` once they trust the
judge's verdicts. Thresholds:

- Single-model path: confidence >= 0.95
- Ensemble path: 3/3 unanimous AND min confidence >= 0.85
- 'unresolvable' verdict NEVER auto-applies even at confidence=1.0

These are MONOTONIC TIGHTENING ONLY. The config schema rejects attempts
to LOWER an active threshold without an explicit `--allow-loosen-confidence`
flag — because relaxing after data accumulates silently shifts which
historical resolutions count as auto-applied.

## Cross-brain semantics (D18)

For any read of a calibration profile across mounted brains:

1. **Local first.** Query local. If local has it, return; do not query mounts.
2. **Mount fallback.** Only if local is empty AND `canReadMountsForCtx(ctx)`
   returns true. Mount-side rows must have `published=true`.
3. **Cross-brain attribution.** Returned profile carries
   `source_brain_id` + `from_mount`. UI consumers MUST surface
   "from mounted brain: X" so the user knows.
4. **Subagent prohibition.** `ctx.viaSubagent && !allowedSlugPrefixes`
   cannot read mounts — subagent loops see only the local brain. Trusted-
   workspace cycle phases (synthesize/patterns) pass
   `allowedSlugPrefixes` set and ARE allowed.

## Test seams

Every calibration module accepts test injection via opts:
- `opts.judge` / `opts.thinkRunner` / `opts.extractor` / `opts.evidenceRetriever`
- `opts.voiceGateJudge` — bypass the Haiku call
- `opts.preferenceResolver` — bypass the interactive prompt in A/B harness

Tests MUST use these seams. Never call gateway.chat directly from a
calibration unit test — that's a test-isolation R2 violation (mocks the
gateway module via `mock.module`, which leaks across files in the shard
process).

## Bug class to avoid

The v0.34.1 source-isolation leak class is the canonical bug pattern
the calibration wave has structural defense against:

- BaseCyclePhase enforces `sourceScopeOpts(ctx)` threading at the type level.
- Every new schema table has `source_id NOT NULL REFERENCES sources(id)`.
- Cross-brain reads route through `canReadMountsForCtx()` classifier.
- Tests pin all 4 D18 rules in `test/cross-brain-calibration.test.ts`.

If you find yourself writing a `ctx.engine.executeRaw(...)` inside a
calibration module that doesn't pass `sourceScopeOpts`, you've found
the bug. Stop, route through the helper.
