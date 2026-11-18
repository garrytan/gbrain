# Write path: ingest, parse, chunk, embed, store

Line numbers refer to gbrain 36bd05806a.

Scope: the TypeScript gbrain write path, pinned to commit `36bd05806a` (v0.60.733.0) in `garrytan/gbrain`. Read-only reference; nothing there was edited.

Evidence convention: plain statements were verified by reading the cited line. Statements marked **(inferred)** were not traced end to end.

## 1. Entry points

| Entry | Path | Notes |
|---|---|---|
| `gbrain import <dir>` | `src/commands/import.ts:267` `runImport`; per file calls `importFile` at `:749` | Concurrency clamped by `sync-concurrency.ts` (`clampWorkersForConnectionBudget`, `:488`). |
| `gbrain sync` | `src/commands/sync.ts:444` `runSync` -> `runSyncInner`; `:517` `syncOneSource` | `--all` worker pool: `resolveParallelism` (`:477`), `DEFAULT_PARALLEL_SOURCES = 4` (`src/core/sync-concurrency.ts:47`). |
| Sync pipeline | `src/commands/sync/incremental.ts:23` `performSyncInner` -> `preflight.ts:65` `preflightIncrementalSync` -> `preflight.ts:1005` `computeFilteredDelta` -> `imports.ts:57` `runImportsPhase` | Phase names (inferred from the module list in `src/commands/sync/`): preflight, delta, holds, imports, deletes/renames, embed pass, checkpoint. |
| Per-file import in sync | `src/commands/sync/imports.ts:270` `importOnePath`; `:432` `drainImports` | Images go to `importImageFile` (`imports.ts:357`); text to `importFile`. |
| `put_page` (MCP/CLI) | `src/core/ops/pages.ts:345` op; handler at `:368`-`:390` | Validates slug, runs slug fences and large-page admission (remote), then `submitPageMutation` (`src/core/persistence/page-mutations.ts:234`). |
| `put_pages` (batch) | `src/core/ops/page-batch.ts` | Batch variant; `submitPageMutations` at `src/core/persistence/page-batch.ts:337`. |

Verified: `imports.ts:68-74` says not to wrap the add/modify loop in `engine.transaction()`. Each file gets its own inner transaction. The comment states PGLite transactions are not reentrant (one mutex), so nesting hangs. Per-file atomicity is the chosen granularity.

Inferred: the persistence coordinator reaches `importFromContent` through its `prepare` / `coordinated` seam (documented at `src/core/import-file.ts:259-265`). I did not trace the coordinator body.

Checkpoint defaults (`src/commands/sync/checkpoint.ts:37-39, 72`): flush every 1000 files, at least every 10 s, abort after 3 consecutive checkpoint failures, yield to the event loop every 64 files.

## 2. Change discovery (git)

`src/core/sync-delta.ts`:
- Committed range: `git diff --name-status -M from..to` (`:151`) and the NUL-safe form `git diff --raw -z -M from..to` (`:277`).
- Working tree: `git diff --raw -z -M HEAD` (`:287`) plus `git ls-files -z --others --exclude-standard` (`:288`) for untracked files.
- Output is read with a raised buffer because a 100K-file `--name-status` diff can exceed Node's 1 MiB default (`sync-delta.ts:46`; `sync-git.ts:303`).
- Read-only git verbs are allowlisted (`sync-git.ts:288`).

`sync-git.ts:264` `buildAutoEmbedArgs` and `:280` `resolveNoEmbed` are the sync-side embed switches (signatures verified; their exact decision rules were not traced).

Verified: code-file allowlist `CODE_EXTENSIONS` in `src/core/sync.ts` (around `:87`) is derived from the chunker's language map, so only chunker-supported code files enter the code path.

## 3. Parsing markdown (`src/core/markdown.ts`)

