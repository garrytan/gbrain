# Documentation Inventory

Status: frozen baseline inventory for upstream PR preparation

Baseline reviewed: `docs/docs-consolidation/00-upstream-base.md`

Pinned upstream commit: `bb2e88c42a4969e16df7a43a9eb118aa031e89a4`

Current upstream version reviewed: `0.42.52.0`

## Scope

This inventory describes the documentation reality in the upstream GBrain
checkout at the pinned baseline before the consolidation edits in this branch.
It is intentionally limited to repository files.

No local Nexus runtime, local brain home, local corpus path, runtime configs,
or out-of-repo environment files were inspected. No GBrain runtime commands,
service commands, migrations, imports, syncs, or Docker lifecycle commands were
run.

Generated and execution artifacts:

- `docs/docs-consolidation/01-documentation-manifest.tsv`
- `docs/docs-consolidation/02-architecture-map.md`
- `docs/docs-consolidation/05-current-capabilities-ledger.md`
- `docs/docs-consolidation/06-documentation-status-taxonomy.md`

The manifest lists every documentation-like file found by the baseline metadata
pass: path, area, role, line count, byte count, and first H1. Treat those line
counts and H1 values as a frozen pre-consolidation snapshot, not as live metadata
after later branch edits such as the rewrite of `docs/INSTALL.md`.

The architecture map records the installed Understand / CodeGraph / subagent
analysis used to connect documentation drift back to repository code and
manifests. These `docs/docs-consolidation/*` files are review and handoff
artifacts, not canonical public product docs.

The current-capabilities ledger maps the current release window from
`CHANGELOG.md` into documentation obligations. The status taxonomy defines the
trust labels and action rules used by the remaining consolidation issues.

## Inventory Summary

Documentation-like files found: 350

Files under `test/` or `tests/`: 80

Other documentation-like files: 270

The manifest excludes `docs/docs-consolidation/*` to avoid counting this
analysis output as upstream documentation input.

| Area | Count | Notes |
|---|---:|---|
| github templates | 3 | issue and PR templates |
| root entrypoints and policy | 12 | README, agent entrypoints, license/security/contributing, generated LLM maps, changelog, TODOs |
| docs root references | 24 | install, testing, releasing, verification, schema, eval, progress, storage, guardrails |
| agent workflow docs | 3 | repo-local issue tracker and triage vocabulary |
| architecture references | 15 | current-state architecture, per-file index, retrieval, topology, schema packs, thin-client |
| how-to guides | 36 | task-oriented operator and maintainer guides, including push-context |
| tutorials | 5 | learning-oriented end-to-end walkthroughs |
| MCP client and deploy docs | 8 | client-specific setup plus deployment choices |
| integrations | 6 | external data and reliability integrations |
| AI provider docs | 2 | ZeroEntropy and local reranker setup |
| eval references | 2 | generated metric glossary and search-mode methodology |
| design docs | 8 | forward-looking or historical design material |
| issues / proposals / incidents / plans | 5 | issue writeups, proposal, incident report, one plan |
| operations | 1 | headless install |
| docs migrations | 1 | markdown greenfield migration guide |
| ethos | 3 | philosophy / positioning docs |
| bundled skills | 57 | resolver, shared rules, and skill markdown in `skills/` excluding conventions/migrations |
| skill conventions | 11 | cross-cutting agent conventions |
| skill migration guides | 36 | per-version downstream migration instructions |
| recipes | 21 | integration recipes and recipe bundles |
| examples | 4 | skillpack reference example |
| eval harness docs | 6 | local eval harness documentation and variants |
| admin docs | 1 | admin UI design system |
| script references | 1 | upstream scrub table |
| test fixture docs | 80 | fixtures, synthetic corpora, test-only skills, README files under test paths |

## Documentation Authority Layers

### User and agent entrypoints

These are the surfaces a new reader is likely to hit first:

