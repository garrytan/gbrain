# Current Capabilities Ledger

Status: changelog-derived baseline for docs consolidation issues #2-#14

Proof level: `code_proven` static documentation and source inspection only.
No GBrain runtime command, local brain home, local corpus path, service,
migration, import, sync, or Docker lifecycle command was run.

Baseline:

- Current upstream commit: `090bb53203557f5659563ea28c1c847c32167aeb`
- Current upstream version: `0.42.44.0`
- Primary release window: `0.42.44.0` through `0.42.41.0`
- Supporting release window for drift classification: `0.42.40.0` through
  `0.42.20.0`

## How To Use This Ledger

For the rest of this docs-only PR, treat `CHANGELOG.md` as the release
evolution ledger. A doc is not automatically stale just because a later release
exists. Classify it against the current capability it claims to document:

- `current`: accurately represents the current capability for its intended
  scope.
- `incomplete-current`: mostly true, but missing current behavior a reader
  needs to operate correctly.
- `contradictory`: says something that conflicts with current source, current
  docs authority, or the changelog-derived capability.
- `historical`: useful release/design/archive material, but not current
  operational guidance.
- `missing`: the current capability has no reader-usable docs surface yet.

`docs/docs-consolidation/*` is analysis output, not upstream documentation
input. Do not count this ledger as proof that the public docs are fixed.

## Capability Matrix

