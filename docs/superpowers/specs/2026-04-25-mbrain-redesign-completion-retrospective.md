# MBrain Redesign Completion Retrospective

## Scope

This retrospective closes the current redesign implementation boundary. The
goal was not to finish every possible product extension; it was to make the
brain-agent loop observable, typed, scenario-tested, and safe enough that future
work can build on a measured system instead of an implicit protocol.

## Completed PRs

| PR | Merge | Branch | Result |
|---|---|---|---|
| #38 | `5d336f3` | `sprint-1.0-interaction-identity` | Made agent turns first-class by allowing task-less retrieval traces and attaching `interaction_id` to governance event rows. |
| #39 | `ce44c65` | `postgres-jsonb-correctness` | Repaired Postgres JSONB persistence and legacy scalar-string behavior. |
| #40 | `6301eb6` | `sprint-1.1-trace-fidelity` | Added structured trace-fidelity fields for intent, scope gate, derived consultation, and write outcome. |
| #41 | `57285a8` | `mbrain-completion-plan` | Published the remaining completion roadmap. |
| #42 | `528b07d` | `sprint-1.1b-loop-audit` | Added `audit_brain_loop` and scenarios for structured loop audit and linked writes. |
| #43 | `06c6949` | `docs/mbrain-completion-roadmap-refresh` | Refreshed the roadmap after audit landed. |
| #44 | `c1991ec` | `sprint-0.1-tsc-engine-contract` | Removed the incorrect shared SQL migration capability from the base engine contract. |
| #45 | `6e9b046` | `sprint-0.2-tsc-sql-json-mappers` | Tightened SQL, JSON, and mapper boundary types. |
| #46 | `e70dab4` | `sprint-0.3-tsc-domain-boundaries` | Fixed domain-boundary TypeScript mismatches. |
| #47 | `f20be12` | `sprint-0.4-tsc-test-fixtures` | Fixed test and scenario fixture type errors. |
| #48 | `54a65e1` | `sprint-0.5-tsc-ci` | Made `bunx tsc --noEmit --pretty false` green and enforced it in CI before tests. |
| #49 | `b5227f2` | `sprint-2-request-decomposition` | Closed S5 with deterministic request-level retrieval decomposition. |
| #50 | `8c750bc` | `sprint-3-canonical-first-ranking` | Closed S9 by preferring curated canonical notes over map-derived suggestions. |
| #51 | `c8c41c2` | `sprint-4-code-claim-verification` | Closed S11 by verifying stale code claims before reuse in task resume. |

## Implemented Invariants

- Agent-turn identity is durable: `retrieval_traces.id` is the interaction row
  used by audit and linked-write joins.
- Loop audit is structured: selected intent, scope, scope-gate policy/reason,
  canonical-vs-derived reads, write outcome, and linked writes are queryable
  without parsing prose.
- Governance writes preserve provenance and can link back to the originating
  interaction by `interaction_id`.
- Request decomposition is deterministic for the implemented L1 mixed-intent
  case and does not call an LLM.
- Broad synthesis keeps curated canonical notes authoritative over derived map
  suggestions for the implemented L2 conflict case.
- Task resume treats historical code claims as historical until reverified
  against the current repo path, branch, file path, and symbol evidence.
- Scenario contracts are real tests, not placeholders.
- TypeScript is clean locally and enforced by CI before the main test suite.

## Review Findings That Improved The Design

- The initial observability plan was too approximate because the codebase did
  not have a first-class agent-turn identity. Splitting Sprint 1.0 before
  Sprint 1.1 made loop audit exact instead of timestamp-correlated.
- TypeScript cleanup had to land before new semantic features. This prevented
  new behavior from hiding inside an already noisy type baseline.
- Code-claim verification needed more than direct `path + symbol` checks. Final
  hardening added pathless-symbol handling, symlink escape protection,
  branch-unknown handling, summary-derived code facts, active working-set facts,
  root config/code paths, extensionless root paths, lowercase path-scoped
  symbols, Oxford-comma symbol lists, and exact `{path, symbol}` masking rules.
- The correct policy for stale code claims is to withhold current authority
  while preserving the historical operational record. Deleting or mutating the
  old trace would have hidden useful provenance.

## Final Verification Evidence

Run on the final acceptance branch based on merge `c8c41c2`:

```bash
if rg -n "test\\.todo|todo\\(" test/scenarios; then
  echo "Scenario placeholders remain"
  exit 1
fi
bunx tsc --noEmit --pretty false
bun run test:scenarios
FINAL_ACCEPTANCE_TEST_HOME=$(mktemp -d /tmp/mbrain-final-acceptance-test-home.XXXXXX)
env HOME="$FINAL_ACCEPTANCE_TEST_HOME" bun test --timeout 60000
bun run build
git diff --check
git status --short
```

Expected evidence:

- scenario placeholder scan prints no matches and exits 0
- TypeScript exits 0 with no output
- scenarios: `61 pass`, `2 skip`, `0 fail`
- full suite: `1219 pass`, `145 skip`, `0 fail`
- build exits 0
- diff check exits 0
- `git status --short` is inspected so the new retrospective and other
  acceptance docs are not accidentally omitted from the commit

CLI audit verification:

```bash
FINAL_ACCEPTANCE_CLI_HOME=$(mktemp -d /tmp/mbrain-final-acceptance-cli-home.XXXXXX)

env HOME="$FINAL_ACCEPTANCE_CLI_HOME" \
  bun run src/cli.ts init --local \
  --path "$FINAL_ACCEPTANCE_CLI_HOME/mbrain.db" \
  --json

env HOME="$FINAL_ACCEPTANCE_CLI_HOME" \
  bun run src/cli.ts audit-brain-loop --since 24h --json
```

Observed behavior on an empty local SQLite brain: the command returns valid
`AuditBrainLoopReport` JSON with zero activity and the summary line
`No brain-loop activity in the selected window.`

## Remaining Future Work

These are intentionally deferred and are not completion blockers:

- trace retention, TTL, and pruning
- loop-observability dashboard or scheduled audit job
- full `memory_candidate_status_events` event log
- active-only task-compliance policy
- AST-aware code-claim verification beyond current lexical path/symbol/branch
  checks
- richer automation that writes audit results back into canonical project
  status pages

## Retrospective Rule Changes

- Build foundation concepts before measuring them. Interaction identity came
  before observability, and that ordering should remain the default for future
  loop-level features.
- Keep semantic contracts as separate PRs. L1, L2, and L4 were easier to review
  and harden because they landed independently.
- Treat review findings as hypotheses. Valid findings should be reproduced with
  a failing test first, then fixed narrowly.
- Before merging any PR, run a final critical subagent review and fix all valid
  findings before relying on CI.
