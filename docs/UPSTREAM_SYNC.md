# Upstream Reference Log

This file records which commits from **garrytan/gbrain** (upstream) have been
adopted, skipped, or deferred by **meghendra6/mbrain**. `mbrain` is now its own
product with a local-first memory architecture; upstream remains a reference
source for targeted cherry-picks, not a release authority.

Use this file when evaluating an upstream cherry-pick or historical
decision. Find the latest `git merge-base HEAD upstream/master`, then read the
sections below to learn which later upstream commits were (a) adopted, (b)
explicitly skipped (and why), or (c) deferred for a later sync. Do not
re-import an already adopted commit, and do not silently import a commit that
this log says was skipped for a reason.

## Remotes

```
origin    = git@github.com:meghendra6/mbrain.git      (primary)
upstream  = https://github.com/garrytan/gbrain.git    (reference)
```

If the `upstream` remote is missing:

```bash
git remote add upstream https://github.com/garrytan/gbrain.git
git fetch upstream --tags
```

## How to read this log

Each entry has three parts:

- **Adopted** — upstream commits whose effect is now in `mbrain`. Imported
  verbatim, cherry-picked, or re-implemented locally (noted per entry).
- **Skipped (permanent)** — upstream changes that will not land because they
  conflict with `mbrain`'s design (local-first focus, independent memory
  architecture, or product direction). Revisit only if the underlying decision
  changes.
- **Deferred (revisit)** — changes worth evaluating in a later sync, with
  the reason they were not done yet.

`mbrain` versions now follow `mbrain`'s own release story. Historical entries
in this file may mention earlier alignment decisions, but those are
archival context only. `CHANGELOG.md` explains the user-visible release; this
file explains upstream provenance when upstream code was considered.

---

## Sync 2026-05-01 — source-aware search ranking only

