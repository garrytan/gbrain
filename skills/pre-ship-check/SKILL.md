---
name: pre-ship-check
version: 1.0.0
description: |
  Walk a diff through the 6 Shippable Standard quality gates (CONTRACT, IDEMPOTENCY,
  OBSERVABILITY, INTEGRATION, PROOF, SCOPE) defined in quality/criteria.md.
  Combines automated grep-based checks with agent judgment for gates that
  require context. Invoke before /ship to catch blocking-severity failures
  early. Returns exit 1 on any blocking finding.
triggers:
  - "pre-ship check"
  - "shippable check"
  - "ready to ship"
  - "quality gate"
  - "before I ship"
  - "is this shippable"
  - "shippable standard"
tools:
  - shell
mutating: false
---

# Pre-Ship Check — Shippable Standard

> **Source of truth:** [quality/criteria.md](../../quality/criteria.md). The gate definitions live there. This skill is the runner.
> **When invoked:** before `/ship`, before opening a PR, or when the agent/user wants a sanity check. NOT yet auto-wired into the ship workflow ... that is a follow-up. Today, the agent is responsible for invoking this skill. Run `bun run preship` from CLI for the same check.

## Contract

This skill guarantees:
- Every gate in `quality/criteria.md` is evaluated against the current diff.
- Each gate produces a structured finding: `{ gate, severity, file:line, evidence, fix_hint }`.
- Blocking-severity failures HALT the ship workflow; warning-severity failures land but get logged.
- The output is BOTH a human-readable report (for the user) AND a JSON envelope (for the ship workflow to consume).
- Re-running the skill on the same diff produces the same findings (deterministic — gates that need agent judgment use temperature 0 prompts).

## Phases

### 1. Identify the diff

```bash
# Default: diff vs base branch (master)
git diff master...HEAD --name-only > /tmp/preship-changed.txt

# Or against an explicit base
git diff <base>...HEAD --name-only > /tmp/preship-changed.txt
```

If the changed-files list is empty, exit 0 with `{ status: 'no_changes' }`. Nothing to check.

### 2. Run automated gate checks

Invoke `scripts/check-shippable.sh` against the changed-files list. This handles the gates that can be reduced to grep/AST patterns:

| Gate | Automated check |
|---|---|
| CONTRACT | grep TypeScript files for new exported `interface .*Report` types missing `schema_version:` |
| OBSERVABILITY | grep for empty catch blocks: `catch\s*(\([^)]*\))?\s*\{\s*\}` and trivial-skip patterns |
| OBSERVABILITY | grep for bulk file ops (>100 iter loops over pages/files) without `createProgress` import |
| INTEGRATION | grep for raw SQL strings outside engine implementations (engine bypass smell) |

Output: `/tmp/preship-automated.json` with one line per finding.

### 3. Walk the judgment gates

For gates that need context (PROOF, SCOPE, INTEGRATION-architectural-fit, IDEMPOTENCY-semantic), examine the diff and PR description. Apply each gate's criteria from `quality/criteria.md`:

- **CONTRACT — edge cases documented?** Read changed function/method headers; do docstrings name N=0, N>cap, malformed input behaviors? Flag undocumented surfaces.
- **IDEMPOTENCY — duplicate-safe?** Trace mutating ops in the diff; is there an idempotency key, ON CONFLICT, content-hash lookup, or other dedup mechanism? Flag naive append/insert.
- **INTEGRATION — composes vs duplicates?** For new feature code, identify which existing primitive it should compose into (BrainEngine, runCycle, Minions, progress.ts). Flag bypasses.
- **PROOF — real-data evidence?** Read the PR description. Does it cite real-data validation with numbers (page counts, scores, timing)? Flag "tested on real brain" claims without numbers.
- **SCOPE — claims honest?** Read changed docstrings. Are claims about security/performance/completeness honest about their limits? Flag aspirational documentation.

Use temperature 0 for each judgment so re-runs produce the same findings.

### 4. Produce the report

Combine automated + judgment findings into a single structured envelope:

```json
{
  "schema_version": "1",
  "status": "blocked" | "warnings_only" | "clean" | "no_changes",
  "gates_evaluated": ["CONTRACT", "IDEMPOTENCY", "OBSERVABILITY", "INTEGRATION", "PROOF", "SCOPE"],
  "blocking_count": <int>,
  "warning_count": <int>,
  "findings": [
    {
      "gate": "OBSERVABILITY",
      "severity": "blocking",
      "file": "src/core/promotion.ts",
      "line": 149,
      "evidence": "} catch { /* skip pages with broken timelines */ }",
      "fix_hint": "Replace empty catch with structured logging. Pattern: catch (e) { console.warn('[collectEvidence] skipping page %s: %s', page.slug, errMessage(e)); }"
    }
  ]
}
```

Also produce a human-readable Markdown summary alongside.

### 5. Exit code + ship-workflow contract

- `exit 0` if `status` is `clean`, `warnings_only`, or `no_changes`.
- `exit 1` if `status` is `blocked` (any blocking finding present).
- Print the JSON envelope to stdout (machine-readable), the Markdown summary to stderr (human-readable). Stdout/stderr split matches `progress.ts` convention.

`/ship` reads stdout; on `exit 1`, /ship halts with the findings list and instructs the user (or another agent) to fix.

## Output Format

### Human-readable (stderr)

```markdown
## Pre-Ship Check — <branch> vs <base>

**Status: BLOCKED** (2 blocking, 1 warning)

### Blocking findings

#### OBSERVABILITY: empty catch block at src/core/promotion.ts:149
Evidence: `} catch { /* skip pages with broken timelines */ }`
Fix: Replace with structured logging. Pattern: `catch (e) { console.warn('...', errMessage(e)); }`

#### INTEGRATION: bypasses runCycle at src/commands/autopilot.ts:342
Evidence: dream-cycle added as sibling step in autopilot, not as a phase inside runCycle
Fix: Move to src/core/cycle.ts as `phase: 'promotion'`. See quality/criteria.md INTEGRATION gate.

### Warnings

#### SCOPE: over-claims at src/core/promotion.ts:80
Evidence: `looksLikePhi` claims "PHI detection" with 5 regex patterns
Fix: Rename to `looksLikePhiOrSensitive` and scope docstring: "best-effort regex filter for phone/SSN-shaped strings, NOT a HIPAA control"
```

### Machine-readable (stdout)

The JSON envelope from Phase 4. Stable schema (`schema_version: '1'`).

## Anti-Patterns

- Running this skill AFTER ship instead of before. Pre-ship check is a gate, not an audit. Land-then-check defeats the purpose.
- Manually overriding blocking findings without changing the gate criteria first. If a finding is genuinely a false positive, fix the gate (in `quality/criteria.md` AND this skill's logic) before bypassing.
- Adding new gates without updating `quality/criteria.md`. The criteria file is the source of truth; the skill is the runner.
- Treating warnings as ignorable forever. Warnings triggered 3+ times should be promoted to blocking (per the Maintenance section in `quality/criteria.md`).
- Running the skill in CI but not in `/ship`. Both should invoke it; CI catches things that escape pre-ship.

## Tools Used

- `shell` — runs `git diff`, `scripts/check-shippable.sh`, and emits the structured report.
- (none from gbrain operations.ts — this skill is a pre-merge gate, not a brain operation)

## See also

- [quality/criteria.md](../../quality/criteria.md) — the gate definitions (source of truth)
- [scripts/check-shippable.sh](../../scripts/check-shippable.sh) — automated gate checks
- `~/.claude/CLAUDE.md` Quality Gate section — the global framework this skill instantiates for GBrain