Frontmatter:
- `parseMarkdown` `:319`; `parseMarkdownHead` `:355`; `parsedMarkdownFields` `:449`; `frontmatterBodyOffset` `:137`.
- Parse validation codes (`:16-24`): `MISSING_OPEN`, `MISSING_CLOSE`, `YAML_PARSE`, `SLUG_MISMATCH`, `NULL_BYTES`, `NESTED_QUOTES`, `NON_STRING_FIELD`, `EMPTY_FRONTMATTER`.
- Warnings (`:37`): `FRONTMATTER_RECOVERED`, `FRONTMATTER_COMMENT_VALUE`.
- Ambiguous unquoted lines are repaired by `quoteAmbiguousFrontmatterLine` (`:233`). I did not read its rules in full.
- YAML alias budget: `MAX_FRONTMATTER_YAML_ALIASES = 16` (`:804`), checked by `yamlAliasesWithinLimit` (`:807`).
- Reserved keys `type`, `title`, `tags`, `slug` (`:1304`).

Holds (quarantine on import, not failure):
- `HOLD_CODES` (`:510`): `invalid_frontmatter`, `frontmatter_slug_conflict`, `file_too_large`, `rename_held`, `parser_regression`, `tag_too_long`.
- `INVALID_FRONTMATTER_REASONS` (`:512`): `yaml_parse`, `needs_interpretation`, `ambiguous_identity_key`, `ambiguous_protected_key`.
- `contentSizeHold` (`:528`) and `classifyImportHold` (`:561`).
- Intended refusal: `yaml_alias_limit` (`:515`).

Timeline split (`splitBody` `:869`):
1. `<!-- timeline -->` (preferred; also `<!--timeline-->`), or `--- timeline ---` (`timelineSentinelKind`, `:938`).
2. A bare `---` counts only if content sits above it and the next non-blank line is a timeline heading (`isTimelineHeadingAfterDash`, `:944`).
3. A sentinel inside a fenced code block does not split (`findLineOutsideFencedCode`, used by `findTimelineSplitIndex`, `:900`).
4. Fallback: a timeline-shaped section (`findBareTimelineSection`) moves out of `compiled_truth`; later H2 sections stay.

Output: `compiled_truth` is everything above the split; `timeline` is the rest. `serializeMarkdown` (`:1018`) writes `\n\n<!-- timeline -->\n\n` before a non-empty timeline and writes an empty sentinel when `needsEmptyTimelineSentinel` (`:1012`) says the body would otherwise be re-parsed wrongly.

Size limits (`src/core/page-size-policy.ts`):

| Constant | Value | Line |
|---|---|---|
| `PAGE_MAX_BYTES` | 24 MiB | `:16` |
| `CODE_FILE_MAX_BYTES` | 5,000,000 | `:26` |
| `PAGE_INLINE_MAX_BYTES` | 1 MiB | `:35` |
| `isLargePageBytes` | predicate on the inline threshold | `:38` |
| `MAX_FILE_SIZE` (import screen) | `= PAGE_MAX_BYTES` | `src/core/import-screen.ts:44` |

Segmentation thresholds (`src/core/page-body/limits.ts`): promote to segmented above 1 MiB (`:28`); demote at or below 512 KiB (`:30`); segment min 64 KiB, target 256 KiB, rank-4 384 KiB, max 1 MiB (`:33-38`). Segmented pages store body regions separately (`src/core/page-body/`).

## 4. Slug rules

