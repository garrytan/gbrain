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
   operates ↔ OpenClaw executes). Latest sync story: **§6.33 v0.42.1.0
   upstream sync (2026-06-01, 27 commits / v0.41.14.0 → v0.42.1.0 / 605
   files; schema v97 → v111)**. Previous: §6.31 v0.41.14.0 sync
   (2026-05-26, schema v85 → v97); §6.30 v0.38.2.0 sync (2026-05-22,
   schema v78 → v85). Note §6.32 (2026-05-31) was the embedding
   convergence, not a sync.
3. Read [`skills/kos-jarvis/TODO.md`](skills/kos-jarvis/TODO.md) — current
   outstanding work (P0/P1/P2). Check here before suggesting "what should
   we do next?"

### Fork-specific rules (override upstream behavior)

- **Embeddings: OpenAI `text-embedding-3-large` @ 1536d via the avman.ai
  OpenAI-compatible relay** (§6.32 convergence, 2026-05-31). The whole
  brain (38,056 chunks: `default` 6,940 + `mailagent-emails` 31,116) was
  re-embedded into ONE coherent vector space after the prior state was
  found incoherent: `~/.gbrain/config.json` said
  `google:gemini-embedding-001`, but `default` actually held stale
  gemini-bridge-shim vectors (norm ~0.70, mislabeled `text-embedding-3-large`)
  and `mailagent-emails` held `zeroentropyai:zembed-1` (the daemon embedded
  these at ingest under a prior ZE-default config; mailagent itself only sends
  content via MCP `put_page` — `PageInput` has no embedding field, verified) —
  three mismatched spaces a single
  global query model could never serve. Production env (4 plists + `.env.local`
  + `~/.gbrain/config.json` + DB-plane `config` table — ALL must agree) carries
  `GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large`,
  `GBRAIN_EMBEDDING_DIMENSIONS=1536`, `OPENAI_API_KEY` (the avman relay key) +
  `OPENAI_BASE_URL=https://api.avman.ai/v1`. **`OPENAI_BASE_URL` is now
  INTENTIONAL and REQUIRED** — it routes the native `openai` recipe's
  `createOpenAI()` through the avman relay; the old M3 "never reintroduce
  OPENAI_BASE_URL" prohibition is RETIRED (that warning was about the
  retired gemini-embed-shim, not this deliberate convergence). Caveats baked
  in: the `litellm` recipe is **unusable** for embedding here (upstream gbrain
  bug — `diagnoseEmbedding` at `src/core/ai/gateway.ts:670` rejects it
  unconditionally), so we use the native `openai` recipe + `OPENAI_BASE_URL`;
  gbrain's embed path **mislabels** the per-chunk `model` column as the gateway
  default, so after any re-embed run `UPDATE content_chunks SET
  model='openai:text-embedding-3-large'` to fix the cosmetic label.
  `GOOGLE_GENERATIVE_AI_API_KEY` and any ZeroEntropy key are now **vestigial**
  for embedding (kept in env but unused). External writers (mailagent etc.) send
  content via MCP `put_page` (no client embedding possible — `PageInput` has no
  vector field), so the daemon embeds everything via openai@avman → past content
  re-embedded + new content auto-unifies. **No writer-side change needed**; the
  only rule is never wire a writer to bypass the daemon with pre-computed vectors. See §6.32.
- **Chinese-first knowledge base.** Postgres tsvector has no CJK
  tokenizer, so **compound CJK queries (4+ Han characters without
  whitespace)** cannot be served by keyword search and require the
  vector path. English queries and 2-3 char standalone CJK terms
  match fine via body-fragment containment (see §6.25 for the
  2026-05-15 15-query probe). Operationally: always ensure vector
  search is live (`gbrain serve --http` on :7225 reachable via
  `kos.chenge.ink`, `OPENAI_API_KEY` + `OPENAI_BASE_URL` (avman relay) env
  set in plist — §6.32) before declaring queries broken — the modal operator query on this
  brain is a compound CJK phrase that depends on it.
- **9 KOS page kinds coexist with GBrain's 20-dir MECE.** KOS `kind`
  frontmatter (source/entity/concept/project/decision/synthesis/comparison/
  protocol/timeline) is preserved on every page; it drives kos-jarvis
  quality gates (evidence threshold per kind) while GBrain's directory
  placement follows upstream RESOLVER.md. Mapping lives in
  `skills/kos-jarvis/type-mapping.md`.
