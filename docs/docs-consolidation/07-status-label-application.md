# Status Label Application

Status: tracking artifact for docs consolidation issue #12

Proof level: `code_proven` static documentation inspection only. No GBrain
runtime command, local brain home, local corpus path, service, migration, import,
sync, or Docker lifecycle command was run.

## Scope

This pass applied visible trust labels only to historical, design, proposal,
incident, and plan docs that can be mistaken for current operational guidance or
are reachable from current references and generated maps.

It deliberately did not label every current guide, tutorial, skill file, recipe,
fixture, or generated map.

## Applied Labels

| File | Label | Current route |
|---|---|---|
| `docs/GBRAIN_V0.md` | `HISTORICAL` | `docs/ENGINES.md`, `CHANGELOG.md` |
| `TODOS.md` | `HISTORICAL` | `CHANGELOG.md`, `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md` |
| `docs/designs/2026_05_EVAL_PLAN.md` | `DESIGN` | `docs/eval-bench.md`, `docs/eval/SEARCH_MODE_METHODOLOGY.md` |
| `docs/designs/CODE_CATHEDRAL_II.md` | `HISTORICAL` | `docs/architecture/KEY_FILES.md`, `docs/architecture/RETRIEVAL.md` |
| `docs/designs/COMMUNITY_IDEAS.md` | `HISTORICAL` | `CHANGELOG.md`, `TODOS.md` |
| `docs/designs/HOMEBREW_FOR_PERSONAL_AI.md` | `DESIGN` | `docs/integrations/README.md`, `docs/INSTALL.md` |
| `docs/designs/KNOWLEDGE_RUNTIME.md` | `DESIGN` | `docs/architecture/KEY_FILES.md`, `docs/architecture/RETRIEVAL.md` |
| `docs/designs/MINIONS_AGENT_ORCHESTRATION.md` | `DESIGN` | `docs/guides/minions-deployment.md`, `docs/guides/minions-fix.md`, `docs/architecture/KEY_FILES.md` |
| `docs/designs/SKILLPACK_REGISTRY_V1_SPEC.md` | `SUPERSEDED_BY` | `docs/guides/skillpacks-as-scaffolding.md`, `docs/skillpack-anatomy.md` |
| `docs/designs/V038_SCHEMA_PACKS.md` | `DESIGN` | `docs/architecture/schema-packs.md`, `docs/schema-author-tutorial.md`, `docs/what-schemas-unlock.md` |
| `docs/issues/cross-modal-search.md` | `SUPERSEDED_BY` | `docs/architecture/RETRIEVAL.md`, `docs/architecture/KEY_FILES.md` |
| `docs/issues/doctor-auto-heal-and-scoring.md` | `DESIGN` | `docs/GBRAIN_VERIFY.md`, `docs/INSTALL.md` |
| `docs/proposals/temporal-contradiction-probe.md` | `DESIGN` | `docs/eval-bench.md`, `docs/takes-vs-facts.md`, current source |
| `docs/incidents/2026-05-20-lsd-cost-explosion.md` | `HISTORICAL` | `CHANGELOG.md`, `docs/GBRAIN_VERIFY.md`, `docs/INSTALL.md` |
| `docs/plans/2026-06-03-001-feat-idea-lineage-skill-plan.md` | `HISTORICAL` | `skills/idea-lineage/SKILL.md`, `skills/RESOLVER.md` |

## Non-Goals

- No status banners were added to current operational docs such as `README.md`,
  `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md`, `docs/mcp/DEPLOY.md`, or
  current architecture references.
- No test fixtures, generated maps, or bundled skill bodies were relabelled.
- No historical content was deleted.

## Proof Map

| Claim | Proof level | Evidence |
|---|---|---|
| Labels follow the issue #3 taxonomy | `implemented` | `docs/docs-consolidation/06-documentation-status-taxonomy.md` and the banners added in this pass. |
| Label application avoids mass-labelling current docs | `implemented` | Applied labels are limited to 15 historical/design/proposal/incident/plan docs listed above. |
| Superseded/design docs route to current references | `code_proven` | The banners link to existing current docs or source-owned skill routes. |
