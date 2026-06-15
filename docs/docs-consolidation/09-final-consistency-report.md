# Final Docs-Only Consistency Report

Status: issue #14 final pass

Proof level: `docs_complete` with static/source inspection only. No GBrain
runtime command, local brain home, local corpus path, service, migration,
import, sync, or Docker lifecycle command was run.

## Inputs Checked

- GitHub PRD issue: <https://github.com/TheAngryPit/gbrain/issues/1>
- GitHub final-pass issue: <https://github.com/TheAngryPit/gbrain/issues/14>
- Operator feedback comment by `Ben-Home` on issue #1.
- `docs/docs-consolidation/05-current-capabilities-ledger.md`
- `docs/docs-consolidation/06-documentation-status-taxonomy.md`
- `docs/docs-consolidation/03-issue-breakdown.md`
- Current branch diff against `upstream/master`.
- Landed docs and generated maps listed below.

## PRD Acceptance Map

| PRD acceptance bar | Landed evidence | Status |
| --- | --- | --- |
| New user can start from README and find one correct human install/operating path. | `README.md` Start here section routes humans to `docs/INSTALL.md`; `docs/INSTALL.md` is the Human Operational Center. | pass |
| Coding agent can start from README or `AGENTS.md` and find one correct agent operating path. | `README.md` routes coding agents to `INSTALL_FOR_AGENTS.md`, `AGENTS.md`, and `CLAUDE.md`; `INSTALL_FOR_AGENTS.md` contains the agent operating map and safety gates. | pass |
| Production operators have a central path covering topology, safety boundaries, brain repo layout, mode selection, credentials, backups, and failure modes. | `docs/INSTALL.md` production/shared branch covers shape, modes, MCP exposure, scopes, providers/secrets, backups/restore, health, and failure-mode checklist. | pass |
| Operating Model and Deployment Topology are distinct and branchable. | `docs/architecture/topologies.md` separates operating model from deployment topology and links from `README.md`, `docs/INSTALL.md`, and `INSTALL_FOR_AGENTS.md`. | pass |
| Shared Group Brain includes family/team/company use cases without inventing separate topology families unnecessarily. | `docs/architecture/topologies.md`, `docs/INSTALL.md`, and `INSTALL_FOR_AGENTS.md` treat family, household, team, and company as shared group brain operating models. | pass |
| `search`, `think`, and `dream`/autopilot are explained through a mode-selection guide. | `docs/guides/mode-selection.md` covers retrieval, synthesis, maintenance, push context, and search-mode bundles; README and install docs route to it. | pass |
| Historical/design/superseded docs are visibly labeled. | `docs/docs-consolidation/07-status-label-application.md` tracks labels applied to selected historical/design/proposal/incident/plan docs and `TODOS.md`. | pass |
| `CHANGELOG.md` is treated as the Release Evolution Ledger. | `docs/docs-consolidation/05-current-capabilities-ledger.md` derives the baseline from `CHANGELOG.md`; `docs/adr/0001-centralize-operational-documentation.md` preserves the authority decision. | pass |
| Generated `llms.txt` and `llms-full.txt` are promoted as machine-readable entrypoints. | `README.md`, `AGENTS.md`, `INSTALL_FOR_AGENTS.md`, `scripts/llms-config.ts`, `scripts/build-llms.ts`, `llms.txt`, and `llms-full.txt`. | pass |
| PR remains docs-only and does not mutate runtime behavior. | Branch diff is docs, repo-local docs support, generated LLM maps, and documentation generator source. No `src/`, runtime migrations, package manifests, or tests were modified. | pass with note |

Note: the branch contains a `.gitignore` entry for local `.codegraph/` and
`.understand-anything/` analysis outputs. This is not runtime behavior, but it is
the only tracked file outside documentation or documentation generation/support.

## Changelog-Current Capability Map

| Capability group from ledger | Docs now explaining or routing to it |
| --- | --- |
| Current version and release evolution | `README.md`, `VERSION`, `CHANGELOG.md`, `docs/docs-consolidation/05-current-capabilities-ledger.md` |
| Push-based context: retrieval reflex, `volunteer_context`, `gbrain volunteer-context`, `gbrain watch` | `docs/guides/mode-selection.md`, `docs/guides/push-context.md`, `README.md`, `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md` |
| Search, synthesis, dream/autopilot, and search-mode cost/quality choices | `docs/guides/mode-selection.md`, `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md` |
| Brain/source routing, source-local write-through, repo layout, managed/generated surfaces, backup implications | `docs/architecture/brain-repo-layout.md`, `docs/architecture/brains-and-sources.md`, `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md` |
| Operating models: personal, multi-source, shared group, single-agent shared, auth-scoped shared | `docs/architecture/topologies.md`, `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md` |
| Deployment topologies: local/default, remote/thin client, split-engine/worktree, mounted/cross-team, security-driven isolation | `docs/architecture/topologies.md`, `docs/architecture/thin-client.md`, `docs/INSTALL.md`, `docs/mcp/DEPLOY.md` |
| PGLite locking, single-writer caution, resumable sync, failure/retry posture | `docs/INSTALL.md`, `docs/architecture/topologies.md`, `docs/TESTING.md`, `docs/GBRAIN_VERIFY.md` |
| Provider/base URL gotchas, key management, model/search cost guardrails | `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md`, `docs/guides/mode-selection.md`, provider references linked from install docs |
| OAuth 2.1, scopes, legacy bearer compatibility, remote MCP exposure, localOnly boundaries | `docs/mcp/DEPLOY.md`, `SECURITY.md`, `docs/mcp/ALTERNATIVES.md`, `docs/architecture/thin-client.md`, `INSTALL_FOR_AGENTS.md`, client-specific MCP docs |
| Relational retrieval and current retrieval architecture | `README.md`, `docs/architecture/RETRIEVAL.md`, `docs/guides/mode-selection.md` |
| Production health, doctor/remediation, backups, restore proof, queue/minion failure signals | `docs/INSTALL.md`, `docs/GBRAIN_VERIFY.md`, `docs/guides/minions-deployment.md`, references routed from install docs |
| Brittle skill/test/generated-map count drift | `docs/docs-consolidation/08-brittle-counts-and-generated-maps.md`, `README.md`, `CLAUDE.md`, `docs/TESTING.md`, generated map source |

