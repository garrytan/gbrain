# Upstream Sync Log

This file tracks how far **meghendra6/gbrain** (this fork) has adopted commits
from **garrytan/gbrain** (upstream). The fork exists to add a local/offline
SQLite profile, local embedding runtime, agent auto-registration, and a
searchable technical knowledge map layer on top of upstream's managed
Postgres/PGLite architecture.

Use this file every time you pull from upstream. Find the latest
`git merge-base HEAD upstream/master`, then read the sections below to learn
which later upstream commits were (a) adopted, (b) explicitly skipped (and
why), or (c) deferred for a later sync. Do not re-merge an already-adopted
commit; do not silently import a commit that this log says was skipped for a
reason.

## Remotes

```
origin    = https://github.com/meghendra6/gbrain.git (fork)
upstream  = https://github.com/garrytan/gbrain.git   (canonical)
```

If the `upstream` remote is missing:

```bash
git remote add upstream https://github.com/garrytan/gbrain.git
git fetch upstream --tags
```

## How to read this log

Each entry has three parts:

- **Adopted** — upstream commits whose effect is now in fork master. Imported
  verbatim, cherry-picked, or re-implemented for the fork (noted per entry).
- **Skipped (permanent)** — upstream changes that will not land because they
  conflict with the fork's design (local/offline focus, fork-specific
  architecture, version slot collisions). Revisit only if the underlying
  decision changes.
- **Deferred (revisit)** — changes worth evaluating in a later sync, with
  the reason they were not done yet.

The fork's **version number tracks upstream's latest released version** (e.g.
upstream `0.10.1` → fork `0.10.1`). That policy makes sync state legible from
the CLI (`gbrain --version`) and the skills manifest, but it is deliberately
decoupled from content parity: matching version numbers do NOT imply matching
content. The content story for each version lives in `CHANGELOG.md`; the
commit-level accounting of what was adopted vs. skipped vs. deferred lives in
this file. Both are load-bearing. Never bump `VERSION` / `package.json` /
`skills/manifest.json` without also adding a `CHANGELOG.md` entry and a sync
log block here that explains which upstream commits the bump represents.

---

## Sync 2026-04-17 — this entry

