# Skills

Read the skill files in `skills/` before doing brain operations. GBrain ships 50+ skills
(the current list lives in `skills/manifest.json`) organized by `skills/RESOLVER.md`
(`AGENTS.md` is also accepted):

**Core 8:** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills:** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms, data-research, minion-orchestrator.
`minion-orchestrator` is the single skill for both lanes of background work (shell jobs
via `gbrain jobs submit shell`, LLM subagents via `gbrain agent run`), with shared
Preconditions and trigger routing limited to what the skill covers.

**Skillify loop:** skillify (the markdown orchestration), skillpack-check
(agent-readable health report).

**Finding the right skill for a task over MCP:** `list_skills` takes an optional
`query` (full MCP surface, host catalog) and returns the skills whose name,
triggers or description share words with it, best first, with
`match.matched_on` saying which of the three matched; skills that share no
words are left out, and `limit` (default 10) caps the list. It is a word-overlap
ranking, not a model call, so it is free and instant, and the same call
without `query` returns the whole catalog exactly as before. On a brain that
serves a shared catalog (`schema_version: 2`, or shared skills activated)
`query` is refused with `invalid_params` instead of being ignored; narrow with
`section` there. **Say to your agent:** *"Which of my brain's skills fit
preparing for this meeting?"*

**Brain-resident skillpacks + advisor:** A brain repo can carry its
own publishable skillpack (`brain_resident: true` in `skillpack.json` + `schema_pack`);
`gbrain skillpack init-brain-pack` scaffolds one with a 5-section machine-parseable README.
Connecting harnesses discover it on `gbrain sources add` (Topology A advisory, bounded nag
via `nag-state.ts`) and over MCP via the source-scoped `list_brain_skillpack` op +
`get_skill --source_id` (gated by `mcp.publish_skills`). The bundled `gbrain-advisor` skill
+ `gbrain advisor` op compute a ranked, read-only list of high-leverage actions from brain
state (8 collectors in `src/core/advisor/`); `--json`+exit codes for CI/cron, local-only
`--apply <id>` behind confirm, exposed over MCP behind `mcp.publish_advisor` (read-only; on
by default for the local stdio server, opt-in for remote HTTP; an explicit `false` hides it). Thin clients cannot install a brain pack as a binary.

**Routing-table compression:** `skills/functional-area-resolver/` —
two-layer dispatch pattern for shrinking large AGENTS.md / RESOLVER.md files
(>=12KB) without losing routing accuracy. Replaces one row per skill with one
entry per functional area, where each area declares its sub-skills in a
`(dispatcher for: ...)` clause. The static-prompt analog of hierarchical agent
routing (AnyTool [arXiv:2402.04253](https://arxiv.org/abs/2402.04253), RAG-MCP
[arXiv:2505.03275](https://arxiv.org/html/2505.03275v1), Anthropic Agent Skills
progressive disclosure). Empirically validated across Opus 4.7 / Sonnet 4.6 /
Haiku 4.5: +13 to +17pp over the verbose baseline at 48% the size (25KB → 13KB
on a real fork). The `(dispatcher for: ...)` clause is the load-bearing signal
— strip it and lenient accuracy collapses to 41.7% on Sonnet (the
`resolver-of-resolvers` ablation case). A/B eval surface lives at
`evals/functional-area-resolver/` (outside `skills/` deliberately so the
skillpack bundler doesn't ship eval infrastructure to downstream installs):
gateway-routed TypeScript harness, 20 training + 5 held-out fixtures, strict +
lenient scoring, three committed cross-model receipts in `baseline-runs/`.
Receipt header binds (model, prompt_template_hash, fixtures_hash, harness_sha,
ts) so future contributors can verify reproduction. Companion `rescore.mjs`
re-scores existing JSONL with lenient tolerance for zero API cost. Reproduce
with `cd evals/functional-area-resolver && node harness.mjs --model
{opus|sonnet|haiku}` (~$0.30–1.70 per model). Open follow-ups (held-out corpus
growth, cross-vendor verification, hierarchical area-of-areas, an embedding-based
pre-router, and the run-1 vs run-2 prompt-design ablation methodology) are tracked
in [TODOS.md](../../TODOS.md#functional-area-resolver-follow-ups-v03230).

**Operational health:** smoke-test (8 post-restart health checks; bounded
auto-fix for Bun, CLI, and Zod CJS; read-only worker topology via native supervisor
status with duplicate detection; DB, gateway, API key, brain repo; user-extensible
via `~/.gbrain/smoke-tests.d/*.sh`).

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.