## Operator Feedback Map

| Feedback from issue #1 | Landed resolution |
| --- | --- |
| Single "getting started in production" path. | Implemented as the production/shared-brain branch inside `docs/INSTALL.md`, not a separate overlapping `OPERATING.md`. |
| Search vs chat vs dream scattered across files. | Implemented as `docs/guides/mode-selection.md`, using current GBrain surfaces: `search`, `think`, `dream`/autopilot, retrieval reflex, volunteer context, and watch. |
| Vault directory structure undocumented. | Implemented as `docs/architecture/brain-repo-layout.md`; uses "Brain Repo Layout" as the generic term and reserves "vault" for compatibility/import contexts. |
| Status badges on historical docs. | Implemented through selected banners tracked in `docs/docs-consolidation/07-status-label-application.md`. |
| Production checklist should cover base URL gotcha, keys, backup strategy. | Implemented in `docs/INSTALL.md` production branch and failure-mode checklist. |
| Local glossary and ADR from grill session should be included. | `CONTEXT.md` and `docs/adr/0001-centralize-operational-documentation.md` are present in the branch. |

## Issue Ledger

| Issue | Slice | Evidence | Status |
| --- | --- | --- | --- |
| #2 | Changelog-to-current-capabilities baseline | `docs/docs-consolidation/05-current-capabilities-ledger.md` | pass |
| #3 | Inventory and status taxonomy | `docs/docs-consolidation/06-documentation-status-taxonomy.md`, manifest files | pass |
| #4 | README router, current version, LLM entrypoints | `README.md`, regenerated LLM maps | pass |
| #5 | Human Operational Center | `docs/INSTALL.md` | pass |
| #6 | Agent Operational Center | `INSTALL_FOR_AGENTS.md`, `AGENTS.md`, regenerated LLM maps | pass |
| #7 | Operating model and topology trees | `docs/architecture/topologies.md` plus README/install/agent routes | pass |
| #8 | Brain Repo Layout | `docs/architecture/brain-repo-layout.md` plus routes | pass |
| #9 | Mode Selection Guide | `docs/guides/mode-selection.md` plus routes | pass |
| #10 | Production operational path and checklist | `docs/INSTALL.md` production/shared branch | pass |
| #11 | MCP/auth/remote/thin-client alignment | `docs/mcp/DEPLOY.md`, `SECURITY.md`, `docs/mcp/ALTERNATIVES.md`, `docs/architecture/thin-client.md`, MCP client docs | pass |
| #12 | Status labels | `docs/docs-consolidation/07-status-label-application.md` and selected banners | pass |
| #13 | Brittle counts and generated maps | `docs/docs-consolidation/08-brittle-counts-and-generated-maps.md`, generator updates, regenerated LLM maps | pass |
| #14 | Final consistency pass | This report | pass |

## Branch Scope Check

`git diff --name-only upstream/master...HEAD` shows documentation, generated LLM
maps, docs-consolidation artifacts, repo-local documentation support, and docs
generator source. The final pass found no changes under:

- `src/`
- `test/` or `tests/`
- `migrations/`
- `package.json`
- `bun.lock`
- Docker compose files
- runtime config templates

No runtime behavior change was introduced by this branch.

## Static Validation

| Check | Result |
| --- | --- |
| CodeGraph-first exploration before raw search on final pass | pass |
| GitHub issue #1 and #14 bodies read | pass |
| GitHub issue #1 comments read, including operator feedback | pass |
| `bun run build:llms` after generator/content changes | pass |
| `git diff --check` / staged whitespace checks on implementation slices | pass |
| Targeted stale-count search for #13 phrases | pass |
| Secret-pattern scan over staged #13 diff | pass |
| `bun test test/build-llms.test.ts` | `test_not_run`: Bun cannot resolve package `ai` from `src/core/ai/gateway.ts` in this checkout; no dependency install was performed. |

## Proof Limits

- This is static documentation/source inspection only.
- No GBrain runtime command was run.
- No local GBrain brain home, corpus path, runtime config, Hermes/OpenClaw, or
  Nexus runtime was inspected.
- No service was started.
- No dependency install was performed.
- The generated-doc unit test remains blocked by the local missing-package
  condition described above; `bun run build:llms` is the fresh generated-map
  proof available in this environment.

## Strongest Safe Truth

The docs-only consolidation PR is prepared as a current-state documentation
proposal. It centralizes human operation in `docs/INSTALL.md`, agent operation
in `INSTALL_FOR_AGENTS.md`, branchable topology in
`docs/architecture/topologies.md`, brain layout in
`docs/architecture/brain-repo-layout.md`, mode selection in
`docs/guides/mode-selection.md`, MCP/auth truth in `docs/mcp/DEPLOY.md` plus
linked security/client docs, and LLM ingestion in generated maps.

The proof is not runtime proof. It is docs-complete with static/source evidence
for the PRD and issue acceptance bars.