- **Fork baseline before sync**: `36eccd8` (PR #23 — technical link types in add_link)
- **Upstream HEAD**: `b7e3005` (upstream v0.10.1)
- **Prior merge-base**: `91ced66` (upstream v0.8.0; last brought in by PR #19 on 2026-04-16)
- **Feature branch**: `codex/upstream-sync-20260417`
- **Fork version after sync**: `0.10.1` (aligned with upstream release number)

Upstream commits between `91ced66..b7e3005` (23 commits) were classified
and applied as follows.

### Adopted

| Upstream commit | What it does | How it landed in the fork |
|---|---|---|
| `1e6d7e3` | Battle-tested skill patterns from production (ingest/enrich/maintain/briefing/query skills + `_brain-filing-rules.md` + voice/X recipe lessons). | Commit `5aa923e` — pre-GStackBrain snapshot adopted verbatim for untouched skills; `query/SKILL.md` merged (kept fork's *Technical Concept Queries* section + added upstream's *Citation in Answers* and *Search Quality Awareness*). |
| `80d00e7` | Adds `skills/_brain-filing-rules.md` to CLAUDE.md "Key files" list. | Commit `5aa923e` — line added after the `docs/local-offline.ko.md` entry. |
| `edc2174` + `87bb2a5` (publish hardening) | `gbrain publish` — shareable HTML with inline marked.js, AES-256-GCM encryption, XSS sanitization of markdown render. | Commit `c5b1aba` — took `upstream/master` versions of `src/commands/publish.ts`, `skills/publish/SKILL.md`, `test/publish.test.ts` (hardening already rolled in). Added `marked@^18.0.0` dep. Registered in `skills/manifest.json`. Wired in `src/cli.ts` CLI_ONLY + handleCliOnly. |
| `13fca37` + `54fdd4b` + `87bb2a5` (tool hardening) | `gbrain check-backlinks`, `gbrain lint`, `gbrain report`. Deterministic brain-quality tools, no DB, no LLM. `54fdd4b` renames `backlinks` → `check-backlinks` to avoid clashing with existing `get_backlinks` operation. | Commit `c5b1aba` — took `upstream/master` versions of `src/commands/{backlinks,lint,report}.ts` and their tests (hardening already rolled in). Wired in `src/cli.ts`. CLAUDE.md "Commands" section extended with the new tools. |

### Skipped (permanent)

| Upstream commit | What it does | Why skipped |
|---|---|---|
| `55d05f8`, `c8d6d59`, `baf3517`, `adb02b7` (VERSION parts), `f82978d` (VERSION parts), `13773be` (VERSION parts) | Bump `VERSION` / `package.json` version (v0.8.1 → v0.10.1). | Per maintainer direction, the fork does not track upstream's version number directly. `package.json` stays at `0.9.0` (fork's own Technical Knowledge Map release); `VERSION` stays at `0.8.0` (last merge-base tag). Alignment is recorded in this log instead. |
| `d798d81` | Rewrites `skills/migrations/v0.9.0.md` for upstream's smart-file-storage + publish release. | The fork already owns `skills/migrations/v0.9.0.md` for the Technical Knowledge Map migration (commit `4a6170a`). Same filename slot, different intent. Keeping the fork's file. |
| `7d49b8b`, `784b582` | Rewrite of README.md install block for upstream's clone-based install. | The fork's README install block documents the dual-path (local/offline SQLite + managed Postgres) experience and already points at `meghendra6/gbrain`. Overwriting with upstream's text would regress the local/offline positioning. Individual improvements (PATH export note, optional-Anthropic messaging) can be cherry-picked later if needed. |
| `fa62e61` | Fixes URL `openclaw/alphaclaw` → `chrysb/alphaclaw` in README. | The fork's README never shipped that "Deploy AlphaClaw on Render" sentence, so there is nothing to fix. |
| `c2a14c9` | Smart file upload with TUS resumable protocol and `.redirect.yaml` pointers. | Supabase-storage-specific. The fork's SQLite/local profile does not support TUS and its value proposition is "no cloud at all," so adding a TUS code path would bloat the local path without benefit. Revisit if the fork introduces its own large-file handling. |
| `b7f3dc9` | Rewrites all skills to reference actual `gbrain files` commands. | Mixed upstream-command surface vs. fork-command surface — upstream assumes features we have not adopted yet (`gbrain files verify`, `gbrain files mirror + redirect`, publish upload flow). Portions of the skill refresh already landed via `1e6d7e3` adoption. The rest depends on first accepting the upstream `files` command evolution, which is deferred. |
| `e5a9f01` (v0.10.0 GStackBrain) | Adds 16 new skills, `skills/RESOLVER.md`, `skills/conventions/`, `skills/_output-rules.md`, identity/soul layer. Rewrites existing skills into "conformance format" with YAML frontmatter (name/version/triggers/tools/mutating) + Contract/Anti-Patterns/Output Format/Phases sections. | Architectural choice, not a bug fix. The fork currently runs the v0.4.0-shaped skills intentionally. Adopting GStackBrain is a product decision that needs maintainer sign-off; until then it stays out. |
| `b7e3005` (v0.10.1 autopilot/extract/features) | Adds `gbrain autopilot`, `gbrain extract`, `gbrain features` commands; depends on GStackBrain. | Depends on `e5a9f01`. Skipped with it. The autopilot idea is attractive but the current fork's `setup-agent` + cron approach covers the same ground. |

### Deferred (revisit in a later sync)

| Upstream commit | What it does | Why deferred |
|---|---|---|
| `d547a64` | Search quality boost — compiled-truth ranking + `detail` parameter. Touches 15+ files in `src/core/search/` including `expansion.ts`. | The fork has local modifications to `src/core/search/expansion.ts` (commit `894ba46`, "Keep local bootstrap honest about offline capabilities") and `hybrid.ts`. A clean port needs a focused diff to ensure the local/offline "no Anthropic key" branch keeps working. |
| `13773be` | Community fix wave — 10 PRs, 7 contributors. Touches embed/import/db/engines/pglite + 10 smaller changes. | Partially already landed via fork cherry-picks (`5db918f`, `c0bcb2f`, `5b94039`). Rest needs per-engine diff because the fork's `postgres-engine.ts` / `pglite-engine.ts` / `sqlite-engine.ts` have diverged. |
| `f82978d` | Security fix wave 2 + typed health-check DSL for integration recipes (changes `ngrok-tunnel.md` and friends). | The typed health-check DSL is independently useful. Partial security patches already applied via `5b94039`. Remaining changes need integration-command test coverage before landing. |
| `004ac6c` | `statement_timeout` scoped to search, `upload-raw` writes pointer JSON, publish inlines marked.js. | `publish` inlined-marked piece already adopted via `edc2174`. `upload-raw` pointer ties to the skipped TUS feature. The `statement_timeout` scoping is engine-level and should ride alongside the deferred `13773be` engine port. |

### Verification performed

- `bun test` — 547 pass, 123 skip (DATABASE_URL / API key gated E2E), 0 fail.
- Manual review of `src/cli.ts` routing against fork's existing `setup-agent` handler.
- Confirmed `backlinks` CLI alias still resolves to `get_backlinks` operation (fork's original per-page incoming-links reader) and `check-backlinks` routes to the new deterministic tool.
- `docs/UPSTREAM_SYNC.md` (this file) added so the next sync can pick up from here.

### How to continue from here (next sync)

1. `git fetch upstream`.
2. `git log 91ced66..upstream/master --oneline` (baseline for this log).
3. For each new upstream commit, either:
   - confirm it is already covered by an entry above (nothing to do), or
   - classify it as *Adopted / Skipped / Deferred* and add a row below.
4. Update the "Sync YYYY-MM-DD" section header and the "Prior merge-base" with the new baseline once you ship.
