# CLAUDE.md

## Jarvis KOS v2 fork — read first (Lucien's context)

This repo is a **fork of `garrytan/gbrain`**, not a vanilla install. When
working on this codebase, before touching anything else:

1. Read [`skills/kos-jarvis/README.md`](skills/kos-jarvis/README.md) — the
   fork-local extension pack boundary. **All Jarvis-specific logic lives
   under `skills/kos-jarvis/`**. Never modify `src/*`, `skills/RESOLVER.md`
   outside the `## KOS-Jarvis extensions` append-only section, or other
   upstream `skills/*`. If you think you need to change upstream, file an
   issue on the fork instead so we can evaluate whether it's worth the
   merge-conflict tax.
2. Read [`docs/JARVIS-ARCHITECTURE.md`](docs/JARVIS-ARCHITECTURE.md) — the
   full migration story (v1 Python/shell → v2 GBrain TS + Gemini shim),
   current deployment (launchd / kos.chenge.ink / Notion Knowledge Agent
   / OpenClaw feishu), and the Jarvis triangle (KOS compiles ↔ Notion
   operates ↔ OpenClaw executes). Latest sync story: **§6.22 v0.31.2
   (2026-05-09)**.
3. Read [`skills/kos-jarvis/TODO.md`](skills/kos-jarvis/TODO.md) — current
   outstanding work (P0/P1/P2). Check here before suggesting "what should
   we do next?"

### Fork-specific rules (override upstream behavior)

- **Embeddings now native** via v0.27 Vercel AI SDK gateway
  (`google:gemini-embedding-001` + `--embedding-dimensions 1536`).
  M3 cutover landed 2026-05-10: gemini-embed-shim retired, all 2718
  pages re-embedded into a clean native vector space, shim launchd
  service bootout'd, `skills/kos-jarvis/gemini-embed-shim/` archived.
  Production env (5 plists + `~/.gbrain/config.json`) carries
  `GOOGLE_GENERATIVE_AI_API_KEY` + `GBRAIN_EMBEDDING_MODEL` +
  `GBRAIN_EMBEDDING_DIMENSIONS=1536`. **Don't reintroduce
  `OPENAI_BASE_URL` or `OPENAI_API_KEY=stub` to plists** — it would
  silently route around the native gateway.
- **Chinese-first knowledge base.** Postgres tsvector has no CJK
  tokenizer, so **compound CJK queries (4+ Han characters without
  whitespace)** cannot be served by keyword search and require the
  vector path. English queries and 2-3 char standalone CJK terms
  match fine via body-fragment containment (see §6.25 for the
  2026-05-15 15-query probe). Operationally: always ensure vector
  search is live (kos-compat-api reachable,
  `GOOGLE_GENERATIVE_AI_API_KEY` env set) before declaring queries
  broken — the modal operator query on this brain is a compound CJK
  phrase that depends on it.
- **9 KOS page kinds coexist with GBrain's 20-dir MECE.** KOS `kind`
  frontmatter (source/entity/concept/project/decision/synthesis/comparison/
  protocol/timeline) is preserved on every page; it drives kos-jarvis
  quality gates (evidence threshold per kind) while GBrain's directory
  placement follows upstream RESOLVER.md. Mapping lives in
  `skills/kos-jarvis/type-mapping.md`.
- **`kos.chenge.ink` is the stable external boundary.** External systems
  (Notion Knowledge Agent, OpenClaw feishu cron) never talk to gbrain
  directly — they hit the compat-api. If you change request/response
  shape, notify Lucien. The historical command-mapping doc at
  `skills/kos-jarvis/_archived/feishu-bridge/SKILL.md` (archived
  2026-05-05) records the v1→v2 cutover layout for reference.
- **Production engine is Postgres, not PGLite.** `~/.gbrain/config.json`
  must say `"engine": "postgres"` + `"database_url": "postgresql://chenyuanquan@127.0.0.1:5432/gbrain"`.
  Running `gbrain init --pglite ...` (e.g. for a M3 pilot) will
  **clobber** this global config — always pass `--dir /tmp/...` AND
  manually inspect/restore `~/.gbrain/config.json` after pilot work.
  Backup at `~/.gbrain/config.json.before-sync-fix` (2026-05-09).