- **`kos.chenge.ink` is the stable external boundary** (hostname unchanged
  across the 2026-05-17 cutover; only the origin server + port changed:
  fork-side `kos-compat-api :7225` Bearer → upstream native `gbrain serve
  --http :7225` OAuth 2.1 + MCP JSON-RPC). Cloudflared on mbp-office holds
  the public ingress; jarvis Mac runs the brain. External systems (Notion
  Knowledge Agent, mailagent future, OpenClaw feishu future) talk to
  `https://kos.chenge.ink` via OAuth + MCP wire; never gbrain CLI directly,
  never the retired KOS-v1 Bearer shape. Wire spec at
  [`docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md`](docs/EXTERNAL-CLIENTS-MCP-WIRE-HANDOFF.md)
  is self-contained for any caller. If you change MCP op signatures or
  OAuth client scopes, notify Lucien.
- **OAuth client identities**: legacy clients live at
  `~/.gbrain/oauth-clients/<name>.json` (gitignored, mode 600, plaintext
  `client_secret`); newer ones (post-v0.42) live in the **`oauth_clients` DB
  table** with a *hashed* secret (shown ONCE at registration — capture it then,
  it's unrecoverable). Never commit secrets. If lost:
  `bin/gbrain auth revoke-client <client_id>` then re-register via
  `bin/gbrain auth register-client`. There is **no update command** — to change
  an existing client's `federated_read` (cross-source read), `UPDATE
  oauth_clients SET federated_read = ARRAY[...]` directly (daemon reads it live;
  keeps the creds). Active clients:
  - `kos-worker` — Notion Knowledge Agent (default).
  - `lucien-cli` — Lucien ad-hoc CLI.
  - `mailagent` — chat-save (write `default`); **`federated_read = {default,
    mailagent-emails, omada}`** so its LLM can query across all three (2026-06-02).
  - `mailagent-bulk` — bulk email ingest (write/read `mailagent-emails`).
  - `omada-sentiment` — the Omada 舆情/竞品 sentiment system's daily writer
    (write+read `omada`, `client_credentials`; created 2026-06-02; secret in
    `~/.gbrain/oauth-clients/omada-sentiment.secret.txt`, mode 600).
  - `feishu` — dormant since 2026-05-05.
- **MCP skill publishing is ENABLED** (`mcp.publish_skills = true`,
  `mcp.skills_dir = <repo>/skills`, both in the DB config plane; 2026-06-02). The
  MCP server publishes all 56 skills (upstream + fork, fork under `kos-jarvis/…`
  names) via `list_skills` / `get_skill` so a thin client (mailagent's LLM, etc.)
  can discover + follow them, then call the CRUD MCP tools. Publishing is GLOBAL
  (one catalog for all OAuth clients — no per-client skill allowlist); curate on
  the *client/prompt* side (e.g. mailagent should use `query`/`idea-ingest`/
  `brain-ops`, not the `kos-jarvis/*` batch/operator skills).
- **Retired (2026-05-17, §6.28)**: `server/kos-compat-api.ts` (661 LoC,
  KOS-v1 Bearer wire that bound `:7225`) → `server/_archived/`, executed
  same-session via atomic port re-use (not 1-week deferred). Mbp-office
  cloudflared NEVER touched — `kos.chenge.ink` ingress still routes to
  `:7225` of jarvis Mac; only the brain-side process bound to `:7225`
  changed (kos-compat-api booted out → gbrain serve --http bootstrapped on
  the freed port, ~5 s downtime). Old `KOS_API_TOKEN` env var stays in
  `.env.local` commented-out as a rollback marker (re-bootstrap
  kos-compat-api from `scripts/launchd/_archived/` to swap back, again
  no cloudflared touch). Historical feishu command-mapping doc at
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

For our fork: brain = `host`. Sources (2026-06-02): `default` (personal
brain), `mailagent-emails` (email corpus), `gbrain-docs` (upstream gbrain docs,
145 pages), `omada` (Omada product KB: 114 user-guide sections + 572 FAQs + 24
corpus-synth viewpoint pages + 720 entities; built via `corpus-ingest`; the
`omada-sentiment` client appends daily 舆情/竞品 data). All on one coherent
embedding space (openai:text-embedding-3-large@1536 via avman, §6.32).

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