- `README.md` - product overview, value proposition, broad install paths, major features.
- `AGENTS.md` - non-Claude agent install and operating protocol.
- `CLAUDE.md` - Claude Code and maintainer orientation, current architecture invariants, reference dispatcher, ship rules.
- `INSTALL_FOR_AGENTS.md` - long-form agent-executed installation flow.
- `docs/INSTALL.md` - compact install reference for humans and CLI/MCP users.
- `docs/tutorials/*` - learning paths for personal brain, company brain, coding-agent connection, and skillopt.
- `docs/mcp/*` - client-specific MCP setup and remote deployment references.
- `llms.txt` / `llms-full.txt` - generated documentation maps for single-fetch agent ingestion.

### Current-state architecture

These are the strongest current-state references for implementation and review:

- `CLAUDE.md`
- `docs/architecture/KEY_FILES.md`
- `docs/architecture/brains-and-sources.md`
- `docs/architecture/topologies.md`
- `docs/architecture/thin-client.md`
- `docs/architecture/RETRIEVAL.md`
- `docs/architecture/schema-packs.md`
- `docs/architecture/type-taxonomy.md`
- `docs/TESTING.md`

The current invariant surface is concentrated in `CLAUDE.md` and expanded in
the architecture references: trust boundary, source isolation, JSONB handling,
engine parity, contract-first operations, migration rules, multi-source
identity, and pricing table ownership.

### Agent operation content

The repo has a large markdown skill surface:

- `skills/RESOLVER.md` routes agent intent.
- `skills/**/SKILL.md` contains executable agent procedures.
- `skills/conventions/*.md` carries cross-cutting behavior rules.
- `skills/migrations/*.md` carries downstream agent migration playbooks.
- `docs/guides/*.md` and `recipes/*.md` provide task-oriented operator playbooks.

This material is operational content, not ordinary prose docs. A docs PR should
avoid treating every skill file as a public user guide.

### Generated or drift-guarded surfaces

These files are derived or explicitly guarded against drift:

- `llms.txt`
- `llms-full.txt`
- `docs/eval/METRIC_GLOSSARY.md`

`scripts/llms-config.ts` is the source for `llms.txt` and `llms-full.txt`.
`CLAUDE.md` states that changes to `CLAUDE.md` or reference docs require
regenerating the LLM bundles with `bun run build:llms`.

### Historical, design, and archive material

These should not be treated as current install or runtime authority without an
explicit current-state banner:

- `CHANGELOG.md`
- `TODOS.md`
- `docs/GBRAIN_V0.md`
- `docs/designs/*`
- `docs/issues/*`
- `docs/proposals/*`
- `docs/incidents/*`
- `docs/plans/*`

They are valuable for provenance and roadmap context, but they can contain old
counts, old defaults, or pre-implementation design language.

## Changelog-First Drift Baseline

The first executable issue should not start by rewriting entrypoints. It should
build a current-capabilities ledger from `CHANGELOG.md`, then compare docs
against that ledger.

Execution artifact:

- `docs/docs-consolidation/05-current-capabilities-ledger.md`

The latest release window changes the docs problem in concrete ways:

- `0.42.52.0` makes autopilot/supervisor/sync/status reliability current docs
  territory: autopilot has one brain-wide maintenance pass, supervisor recovery
  is self-healing, `sources status` reports active syncs, `status --fast` and
  `--deadline-ms` provide budgeted snapshots, and the sync stall watchdog has a
  tunable no-progress abort.
- `0.42.51.0` makes sync reliability and performance current docs territory:
  active sync locks are not stale sync, checkpoint corruption is
  repaired/constrained, and force-break-lock must report no-lock cases
  honestly.
- `0.42.50.0` confirms CI reliability and environment isolation are part of
  the current contributor contract, not tribal maintainer knowledge.
- `0.42.49.0` adds opt-in pacing as the supported answer for large embed
  backfills and shared DB pressure.
- `0.42.48.0` adds explicit brain-repo durability commands, so source-backed
  pages need backup guidance beyond "the DB is backed up."
