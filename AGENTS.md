# Agents working on GBrain

This is your install + operating protocol. Claude Code reads `./CLAUDE.md` automatically.
Everyone else (Codex, Cursor, OpenClaw, Aider, Continue, or an LLM fetching via URL):
start here.

## Install (5 min)

1. Install gbrain via Bun (the canonical path):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   bun install -g github:garrytan/gbrain
   ```
   If `bun install -g` aborts or `gbrain doctor` reports `schema_version: 0`,
   the CLI prints a recovery hint pointing at [#218](https://github.com/garrytan/gbrain/issues/218).
   Run `gbrain apply-migrations --yes` to recover, or fall back to the
   deterministic install: `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`.
2. Init the brain: `gbrain init` (defaults to PGLite, zero-config). For 1000+ files or
   multi-machine sync, init suggests Postgres + pgvector via Supabase.
3. **STOP — ask the user about search mode.** `gbrain init` auto-applied a
   default but printed a 9-cell cost matrix (mode × downstream model)
   preceded by `[AGENT]` markers. You MUST relay the matrix to the operator
   and confirm their choice before continuing. Cost spread between corners
   is 25x — silent acceptance is the wrong default. See
   [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) Step 3.5 for the
   exact ask-the-user protocol. Same banner fires on `gbrain post-upgrade`
   for existing users (search modes were added in v0.32.3).
4. Read [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) for the full 9-step flow
   (API keys, identity, cron, verification).

## Read this order

1. `./AGENTS.md` (this file) — install + operating protocol.
2. [`./CLAUDE.md`](./CLAUDE.md) — architecture reference, key files, trust boundaries,
   test layout.
3. [`./docs/architecture/brains-and-sources.md`](./docs/architecture/brains-and-sources.md)
   — the two-axis mental model (brain = which DB, source = which repo in the DB). Every
   query routes on both axes. Read before writing anything that touches brain ops.
4. [`./skills/conventions/brain-routing.md`](./skills/conventions/brain-routing.md) —
   agent-facing decision table: when to switch brain, when to switch source, how
   cross-brain federation works (latent-space only; the agent decides).
5. [`./skills/RESOLVER.md`](./skills/RESOLVER.md) — skill dispatcher. Read before any task.

## Trust boundary (critical)

GBrain distinguishes **trusted local CLI callers** (`OperationContext.remote = false`,
set by `src/cli.ts`) from **untrusted agent-facing callers** (`remote = true`, set by
`src/mcp/server.ts`). Security-sensitive operations like `file_upload` tighten filesystem
confinement when `remote = true` and default to strict behavior when unset. If you are
writing or reviewing an operation, consult `src/core/operations.ts` for the contract.

## Common tasks

- **Configure:** [`docs/ENGINES.md`](./docs/ENGINES.md),
  [`docs/guides/live-sync.md`](./docs/guides/live-sync.md),
  [`docs/mcp/DEPLOY.md`](./docs/mcp/DEPLOY.md).
- **Debug:** [`docs/GBRAIN_VERIFY.md`](./docs/GBRAIN_VERIFY.md),
  [`docs/guides/minions-fix.md`](./docs/guides/minions-fix.md), `gbrain doctor --fix`.
- **Migrate / upgrade:** `gbrain upgrade` (binary self-update + schema migrations + post-upgrade prompts),
  [`docs/UPGRADING_DOWNSTREAM_AGENTS.md`](./docs/UPGRADING_DOWNSTREAM_AGENTS.md),
  [`skills/migrations/`](./skills/migrations/), `gbrain apply-migrations --yes` (manual schema-only).
- **Eval retrieval changes:** capture is off by default. To benchmark a
  retrieval change against real captured queries, set
  `GBRAIN_CONTRIBUTOR_MODE=1`, then `gbrain eval export --since 7d > base.ndjson`
  and `gbrain eval replay --against base.ndjson`. For public benchmark
  coverage (LongMemEval, ground-truth scoring), `gbrain eval longmemeval
  <dataset.jsonl>` (v0.28.8) runs against an isolated in-memory PGLite
  per question — your `~/.gbrain` is never opened. Full guide:
  [`docs/eval-bench.md`](./docs/eval-bench.md).
- **Drive the brain to a target health score (v0.36.4.0):** the one-command
  loop. `gbrain doctor --remediation-plan --json` previews what would be
  fixed; `gbrain doctor --remediate --yes --target-score 90 --max-usd 5`
  walks a dependency-ordered plan (sync before extract, embed after
  consolidate), re-checking score between every step, refusing to spend
  past the cost cap. Empty brains (no entity pages) or unconfigured embedding
  keys hit a `max_reachable_score` ceiling and bail with what's missing.
  Three phase handlers (synthesize / patterns / consolidate) are
  PROTECTED — only trusted local callers can submit them; MCP cannot.
  Reference: [`docs/architecture/topologies.md`](./docs/architecture/topologies.md)
  and the CHANGELOG entry for v0.36.4.0.
- **Track a founder/company over time (v0.35.7):** when an entity has
  typed metric claims in its `## Facts` fence (`metric: mrr`, `value: 50000`,
  `unit: USD`, `period: monthly` columns), run
  `gbrain eval trajectory <entity-slug>` for the chronological history
  with regressions auto-flagged, or `gbrain founder scorecard <entity-slug>`
  for a four-signal JSON rollup (claim_accuracy / consistency /
  growth_trajectory / red_flags). MCP op `find_trajectory` exposes the
  same data — read scope, visibility-filtered for remote callers. **v0.40.2.0:**
  `gbrain think` now uses this substrate automatically on temporal /
  knowledge_update intent (default ON; flip `think.trajectory_enabled=false`
  to opt out). Migration v82 added `facts.event_type` so non-metric event
  rows (`meeting`, `job_change`, `location_change`) ride through the same
  pipeline; pass `kind: 'event'` or `'all'` to `find_trajectory` to query
  them.
- **Everything else:** [`./llms.txt`](./llms.txt) is the full documentation map.
  [`./llms-full.txt`](./llms-full.txt) is the same map with core docs inlined for
  single-fetch ingestion.

## Before shipping

Easiest path: `bun run ci:local` runs the full CI gate inside Docker (gitleaks,
unit tests with `DATABASE_URL` unset, then all 29 E2E files sequentially against a
fresh pgvector container) and tears down. Use `bun run ci:local:diff` for the
diff-aware subset during fast iteration on a focused branch. Requires Docker
(Docker Desktop / OrbStack / Colima) and `gitleaks` (`brew install gitleaks`).

Manual path: `bun test` plus the E2E lifecycle described in `./CLAUDE.md` (spin
up the test Postgres container, run `bun run test:e2e`, tear it down).

Ship via the `/ship` skill, not by hand.

## Privacy

Never commit real names of people, companies, or funds into public artifacts. See the
Privacy rule in `./CLAUDE.md`. GBrain pages reference real contacts; public docs must
use generic placeholders (`alice-example`, `acme-example`, `fund-a`).

## Forks

If you are a fork, regenerate `llms.txt` + `llms-full.txt` with your own URL base before
publishing: `LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms`.