- `pathToSlug` `src/core/sync.ts:799`; `slugifyPath` `:775`; `slugifySegment` `:730`; `slugifyCodePath` `:786`.
- Markdown: strip `.md`/`.mdx`; backslashes to `/`; drop leading `./`; slugify each segment.
- Segment slugify: NFD, strip combining marks, strip Hebrew niqqud and cantillation (U+0591-U+05C7), NFC, strip variation selectors, lowercase, keep alnum, dot, space, `_`, `-`, and CJK; spaces to `-`; collapse hyphen runs and trim edge hyphens (`foldSegmentHyphens`).
- Code: dots become hyphens and the path is flattened to one segment, so `src/core/chunkers/code.ts` becomes `src-core-chunkers-code-ts` (per the function's own doc comment).
- A put that would change its slug under folding is refused (`hyphenFoldedSlug`, #7305).
- Portability: `FILE_NAME_MAX_BYTES = 240` (`src/core/portable-slug.ts:18`); reserved device names (`:22`).
- Op-level slug grammar: `OP_PAGE_SLUG_RE` (`src/core/page-slug-grammar.ts:25`); `validateSlug` (`src/core/utils.ts:39`).
- Frontmatter slug conflict produces a hold, message from `slugConflictHoldMessage` (`src/core/import-file.ts:195`).

## 5. Link extraction

- Body: `extractPageLinks` `src/core/link-extraction.ts:844`; `extractBodyLinks` `:866`; `extractMarkdownLinks` `:1153`; `resolveMarkdownLinkSlug` `:655`.
- Frontmatter: `frontmatterLinks` `:1083`.
- Dedupe: `dedupeCandidates` `:1104`.
- Code refs and entity refs: `extractCodeRefs` `:385`, `extractEntityRefs` `:409`.
- Derived link storage lives in `src/core/derived-links.ts` **(not traced)**.

## 6. Content hashing and change detection

Page hash (`src/core/utils.ts:121`, `contentHash`):
- `sha256(JSON.stringify({ title, type, compiled_truth, timeline: timeline || '', frontmatter, tags }))`, hex.
- Frontmatter is a copy with `HASH_EPHEMERAL_FRONTMATTER_KEYS` and `tags` removed (`contentHashFrontmatterAndTags`, `:141`). Tags are the sorted `page.tags ?? frontmatter.tags`.
- A streamed form (`src/core/page-body/content-hash-stream.ts`) must hash identical bytes.
- Byte parity is pinned by `test/content-hash-parity-3694.test.ts` (named in a comment at `import-file.ts:510-516`).
- Legacy formula: `contentHashLegacy` (`utils.ts:158`), used for compatibility (`import-file.ts:564`). Its full body was not read.

Short-circuit: in `importFromContent` (`src/core/import-file.ts:254`), `hash` is computed at `:521`. When `existing.content_hash === hash` and the trust marker is unchanged (`:564-575`), the chunk-and-embed step is skipped. `forceRechunk` (opt, `:295`) bypasses it for `gbrain reindex --markdown`.

Code files: `importCodeFile` (`import-file.ts:1241`) computes `sha256` at `:1287`; same short-circuit at `:1298`; `noEmbed` branch at `:1311`.

Images: `importImageFile` (`:1877`) hashes the buffer at `:1916`; skip at `:1920`.

Per-chunk provenance (`src/core/embedding-input-hash.ts`, #5553): `embeddingInputHash(ctx, tier, chunk)` (`:59`). It digests the vector column, model, dims, tier, and the exact input text. Tiers: `none`, `title`, `per_chunk_synopsis`. `content_chunks.embedded_text_hash` is `md5(chunk_text)` at embed time (`src/core/embed-stale.ts:178-183`, and the column comment in the schema).

## 7. Chunking

### 7a. Markdown: `src/core/chunkers/recursive.ts`

Pipeline:
1. `chunkText` (`:116`): `sanitizeRemoteBody` strips takes fences; `credentialSafeProjection`; world-visibility facts stay, private ones are removed.
2. `chunkProjectedText` (`:134`): word count (CJK-aware, `src/core/cjk.ts`). If `wordCount <= chunkSize`, one chunk, then the char cap.
3. Otherwise `recursiveSplit` -> `greedyMerge` -> `applyOverlap` -> `capByChars` (hard cap).

Defaults (verified in code):

| Option | Default | Where |
|---|---|---|
| `chunkSize` | 300 words | `recursive.ts:135` (`opts?.chunkSize \|\| 300`) |
| `chunkOverlap` | 50 words | `:136` |
| `maxChars` | 6000 chars | `:137` |
| `maxTokens` | `DEFAULT_MAX_CHUNK_TOKENS` = 2000 (clamped down only) | `:138-141`; constant at `src/core/chunkers/token-estimate.ts:20` |
| `boundaryCuts` | off (on for segmented pages only) | `ChunkOptions`, `recursive.ts:58-88` (doc comments) |
| `headingsLead` | off (segmented only) | `ChunkOptions`, `recursive.ts:58-88` (doc comments) |
| `CUT_LOOKBACK_CHARS` | 512 | `:353` |

Delimiter hierarchy (`DELIMITERS`, `:50-56`): L0 `\n\n` paragraphs; L1 `\n` lines; L2 sentence ends including CJK full stops; L3 clauses `; `, `: `, `, `, CJK commas; L4 words (whitespace, or CJK char slice).

Version constants (any boundary change must bump these to force reindex or re-embed):
- `MARKDOWN_CHUNKER_VERSION` = `SAFE_FENCE_CHUNKER_VERSION` = 4 (`src/core/search/safe-chunks.ts:6`; re-exported at `recursive.ts:48`).
- `SEGMENTED_CHUNKER_VERSION` = 5 (`src/core/search/safe-chunks.ts:23`, re-exported by `src/core/page-body/segment-chunks.ts`).

Token estimate: `estimateEmbedTokens` (`src/core/chunkers/token-estimate.ts:190`). `cl100kAvailable()` (`:48`) gates an exact tokenizer; the fallback when it is false is **(inferred: a heuristic)**. Whether the exact path runs depends on the host (see Rust risks).

### 7b. Fenced code inside markdown: `src/core/markdown-chunks.ts`

- Fence language tags map to pseudo paths (`FENCE_TAG_TO_PSEUDO_PATH`, `:10`), e.g. `ts`/`typescript` -> `fence.ts`, `py` -> `fence.py`, `rs` -> `fence.rs`. Unknown tags stay prose.
- Per-fence tree-sitter parse timeout `GBRAIN_FENCE_PARSE_TIMEOUT_MS`, default 2000 ms (`:57`). Per-page budget `GBRAIN_FENCE_PARSE_BUDGET_MS`, default 5000 ms (`:59`).
- Max fences per page: `GBRAIN_MAX_FENCES_PER_PAGE`, default 100 (`src/core/fence-scan.ts:27-29`).
- `prepareMarkdownChunks` (`:179`): a quarantined page returns zero chunks. An `embed_skip` page keeps its chunks for keyword search but gets no vectors (#6722).
- `prepareProseChunks` (`:191`) is the prose-only variant used by embed rebuilds.

### 7c. Code: `src/core/chunkers/code.ts`

- Tree-sitter WASM (`web-tree-sitter`), 36 grammars bundled as WASM assets (imports at `:48-113`).
- `SupportedCodeLanguage` union (`:171-176`): 30 identifiers (typescript, tsx, javascript, python, ruby, go, rust, java, c_sharp, cpp, c, php, swift, kotlin, scala, lua, elixir, elm, ocaml, dart, zig, solidity, bash, css, html, vue, json, yaml, toml, sql), with a comment that all 36 grammars ship.
- Extension detection: `detectCodeLanguage` (`:580`).
- Entry points: `chunkCodeText` (`:629`); `chunkCodeTextFull` (`:723`, returns chunks and edges); `parseWithTimeout` (`:688`); `ChunkerTimeoutError` (`:657`).
- Target size: `chunkSizeTokens` default 300 (`:788`); cap `maxChunkTokens` default 2000 (`:1080`).
- Unsupported languages fall back to the recursive chunker with 300 words (`:1125`, `:1200`).
- Versions: `CHUNKER_VERSION = 8` (`:146`); `GRAMMAR_REVISIONS` (`:157`): lua 1, typescript 2, tsx 2, javascript 2, python 2, ruby 2, elixir 1.
- Edge extraction (symbols, calls, imports): `src/core/chunkers/edge-extractor.ts` (837 lines, **not traced**).

## 8. Embedding

### 8a. Defaults and dimensions

- Default model `voyage:voyage-4`, 1024 dims, reranker `voyage:rerank-3-lite` (`src/core/ai/defaults.ts`, top-level constants).
- Voyage recipe (`src/core/ai/recipes/voyage.ts`): OpenAI-compatible endpoint `https://api.voyageai.com/v1`; `max_batch_tokens: 120_000`; `chars_per_token: 1`; `safety_factor: 0.5`; `default_dims: 1024`; multimodal model `voyage-multimodal-3` only.
- Voyage valid output dims: `[256, 512, 1024, 2048]` (`src/core/ai/dims.ts:56`). OpenAI text-embedding-3 max: small 1536, large 3072 (`dims.ts:73-74`).
- Dims per provider are passed by `dimsProviderOptions` (`dims.ts:163`).

Storage dims conflict (verified):
- `src/schema.sql:360` declares `content_chunks.embedding vector(1536)` as a literal, and the column default model is `text-embedding-3-large` in `src/core/schema-embedded.generated.ts:365`.
- The PGLite template uses `vector(__EMBEDDING_DIMS__)` (`scripts/build-schema.ts:410`) and replaces it at init (`:605`).
- Runtime default is 1024. Dims mismatches are caught by `src/core/embedding-dim-check.ts`; the exact reconciliation flow was not traced **(inferred)**.
- Image and multimodal columns are `vector(1024)` (`src/schema.sql:400` and `:403`).

### 8b. Batching and truncation

- Per-input char cap `EMBED_MAX_CHARS = 8000` (`src/core/ai/embed-batch-plan.ts:13`), applied by `truncateEmbedInputs` before any request.
- Token-budget split: `splitByTokenBudget` (`:52`), `planEmbedRequests` (`:102`); default chars-per-token 4 (`:15`); default safety factor 0.8 (`:17`).
- Item cap for recipes with no batch cap: `NO_BATCH_CAP_SUB_BATCH_ITEMS = 16` (`:33`).
- Legacy wrapper `embedBatch` (`src/core/embedding.ts:80`) slices by `BATCH_SIZE = 100` (`:79`).
- Gateway `embed` (`src/core/ai/gateway.ts:1625`): resolves recipe, truncates, drops empty inputs (`sendableEmbeddingInputs`), plans requests, honors `GBRAIN_EMBED_MAX_BATCH_TOKENS`, and records cost on the budget tracker.
- Input-cap safety for strict models: `EMBED_INPUT_SAFETY = 0.6` (`src/core/embedding-input-limit.ts:34`); `resolveMaxChunkTokens` clamps to `[MIN, 2000]` (`:95`); `learnChunkCap` (`:75`) stores the cap learned from provider errors.
- Batch-token overflow: recursive halving is the runtime net (per the voyage recipe comment).

### 8c. Retries and refusal

`src/core/embed-retry.ts`:

| Constant | Value | Line |
|---|---|---|
| `MAX_RATE_LIMIT_RETRIES` | 5 | `:75` |
| `RATE_LIMIT_FALLBACK_MS` | 60 000 | `:76` |
| `RATE_LIMIT_PAD_MS` | 500 | `:77` |
| `RATE_LIMIT_JITTER` | 0.3 | `:78` |
| `RETRIABLE_GATEWAY_STATUSES` | 502, 503, 504 | `:103` |
| `RATE_LIMIT_ATTEMPT_FLOOR_MS` | 1 s, 4 s, 10 s, 30 s, 75 s | `:151` |
| `TRANSIENT_NET_BASE_MS` / `_MAX_MS` | 1 000 / 15 000 | `:291-292` |

- SDK-level retries are disabled (`maxRetries: 0`, `:221`); this loop owns retries.
- `embedBatchWithBackoff` (`:213`) retries rate limits and transient network errors.
- `embedBatchKeepingUsable` (`:261`) keeps the usable vectors of a partly refused batch (null where refused). Refused chunks stay NULL for `embed --stale`.
- Zero-norm and non-finite vectors are refused: `EMBEDDING_NORM_EPSILON = 1e-6` (`src/core/ai/embedding-guard.ts:21`); `degenerateEmbeddingReason` (`:25`); `screenEmbeddings` (`:92`); Matryoshka prefix fit (`fitMatryoshkaPrefix`, `:118`).

### 8d. Write-time embedding inside import

`src/core/import-file.ts:682-735`:
- `noEmbed` is true when the caller passes it or the frontmatter has `embed_skip`.
- `largePage = isLargePageBytes(bodyBytes) || segmented !== null`.
- For a normal page, `embedChunks` runs before the DB transaction (`:688-735`). Pending chunks only (reused vectors skipped). Contextual-retrieval wrapper only in `title` mode.
- On provider failure the text is still saved, chunks stay NULL, and the page is flagged deferred. The error is written to stderr (`:715-735`).
- For a large or segmented page the write commits with NULL vectors and the stale sweep embeds later (`:683-684`, `postCommitEmbedding` at `:886` and `:924`).

### 8e. Cost controls

| Control | Default | Source |
|---|---|---|
| Sync inline cost gate | `sync.cost_gate_min_usd` = $0.50 | `src/core/sync-cost-gate.ts:340-348`, `runInlineCostGate` `:458` |
| Per-page embed cap | `embed.max_usd_per_page` = $2; `tokenmax` posture makes it unlimited | `src/core/page-embedding-budget.ts:58-69` |
| Spend posture | `spend.posture` config key; `tokenmax` disables caps | `src/core/config.ts:1700`; `src/core/page-spend.ts:7` |
| Run cost cap | `embedCostCap` built from the authorization; aborts through an `AbortController` and sets a resume command | `src/core/embed-cost-cap.ts:39`, `:65` |
| Image OCR per run | 200 images; est. $1.00; est. $0.002 per image; off unless `GBRAIN_EMBEDDING_IMAGE_OCR=true` | `src/core/import-file.ts:1734-1743`, `:1788` |

Prices (`src/core/embedding-pricing.ts:31`): voyage-4 $0.06/MTok; voyage-4-large $0.12; voyage-4-lite $0.02; openai text-embedding-3-small $0.02; text-embedding-3-large $0.13. Unknown models fall back to $0.13 (`src/core/embedding.ts:137-145`). The legacy constant `EMBEDDING_COST_PER_1K_TOKENS = 0.00013` is `$0.13/MTok` (`:130`).

### 8f. Stale detection and backfill

- `embedStalePages` (`src/core/embed-stale.ts:292`) and `embedStaleForSource` (`:388`) are the drains. Stale means: `embedding IS NULL` (legacy) or the stored signature or `embedded_text_hash` does not match the current model, dims and chunk text (`:112`, `:178-183`).
- CLI: `gbrain embed` flags (`src/commands/embed.ts`): `--stale`, `--slugs`, `--all`, `--batch-size` (capped at 10 000), `--pace`, `--priority`, `--catch-up`, `--dry-run`, `--yes`, `--images`, `--facts`, `--held`, `--force`, `--include-null-signature`, `--background`.
- Background jobs: `submitEmbedBackfill` (`src/core/embed-backfill-submit.ts:177`); keyless path `keylessEmbedBackfill` (`:155`).
- Sync embed pass: `resolveSyncEmbedBackfill` (`src/core/sync-embed-backfill.ts:149`).
- Pass to a provider only what is missing: the reuse path (`import-chunk-reuse.ts`, `reuseStoredChunkVectors`) keeps identical rows and their vectors (import-file.ts ~`:770-800`).

### 8g. Multimodal and images

- Image import: `importImageFile` (`import-file.ts:1877`); supported extensions `png, jpg, jpeg, gif, webp, heic, heif, avif` (`:1512`); `MAX_IMAGE_BYTES = 20 MiB` (`:1515`).
- Multimodal call: `embedMultimodal` (`src/core/ai/gateway.ts:1919`), gated by `multimodal_models` on the recipe; `multimodalEmbeddingModel` (`src/core/ai/multimodal-model.ts:14`).
- Columns: `embedding_image vector(1024)`, `embedding_multimodal vector(1024)` (`src/schema.sql:400`, `:403`).
- OCR text path (optional) produces chunk text from images when enabled.

## 9. Storage and the DB dependencies on the write path

Table `content_chunks` (`src/core/schema-embedded.generated.ts:358`; PGLite template `src/core/pglite-schema.generated.ts:180`): `id`, `page_id` (FK, cascade), `chunk_index`, `chunk_text`, `chunk_source` (default `compiled_truth`; the other source is `timeline`), `embedding`, `model`, `token_count`, `embedded_at`, `embedded_text_hash`, `embedding_input_hash`, `created_at`, `language`, `symbol_name`, `symbol_type`, plus later columns for segmented pages (`occurrence_id`, `local_ordinal`, `raw_byte_start/end`, `body_generation`), projection spans, and `embedding_pending_since`.

Triggers and locks the write path depends on (verified by reading `src/schema.sql`):

| Object | Event | Line | Effect |
|---|---|---|---|
| `bump_page_generation_trg` | BEFORE INSERT/UPDATE on `pages` | `:209` | Bumps page generation (cache gate). |
| `trg_pages_search_vector` | BEFORE INSERT/UPDATE OF title, timeline on `pages` | `:1231` | Maintains `pages.search_vector` (tsvector). |
| `chunk_search_vector_trigger` | BEFORE INSERT/UPDATE OF chunk_text, doc_comment, symbol_name_qualified on `content_chunks` | `:455` | Builds the chunk tsvector (`to_tsvector('english', ...)`, weights at `:444-447`). |
| `pages_knowledge_revision` | BEFORE UPDATE on `pages` | `:1935` | Advances the revision counter. |
| `tags_knowledge_revision` | AFTER INSERT/UPDATE/DELETE on `tags` | `:1960` | Revision on tag change; checks `pg_catalog.row_security_active`. |
| `pages_projection_queue` | AFTER INSERT/UPDATE/DELETE on `pages` | `:2765` | Queues projection rebuilds. |
| Derivation scope triggers | on `page_body_manifest`, `pages` (deleted_at) | `:2337-2343` | Retire derivations on page change. |
| `managed_writer_guard` | BEFORE INSERT/UPDATE/DELETE on managed tables | `:2635` | Blocks non-managed writers. |
| `facts_refuse_purged` | BEFORE INSERT/UPDATE on `facts` | `src/core/facts/purge-schema.ts:177` | Refuses purged facts. |
| `minion_job_notify` | AFTER INSERT/UPDATE OF status on `minion_jobs` | `:1824` | NOTIFY for job wakeups (used by background embed jobs **(inferred)**). |

Locks and transactions:
- `importFromContent` opens one transaction covering version snapshot, `putPage`, tags, chunk replacement, and `beforeCommit` (`import-file.ts:242` doc; `:549-550`; `:744-884`).
- Sources are locked `FOR SHARE` during embedding invalidation (`src/core/embedding-invalidation.ts:65-66`).
- Chunk-vector index writes are budgeted: `CHUNK_VECTOR_WRITE_BUDGET = 5` (`src/core/page-state/chunk-moves.ts:24`); over budget, the import commits the page pending and finishes after commit.
- Markdown read-modify-write uses file locks, not DB locks: `~/.gbrain/page-locks/<sha256-of-slug>.lock` (`src/core/page-lock.ts:7`). This is a separate mechanism from the DB.
- Not verified: whether `pipelined(tx, ...)` (`import-file.ts:~790`) issues statements in parallel within one transaction.

## Rust engine implications

What must be preserved exactly:
1. Content hash bytes. `contentHash` hashes a JSON string with a fixed key order and sorted tags after stripping ephemeral frontmatter keys. Any change in serialization, key order, or the ephemeral-key list makes every page look changed and triggers re-embed. Keep the parity fixture from `test/content-hash-parity-3694.test.ts` and port it.
2. Chunk boundaries. Word counting (CJK-aware), the delimiter ladder, greedy merge, overlap of 50 words, and the 6000-char cap decide embedding inputs. Keep the same version integers (4 markdown, 5 segmented, 8 code) and bump them on any boundary change.
3. `embedded_text_hash = md5(chunk_text)` and `embedding_input_hash` digests: stored values must still validate against vectors produced by the TS version if the Rust build reads the same data.
4. Timeline sentinel rules (marker, `--- timeline ---`, bare `---` plus heading, fence-aware).
5. Slug folding (NFD, niqqud strip, CJK keep, hyphen fold) so the same file yields the same page in both implementations.
6. Hold codes and reasons (strings are part of `--json` output and the agent contract).
7. Size thresholds: 24 MiB page max, 5,000,000 code max, 1 MiB inline, 512 KiB demote.

What can be simplified:
- Collapse the many per-engine variants (PGLite vs Postgres DDL, dims templating) into one schema generated from a single dim setting.
- Replace `vector(1536)` literal vs 1024 default conflict with one source of truth.
- Replace DB triggers with explicit application code in the same write transaction (FTS vectors, revision counters, projection queue, derivation retirement). The trigger set above is the complete list the write path relies on.
- Drop RLS checks (`row_security_active`) in the embedded case **(inferred: no multi-tenant access inside one local process)**.
- Replace `FOR SHARE` source locks with a single-writer lock on the brain file.
- Replace LISTEN/NOTIFY wakeups (`minion_job_notify`) with an in-process channel.
- Replace the per-page file locks with an in-process mutex plus a file lock only where the markdown file itself is written.

Postgres feature dependencies on the write path:

| Feature | Used for | Rust replacement |
|---|---|---|
| `vector(N)` + HNSW/IVFFlat | content_chunks.embedding, image, multimodal | sqlite-vec, usearch, or a flat f32 store with SIMD scan |
| `tsvector` + `to_tsvector('english')` | search_vector on pages and chunks | FTS5 or tantivy, updated in the write transaction |
| `md5()` | embedded_text_hash | any md5 crate, or switch to sha256 with a one-time backfill |
| Triggers (listed above) | derived columns, revisions, queue | explicit writes in one transaction |
| `FOR SHARE` / row locks | source locks during invalidation | serialized writer |
| `SERIAL`, `TIMESTAMPTZ` | ids and timestamps | integer ids; RFC 3339 strings |
| LISTEN/NOTIFY | job wakeup | channel |
| `SKIP LOCKED` queues | background embed jobs **(inferred from minion queue design; not verified in this map)** | single-process queue |

Risks:
1. Host-dependent tokenization. `estimateEmbedTokens` switches on `cl100kAvailable()` (`token-estimate.ts:48`). If the Rust build cannot match the exact path, chunk token counts and therefore split points can differ between machines. Pin one estimator.
2. Timing-dependent fence output. Per-fence (2 s) and per-page (5 s) parse budgets (`markdown-chunks.ts:57-59`) can change chunk output on a slow machine. Decide whether the Rust build uses a deterministic step budget instead.
3. Provider-specific dims. Voyage accepts only 256/512/1024/2048; the schema must be sized from the chosen model at init, not a literal.
4. Batch-token ceilings and retries: 120K tokens per Voyage batch, five rate-limit retries with fixed floors. Reimplementing this without the same floors changes behavior under load.
5. Price table drift: the voyage recipe's display price ($0.12, labeled for voyage-4-large) and the pricing table ($0.06 for voyage-4) disagree. Keep one table.
6. Keep provider calls outside the DB transaction. The TS small-page path embeds before the transaction (`import-file.ts:688-735`) and large pages embed after commit (`:886`, `:924`). A Rust port that embeds inside the write transaction would hold the write lock across network calls.

## Open questions

1. How the persistence coordinator (`src/core/persistence/page-mutations.ts:234`, `page-batch.ts:337`) drives `importFromContent` with `prepare` and `coordinated`. The full ordering of prepare, commit and read-back was not traced.
2. `src/core/page-body/segment-chunks.ts` (`headingsLead`, `boundaryCuts`, segment windows) was referenced but not read. The Rust port needs it for segmented pages.
3. `contentHashLegacy` (`src/core/utils.ts:158`): which stored rows still carry the legacy hash, and whether a Rust build must read or write it.
4. `src/core/chunkers/edge-extractor.ts` (837 lines) and `symbol-resolver.ts` define code edges. Not traced.
5. `src/core/embedding-dim-check.ts` reconciliation: how a 1536 literal in `schema.sql` becomes the configured width at Postgres init. Not traced.
6. `cl100kAvailable` (`token-estimate.ts:48`): which path runs on a stock install, and whether the heuristic path is ever used in production.
7. The `pipelined(tx, ...)` helper (`src/core/page-state/transactions.ts`): does it run statements concurrently inside one transaction?
8. The embed pass in `sync` and the sync-lock interplay (`src/core/sync-lock.ts`) were not read.
9. Video and audio ingestion (`src/core/transcription.ts`, 25 MB cap) is out of this map's scope; only images were traced.
