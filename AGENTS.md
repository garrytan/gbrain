# AGENTS.md — AIMS Brain (engine repo `itradeaims-brain`)

You are working on **AIMS Brain** — the iTradeAIMS network's **owned** semantic-memory
+ code-intelligence engine. This is a **maintained fork** of `garrytan/gbrain`
(governance: ADR-0041 in `itradeaims-agent-workflows`), not Garry's personal-brain
product. Identity: **AIMS Brain** = the product · this repo `itradeaims-brain` = the
engine · `gbrain-immy` (Fly) = the served instance · `garrytan/gbrain` = upstream.

## What this brain is (and is NOT)
- It is iTradeAIMS infrastructure: a **pull-only derived index** (ADR-0038) over the
  iTradeAIMS repo network + MQL/C++ code-intelligence, queried by a coding-agent fleet
  and the AIMS MCP. `put_page` write-through is forbidden.
- It is NOT a personal knowledge brain, NOT a Telegram/OpenClaw agent, NOT a
  "billion-user" product. **Do not optimise for `brain_score` / BrainBench / longmemeval**
  — those are upstream's personal-wiki metrics; a code brain scores low on them
  structurally and that is fine. Health = the green integrity/sync/embed checks.

## Operating rules
- **Governance is the AIMS control plane** (`itradeaims-agent-workflows`), a SEPARATE
  authority (ADR-0031): it governs around this brain, never merges with it.
- **Engineering discipline is gbrain's own** — use `/ship`, the `VERSION` 5-file sync,
  and this repo's CI for engine releases. The architecture invariants in `CLAUDE.md`
  (trust boundary, engine parity, JSONB, migrations, contract-first) are load-bearing —
  follow them for any engine edit.
- **Do NOT apply upstream's privacy / responsible-disclosure rules** (the README/CLAUDE
  text about names like `Wintermute` / `Garry's OpenClaw`) — those are Garry's contacts,
  not ours. Our privacy rule: never expose real iTradeAIMS customers/contacts.
- **Upstream relationship:** we merge `garrytan/gbrain` INBOUND for engine + security
  fixes; we do NOT contribute outbound (`upstream` push is DISABLED). Keep `README.md`,
  this `AGENTS.md`, and the `CLAUDE.md` AIMS-Brain header as "keep ours" on merge.

## Governance scaffolding
- Engine design decisions → `docs/adr/` here. Engine specs/plans → `docs/superpowers/`.
- `/to-prd` `/to-issues` → this repo's own GitHub issues.
- Network/identity decisions live in the control plane, NOT here. Do not duplicate the
  AIMS-Brain glossary (it lives in `itradeaims-agent-workflows/CONTEXT.md`).

See `AIMS-BRAIN.md` for the full charter.

---

The sections below are the engine's practical install + operating protocol (inherited
from upstream gbrain, still correct for working on this engine). Claude Code reads
`./CLAUDE.md` automatically; everyone else (Codex, Cursor, OpenClaw, Aider, Continue,
or an LLM fetching via URL) starts here.

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

1. `./AIMS-BRAIN.md` — the AIMS Brain charter (identity, owned-fork relationship, boundaries).
2. `./AGENTS.md` (this file) — install + operating protocol.
3. [`./CLAUDE.md`](./CLAUDE.md) — orientation + resolver: the AIMS-Brain header (read first),
   then architecture, cross-cutting invariants, the reference map, inline ship rules. It
   routes to on-demand detail docs:
   [`./docs/architecture/KEY_FILES.md`](./docs/architecture/KEY_FILES.md) (per-file index —
   read a file's entry before editing it), [`./docs/TESTING.md`](./docs/TESTING.md) (test
   tiers + isolation lint + E2E lifecycle), and
   [`./docs/architecture/thin-client.md`](./docs/architecture/thin-client.md) (remote-MCP seam).
4. [`./docs/architecture/brains-and-sources.md`](./docs/architecture/brains-and-sources.md)
   — the two-axis mental model (brain = which DB, source = which repo in the DB). Every
   query routes on both axes. Read before writing anything that touches brain ops.
5. [`./skills/conventions/brain-routing.md`](./skills/conventions/brain-routing.md) —
   agent-facing decision table: when to switch brain, when to switch source, how
   cross-brain federation works (latent-space only; the agent decides).
6. [`./skills/RESOLVER.md`](./skills/RESOLVER.md) — skill dispatcher. Read before any task.

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

Manual path: `bun test` plus the E2E lifecycle described in `./CLAUDE.md` (spin
up the test Postgres container, run `bun run test:e2e`, tear it down).

Ship via the `/ship` skill, not by hand. The full release process (CHANGELOG voice,
version-locations sync, PR conventions) lives in
[`./docs/RELEASING.md`](./docs/RELEASING.md); read it before shipping.

## Privacy

Never expose real iTradeAIMS customers or contacts in public artifacts. (We do NOT
carry upstream's `Wintermute` / `Garry's OpenClaw` naming rules — those are Garry's
contacts.) Use generic placeholders in examples.
