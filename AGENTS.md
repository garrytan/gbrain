# Agents working on GBrain

This is your install + operating protocol. Claude Code reads `./CLAUDE.md` automatically.
Everyone else (Codex, Cursor, OpenClaw, Aider, Continue, or an LLM fetching via URL):
start here.

> **Default: add memory to the existing agent.** Preserve its identity and unrelated instructions. Start keyless; automatic capture and paid enrichment are opt-in. No bootstrap interview or private repository is required.
>
> **Inside Grok Bot or Muse:** follow [Grok Bot](docs/guides/grok-bot.md) or [Muse](docs/guides/muse.md). The recommended path connects an isolated thin CLI to a brain on the user's own computer, published with `gbrain mcp expose --funnel` when needed; use the isolated [in-agent setup](docs/guides/in-agent-setup.md) when no machine stays online. Use the absolute recorded launcher on every call. Sources organize local memory; they do not isolate agents that share files or credentials. Do not mark generated skills or routines as activated without native-harness evidence.
>
> **Existing hosted brain:** follow [hosted harness access](docs/guides/hosted-harness-access.md). Choose native OAuth/PKCE or a private machine handoff for the intended harness. For login links, clients, permissions, or token lifecycle, follow [MCP administration](docs/mcp/ADMIN.md) or `skills/mcp-access/SKILL.md`. A URL or ordinary OAuth token is not owner administration authority.
>
> **Creating a new personal agent, explicitly requested by the user:** follow [BOOTSTRAP_FOR_AGENTS.md](BOOTSTRAP_FOR_AGENTS.md), then return here for the operating protocol.

## Install (5 min)

<!-- npm-trap + #218 recovery: canonical copy lives in README.md ("Install" warning) — sync edits. -->
1. Install gbrain via Bun (the canonical path):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   export PATH="$HOME/.bun/bin:$PATH"
   bun install -g github:garrytan/gbrain
   ```
   If `bun install -g` aborts or `gbrain doctor` reports `schema_version: 0`,
   the CLI prints a recovery hint pointing at [#218](https://github.com/garrytan/gbrain/issues/218).
   Run `gbrain apply-migrations --yes --no-autopilot-install` to recover without installing services, or fall back to the
   deterministic install: `git clone https://github.com/garrytan/gbrain.git ~/gbrain && cd ~/gbrain && bun install && bun link`.
2. Init keyless memory: `gbrain init --pglite --no-embedding` (zero-config). For 1000+ files or
   multi-machine sync, init suggests Postgres + pgvector via Supabase.
3. **STOP — ask the user about search mode.** `gbrain init` auto-applied a
   default but printed a 9-cell cost matrix (mode × downstream model)
   preceded by `[AGENT]` markers. You MUST relay the matrix to the operator
   and confirm their choice before continuing. Cost spread between corners
   is 25x — silent acceptance is the wrong default. See
   [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) Step 3.5 for the
   exact ask-the-user protocol. Same banner fires on `gbrain post-upgrade`
   for existing users (search modes were added in v0.32.3).
4. Read [`./INSTALL_FOR_AGENTS.md`](./INSTALL_FOR_AGENTS.md) for the full step-by-step
   flow (keyless memory, optional API capabilities, maintenance, verification).

## Memory operating protocol

Recall relevant saved context before answering. Save explicit requests to remember with provenance; confirm corrections against the stored record. Automatic capture requires opt-in. Withdrawal (`forget`) removes a fact from active memory; history, source material, and private backups may remain. Never promise physical erasure. Verify changes with actual GBrain calls and distinguish a local test from a new-conversation test in the harness.

Durable preferences and facts belong in shared memory when the user wants them
recalled later. Transient task state, credentials, local configuration, and harness
activation state do not. Remote `put_page` saves references as text without inline
graph extraction; stdio has best-effort startup/idle sweeps, while HTTP requires
explicit host maintenance or authorized `add_link` calls. Configured model
providers can receive text; Markdown export is not a full database backup.
Read [memory boundaries](docs/guides/memory-boundaries.md) before promising
portability, graph freshness, privacy, or recovery.

## Read this order

1. `./AGENTS.md` (this file) — install + operating protocol.
2. [`./CLAUDE.md`](./CLAUDE.md) — orientation + resolver: architecture, cross-cutting
   invariants, the reference map, inline ship rules. It routes to on-demand detail docs:
   [`./docs/architecture/KEY_FILES.md`](./docs/architecture/KEY_FILES.md) (per-file index —
   read a file's entry before editing it), [`./docs/TESTING.md`](./docs/TESTING.md) (test
   tiers + isolation lint + E2E lifecycle), and
   [`./docs/architecture/thin-client.md`](./docs/architecture/thin-client.md) (remote-MCP seam).
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
  [`docs/mcp/DEPLOY.md`](./docs/mcp/DEPLOY.md),
  [`docs/guides/remote-mcp.md`](./docs/guides/remote-mcp.md) (`gbrain mcp expose`).