| Release | Current capability or design semantic | Documentation obligation | Current docs status | Follow-up |
|---|---|---|---|---|
| `0.42.44.0` | Tutorials are part of the live operational surface; the personal-brain AlphaClaw link was fixed because a stale deploy link broke the path. | Treat tutorials as live install/deploy docs, not archive examples. | `current` for the specific link fix; broader tutorial routing still needs the final consistency pass. | #14 |
| `0.42.43.0` | Push-based context is current: `volunteer_context`, `gbrain volunteer-context`, `gbrain watch`, rolling-window retrieval reflex, volunteered-vs-used stats, deterministic rationales, slug-only suppression under windows, privacy-stripped synopses. | Public and agent docs must explain when the brain volunteers context, when an agent should call the op, and when watch is appropriate. | `current`: `docs/guides/push-context.md`, `CLAUDE.md` reference map, `docs/TESTING.md`, `docs/architecture/KEY_FILES.md`. `incomplete-current`: `README.md`, `docs/INSTALL.md`, `INSTALL_FOR_AGENTS.md`, and `docs/guides/search-modes.md` do not route readers to push-context in the operational flow. | #4, #5, #6, #9 |
| `0.42.43.0` | Transaction-pooler teardown coverage is part of local CI; `doctor` exit-verdict sweep was completed; raw exit-code writes are structurally guarded. | Testing/release docs should describe the current CI gate without brittle counts; operational docs should not imply the old force-exit banner is normal. | `current`: `AGENTS.md`, `docs/TESTING.md`, `docs/architecture/KEY_FILES.md`. `incomplete-current`: production troubleshooting has no central path yet. | #10, #13, #14 |
| `0.42.42.0` | CLI teardown is bounded at teardown time, not before the operation handler. Slow operations should not be killed mid-run with false success. | Docs that discuss command reliability, poolers, or scripted usage should describe truthful exit verdicts and bounded teardown only where operator-relevant. | `current`: `docs/TESTING.md` and `KEY_FILES.md` cover the contract. `missing`: operator-facing failure-mode checklist. | #10 |
| `0.42.42.0` | PGLite error exits report non-zero, and piped output is explicitly flushed before process exit. | Agent docs and production checklists should treat exit status and complete piped output as reliable after this release. | `current`: test docs. `incomplete-current`: user/agent install docs do not mention this when teaching verification. | #6, #10 |
| `0.42.41.0` | Conversation facts survive fence reconciliation; destructive extract phases no longer full-walk after failed sync; net-negative fact reconciles warn. | Maintenance/dream/autopilot docs should avoid implying all fact rows are regenerated from fences. | `current`: `KEY_FILES.md`. `missing`: concise operator explanation in the future maintenance/mode-selection path. | #9, #10 |
| `0.42.41.0` | `put_page` write-through is source-local; missing source repo paths are skipped instead of leaking writes into a global repo path. | Brain/source docs and Brain Repo Layout must make source-local write-through and source ownership explicit. | `current`: `AGENTS.md`, `CLAUDE.md`, `docs/architecture/brains-and-sources.md` for the two-axis model. `missing`: central Brain Repo Layout. | #8 |
| `0.42.41.0` | Engine reconnect is a first-class method on PGLite and Postgres; autopilot survives transient DB errors. | Production docs should frame reconnect/autopilot failure modes around current self-healing behavior, not old crash-loop expectations. | `current`: `KEY_FILES.md`. `missing`: production checklist/failure-mode guide. | #10 |
| `0.42.41.0` | Concurrent PGLite process locking uses heartbeat and dead/stalled-holder detection. | Docs should not describe PGLite as generally multi-process safe; they should explain where single-writer constraints still matter. | `current`: `docs/architecture/serve-sync-concurrency.md` and `docs/guides/push-context.md` include PGLite contention notes. `incomplete-current`: central install/topology docs do not branch on this. | #5, #7, #10 |
| `0.42.41.0` | Timeline dedup index drift is detected and repaired; `doctor` reports it. | Verification docs should route operators to doctor for schema/index drift instead of manual DB archaeology. | `current`: `AGENTS.md` common tasks and `docs/GBRAIN_VERIFY.md` direction. `incomplete-current`: production path missing. | #10 |
| `0.42.41.0` | Cwd `.env` `DATABASE_URL` no longer silently retargets the brain; `GBRAIN_DATABASE_URL` and config-file authority remain distinct. | Production and secret/config docs should mention generic `DATABASE_URL` gotchas with current precedence and mitigation. | `incomplete-current`: scattered references exist in security/minions docs; no central production checklist. | #10 |
| `0.42.41.0` | `gbrain sync --strategy code` honors `.gitignore` and skips generated/vendor dirs. | Code-brain and split-engine docs should avoid telling operators to hand-filter common generated dirs. | `current`: `KEY_FILES.md` and topology code-brain notes. `incomplete-current`: central topology branch missing. | #7, #8 |
| `0.42.41.0` | OpenAI-compatible asymmetric embedding `input_type` reaches the wire; model/provider config matters to retrieval quality. | Mode/provider docs should route readers to current provider semantics and avoid stale provider tables. | `incomplete-current`: provider docs exist, but no central mode/production decision tree. | #9, #10 |
| `0.42.41.0` | OAuth scope handling defaults omitted authorize scope to the registered grant and honors legacy token source grants through a shared parser. | MCP/auth docs should explain current OAuth/scoped access and legacy bearer compatibility without treating bearer/Postgres-only as the main current path. | `current`: `docs/mcp/DEPLOY.md` for OAuth setup. `contradictory`: `SECURITY.md` and `docs/mcp/ALTERNATIVES.md` still carry older bearer/Postgres-only framing. | #11 |
| `0.42.40.0` | Free-text fields bound for JSONB are NUL/surrogate-sanitized centrally; identity fields still fail closed. | Architecture/testing docs should preserve the free-text vs identity-field distinction. | `current`: `docs/TESTING.md`, `KEY_FILES.md`. Public install docs do not need detail unless troubleshooting extraction. | #14 |
| `0.42.39.0` | Retrieval Reflex pointer layer is current and on by default; policy skill can be installed for agents; doctor checks reflex health. | Search/mode docs should teach pull retrieval and push pointers together. | `current`: `docs/guides/push-context.md`, `CLAUDE.md`. `incomplete-current`: `docs/guides/search-modes.md` remains a pre-push-context skillpack guide. | #9 |
| `0.42.36.0` | Large sync is resumable, durable, single-flight, and banks progress through checkpoints. | Production docs should teach resume/partial semantics and not frame killed sync as total loss. | `current`: `KEY_FILES.md`. `missing`: central production path. | #10 |
| `0.42.35.0` | Sync recovers from reachable history-rewrite anchors by tree diff and full sync is authoritative for deletes. | Brain Repo Layout and production docs should distinguish source-backed pages from manual `put_page` pages. | `incomplete-current`: source model exists; operational layout guide missing. | #8, #10 |
| `0.42.34.0` | Typed-edge relational retrieval is current for relationship questions in `balanced` and `tokenmax`; source-scoped, deterministic, bounded. | Mode selection must include relational retrieval and avoid describing hybrid retrieval as vector+keyword only. | `current`: `README.md` capability prose and `docs/architecture/RETRIEVAL.md`. `contradictory/incomplete-current`: `docs/guides/search-modes.md` describes an older three-command model and omits relational retrieval. | #9 |
| `0.42.33.0` | Re-clone only deletes clones GBrain owns; unowned working trees are read-only/refused before destructive filesystem ops. | Brain Repo Layout and production docs should tell users which paths GBrain owns or only indexes. | `missing`: central layout/ownership guidance. | #8, #10 |
| `0.42.26.0` | Supabase docs now prefer Transaction pooler for main URL and Session pooler/direct URL for IPv4 hosts. | Install and production docs should centralize the pooler/base-URL decision. | `current`: `docs/tutorials/personal-brain.md`, `docs/guides/live-sync.md`, `docs/GBRAIN_VERIFY.md`. `missing`: production checklist. | #5, #10 |
| `0.42.25.0` | Chat model pricing has one canonical table; cost caps cover Opus 4.8 and provider-prefixed ids. | Mode/production docs should frame cost controls as current guardrails, not loose estimates. | `current`: `CLAUDE.md` invariant. `missing`: mode/production decision surface. | #9, #10 |
| `0.42.24.0` | Minion lock hot path routes to direct session pool on Supabase; PGLite is a no-op path. | Production worker docs should treat direct pool configuration as operationally important. | `current`: personal-brain/live-sync docs for direct URL; `missing`: central production path. | #10 |
| `0.42.23.0` | Worker/supervisor support `--nice`; effective niceness is observable in stats/doctor. | Production operations should include priority/concurrency distinction. | `incomplete-current`: minions docs exist, but not central checklist. | #10 |
| `0.42.22.0` | Wedged queues are detected by worker self-probe and supervisor forward-progress watchdog; doctor surfaces `wedged_queue`. | Production troubleshooting should teach forward-progress health, not just process liveness. | `current`: queue/minions references. `missing`: production failure-mode checklist. | #10 |
| `0.42.21.0` / `0.42.20.0` | Dream/background work, reconnect, and background drain fixes make command/cycle cleanup more reliable. | Maintenance-mode docs should reflect current behavior and avoid historical "connect() has not been called" framing except as historical troubleshooting. | `current`: changelog and KEY_FILES. `missing`: mode-selection and production guide. | #9, #10 |

