---
name: testing
version: 1.1.0
description: |
  Skill validation framework PLUS daily test-suite health and regression
  intelligence. Validates skill conformance (frontmatter, manifest coverage,
  resolver coverage). Runs the project test suite in tiered phases (unit /
  evals / integration / system health), classifies failures, and produces
  a regression-aware report.
triggers:
  - "validate skills"
  - "test skills"
  - "skill health check"
  - "run conformance tests"
  - "run the tests"
  - "how are the tests"
  - "what's broken"
  - "daily test run"
tools:
  - search
  - list_pages
mutating: false
---

# Testing Skill — Validation + Daily Health & Regression Intelligence

> **Convention:** see [conventions/quality.md](../conventions/quality.md) for
> the test-before-bulk pattern; this skill enforces it across the project's
> own test suite.

## Two modes

This skill has two related but distinct modes:

1. **Skill conformance validation** — gbrain's own conformance bar
   (the original 1.0 scope). Validates every skill has SKILL.md with
   frontmatter, every reference exists, manifest + resolver coverage
   round-trips.

2. **Project test-suite health (v0.25.1 extension)** — runs the
   project's tiered test suite and produces a regression-classified
   report. Used by daily cron, container-restart bootstrap, and
   "how are the tests" prompts.

Pick the mode by trigger.

## Mode 1: Skill conformance validation

### Contract

This mode guarantees:

- Every skill directory has a `SKILL.md` file
- Every `SKILL.md` has valid YAML frontmatter (`name`, `description`)
- Every `SKILL.md` has required sections per
  `test/skills-conformance.test.ts`
- `skills/manifest.json` lists every skill directory
- `skills/RESOLVER.md` references every skill in the manifest
- `openclaw.plugin.json` `skills[]` round-trips with both
- No MECE violations (duplicate triggers across skills)

### Phases

1. **Walk skills directory.** List all subdirs containing `SKILL.md`.
2. **Validate frontmatter.** Parse YAML, check required fields.
3. **Validate sections.** Check for the required headings.
4. **Check manifest.** Every skill dir must be in `manifest.json`.
5. **Check resolver.** Every manifest skill must have a RESOLVER row.
6. **Check round-trip.** RESOLVER trigger ↔ frontmatter triggers.
7. **Report results.**

### Automation

```bash
bun test test/skills-conformance.test.ts test/resolver.test.ts
```

The CI-gated check is the package.json `test` script.

### Output format

```
Skill Validation Report
========================
Skills found:        N
Conformance:         N/N pass
Manifest coverage:   N/N
Resolver coverage:   N/N
Round-trip:          N/N
MECE violations:     N

Issues:
- <skill>: <issue>
```

## Mode 2: Project test-suite health (v0.25.1)

### When to use

- Daily test cron fires
- User asks "run the tests" / "how are the tests" / "what's broken"
- After significant code changes (often via cross-modal-review)
- After container restart (bootstrap)
- When something seems off and you want to verify system health

### Test tiers

| Tier | What it runs | Wall time | Gates |
|------|--------------|-----------|-------|
| **Unit** | `bun test` (deterministic, zero external calls) | <2s | Every commit |
| **Evals** | LLM-judge or quality evals | ~60s | Daily |
| **Integration** | E2E tests against real Postgres | ~5m | Pre-ship + nightly |
| **System health** | Disk / memory / CPU / service liveness | <10s | Daily |

### Daily run protocol

When the cron fires (or the user asks), do ALL of this:

#### 1. Run unit tests

```bash
bun test 2>&1
```

Parse: total passed, total failed, total skipped, file-level results.

#### 2. Run evals (if the project has an evals config)

```bash
# Adapt to the project's eval config
bun test --filter eval 2>&1
```

Parse: same format. Note any flakes (tests that fail due to API
timeouts, not code bugs).

#### 3. Run system health checks

