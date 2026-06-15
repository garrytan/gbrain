# GBrain docs consolidation execution goal

Use this as the goal file for the next long-running Codex thread:

```md
/goal Execute the GBrain docs-only consolidation according to docs/docs-consolidation/04-execution-goal.md.
```

## Goal text

MODO: GBRAIN DOCS CONSOLIDATION PR, DOCS-ONLY, CHANGELOG-FIRST.

This goal is documentation and architecture work. It is not runtime migration.
It must land useful docs, not another status layer.

## Context

This is the upstream GBrain documentation fork, not the Nexus implementation
project and not a local runtime migration.

The branch already has:

- PRD issue: <https://github.com/TheAngryPit/gbrain/issues/1>
- Published AFK issues: #2 through #14
- Current upstream baseline: `090bb53203557f5659563ea28c1c847c32167aeb`
- Current branch commit at goal authoring time: `2889685a`
- Current upstream version at goal authoring time: `0.42.44.0`
- Documentation consolidation artifacts under `docs/docs-consolidation/`
- CodeGraph indexed for this repo
- `understand-anything` refreshed for the branch at the merge commit noted in
  `docs/docs-consolidation/02-architecture-map.md`

## Goal

Deliver the docs-only consolidation PR for GBrain by executing issues #2 through
#14 in order, with `CHANGELOG.md` as the current-capabilities baseline and with
all claims backed by source/docs/static proof.

## Success means

1. The docs start from a changelog-derived current-capabilities ledger, not from
   stale assumptions.
2. README routes readers to one human operational path, one agent operational
   path, current version info, production guidance, architecture refs, and LLM
   entrypoints.
3. `docs/INSTALL.md` is the Human Operational Center and is not a thin
   quickstart only.
4. `INSTALL_FOR_AGENTS.md` is the Agent Operational Center and keeps the
   search-mode user gate and trust boundaries explicit.
5. Operating Model and Deployment Topology are separate branchable decisions.
6. Brain Repo Layout is documented centrally with GBrain-native terms.
7. Mode selection covers `gbrain search`, `gbrain think`, `gbrain dream` /
   autopilot, retrieval reflex, `volunteer_context`, `gbrain volunteer-context`,
   and `gbrain watch` where current docs and changelog support them.
8. Production operators have one path covering topology, safety boundaries,
   provider base URL gotchas, keys, backups, OAuth/scopes, MCP exposure, health
   checks, and failure verification.
9. MCP, auth, remote, thin-client, and agent-exposure docs match current source
   and current docs authority.
10. Historical, design, deprecated, and superseded docs no longer look like
    current operational guidance.
11. Brittle skill/test/generated-map count claims are removed or qualified.
12. `llms.txt` and `llms-full.txt` are regenerated if their source content
    changed.
13. The final consistency pass maps every PRD acceptance bar and issue to the
    landed docs.
14. The branch remains docs-only.

## Current accepted state

Preserve these facts unless fresh repo/GitHub evidence says otherwise:

- Issue #1 is the parent PRD.
- Issues #2 through #14 are the ordered execution ledger.
- All issue slices are AFK.
- The first slice is #2, changelog-to-current-capabilities baseline.
- `CHANGELOG.md` is the Release Evolution Ledger for this work.
- `docs/docs-consolidation/03-issue-breakdown.md` maps issue numbers to titles.
- The previous pass explicitly avoided GBrain runtime commands and local runtime
  inspection.

## Skill stack

Use these skills and principles:

- `karpathy-agentic-guidelines-q8`: default execution discipline for every
  slice. Keep autonomy bounded, assumptions explicit, and diffs reviewable.
- `karpathy-agentic-guidelines-full`: use for #2, #13, #14, and any delegated or
  multi-doc pass where assumptions could drift.
- `unslop`: apply to all public prose before considering a slice done. Cut AI
  tells, generic phrasing, over-bolded labels, title-case headings where not
  already established, and vague claims.
- `principle-outcome-oriented-execution`: converge on the final docs shape, not
  a pile of smooth intermediate compatibility notes.
- `principle-prove-it-works`: inspect the real files, generated maps, diffs,
  issue bodies, and final docs. Do not trust summaries.
- `principle-minimize-reader-load`: every consolidation edit must reduce the
  work a reader does to answer "what should I do next?"
- `principle-boundary-discipline`: keep authority boundaries clear. README
  routes. Human docs operate. Agent docs gate and protect. Architecture refs
  define semantics. Changelog explains release evolution.
- `principle-subtract-before-you-add`: remove duplicate or stale snippets before
  adding new prose.
- `principle-guard-the-context-window`: keep large evidence in files. Use short
  summaries in chat.
- `principle-build-the-lever`: if a check or inventory must be repeated across
  many docs, script it or make it rerunnable instead of hand-checking forever.
- `principle-encode-lessons-in-structure`: if the same drift class appears more
  than once, add a durable check, generated map rule, status label convention,
  or docs-consolidation note.

Do not use these by default:

- Type-system, idempotency, shared-state, migration, or runtime-operation
  principles. If a slice seems to need them, the work is probably leaving
  docs-only scope. Stop and report the exact reason.