- `0.42.47.0` adds brain-resident skillpacks and `gbrain advisor`, so agent
  docs must distinguish repo-bundled skills from brain-published skills.
- `0.42.46.0` makes cross-source read federation a current, intentional read
  scope rather than an accidental gap.
- `0.42.45.0` adds spend posture controls, making cost policy separate from
  search-mode selection.
- `0.42.44.0` confirms tutorials remain part of the live operational surface:
  a single stale external link can break the install/deploy path.
- `0.42.43.0` adds push-based context as a current capability:
  `volunteer_context`, `gbrain volunteer-context`, `gbrain watch`, rolling
  retrieval-reflex windows, volunteered-context feedback stats, suppression
  semantics, and transaction-pooler CI coverage.
- `0.42.42.0` changes CLI operational expectations: teardown is bounded at
  teardown time, operation verdicts own exit codes, PGLite errors no longer
  report success, and piped output gets an explicit flush window.
- `0.42.41.0` and the nearby release wave harden data durability, source
  isolation, sync/lock behavior, provider input typing, remote grants, and
  doctor correctness.

Docs consolidation must therefore treat "not wrong but incomplete for the
current version" as a first-class drift class. Some docs should be retired or
labelled historical, but many should be evolved to include these current
capabilities.

## Consolidation Findings

Status taxonomy artifact:

- `docs/docs-consolidation/06-documentation-status-taxonomy.md`

### 1. Install surface sprawl

The install story is spread across `README.md`, `AGENTS.md`,
`INSTALL_FOR_AGENTS.md`, `docs/INSTALL.md`, tutorials, and MCP client pages.
That is acceptable only if each surface has a clear job:

- `README.md`: choose the path and route to the canonical detailed page.
- `AGENTS.md`: agent protocol and mandatory safety gates.
- `INSTALL_FOR_AGENTS.md`: agent-executed install flow.
- `docs/INSTALL.md`: compact human reference.
- `docs/tutorials/*`: guided learning path.
- `docs/mcp/*`: client-specific connection reference.

Current risk: quick-start snippets in `README.md` and `docs/INSTALL.md` show
`gbrain init --pglite` without carrying the same mandatory agent search-mode
stop gate that `AGENTS.md` and `INSTALL_FOR_AGENTS.md` emphasize.

PR direction: add a short agent-execution warning to README and `docs/INSTALL.md`
that points agents to `INSTALL_FOR_AGENTS.md` and the search-mode confirmation
gate, while keeping human CLI snippets concise.

### 2. Search-mode default wording conflict

Observed tension:

- `src/core/search/mode.ts` defines the search-time fallback as
  `DEFAULT_SEARCH_MODE = 'balanced'`. If `config.search.mode` is unset or
  invalid, `resolveSearchMode()` resolves to `balanced`.
- `src/commands/init-mode-picker.ts` runs after schema initialization in both
  PGLite and Postgres init paths. It persists a recommended mode: `tokenmax`
  for the general Sonnet/Opus/unknown case, `conservative` for Haiku-class
  subagent tier or no OpenAI key.
- `INSTALL_FOR_AGENTS.md` describes the install-time auto-applied choice as a
  default. `README.md` describes the runtime fallback/default bundle as
  `balanced`.
- `CLAUDE.md` and `skills/conventions/search-modes.md` contain detailed search
  mode tables and cache-key semantics.

PR direction: stop using one overloaded word, "default", for two different
states. Entry points should distinguish:

- runtime fallback when `search.mode` is unset: `balanced`
- fresh-init recommended/persisted mode: usually `tokenmax`, with documented
  conservative exceptions

### 3. Skill count drift

Pre-cleanup observed counts and claims from the frozen inventory:

- `scripts/llms-config.ts` and generated `llms.txt` said "26 fat-markdown skills."
- `CLAUDE.md` said the repo shipped 29 skills.
- `README.md` and `docs/INSTALL.md` said "43 skills."

Current rebased checkout counts after the consolidation edits:

- `openclaw.plugin.json#skills`, which is the runtime skillpack manifest read
  by `src/core/skillpack/bundle.ts`, currently lists 38 scaffolded skills.
- `skills/manifest.json` currently lists 52 resolver/registry entries.
- A repo metadata count finds 53 `skills/**/SKILL.md` files.
- The broader `skills/` documentation area contains 57 files when resolver and
  shared markdown files are included, excluding conventions and migrations.

This may be definition drift rather than a runtime bug. The docs need one
canonical count definition, for example "curated scaffolded skills" vs
"SKILL.md files in repo" vs "skills plus shared rule files."

PR direction: either remove numeric skill counts from broad entrypoints or
replace them with a generated/current count from the skillpack manifest. If a
number is necessary for the install surface, use the manifest count, not a glob
over `skills/**/SKILL.md`.

### 3a. Generated LLM map fork gap

Observed tension:

- `AGENTS.md` tells forks to regenerate `llms.txt` and `llms-full.txt` with a
  fork-specific `LLMS_REPO_BASE` before publishing.
- `scripts/llms-config.ts` implements that override.
- The checked-in `llms.txt` and `llms-full.txt` still point at upstream
  `https://raw.githubusercontent.com/garrytan/gbrain/master/...` URLs.

PR direction: keep this separate from an upstream docs PR. For the fork itself,
regenerate the LLM maps with the fork URL base before publishing.

### 4. E2E test count drift

Observed tension:

- `AGENTS.md` and `docs/RELEASING.md` say local CI runs "all 29 E2E files."
- The current checkout has 149 `test/e2e/*.test.ts` files.
- `scripts/run-e2e.sh` falls back to the full `test/e2e/*.test.ts` glob.
- `scripts/ci-local.sh` computes `EXPECTED_ALL` dynamically from that glob.

PR direction: avoid brittle hard-coded counts in docs that describe moving test
suites. Prefer "all selected E2E files" or derive the count from the selector
when a number is necessary.

### 5. MCP HTTP docs have an old alternatives page

Observed tension:

- `docs/mcp/DEPLOY.md` describes `gbrain serve --http` as v0.26.0+ with OAuth
  2.1 and says OAuth tables work on both PGLite and Postgres, while the legacy
  bearer fallback is Postgres-only.
- `docs/mcp/ALTERNATIVES.md` still says the built-in HTTP transport is v0.22.7+,
  bearer-auth/Postgres-only, and that PGLite is local-only.
- `SECURITY.md` also retains older bearer-token/Postgres-only wording for
  remote MCP.
- `src/commands/serve-http.ts` now routes the HTTP auth/admin surface through
  an engine-aware SQL adapter and comments that `gbrain serve --http` works
  against PGLite brains too.

PR direction: make `docs/mcp/ALTERNATIVES.md` and the relevant `SECURITY.md`
sections defer protocol/version truth to `docs/mcp/DEPLOY.md`, or update their
notes to the current OAuth 2.1/PGLite+Postgres framing.

### 6. Historical docs need clearer archive labeling

Several useful files are historical or forward-looking but live near current
references:

- `docs/GBRAIN_V0.md`
- `docs/designs/*`
- `docs/issues/*`
- `docs/proposals/*`
- `docs/incidents/*`
- `TODOS.md`

PR direction: add a small archive/current-state convention. Historical docs can
stay, but their header should say whether they are current reference, design
record, incident record, or backlog/archive.

## Suggested Docs-Only PR Shape

The smallest coherent PR should avoid rewriting the docs system. It should:

1. Add or update short "source of truth" callouts in the main entrypoints.
2. Normalize search-mode wording across README, AGENTS, install docs, and
   search-mode references by naming the two states separately: runtime fallback
   vs init-time recommendation.
3. Replace brittle numeric claims for skills and E2E files with either generated
   counts or count-free wording. If an install surface keeps a skill count, it
   must name the manifest or command that produced that count.
4. Update search/retrieval and eval-capture docs for current mode bundle knobs
   and the persisted `embedding_column` replay field.