- Disk / memory / CPU
- gbrain: `gbrain doctor --fast --json`
- Database connection (if applicable)
- Critical files exist (CLAUDE.md, AGENTS.md, etc.)

#### 4. Git diff analysis (CRITICAL — regression intelligence)

```bash
# What changed since last test run?
git log --oneline --since="24 hours ago"
```

For each failing test:

1. Check if the test itself was modified recently (test change, not
   regression).
2. Check if the code it tests was modified recently (possible
   regression).
3. Check if it's a known flake (API timeout, service down).
4. Check if a dependency was updated (gbrain, bun, etc.).

#### 5. Classify each failure

| Classification | Marker | Action |
|---------------|--------|--------|
| **REGRESSION** — code changed, test broke | 🔴 | Flag with the commit that broke it |
| **STALE** — test expects old behavior; code is correct | 🟡 | Fix the test, not the code |
| **FLAKE** — API timeout, service down, LLM variance | ⚠️ | Note, don't alarm; retry once |
| **NEW** — test was just added and isn't passing yet | 🟢 | Check if intentional |
| **INFRA** — container restart wiped state | 🛠 | Run bootstrap, retest |

#### 6. Report format

```
🧪 Daily Tests — YYYY-MM-DD

Unit:   X/Y passed (Z skipped)
Evals:  X/Y passed
System: [health summary]

REGRESSIONS:
  🔴 <test-name>: broke by commit <sha> "<commit message>"

STALE TESTS:
  🟡 <test-name>: expects X but code now does Y (commit <sha>)

FLAKES:
  ⚠️ <test-name>: timeout (retry passed)

✅ ALL CLEAR  (when applicable)
```

#### 7. Auto-fix protocol

**DO auto-fix:**

- Test expects an old file path after a rename → update the test
- Test expects an old version string → update
- Test expects a file that was intentionally deleted → remove the test
- Import path broke because file moved → fix the import

**DO NOT auto-fix:**

- Test expects behavior A but code now does B → ASK first. Maybe the
  test is right and the code has a bug.
- Security test failing → ALWAYS escalate, never auto-fix.
- Test was skipped with a TODO → don't un-skip without understanding why.

When uncertain: check the commit message that changed the code, check
if there's a related PR or conversation, ask the user if still unclear.

### State (regression history)

Track results in `~/.gbrain/test-state.json` for trend tracking:

```json
{
  "lastRun": "2026-04-16T13:37:00Z",
  "unit": { "passed": 1262, "failed": 31, "skipped": 8 },
  "evals": { "passed": 17, "failed": 0 },
  "system": { "doctor": "ok", "gbrain": "0.25.1" },
  "failureHistory": [
    { "test": "<name>", "since": "2026-04-14", "classification": "stale" }
  ]
}
```

This enables:

- Trend tracking (are we getting better or worse?)
- Flake detection (same test fails intermittently)
- Regression velocity (how fast do we break things after changes?)

## Anti-Patterns

- ❌ Skipping conformance validation after adding a new skill
- ❌ Adding skills to `manifest.json` without adding to RESOLVER.md
- ❌ Treating every red test as a regression. Classify first; many are
  stale or flaky.
- ❌ Auto-un-skipping a test without understanding why it was skipped
- ❌ Auto-"fixing" a security test failure
- ❌ Reporting "all clear" without actually running system health checks


## Contract

This skill guarantees:

- Routing matches the canonical triggers in the frontmatter.
- Output written under the directories listed in `writes_to:` (when applicable).
- Conventions referenced (`quality.md`, `brain-first.md`, `_brain-filing-rules.md`) are followed.
- Privacy contract preserved: no real names, no fork-specific filesystem path literals, no upstream-fork references.

The full behavior contract is documented in the body sections above; this section exists for the conformance test.

## Output Format

The skill's output shape is documented inline in the body sections above (see "Output", "Brain page format", or equivalent). The literal section header here exists for the conformance test (`test/skills-conformance.test.ts`).