## Non-goals and red lines

Do not inspect:

- `/Users/nexus00`
- `/Users/vitorcepedalopes/AgentRuntimeCoordination`
- any local `GBRAIN_HOME`
- any local `GBRAIN_CORPUS_PATH`
- Hermes/OpenClaw/Hindsight runtime configs
- any local `.env` outside this repository

Do not run:

- `gbrain init`
- `gbrain sync`
- `gbrain serve`
- `gbrain auth`
- `gbrain import`
- `gbrain migrate`
- `docker compose up`
- `docker compose down`
- `launchctl`

Do not:

- mutate runtime behavior
- inspect private/local brain data
- weaken safety wording to make docs shorter
- advertise an official installable GBrain docs skill unless the upstream repo
  ships and supports it
- create a separate `OPERATING.md` unless the current docs prove
  `docs/INSTALL.md` cannot carry the production path cleanly
- claim `runtime_proven`

## Operator approvals

Allowed:

- Edit docs and docs-only generated maps in this repository.
- Read repo source and tests for documentation truth.
- Use CodeGraph before raw search when locating code/docs.
- Use GitHub issues #1 through #14 as the tracker truth.
- Run static and docs-generation checks that do not start GBrain runtime
  services.
- Commit and push docs-only changes on the current branch when the slice is
  ready.

Requires explicit operator approval:

- Opening or marking a PR ready.
- Installing dependencies, plugins, hooks, MCP servers, or CLIs.
- Any command that starts a service, touches local runtime state, or needs
  credentials.
- Any move from docs-only into runtime implementation.

## Required sources to read

Read these before editing the relevant slice:

- `AGENTS.md`
- `CLAUDE.md`
- `README.md`
- `VERSION`
- `CHANGELOG.md`
- `docs/docs-consolidation/00-upstream-base.md`
- `docs/docs-consolidation/01-documentation-inventory.md`
- `docs/docs-consolidation/02-architecture-map.md`
- `docs/docs-consolidation/03-issue-breakdown.md`
- GitHub issue #1 and comments
- GitHub issues #2 through #14 as they become active
- `docs/INSTALL.md`
- `INSTALL_FOR_AGENTS.md`
- `docs/architecture/brains-and-sources.md`
- `docs/architecture/topologies.md`
- `docs/architecture/thin-client.md`
- `docs/architecture/RETRIEVAL.md`
- `docs/guides/search-modes.md`
- `docs/guides/push-context.md`
- `docs/mcp/DEPLOY.md`
- `docs/mcp/ALTERNATIVES.md`
- `SECURITY.md`
- `scripts/llms-config.ts`

Use source files only to verify docs claims. Do not change runtime code.

## Required phases

1. Refresh local truth.
   - Check branch, upstream base, open issues, and worktree.
   - If upstream moved, merge or report the exact blocker before editing.
   - Refresh CodeGraph when the branch changes.

2. Execute #2 and #3 first.
   - Build the changelog capability ledger.
   - Refresh doc status taxonomy.
   - Treat this as the frozen measuring stick for the rest of the work.

3. Execute entrypoint and operational-center slices.
   - #4 README router.
   - #5 Human Operational Center.
   - #6 Agent Operational Center.

4. Execute branchable operation slices.
   - #7 operating model and topology.
   - #8 Brain Repo Layout.
   - #9 Mode Selection Guide.
   - #10 production path.

5. Execute alignment and cleanup slices.
   - #11 MCP/auth/thin-client.
   - #12 status labels.
   - #13 brittle counts and generated maps.

6. Execute final consistency pass.
   - #14 maps PRD, changelog, source/docs, operator feedback, issues, and final
     diff.

7. Prepare PR handoff.
   - Commit and push docs-only work.
   - Prepare PR title/body/checklist.
   - Stop before opening or marking ready unless the operator approved it.

## Ordered execution ledger