5. Update engine/storage docs for live `postgres`/`pglite` support, PGLite
   tiering nuance, and the two `StorageConfig` meanings.
6. Update thin-client docs for remote doctor, `get_brain_identity` fields,
   transport split, and legacy bearer compatibility.
7. Update `docs/mcp/ALTERNATIVES.md` and stale `SECURITY.md` wording to defer
   MCP protocol truth to `docs/mcp/DEPLOY.md`.
8. Add archive/status labels only where historical docs currently look like
   live reference.
9. Regenerate `llms.txt` and `llms-full.txt` only if their source text changes
   or if publishing this fork with a fork-specific URL base.

## Proof Map

| Claim | Proof level | Evidence |
|---|---|---|
| `00-upstream-base.md` was reviewed | code_proven | Direct file read |
| Inventory covers documentation-like files in the baseline checkout | code_proven | `01-documentation-manifest.tsv` has 350 rows generated from the refreshed `understand-anything` scan metadata; it is a frozen pre-consolidation snapshot |
| Test fixture docs are separated from public docs | code_proven | Manifest role column marks test and fixture support paths |
| Installed Understand refresh completed | code_proven | `.understand-anything/knowledge-graph.json` has 14,004 nodes, 19,949 edges, 9 layers, and 6 tour steps after the v0.42.52.0 rebase refresh |
| Understand graph reference validation has no broken refs | code_proven | Fresh validation found 0 broken edge, layer, or tour references; `.understand-anything/fingerprints.json` covers 2,599 files |
| Search-time fallback is `balanced` | code_proven | CodeGraph trace to `DEFAULT_SEARCH_MODE` and `resolveSearchMode()` in `src/core/search/mode.ts` |
| Fresh init persists a recommended search mode | code_proven | CodeGraph trace to `runModePicker()` in `src/commands/init-mode-picker.ts` and both init paths in `src/commands/init.ts` |
| Skillpack manifest currently has 38 scaffolded skills | code_proven | `openclaw.plugin.json#skills` count; `loadBundleManifest()` and `bundledSkillSlugs()` use that manifest |
| Skill resolver manifest currently has 52 entries | code_proven | `skills/manifest.json#skills` count |
| Current checkout has 53 `skills/**/SKILL.md` files | code_proven | `rg --files skills -g 'SKILL.md'` count |
| Current checkout has 149 E2E test files | code_proven | Fresh count from `rg --files test/e2e -g '*.test.ts'`; `scripts/run-e2e.sh` and `scripts/ci-local.sh` use dynamic globs |
| Current release baseline is v0.42.52.0 | code_proven | `VERSION` and top of `CHANGELOG.md` |
| Changelog-to-current-capabilities ledger exists | implemented | `docs/docs-consolidation/05-current-capabilities-ledger.md` |
| Documentation status taxonomy exists | implemented | `docs/docs-consolidation/06-documentation-status-taxonomy.md` |
| Current HTTP OAuth path is engine-aware | code_proven | CodeGraph trace to `src/commands/serve-http.ts`, `GBrainOAuthProvider`, and PGLite OAuth bootstrap logic |
| Generated LLM maps are still upstream-linked in this fork | code_proven | Direct reads of `llms.txt`, `llms-full.txt`, `AGENTS.md`, and `scripts/llms-config.ts` |
| No GBrain runtime proof was attempted | implemented | This task intentionally avoided runtime commands by instruction |

## Open Questions For The PR

- Should README keep both search-mode facts inline, or link to one canonical
  search-mode reference after naming runtime fallback vs init recommendation?
- Should public docs use the current 37-entry skillpack manifest count, or drop
  numeric skill counts from broad entrypoints entirely?
- Should historical design docs receive a lightweight status banner, or should
  only entrypoints and known conflicts be patched in the first PR?
- Should `docs/docs-consolidation/*` stay in the upstream PR as review/handoff
  artifacts, or be kept fork-local after maintainers review the proposed docs
  changes?
