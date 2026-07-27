# Community Ideas Ledger

> A diary of the **valuable ideas** surfaced by the community-PR wave, kept so that
> good thinking survives even when the PR that carried it is closed. gbrain moves
> fast and the maintainer's "cathedral" rewrites supersede most individual PRs —
> but the *idea* behind a closed PR is often still worth something.
>
> **Bar for this file:** an idea only earns a line if it is (a) still live on
> master and (b) genuinely valuable to gbrain users. **Graduating an idea to
> `TODOS.md` is a higher bar still** — it must serve the North Star (next-Postgres-
> for-memory: widest coverage, best-for-the-most-at-the-least) and be worth a
> maintainer-owned implementation. Most lines here will never graduate. That's fine.
>
> Status legend: **OPEN** = PR still open as a real merge candidate · **CLOSED** =
> PR closed, idea captured here · **HELD** = strategic, awaiting maintainer call.
> Provenance is credited to the contributor; scrub real private-network names per
> the repo privacy rule when anything here graduates to a public artifact.

_Generated from a full triage of the open-PR backlog (436 community PRs), 2026-06-07._

---

## 1. Internationalization — non-English brains are second-class

The single biggest coverage gap for "serve a billion people." Several independent
contributors hit the same walls.

- **Configurable FTS language** (#580/#581/#582, @rafaelreis-r) — **OPEN, high.**
  Every `to_tsvector`/`tsquery` is hardcoded `'english'` (query side, trigger side,
  and no reindex path), so non-English brains run every search through the English
  stemmer. A coherent 3-PR set: `GBRAIN_FTS_LANGUAGE` config → migration recreating
  triggers with the chosen language → `gbrain reindex-search-vector` to change it
  post-install. **Strongest i18n candidate to graduate.**
- **Full-Unicode slugs** (#782, @tamagodo-fu; #514 zh, @JimmyJiang67) — **HELD, high.**
  CJK slugs already work (`CJK_SLUG_CHARS`); generalize to all scripts (Cyrillic,
  Devanagari, Hangul, …) and widen the remaining ASCII-only validators so non-ASCII
  slugs flow end-to-end instead of being generated then rejected. #514 also carries a
  corpus-driven `relationships-zh.json` verb dictionary for `inferLinkType` — a
  reusable artifact for Chinese relationship typing.
- **CJK entity extraction** (#1637, @alkalide) — **OPEN, high.** Mention extraction is
  ASCII-only (`TOKEN_RE`, `MIN_NAME_LENGTH=4`), so 2–3 char Chinese/Japanese/Korean
  names are invisible to the gazetteer (there's an in-code TODO acknowledging it).
  CJK detection + lower min-length + single-token pure-CJK titles + substring pass.

## 2. Reliability — the daily-driver failure modes

Recurring, production-observed failures. Many are tiny fixes with outsized impact;
these are the densest source of real bugs in the whole backlog.

- **Embedding egress waste** (#347/#460, @notjbg) — **OPEN, high.** `getChunks` does
  `SELECT cc.*`, shipping the ~6KB pgvector embedding that `rowToChunk` immediately
  discards — ~19–22 GB/day egress on a busy Supabase brain. Enumerate the columns;
  add a CI guard. (#460 dup of #347.)
- **Body-keyed embedding reuse** (#1424, @defenestrate2) — **OPEN, high.** Markdown
  import re-embeds byte-identical chunks that merely shifted position, turning a
  cosmetic edit into ~99K wasted re-embeds. Reuse by chunk-text hash like the code
  path already does; add `--force` + a no-hash sentinel.
- **`embed --stale` full re-pull** (#775, @kyledeanjackson) — **CLOSED (partial on
  master), high.** Re-pulled all chunks every cycle (~3TB/mo egress); steady-state
  brains should do near-zero work. Master added a `countStaleChunks` early-exit;
  verify it fully closes this.
- **Config round-trip storm** (#1694, @Omerbahari) — **OPEN, high.** A single query
  fires ~85 serial single-key config `SELECT`s — invisible on PGLite, ~85 network
  RTTs on a remote pooler. Batch + cache `getConfig` (`getConfigMany`).
- **cgroup-aware worker sizing** (#1244, @tyler3k1) — **OPEN, high.** `defaultWorkers()`
  sizes from `os.totalmem()` (host RAM), so containerized installs (Railway/Fly/Render/
  Cloud Run/ECS) oversize the pool and get OOM-killed mid-import. Use
  `process.constrainedMemory()`.
- **Linux memory-pressure throttle** (#556, @chengzehsu) — **OPEN, high.** `os.freemem()`
  is `MemFree` (excludes reclaimable cache), so healthy containers reject every batch
  job. Read `MemAvailable` from `/proc/meminfo`.
- **propose_takes never caches empties** (#1218 @AdityaRajeshGadgil / #1760 @notjbg) —
  **OPEN, high.** A valid `[]` extractor result writes no cache row, so unchanged pages
  re-spend extractor tokens every ~5min cycle (57,885 calls/11 days observed). Sentinel
  row keyed on `(source_id, page_slug, content_hash, prompt_version)`.
- **Prompt-cache opt-in on hot paths** (#1761, @notjbg) — **OPEN, high.** Only ~4.9% of
  input tokens hit the Anthropic prompt cache because the highest-volume cycle/extraction
  call sites don't set `cacheSystem:true` despite gateway support. One-line opt-ins.
- **Autopilot reliability cluster** (#232 @ianderse, #464/#465 @notjbg, #289 @RyanAlberts,
  #477 @vinsew, #1935/#1936 @mdcruz88, #1906/#1891 @rayers/@jalagrange) — **OPEN, high.**
  A family of distinct live bugs: argless `engine.connect()` wipes saved config and
  crash-loops under launchd; `cwd=/` wrappers miss `brain/.env`; mtime-only lock probing
  blocks respawn for 10min after OOM; no backoff on the 5-failure suicide cap;
  disconnect-before-connect `reconnect()` bricks the engine on a transient blip; config
  accessors lack the retry wrapper. **Pick the best fix per layer and land as a wave.**
- **lint `--fix` corrupts mid-doc fences** (#1417 @trinh-macbook, #1597 @chungty) —
  **OPEN, high.** Detector/fixer regex disagree, so `lint --fix` strips the closing fence
  of mid-document ```` ```markdown ```` blocks and autopilot re-corrupts the page every
  cycle. Only unwrap whole-page fences.
- **backlinks worker defaults to `fix`** (#1853 @choomz; #1027 @sliday; #495 @23salus) —
  **OPEN, high.** Empty-payload backlinks jobs default to `action='fix'`, silently
  rewriting tracked markdown ("Referenced in" bullets) on every sync→embed→backlinks
  chain (129 files/day in the wild). Default to `check`; require explicit opt-in. Also
  fixes a duplicate-line accumulation bug.
- **`DATABASE_URL` hijack** (#1884, @awilkinson) — **OPEN, high.** A co-located app's
  generic `DATABASE_URL` silently overrides the configured brain (wrong DB, or
  auto-migrates it). Fix precedence: `GBRAIN_DATABASE_URL` > config.json > `DATABASE_URL`.
- **Engine-switch strips config** (#1088, @samchaudhary) — **OPEN, high.** `migrate --to`
  rewrites config to just `{engine,url}`, dropping `embedding_model`/`dimensions`/keys;
  migration "succeeds" but new embeds break.
- **Re-init silently corrupts the brain** (#1060, @vincedk-alt) — **OPEN, high.** Flag-less
  re-init ignores persisted `embedding_model`/`dimensions` and writes a wrong-shape
  OpenAI-1536 brain before the dim-check catches it.
- **IPv6-only direct URL** (#1006, @diazMelgarejo) — **OPEN, high.** `deriveDirectUrl`
  turns a Session-Pooler URL into an IPv6-only host, ECONNREFUSED on IPv4-only networks
  (the majority). Return null for pooler URLs.
- **HOME-isolation in tests** (#205/#517/#534 @orendi84, #434 @lloydarmbrust) — **OPEN,
  high.** The E2E suite spawns `gbrain init/import` against the developer's real
  `~/.gbrain/config.json`, clobbering their live DB URL+keys. Isolate HOME to a tmpdir.
  *(A footgun that bites contributors of this very repo.)*
- **dim-aware embed write target** (#1263, @DmitryBMsk) — **OPEN, high.** `upsertChunks`
  always writes the legacy `embedding vector(1536)` column, so brains on an alternate
  column (`embedding_ze halfvec(2560)`) fail with dim-mismatch on every write.
- **Oversized chunks silently unembedded** (#1675, @lubos-buracinsky) — **OPEN, high.**
  The code chunker emits giant literals/template strings whole; the embedder rejects
  them and they vanish from semantic search. Cap chunk size so they stay embeddable.
- **Token-vs-char truncation** (#557 @chengzehsu, #990 @mgunnin, #1180 @kkroo,
  #1281 @mmekkaoui, #1947 @100menotu001) — **OPEN, high.** The embed path truncates by
  chars (`MAX_CHARS`) not tokens, so dense pages still exceed the 8192/300K-token ceiling
  and loop forever on HTTP 400 with `embedded_at` never cleared; `isTokenLimitError`
  misses OpenAI's real error string; llama-server's 32-input limit isn't capped; and
  `--catch-up`'s unbounded budget overflows the 32-bit `setTimeout` and aborts after one
  batch. A "make embedding backfills never silently wedge" cluster.

## 3. Search & retrieval quality

- **Keyword search ignores page titles** (#1646, @jeades) — **OPEN, high.** `searchKeyword`
  ranks only chunk `search_vector`, never `pages.search_vector` (weight-A titles), so an
  exact-title `gbrain search` returns nothing while `query` finds it. High-impact, tiny.
- **`code-def` misses most OO symbols** (#1628, @rayers) — **OPEN, high.** `DEF_TYPES`
  omits method/constructor/field/struct/protocol, so `code-def` returns 0 for most
  object-oriented code. Root-cause fix in `normalizeSymbolType` + `DEF_TYPES`.
  (Prefer over #1701's fallback-only approach.)
- **doc-comment column is wired but dead** (#520, @Evode-Manirahari) — **OPEN, high.** FTS
  weights `content_chunks.doc_comment` above chunk text but the column is never populated.
  Extract JSDoc/docstrings per symbol via AST and thread through import.
- **autocut weak-top collapse** (#1863, @rayers) — **OPEN, high.** The fresh autocut
  feature (#1682) normalizes the rerank gap by the top score, so a weak top (0.317→1.0)
  looks like a confident cliff and rare cross-source queries collapse to 1 result. Add a
  `minTopScore` floor.
- **Graph-hop wikilink rerank** (#717, @gwanghoon91) — **HELD, high.** Zero-token
  score-shapers (graph-hop wikilink rerank + query-token disambiguation) claimed
  +2.6/+2.8pt P@5/R@5 on BrainBench. Worth re-evaluating against the new retrieval
  cathedral's ranker rather than merging the old diff.
- **Effective-date time filters** (#1706, @mvanhorn) — **OPEN, med.** `since`/`until`
  filter on `updated_at`, so content dated to the past but edited recently is mis-filtered;
  filter on `COALESCE(effective_date, updated_at, created_at)`.

## 4. Extraction & the knowledge graph

- **Obsidian wikilink → typed graph edges** (#87 @franmaranchello; alias/title/basename
  fallback #1188 @rwbaker) — **OPEN/HELD, high.** `[[wikilinks]]`/`![[embeds]]` are
  invisible to the graph. Materialize them as typed edges with alias (frontmatter
  `aliases:`), first-H1-title, and basename fallback resolution (path-equality-only gives
  ~5.5% edge recall on real vaults). Master shipped global-basename (#1388); the alias/
  title fallbacks are the still-novel part.
- **Schema-pack-aware link extraction** (#1547, @billy-armstrong) — **OPEN, high.** The
  link extractor's `DIR_PATTERN` is a frozen 16-prefix const that ignores pack-declared
  `path_prefixes`, so default-pack installs silently lose wikilinks to `person/`,
  `writing/`, `wiki/*`. Resolve prefixes from the active pack.
- **DB-source extraction** (#1539, @afshaker) — **OPEN, high.** The cycle's extract phase
  only walks the filesystem, so DB-resident pages (imported transcripts, remote-DB brains)
  never get links/timeline and `brain_score` is capped. Thread `source:'db'`.
- **source_id threaded through fs-walk extract** (#1719, @seungsu-kr) — **OPEN, high.**
  fs-walk extractors omit `source_id`, defaulting to `'default'`, so the `pages` INNER JOIN
  drops every row on non-default-source brains — silent 0 inserted.
- **extract `--stale` permanent-lag loop** (#1791, @Nazim22) — **OPEN, high.** Pages last
  edited before the link-extractor version bump get stamped below the version threshold and
  re-flag every run (~97% pages permanently "stale"). Stamp `GREATEST(updated_at, versionTs)`.
- **Plain-text NER for auto-link** (#1565, @donogeme) — **HELD, med.** Plain mentions of
  people (no `[[wikilink]]`) never become edges. The opt-in idea is right; the shipped
  implementation (capitalized-bigram regex, Western-names-only) is too crude — needs a
  real NER pass to clear the graph-integrity bar.

## 5. Providers & the gateway

The AI-gateway + recipes + `user_provided_models` system already absorbed ~40
per-vendor embedding PRs (Ollama, Gemini, Azure, DashScope, DeepSeek, Zhipu, E5,
bge-m3, Copilot, Composio, Kimi, LM Studio, Mistral, Hunyuan, MiniMax…). The
*residue* worth keeping:

- **litellm proxy unusable for chat** (#1953 @miroslavb, #1938 @BKF-Gitty) — **OPEN, high.**
  The `litellm-proxy` recipe declares only an embedding touchpoint (no chat), so
  `chat_model=litellm:*` fails validation and `think` degrades to a misleading "set
  ANTHROPIC_API_KEY"; and `build-gateway-config` never folds `litellm/openrouter/together`
  keys, so configured proxy auth goes out unauthenticated. Plus user-provided custom-dim
  embeddings are double-false-rejected in preflight. **The general-OpenAI-compat-proxy
  story.**
- **Matryoshka dims threading** (#1072 @mgandal, #1240 @mike7seven) — **OPEN, high.**
  Qwen3-Embedding returns its native dim (2560/4096) not the requested one because
  `dimensions:N` isn't threaded for the openai-compat path, hard-failing a 1536-dim brain.
- **"Freeze provider at init, clear vectors on dim change"** (#100/#172, @niallobrien/
  @nbzy1995) — **CLOSED, med.** A safety insight worth keeping even though the provider
  PRs are superseded: persist+freeze the brain's provider/dim at init so a later env change
  can't silently corrupt the vector space; clear stale embeddings on an intentional change.
- **China-region provider coverage** (#59 @Magicray1217, #1071 @AzeWZ) — **CLOSED, med.**
  Make DashScope/DeepSeek/Zhipu first-class recipes that honor `provider_base_urls` (the
  China-region endpoints) and provider batch limits — on-mission for global coverage.
- **Amazon Bedrock native** (#1826, @naterchrdsn) / **Jina asymmetric retrieval**
  (#1930, @Whamp) — **HELD, high/med.** The maintainer pattern prefers the universal
  litellm-proxy over per-vendor native recipes, but Bedrock (AWS IAM credential chain) and
  Jina's asymmetric `input_type=document|query` are distinct enough to warrant a call.
- **Local-first chat parity** (#1854/#1855/#1858 @starm2010, #1423 @pabloglzg,
  #1618 @punksterlabs) — **OPEN, high.** `FREE_LOCAL_CHAT_PROVIDERS` doesn't exist (only
  embed), brainstorm/cycle/takes hardcode `anthropic:claude-sonnet-4-6`, and the
  openai-compat `generateObject` path silently fails on providers that reject
  `json_schema`. The "run gbrain fully local" cluster.
- **OpenRouter config key** (#1714 @tmchow), **OAuth bearer for AI providers**
  (#1312 @pabloglzg), **API-key files** (#570 @shawnduggan) — **OPEN, med.** Credential
  ergonomics: config-file key (not just env), externally-minted bearer tokens, and
  `OPENAI_API_KEY_FILE` so OAuth harnesses don't inherit a raw key in `process.env`.

## 6. Auth, federation & access control (security-adjacent)

These cluster into a real theme: **runtime access control for remote/multi-tenant MCP
beyond prompt discipline.** Several are live security gaps (see the security list in the
triage report) and should be treated as a coordinated design, not piecemeal merges.

- **Clamp remote source overrides** (#1372, @jlfetter1) — **OPEN, high, SECURITY.** A
  remote MCP caller can pass `source_id` (or `__all__`) to `query`/`get_page` to read
  sources outside their OAuth `allowedSources` — the param bypasses `sourceScopeOpts`
  (CWE-285). Clamp to token claims, fail-closed. **#1394 (get_page source_id) must land
  *with* this clamp, not before it.**
- **Read-side prefix/federation enforcement** (#1860 @choomz, #1790 @colin-atlas,
  #470 @AdityaRajeshGadgil, #1508 @tim404x) — **OPEN, high.** `bound_slug_prefixes` is
  enforced on write but not read; exact `get_page` uses scalar `ctx.sourceId` while fuzzy
  uses the federation ladder; unqualified search can scan isolated `--no-federated` sources.
  Unify on one fail-closed visibility predicate across every read surface.
- **Per-OIDC-user access tiers** (#789, @0x471) — **HELD, high, SECURITY.** Map verified
  OIDC end-users to `oauth_clients.access_tier` dispatch gates + shape filters — real
  runtime access control. Pairs with multi-agent MCP hardening (#1316, @chipoto69, HELD).
- **Federated-read management CLI + admin UI** (#1592/#1601 @bitak1, #1558 @flamerged) —
  **OPEN, high.** No CLI/UI to inspect or change a client's `federated_read` scope (raw
  SQL only today). Atomic `array_append`/`array_remove` SQL to avoid read-modify-write
  races, plus an admin Sources tab.
- **Pre-registration flow flags** (#894, @panda850819) — **OPEN, high, SECURITY.**
  `register-client` hardcodes `redirect_uris=[]`, making the SECURITY.md-recommended
  pre-registration (DCR-off) flow unusable for Claude.ai/ChatGPT connectors.
- **RFC 9728 `resource_metadata`** (#1410, @rayers) — **OPEN, high.** HTTP MCP 401s omit
  the `resource_metadata` param the MCP auth spec + RFC 9728 require, so claude.ai/Cursor
  can't discover the auth server and never start OAuth.
- **Server-enforced memory groups** (#1497, @oldmate99) — **HELD, med.** Audience-based
  read/write via `memory_groups` + client-to-group assignment — strategic for hosted
  multi-tenant, but overlaps the existing source-isolation model; a design call.

## 7. Security hardening (must not be lost)

- **Command injection in transcription** (#245, @aliceagent) — **OPEN, high, SECURITY.**
  `transcription.ts` shell-interpolates an agent-controlled `audioPath` into `execSync`
  ffprobe/ffmpeg/`rm -rf`. **Confirmed still present on master.** Switch to
  `execFileSync` arg arrays + `fs.rmSync`.
- **Dotfile / skills-dir confinement** (#418/#419, @garagon) — **OPEN, high, SECURITY.**
  `.gbrain-source` walk-up trusts any ancestor dotfile (source hijack on shared hosts);
  `resolveWorkspaceSkillsDir` never canonicalizes (symlink escape). `lstat` ownership/
  symlink/world-writable checks + realpath containment.
- **Destructive reclone gate** (#1705, @mvanhorn) — **OPEN, high, SECURITY.**
  `recloneIfMissing` does `rm`+rename over `src.local_path` without verifying it's
  gbrain-managed, so a re-pointed source can wipe a user's working tree. Gate behind
  `isManagedRecloneTarget()` + reject `..`. *(The maintainer's own #1960 is the canonical
  landing for this class — cross-check.)*
- **CORS preflight asymmetry** (#983, @yashkot007) — **OPEN, high, SECURITY.** Preflight
  returns the full method/header surface unconditionally while the actual-request path
  gates on the allowlist — leaks allowed surface to non-allowlisted origins.
- **jsonb double-encode corruption** (#1584 @warkcod, #597 @vinsew) — **OPEN, high,
  SECURITY/integrity.** Source-config and subagent writers `JSON.stringify` into a
  `::jsonb` cast — the exact postgres.js trap CLAUDE.md forbids; corrupts source config
  (freshness/autopilot) and breaks dream synthesize slug-collection on real Postgres.

## 8. Developer experience & platform reach

- **Windows / CRLF portability** (#1294 @xwang4-svg, #1149 @samporter-31, #1554 @Sanjays2402,
  #1396 @xuezhaolan) — **OPEN, high.** CRLF breaks frontmatter + skill-trigger parsing
  (CI is Ubuntu-only so it never surfaces), `/dev/stdin` doesn't exist, a POSIX postinstall
  one-liner hard-fails `bun install`, backslash bundle keys. A coordinated "first-class
  Windows" pass. *(A working Windows binary + CI target #180/#181 is the prerequisite for
  the full story.)*
- **`.gbrainignore` / per-repo exclusion** (#1483 @eepaul; repo-local code filters
  #1011 @AndrewLauder; `--respect-gitignore` #1159 @jetsetterfl) — **OPEN, high.** Sync
  indexes every file with no ignore mechanism (`data/`, `*.parquet`, fixtures, vendored
  trees), bloating DB + embedding cost. gitignore-parity `.gbrainignore` + per-source
  `excludePatterns`. *(See also the maintainer's walker-prune work; #1942 prunes
  vendor/dist/build.)*
- **Monorepo sub-path sources** (#774, @jeremyknows) — **HELD, high.** `--src-subpath`
  (split repo into git-root + logical-source axes) + `--exclude` so one repo can hold N
  sources at subdirs.
- **MCP tool filtering** (#747, @joelwp) — **OPEN, high.** MCP advertises all ~51 ops to
  every consumer (~10K tokens of schemas, tool confusion); `GBRAIN_EXPOSED_TOOLS` filters
  the advertised surface.
- **Install-method detection for upgrade** (#538, @brucek) — **OPEN, high.** The README's
  own recommended git-clone+bun-link install detects as `unknown`, so `gbrain upgrade`
  offers three dead ends including a wrong npm package.
- **Runtime subagent defs** (#1282, @dcarolan1) — **OPEN, high.** The plugin loader
  validates `SubagentDefinition[]` at startup but the handler never reads
  `data.subagent_def`, so the persisted field is dead at runtime — callers must re-embed
  the full system body in every job.
- **macOS Tahoe PGLite workaround** (#1671, @roysaurav) — **HELD, med.** PGLite's WASM
  engine crashes on macOS 26 (Apple Silicon); document the native Homebrew Postgres+pgvector
  fallback. Reader-valuable until the WASM crash is fixed upstream.

## 9. Capabilities & integrations (strategic — maintainer call)

These are net-new surfaces held for a product decision, not auto-closed.

- **Alternative engines** — SQLite/`bun:sqlite`+FTS5 single-file backend (#291, @mvanhorn)
  and Neo4j GraphBrain REST backend (#594, @pkyanam). Both conflict with the two-engine
  lockstep invariant and the Postgres-for-memory North Star, but the *zero-WASM single-file*
  install story (SQLite) is strategically interesting. **HELD.**
- **Page versioning / soft-delete / read audit** (#573, @cropsgg) — **HELD, high.** Snapshots
  with provenance, soft-delete tombstones + hard purge, read-path audit treating edits as
  derivative works. Ambitious cathedral-scope; maintainer-owned territory.
- **Configurable embedding dimension** (#1051, @vincedk-alt) — **HELD, high.** `schema.sql`
  hardcodes `vector(1536)`; read `embedding_dimensions` from config (default 1536). The
  canonical fix that dozens of local-provider PRs hack around. *(Pairs with #1263.)*
- **Transcribe skill** (#1449, @RyanAlberts) — **OPEN, high.** Implements the empty
  video/audio branch of `media-ingest` (YouTube captions fast path + yt-dlp/whisper
  fallback), $0 by default. A genuine capability gap.
- **iPhone backup importer** (#1733, @H4RR1SON) — **HELD, med.** Local-CLI-only importer
  for decrypted iPhone backups (contacts→person pages, iMessage→conversation pages); zero
  network, thin-client refused.
- **Compounding dream phase** (#509, @durang) — **HELD, high.** An LLM "7th phase" that
  *creates* structure (orphan-mention people, knowledge gaps, concept-dup at cosine>0.92,
  decay, incomplete pages) vs the deterministic phases. Overlaps `enrich --thin`.
- **Codex-OAuth for dream** (#977, @barronlroth) / **dream gateway + `migrate-embedding-dim`**
  (#1013, @cxbitz) — **HELD, high.** OAuth-backed chat for synthesis; a command to resize
  the vector schema + clear incompatible embeddings.
- **Voice-extraction skill** (#300, @harjclaw) — **CLOSED, med.** Mine the user's outbound-
  email corpus already in the brain to build a queryable writing-voice profile so agents
  draft in the user's voice. Overlaps soul-audit.
- **MCP put_page parity + DB→markdown reconciliation** (#438, @rayzhux) — **HELD, high.**
  A frontmatter-only safe auto-link mode for remote callers + `GBRAIN_BRAIN_ROOT` to render
  remote writes back to markdown so MCP writes reach the git source-of-truth. Touches the
  remote trust boundary — a design proposal, not a merge.
- **Recipe discovery convention** (#1279, @ialmeida-jera) — **OPEN, med.** `~/.gbrain/recipes/`
  auto-discovery + `--external-dir`, loaded untrusted to keep the command-spawn boundary.
- **Destructive-op audit trail + audit-factory** (#1069/#1070, @vincedk-alt) — **HELD, med.**
  Rotating JSONL forensic trail for hard-deletes + a shared `createAuditLogger` factory.

## 10. Doctor & brain-health observability

- **Queue dead-job visibility** (#1185, @ethanbeard) — **OPEN, high.** A collector can
  heartbeat green while all its jobs die in the worker (3561 dead in the wild) and doctor
  has zero view into the minions queue. Add a cross-cutting `[queue]` dead-jobs check.
- **Orphan-metric alignment** (#1107 @colin477, #915 @xaviroblessarries, #1202 @rwbaker) —
  **OPEN, high.** `get_health` counts ingestion-by-design (`daily/`, briefings), soft-deleted,
  and hub pages as orphans, distorting `brain_score`; CLI `find_orphans` uses a *different*
  predicate than `getHealth`. Unify on one islanded predicate with sensible exclusions.
- **doctor check-name registry drift** (#1839, @mvanhorn) — **OPEN, med.** Several emitted
  checks aren't registered in `doctor-categories`, printing `unknown check name` every run;
  the drift guard only scanned `doctor.ts`, missing `onboard/checks.ts` emitters.
- **Honest stale-lock hint** (#1553, @Sanjays2402) — **OPEN, med.** doctor always says
  `gbrain sync --break-lock`, which silently no-ops on `gbrain-cycle` locks.

---

## Cross-cutting observations for the maintainer

- **The same bug was filed many times.** `extract_facts.entity_hints` missing an `items`
  schema came in ≥5 times (#812/#832/#847/#863/…, already fixed); the Postgres-singleton
  disconnect class a dozen+ times; sync no-op freshness, slug-casing, and the embedding-
  preflight false-reject each 5–15 times. A short "already fixed / known" note in the
  release notes or a CONTRIBUTING "before you file" list would cut the re-file rate.
- **The recipe system is working as a pressure valve** — it correctly absorbed ~40 vendor
  PRs into config rather than code. The remaining provider asks are about *capabilities*
  the recipe schema doesn't yet express (asymmetric `input_type`, Matryoshka dims, per-item
  RPM caps, alternative credential groups), not new vendors.
- **i18n (§1) and local-first chat (§5) are the two biggest "serve a billion" coverage
  gaps** the community is repeatedly hitting and the best candidates to graduate to TODOs.