| seq | issue | item | class | entry condition | required exit evidence | status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | #2 | Changelog-to-current-capabilities baseline | agent_executable | Clean branch, issue #2 open | Baseline artifact exists and maps current releases to doc obligations | implemented in `05-current-capabilities-ledger.md` |
| 2 | #3 | Documentation inventory and status taxonomy | agent_executable | #2 complete | Inventory/status taxonomy updated against baseline | implemented in `06-documentation-status-taxonomy.md` |
| 3 | #4 | README router, current version, LLM entrypoints | agent_executable | #2 and #3 complete | README routes to canonical docs and current version | implemented in `README.md`; `llms-full.txt` regenerated |
| 4 | #5 | Human Operational Center | agent_executable | #2 and #3 complete | `docs/INSTALL.md` carries the central human path | implemented in `docs/INSTALL.md`; `bun run build:llms` produced no generated diff |
| 5 | #6 | Agent Operational Center | agent_executable | #2, #3, #5 complete | `INSTALL_FOR_AGENTS.md` mirrors operational branches with safety gates | implemented in `INSTALL_FOR_AGENTS.md`; `llms.txt` and `llms-full.txt` regenerated |
| 6 | #7 | Operating model and topology trees | agent_executable | #2 and #3 complete | Branchable choices exist and are linked | implemented in `docs/architecture/topologies.md`; linked from `README.md`, `docs/INSTALL.md`, and `INSTALL_FOR_AGENTS.md` |
| 7 | #8 | Brain Repo Layout | agent_executable | #2, #3, #7 complete | Layout/source/brain docs exist and are linked | implemented in `docs/architecture/brain-repo-layout.md`; linked from human, agent, and production paths |
| 8 | #9 | Mode Selection Guide | agent_executable | #2, #5, #7 complete | Guide covers current command and push-context paths | implemented in `docs/guides/mode-selection.md`; linked from human, agent, and production paths |
| 9 | #10 | Production path and checklist | agent_executable | #5, #7, #8, #9 complete | Production branch/checklist exists inside human path | implemented in `docs/INSTALL.md`; production path remains centralized |
| 10 | #11 | MCP/auth/remote/thin-client alignment | agent_executable | #2, #6, #7, #10 complete | MCP/auth docs align with current protocol truth | implemented in `docs/mcp/DEPLOY.md`, `SECURITY.md`, `docs/mcp/ALTERNATIVES.md`, client MCP recipes, and `docs/architecture/thin-client.md` |
| 11 | #12 | Status labels | agent_executable | #3 complete | Historical/design/deprecated/superseded docs labelled where needed | implemented in selected historical/design/proposal/incident/plan docs and tracked in `07-status-label-application.md` |
| 12 | #13 | Brittle counts and generated-map claims | agent_executable | #2, #3, #4 complete | Counts qualified/removed and generated maps handled | implemented in current docs, generator source, regenerated maps, and `08-brittle-counts-and-generated-maps.md` |
| 13 | #14 | Final consistency pass | agent_executable | #2 through #13 complete | PRD/issues/changelog/operator feedback mapped to final diff | implemented in `09-final-consistency-report.md` |

Preserve order. Do not skip a row. If a row becomes human-in-loop, stop with
`goal_not_complete` and name the operator action.

## Required outputs

- Updated docs under the existing repository layout.
- Changelog-derived capability ledger.
- Refreshed docs status taxonomy or inventory notes.
- Updated `llms.txt` and `llms-full.txt` if their source docs changed.
- Final consistency report in the repo or PR body.
- GitHub issue comments only when useful and factual.
- Commit history that stays docs-only.

## Static proof

Use the strongest safe proof for docs-only work:

- Read the changed files directly.
- Inspect `git diff`.
- Run `git diff --check`.
- Run a secret-pattern scan over the staged diff before commit.
- Run `bun run build:llms` if any source used by `scripts/llms-config.ts`
  changed.
- Run the narrow generated-doc tests if available and already installed.
- Use `rg` checks for stale version strings, old counts, stale paths, and
  old status labels.
- Use CodeGraph for source-backed claims before raw search where practical.

If a check cannot run because dependencies are missing and installing would need
approval, report `goal_not_complete` or `test_not_run` for that proof item. Do
not silently downgrade the claim.

## Validation

Before calling a slice done:

1. Re-read the issue body.
2. Re-read the changed files.
3. Check the diff for unrelated edits.
4. Run targeted static checks.
5. Confirm the slice reduces reader work and does not add duplicate authority.
6. Apply `unslop` to public prose.
7. Update the ordered ledger status.

Before calling the full goal done:

1. Every ledger row is complete or explicitly deferred by the operator.
2. No row is skipped without approval.
3. Every PRD acceptance criterion has evidence.
4. Every changed generated file is either regenerated or explicitly not needed.
5. No forbidden runtime action occurred.
6. Worktree is clean or remaining diffs are explained.

## Completion audit

Final audit must include:

| criterion | evidence source | pass/fail | notes |
| --- | --- | --- | --- |

And for the ledger:

| seq | issue | class | status | evidence source | skipped or deferred | notes |
| --- | --- | --- | --- | --- | --- | --- |

## Completion rule

Do not call the goal complete unless:

- all success criteria pass
- all ledger rows are complete or explicitly deferred by the operator
- no `human_in_loop` row remains unresolved
- no row is `skipped_without_approval`
- the branch remains docs-only
- proof level is named honestly as `docs_complete` plus static/source proof

Never claim `runtime_proven` for this goal.

## Final report

Use this shape:

```md
1. update_goal complete called yes/no
2. issues completed
3. docs changed
4. generated maps changed yes/no
5. validation run
6. forbidden actions occurred yes/no
7. proof level
8. remaining risk
9. next implementation slice or PR step
```

If not complete:

```md
goal_not_complete

1. update_goal complete called no
2. blocked_at
3. blocker_class
4. completed rows
5. exact operator action required
6. resume point
7. skipped items
```

## Stop rule

Stop after the docs-only PR is prepared and pushed, or at the first exact
blocker.

Do not continue into runtime implementation, local runtime migration, service
startup, dependency installation, public release, or ready-PR action without a
fresh operator approval.