- **Project baseline before sync**: `8f24b92` (PR #80 — sync and release safety)
- **Reference upstream HEAD**: `18f5ba5` (upstream after v0.23.0, revert of JSONB double-encoding fix)
- **Prior classified upstream reference**: `b7e3005` (upstream v0.10.1, see 2026-04-17 entry)
- **Feature branch**: `codex/upstream-source-ranking-20260501`

Upstream changed heavily between `b7e3005..18f5ba5`: Minions, agent runtime,
dream cycles, multi-source brains, Code Cathedral/code indexing, frontmatter
guardrails, storage tiering, parallel sync, HTTP transport, and search ranking.
`mbrain` has since diverged toward a local-first durable memory substrate with
SQLite as the default and governed memory writes. This sync therefore adopts one
small search-quality idea and records the rest as skipped or deferred, rather
than treating upstream as a merge target.

### Adopted

| Upstream commit | What it does | How it landed in mbrain |
|---|---|---|
| `172b55b` (v0.22.0 source-aware search ranking) | Boosts high-signal curated sources so bulk/noisy notes do not swamp search results. | Reimplemented, not cherry-picked. Added `src/core/search/source-ranking.ts` with deterministic mbrain path factors (`originals/`, `concepts/`, `ideas/`, `systems/`, `projects/`, etc.) and applied it to `search` and `query` results. Did not import upstream SQL builders, env overrides, or hard-exclude behavior because mbrain's default engine is SQLite and ranking should stay engine-neutral. |

### Skipped for this sync

| Upstream area | Representative commits | Why not applied |
|---|---|---|
| Minions / jobs / agent runtime / plugin loader | `d861336`, `0e9f881`, `e3f7042`, `11abb24`, `ed900c8` | Product direction mismatch for now. `mbrain` is the durable memory layer under agents, not a competing agent runtime or job supervisor. |
| Dream/autopilot orchestration | `55ca498`, `e2961c0`, `5d9dc43`, `527b87b` | `mbrain` has its own memory-inbox, scenario-routing, and dream-cycle maintenance design. Upstream's orchestration model depends on Minions and should not be copied directly. |
| OpenClaw/native plugin/remote-first install flows | `314f961`, `d3b52ed`, `83e55ff` | Useful as reference for install friction, but the implementation is tied to upstream's public/OpenClaw distribution path. |
| Storage tiering and Supabase-only content flows | `52f9581` and related storage commits | Conflicts with mbrain's local-first default unless redesigned around local filesystem semantics first. |
| Code Cathedral/code indexing with bundled tree-sitter WASM | `f718c59` and related commits | Interesting, but too large for this sync and overlaps with mbrain's existing codemap/context-map workstreams. Needs a separate design if adopted. |

### Deferred (revisit)

| Upstream area | Representative commits | mbrain-shaped plan |
|---|---|---|
| Frontmatter guard / resolver warnings | `891c28b`, `17c3c43` | Fold the useful checks into existing `mbrain lint` and import validation instead of adding a separate upstream command surface. |
| Structured sync failures and skip-failed summaries | `08746b0`, `1e73e93` | Keep mbrain's fail-closed checkpoint behavior. Add stable error codes only if they improve retry UX without allowing partial sync to silently advance. |
| Parallel incremental sync | `e96f054` | Revisit after defining a local SQLite/PGLite writer-lock story. `mbrain import` already has staged workers; `sync` currently prioritizes correctness and checkpoint safety. |
| Migration/schema verification hardening | `08b3698`, `6966623`, `be8fffa` | Evaluate per engine. mbrain already has independent JSONB and sync-safety hardening, so only targeted gaps should land. |
| Source-aware ranking v2 | `172b55b` follow-ups | If ranking needs tuning, add data-driven evaluation against mbrain scenario fixtures before changing factors. |

### Verification performed

- `bun test test/source-ranking.test.ts test/hybrid-search.test.ts` — 8 pass, 0 fail.
- `bun test test/dedup.test.ts test/source-ranking.test.ts test/hybrid-search.test.ts test/local-offline.test.ts` — 45 pass, 0 fail.
- `bunx tsc --noEmit` — pass.
- `bun test --timeout 20000` — 1589 pass, 149 skip, 0 fail.

### How to continue from here

1. Use this section, not the raw merge-base, as the classification checkpoint.
2. Prefer reimplementation around mbrain invariants over cherry-picking upstream
   files that assume Minions, GStackBrain, OpenClaw, or hosted storage.
3. For the next sync, start with the deferred table above and require a focused
   test-first patch for each adopted upstream idea.

## Sync 2026-04-17 — this entry

- **Project baseline before sync**: `36eccd8` (PR #23 — technical link types in add_link)
- **Reference upstream HEAD**: `b7e3005` (upstream v0.10.1)
- **Prior merge-base**: `91ced66` (upstream v0.8.0; last brought in by PR #19 on 2026-04-16)
- **Feature branch**: `codex/upstream-sync-20260417`
- **Project version after sync**: `0.10.1` (last release before the independent `mbrain` identity split)

Upstream commits between `91ced66..b7e3005` (23 commits) were classified
and applied as follows.

### Adopted

| Upstream commit | What it does | How it landed in the project |
|---|---|---|
| `55d05f8`, `c8d6d59`, `baf3517`, `adb02b7` (VERSION parts), `f82978d` (VERSION parts), `13773be` (VERSION parts) | Bump `VERSION` / `package.json` / `skills/manifest.json` to `0.10.1`. | Applied later during the `mbrain` identity split to normalize release metadata. This was a one-time compatibility checkpoint, not an ongoing upstream-version policy. |
| `1e6d7e3` | Battle-tested skill patterns from production (ingest/enrich/maintain/briefing/query skills + `_brain-filing-rules.md` + voice/X recipe lessons). | Commit `5aa923e` — pre-GStackBrain snapshot adopted verbatim for untouched skills; `query/SKILL.md` merged (kept the project's *Technical Concept Queries* section + added upstream's *Citation in Answers* and *Search Quality Awareness*). |
| `80d00e7` | Adds `skills/_brain-filing-rules.md` to CLAUDE.md "Key files" list. | Commit `5aa923e` — line added after the `docs/local-offline.ko.md` entry. |
| `edc2174` + `87bb2a5` (publish hardening) | `mbrain publish` — shareable HTML with inline marked.js, AES-256-GCM encryption, XSS sanitization of markdown render. | Commit `c5b1aba` — took `upstream/master` versions of `src/commands/publish.ts`, `skills/publish/SKILL.md`, `test/publish.test.ts` (hardening already rolled in). Added `marked@^18.0.0` dep. Registered in `skills/manifest.json`. Wired in `src/cli.ts` CLI_ONLY + handleCliOnly. |
| `13fca37` + `54fdd4b` + `87bb2a5` (tool hardening) | `mbrain check-backlinks`, `mbrain lint`, `mbrain report`. Deterministic brain-quality tools, no DB, no LLM. `54fdd4b` renames `backlinks` → `check-backlinks` to avoid clashing with existing `get_backlinks` operation. | Commit `c5b1aba` — took `upstream/master` versions of `src/commands/{backlinks,lint,report}.ts` and their tests (hardening already rolled in). Wired in `src/cli.ts`. CLAUDE.md "Commands" section extended with the new tools. |

### Skipped (permanent)

| Upstream commit | What it does | Why skipped |
|---|---|---|
| `d798d81` | Rewrites `skills/migrations/v0.9.0.md` for upstream's smart-file-storage + publish release. | The project already owns `skills/migrations/v0.9.0.md` for the Technical Knowledge Map migration (commit `4a6170a`). Same filename slot, different intent. Keeping the project's file. |
| `7d49b8b`, `784b582` | Rewrite of README.md install block for upstream's clone-based install. | The project's README install block documents the dual-path (local/offline SQLite + managed Postgres) experience and already points at `meghendra6/mbrain`. Overwriting with upstream's text would regress the local/offline positioning. Individual improvements (PATH export note, optional-Anthropic messaging) can be cherry-picked later if needed. |
| `fa62e61` | Fixes URL `openclaw/alphaclaw` → `chrysb/alphaclaw` in README. | The project README never shipped that "Deploy AlphaClaw on Render" sentence, so there is nothing to fix. |
| `c2a14c9` | Smart file upload with TUS resumable protocol and `.redirect.yaml` pointers. | Supabase-storage-specific. The project's SQLite/local profile does not support TUS and its value proposition is "no cloud at all," so adding a TUS code path would bloat the local path without benefit. Revisit if `mbrain` introduces its own large-file handling. |
| `b7f3dc9` | Rewrites all skills to reference actual `mbrain files` commands. | Mixed upstream-command surface vs. current project command surface — upstream assumes features we have not adopted yet (`mbrain files verify`, `mbrain files mirror + redirect`, publish upload flow). Portions of the skill refresh already landed via `1e6d7e3` adoption. The rest depends on first accepting the upstream `files` command evolution, which is deferred. |
| `e5a9f01` (v0.10.0 GStackBrain) | Adds 16 new skills, `skills/RESOLVER.md`, `skills/conventions/`, `skills/_output-rules.md`, identity/soul layer. Rewrites existing skills into "conformance format" with YAML frontmatter (name/version/triggers/tools/mutating) + Contract/Anti-Patterns/Output Format/Phases sections. | Architectural choice, not a bug fix. The project currently runs the v0.4.0-shaped skills intentionally. Adopting GStackBrain is a product decision that needs maintainer sign-off; until then it stays out. |
| `b7e3005` (v0.10.1 autopilot/extract/features) | Adds `mbrain autopilot`, `mbrain extract`, `mbrain features` commands; depends on GStackBrain. | Depends on `e5a9f01`. Skipped with it. The autopilot idea is attractive but the current project's `setup-agent` + cron approach covers the same ground. |

### Deferred (revisit in a later sync)

| Upstream commit | What it does | Why deferred |
|---|---|---|
| `d547a64` | Search quality boost — compiled-truth ranking + `detail` parameter. Touches 15+ files in `src/core/search/` including `expansion.ts`. | The project has local modifications to `src/core/search/expansion.ts` (commit `894ba46`, "Keep local bootstrap honest about offline capabilities") and `hybrid.ts`. A clean port needs a focused diff to ensure the local/offline "no Anthropic key" branch keeps working. |
| `13773be` | Community fix wave — 10 PRs, 7 contributors. Touches embed/import/db/engines/pglite + 10 smaller changes. | Partially already landed via project cherry-picks (`5db918f`, `c0bcb2f`, `5b94039`). Rest needs per-engine diff because the project's `postgres-engine.ts` / `pglite-engine.ts` / `sqlite-engine.ts` have diverged. |
| `f82978d` | Security fix wave 2 + typed health-check DSL for integration recipes (changes `ngrok-tunnel.md` and friends). | The typed health-check DSL is independently useful. Partial security patches already applied via `5b94039`. Remaining changes need integration-command test coverage before landing. |
| `004ac6c` | `statement_timeout` scoped to search, `upload-raw` writes pointer JSON, publish inlines marked.js. | `publish` inlined-marked piece already adopted via `edc2174`. `upload-raw` pointer ties to the skipped TUS feature. The `statement_timeout` scoping is engine-level and should ride alongside the deferred `13773be` engine port. |

### Verification performed

- `bun test` — 547 pass, 123 skip (DATABASE_URL / API key gated E2E), 0 fail.
- Manual review of `src/cli.ts` routing against the project's existing `setup-agent` handler.
- Confirmed `backlinks` CLI alias still resolves to `get_backlinks` operation (the project's original per-page incoming-links reader) and `check-backlinks` routes to the new deterministic tool.
- `docs/UPSTREAM_SYNC.md` (this file) added so the next sync can pick up from here.

### How to continue from here (next sync)

1. `git fetch upstream`.
2. `git log 91ced66..upstream/master --oneline` (baseline for this log).
3. For each new upstream commit, either:
   - confirm it is already covered by an entry above (nothing to do), or
   - classify it as *Adopted / Skipped / Deferred* and add a row below.
4. Update the "Sync YYYY-MM-DD" section header and the "Prior merge-base" with the new baseline once you ship.