## Documentation Classification Snapshot

### Current

- `docs/guides/push-context.md`: source-backed current guide for
  `volunteer_context`, `gbrain volunteer-context`, `gbrain watch`, rolling
  retrieval-reflex windows, feedback stats, and privacy behavior.
- `docs/architecture/RETRIEVAL.md`: current retrieval pipeline reference,
  including typed-edge relational retrieval.
- `AGENTS.md` and `CLAUDE.md`: current agent/router authority for trust
  boundary, read order, push-context reference, search-mode cost matrix, and
  release/test discipline.
- `docs/TESTING.md`: current test/proof map for teardown, volunteer context,
  PGLite/PGbouncer behavior, OAuth, and source isolation.
- `docs/tutorials/personal-brain.md`, `docs/guides/live-sync.md`, and
  `docs/GBRAIN_VERIFY.md`: current Supabase pooler and IPv4 direct-URL
  guidance.

### Incomplete-Current

- `README.md`: strong product overview and LLM entrypoint links, but it lacks a
  Current Version callout, does not route to one human operational center, and
  does not route users toward push-context/mode-selection decisions.
- `docs/INSTALL.md`: useful compact install page, but it is too thin to be the
  Human Operational Center; it also repeats brittle skill counts and does not
  carry the agent search-mode stop gate.
- `INSTALL_FOR_AGENTS.md`: strong agent flow and search-mode gate, but it still
  repeats brittle skill counts and does not yet branch through current operating
  model, topology, production, and push-context decisions.
- `docs/architecture/topologies.md`: useful deployment topology reference, but
  it mixes "who uses/owns the brain" with "where the DB/server lives" and does
  not yet cover family/team/company variants as branchable operating models.
- `docs/architecture/brains-and-sources.md`: current two-axis model, but not a
  user-facing Brain Repo Layout guide.
- `docs/mcp/DEPLOY.md`: mostly current OAuth authority, but it contains an
  "All 30 operations" remote wording that conflicts with its own `localOnly`
  explanation and the current operation trust boundary.

### Contradictory