- **Secrets stay out of git.** `scripts/launchd/*.plist` is gitignored;
  only `*.plist.template` is tracked. `.env.local` (contains
  `NANO_BANANA_API_KEY` + `KOS_API_TOKEN`) is also gitignored.

### Upstream sync policy

- Cherry-pick `garrytan/gbrain:master` monthly.
- Prefer minimal conflict: if upstream touches `skills/RESOLVER.md`,
  resolve by keeping our `## KOS-Jarvis extensions` section at the end.
- If upstream fundamentally changes `src/core/ai/gateway.ts` (the v0.27
  embedding gateway), our shim strategy may need re-evaluation. M3
  cutover is the long-term fix.
- **Upstream `CLAUDE.md`-style content** (Architecture, Key files,
  Testing, Build, Pre-ship, CHANGELOG voice, etc.) lives in
  [`docs/CLAUDE-UPSTREAM.md`](docs/CLAUDE-UPSTREAM.md), NOT this file.
  Future upstream `CLAUDE.md` conflicts merge there. Keep this file
  fork-only.

---

## Two organizational axes (must-know for any brain query)

GBrain knowledge is organized along two orthogonal axes:

- **Brain** — WHICH DATABASE. Personal brain is `host`. Mountable team
  brains via `gbrain mounts add`. Routing: `--brain`, `GBRAIN_BRAIN_ID`,
  `.gbrain-mount` dotfile.
- **Source** — WHICH REPO INSIDE THE DATABASE. A brain holds many
  sources (wiki, gstack, openclaw, essays). Slugs scope per source.
  Routing: `--source`, `GBRAIN_SOURCE`, `.gbrain-source` dotfile.

Both axes follow the same 6-tier resolution pattern. See
`docs/architecture/brains-and-sources.md` for diagrams and
`skills/conventions/brain-routing.md` for the agent decision table.

For our fork: brain = `host`, sources = `default` (the only one).

## Skills + routing

29 upstream skills + 14 fork-local kos-jarvis skills (manifest at
`skills/manifest.json`, total 49+ post-v0.31.2). Routing table at
`skills/RESOLVER.md` — fork's `## KOS-Jarvis extensions` section is
append-only at the END of the file.

When the user's request matches an available skill, **invoke via the
Skill tool as the FIRST action**. Don't answer directly, don't use
other tools first. The skill's specialized workflow produces better
results than ad-hoc answers. Examples:

- "is this worth building", brainstorming → `office-hours`
- bugs / errors / "why is this broken" → `investigate`
- ship / deploy / push / "commit and ship" → `ship`
- code review / "check my diff" → `review`
- update docs after shipping → `document-release`
- weekly retro → `retro`
- design system / brand → `design-consultation`
- visual audit / polish → `design-review`
- architecture review → `plan-eng-review`

For brain operations specifically:
- query / search → `query` (or `brain-ops` for read-enrich-write loops)
- ingest a link / article / tweet → `idea-ingest`
- ingest video / audio / book → `media-ingest`
- ingest meeting transcript → `meeting-ingestion`
- enrich an entity → `enrich` (single) / `enrich-sweep` (bulk, fork)
- daily lint / patrol → `kos-patrol` (fork) — runs daily 08:07 cron

**NEVER hand-roll ship operations.** Don't manually `git commit + push +
gh pr create` when `/ship` is available. /ship handles VERSION bump,
CHANGELOG, document-release, pre-landing review, test coverage audit.
Manual PR creation skips all of these.

## Reference: where things live

- Upstream gbrain context (architecture, key files, testing, build,
  ship workflows, CHANGELOG voice, etc.):
  [`docs/CLAUDE-UPSTREAM.md`](docs/CLAUDE-UPSTREAM.md)
- Fork architecture + sync stories:
  [`docs/JARVIS-ARCHITECTURE.md`](docs/JARVIS-ARCHITECTURE.md)
- Fork extension boundary + state:
  [`skills/kos-jarvis/README.md`](skills/kos-jarvis/README.md)
- Fork outstanding work:
  [`skills/kos-jarvis/TODO.md`](skills/kos-jarvis/TODO.md)
- Consolidation roadmap (M2/M3 milestones, fork shrinkage plan):
  [`docs/KOS-JARVIS-CONSOLIDATION-PLAN.md`](docs/KOS-JARVIS-CONSOLIDATION-PLAN.md)
- Skill routing table (upstream + fork):
  [`skills/RESOLVER.md`](skills/RESOLVER.md)