- **Bring in your chat history:** `gbrain transcripts ingest` imports a
  downloaded ChatGPT / Claude export (or agent session logs); `gbrain connectors`
  connects the account and syncs new conversations live, incrementally and on an
  opt-in schedule (cookie/OAuth credentials stay on your machine, 0600). Full
  guide: [`docs/guides/chat-connectors.md`](./docs/guides/chat-connectors.md).
- **Debug:** [`docs/GBRAIN_VERIFY.md`](./docs/GBRAIN_VERIFY.md),
  [`docs/guides/minions-fix.md`](./docs/guides/minions-fix.md), `gbrain doctor --fix`.
  Database unreachable — or any `GBRAIN_DB_ACCESS <reason>` marker in gbrain
  output: `gbrain engine status --probe` (which engine, where its URL comes from,
  classified reachability), then `gbrain db-repair` to diagnose and
  `gbrain db-repair --yes` to apply safe fixes. All three are engine-free — they
  work while the database is down. Full loop:
  [`docs/ENGINES.md`](./docs/ENGINES.md#engine-detection-and-access-repair).
  Doctor residue (`timeline_history`, `derived_visibility`, `safe_index_pending`):
  preview `gbrain doctor --remediation-plan` (or `gbrain repair`), then, after the
  user agrees, `gbrain doctor --remediate --yes --include-repairs --max-usd <n>`
  or `gbrain repair <kind> --apply` on the brain host. After an upgrade, follow
  [recover after upgrading](./docs/guides/repair.md#recover-after-upgrading-to-this-release).
  A Google or GitHub item held after repeated failures (doctor
  `connector_held_items`, `gbrain waiting` says coverage is partial):
  `gbrain sources status <id>`, fix the cause, then after the user agrees
  `gbrain sources retry-held <id>` and `gbrain sync --source <id>`
  ([held items](./docs/guides/google-connect.md#held-items)). A refused
  write names its reason and recovery command
  ([write refusal reasons](./docs/guides/write-refusals.md)). A managed sync
  blocked with `checkpoint_validation_timeout`: run the printed commands
  (`gbrain repair request-indexes --apply` when an index is missing or INVALID,
  then the printed `gbrain sync --source <id> --no-pull --retry-failed …`);
  doctor `persistence_request_growth` warns before lifetime request IDs run out.
- **Migrate / upgrade:** `gbrain upgrade` (binary self-update + schema migrations + post-upgrade prompts),
  [`docs/UPGRADING_DOWNSTREAM_AGENTS.md`](./docs/UPGRADING_DOWNSTREAM_AGENTS.md),
  [`skills/migrations/`](./skills/migrations/), `gbrain apply-migrations --yes --no-autopilot-install` (manual migration orchestration without service installation).
- **Eval retrieval changes:** capture is off by default. To benchmark a
  retrieval change against real captured queries, set
  `GBRAIN_CONTRIBUTOR_MODE=1`, then `gbrain eval export --since 7d > base.ndjson`
  and `gbrain eval replay --against base.ndjson`. For public benchmark
  coverage (LongMemEval, ground-truth scoring), `gbrain eval longmemeval
  <dataset.jsonl>` runs against an isolated in-memory PGLite
  per question — your `~/.gbrain` is never opened. Full guide:
  [`docs/eval-bench.md`](./docs/eval-bench.md).
- **Drive the brain to a target health score:** preview, then agree.
  `gbrain doctor --remediation-plan --json` previews job steps and the
  PROTECTED repair steps (each marked "requires user agreement", with its
  exact command); after the user agrees,
  `gbrain doctor --remediate --yes --include-repairs --target-score 90 --max-usd 5`
  runs the repairs (even when the score target is unreachable) and walks the
  dependency-ordered job plan, re-checking score between steps. The cap is
  cumulative across `--resume`; a paid step that would exceed it is not
  started while free steps still run. Without `--include-repairs`, repair
  steps are listed as skipped. `--json` classifies each finding `cleared`,
  `pending`, `consent_required`, `operator_required` or `unsupported`.
  Stale extraction uses source-scoped database pages, including DB-only
  pages; it does not require a repository sync first. Empty brains (no
  entity pages) or unconfigured embedding keys hit a `max_reachable_score`
  ceiling: job steps stop with what's missing, while included repair steps
  still run.
  Three phase handlers (synthesize / patterns / consolidate) are
  PROTECTED — only trusted local callers can submit them; MCP cannot.
  Reference: [`docs/architecture/topologies.md`](./docs/architecture/topologies.md).
- **Track a founder/company over time:** when an entity has
  typed metric claims in its `## Facts` fence (`metric: mrr`, `value: 50000`,
  `unit: USD`, `period: monthly` columns), run
  `gbrain eval trajectory <entity-slug>` for the chronological history
  with regressions auto-flagged, or `gbrain founder scorecard <entity-slug>`
  for a four-signal JSON rollup (claim_accuracy / consistency /
  growth_trajectory / red_flags). MCP op `find_trajectory` exposes the
  same data — read scope, visibility-filtered for remote callers.
  `gbrain think` uses this substrate automatically on temporal /
  knowledge_update intent (default ON; flip `think.trajectory_enabled=false`
  to opt out). Non-metric event rows (`meeting`, `job_change`,
  `location_change`) ride through the same pipeline via `facts.event_type`;
  pass `kind: 'event'` or `'all'` to `find_trajectory` to query them.
- **Answer "who is waiting on me?":** connect the user's Google account once
  (`gbrain google setup` — two user interactions; relay the `[SHOW USER]`
  blocks verbatim), then `gbrain waiting --json` returns the ranked people
  waiting on the user, what they promised, evidence quotes, and Gmail deep
  links. Manage loops with `gbrain loops done|drop|mute`. It refuses on
  stale data and names the exact sync command to run first. Guides:
  [`docs/guides/google-connect.md`](./docs/guides/google-connect.md) (setup +
  every error and its fix),
  [`docs/guides/open-loops.md`](./docs/guides/open-loops.md) (how detection
  works); the harness protocol lives in
  [`skills/google-loops/SKILL.md`](./skills/google-loops/SKILL.md).
- **Contribute code:** [`CONTRIBUTING.md`, "Where does my change go?"](./CONTRIBUTING.md#where-does-my-change-go)
  names the files, registry, regenerate command and smallest test for a storage method,
  schema migration, doctor check, CLI-only command, HTTP route or sync phase. A branch written
  before refactor wave 1: follow the moved-symbol map in
  [`docs/architecture/wave-1-porting.md`](./docs/architecture/wave-1-porting.md).
- **Everything else:** [`./llms.txt`](./llms.txt) is the full documentation map.
  [`./llms-full.txt`](./llms-full.txt) is the same map with core docs inlined for
  single-fetch ingestion.

## Before shipping

Easiest path: `bun run ci:local` runs the full CI gate inside Docker (gitleaks,
guards + typecheck, then 4-shard parallel unit + E2E against four pgvector
containers plus a transaction-mode PgBouncer; unit phase keeps `DATABASE_URL`
unset) and tears down. Use `bun run ci:local:diff` for the
diff-aware subset during fast iteration on a focused branch. Requires Docker
(Docker Desktop / OrbStack / Colima) and `gitleaks` (`brew install gitleaks`).

Fastest path, with a Ubicloud token (`UBICLOUD_API_KEY` or
`UBICLOUD_API_TOKEN`): `bun run ci:ubicloud` runs the same gate across ten
ephemeral VMs in about five minutes, uncommitted edits included
(`ci:ubicloud:diff` for the diff-aware subset). See "Ubicloud fan-out" in
[`docs/TESTING.md`](./docs/TESTING.md).

Manual path: `bun test` plus the E2E lifecycle described in `./CLAUDE.md` (spin
up the test Postgres container, run `bun run test:e2e`, tear it down).

Ship via the `/ship` skill, not by hand. The full release + contributor process
(CHANGELOG voice, version-locations sync, PR conventions, community-PR-wave) lives in
[`./docs/RELEASING.md`](./docs/RELEASING.md); read it before shipping.

**Always use PATCH without asking**, including the initial release choice;
override `/ship`'s MINOR/MAJOR prompts. Auto-allocate past collisions, sync all
version stamps and the PR title, then report the number. This changes numbering
only: scope, merge, deployment, paid-work and validation approvals still apply.

## Privacy

Never commit real names of people, companies, or funds into public artifacts. See the
Privacy rule in `./CLAUDE.md`. GBrain pages reference real contacts; public docs must
use generic placeholders (`alice-example`, `acme-example`, `fund-a`).

## Forks

If you are a fork, regenerate `llms.txt` + `llms-full.txt` with your own URL base before
publishing: `LLMS_REPO_BASE=https://raw.githubusercontent.com/your-org/your-fork/main bun run build:llms`.