- `docs/mcp/ALTERNATIVES.md`: still frames built-in HTTP transport as
  v0.22.7+, bearer-auth, Postgres-only, and PGLite-local-only. Current MCP
  authority is OAuth 2.1 from v0.26.0+, with engine-aware OAuth/admin SQL and
  legacy bearer as compatibility.
- `SECURITY.md`: still recommends the old token-only v0.22.7 framing and says
  `gbrain serve --http` is Postgres-only because of `access_tokens` and
  `mcp_request_log`. Current source/docs authority shows OAuth/admin/audit SQL
  routing through engine-aware adapters.
- Hard-coded skill counts: `README.md` and `docs/INSTALL.md` say 43 skills,
  `CLAUDE.md` says 29 skills, and `scripts/llms-config.ts` / `llms.txt` say 26
  fat-markdown skills. The runtime-facing manifest surfaces have different
  scopes and must not be collapsed into one bare number.
- Hard-coded E2E count claims: `AGENTS.md` and `docs/RELEASING.md` still say
  local CI runs all 29 E2E files while the checkout currently has many more and
  CI scripts compute the set dynamically.

### Historical

- `CHANGELOG.md`: authoritative release evolution, not install truth.
- `docs/GBRAIN_V0.md`, `docs/designs/*`, `docs/issues/*`, `docs/proposals/*`,
  `docs/incidents/*`, `docs/plans/*`, and `TODOS.md`: useful provenance and
  future/history material, but should not look like current operational
  guidance without a status banner.

### Missing

- README Current Version and "For LLMs and coding agents" callout with routes
  to `llms.txt`, `llms-full.txt`, `AGENTS.md`, and `INSTALL_FOR_AGENTS.md`.
- One Human Operational Center in `docs/INSTALL.md`.
- One Agent Operational Center in `INSTALL_FOR_AGENTS.md`.
- Branchable Operating Model and Deployment Topology decision trees.
- Brain Repo Layout guide that separates editable source, managed/generated
  output, source ownership, and backup implications.
- Mode Selection Guide covering `gbrain search`, `gbrain think`, `gbrain
  dream` / autopilot, retrieval reflex, `volunteer_context`, `gbrain
  volunteer-context`, and `gbrain watch`.
- Production operational path and checklist.
- Status-label convention for historical/design/deprecated/superseded docs.

## Proof Map

| Claim | Proof level | Evidence |
|---|---|---|
| Current version is `0.42.44.0` | `code_proven` | `VERSION`, top of `CHANGELOG.md`, `docs/docs-consolidation/00-upstream-base.md` |
| Push-context docs exist and are current for v0.42.43.0 surfaces | `code_proven` | `CHANGELOG.md`, `docs/guides/push-context.md`, `CLAUDE.md`, `docs/TESTING.md`, `docs/architecture/KEY_FILES.md` |
| Teardown/exit-verdict behavior is documented in maintainer proof surfaces | `code_proven` | `CHANGELOG.md`, `docs/TESTING.md`, `docs/architecture/KEY_FILES.md` |
| Relational retrieval is current in architecture docs but missing from the old search-mode skill guide | `code_proven` | `CHANGELOG.md`, `README.md`, `docs/architecture/RETRIEVAL.md`, `docs/guides/search-modes.md` |
| MCP docs contain current OAuth authority and stale bearer/Postgres-only framing in separate pages | `code_proven` | `docs/mcp/DEPLOY.md`, `docs/mcp/ALTERNATIVES.md`, `SECURITY.md`, `docs/architecture/KEY_FILES.md` |
| Skill/test count claims drift across docs | `code_proven` | `README.md`, `docs/INSTALL.md`, `CLAUDE.md`, `AGENTS.md`, `docs/RELEASING.md`, `scripts/llms-config.ts`, `llms.txt`, prior inventory counts |
| No runtime proof was attempted | `implemented` | This pass used static reads, CodeGraph, GitHub issue reads, and text searches only |

## Strongest Safe Truth

The first docs consolidation move should not delete large blocks of older docs.
The safer current baseline is a mixed strategy:

- Update docs that are accurate but incomplete for v0.42.44.0.
- Mark historical/design docs when their trust level is ambiguous.
- Route users through one human path and one agent path.
- Fix direct contradictions where current docs conflict with current source or
  current docs authority.
- Remove or qualify brittle counts unless their source and scope are explicit.
