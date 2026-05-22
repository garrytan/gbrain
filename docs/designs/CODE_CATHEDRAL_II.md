# Code Cathedral II — v0.20.0 Design

**Status:** Accepted. CEO + Eng + 2 codex passes CLEARED (2026-04-24). 16 cross-model findings absorbed total: 7 codex pass 1 (structural prereqs) + 6 codex pass 2 (absorption errors including the CHUNKER_VERSION silent-no-op gate and inbound-edge invalidation) + 3 eng-review architectural decisions. DX review recommended post-Layer 8 (new CLI surfaces) before ship.
**Supersedes:** Cathedral I (planned v0.18.0–v0.19.0 code indexing, shipped v0.19.0).
**Mode:** SCOPE EXPANSION (user explicit: "I want the best code search in the world").
**Scale:** 14 bisectable layers, ~20–25 CC hours, 3–5 human-weeks. One schema migration with split edge tables (`code_edges_chunk` + `code_edges_symbol`). Backfill via `CHUNKER_VERSION` bump (automatic on next sync) + explicit `gbrain reindex-code` command.

## Why v0.20.0

v0.19.0 shipped code indexing: tree-sitter chunker, 29 active languages, symbol columns, forward doc↔impl linking, incremental embed cache, BrainBench code category. Four cathedral-I items got deferred during shipping: `query --lang` filter, `sync --all` cost preview, markdown fence extraction, reverse-scan doc↔impl backfill.

Cathedral II is a promise-keeping release for those four, bundled with the leap that makes gbrain *the* code search: structural edges (call graph + references + imports + inheritance), parent-scope capture, doc-comment FTS binding, and two-pass retrieval. No more grep-class retrieval on code.

## The 10x leap

Today: agent asks "how does hybrid search handle N+1?" → gets 3 prose chunks of `hybrid.ts`.

Cathedral II: same query returns the anchor function + its 3 callers + its 2 callees + its JSDoc + the guide in `/docs` that cites it + the test file exercising it + parent scope chain. One walk. Code-aware brain.

## Scope (5 tiers + Layer 0 prerequisites, 14 bisectable layer commits)

### Tier 0 — Prerequisites (surfaced by codex outside voice)

**0a. File-classification widening.** `sync.ts:35` currently classifies only 9 extensions as code (TS, JS, Python, Go, Rust, Ruby, Java, C, C++). Cathedral II's B1 ships 165 lazy-loadable grammars, so the classifier needs to accept any extension the chunker can handle. Also reorders `detectCodeLanguage` so Magika (B2) runs as a fallback for extension-less files, not after a null-return gate.

**0b. Chunk-grain FTS.** Current keyword search lives on `pages.search_vector`. Adding doc-comments or two-pass anchoring at the chunk level has zero ranking effect against a page-grain primitive. Layer 0b adds `content_chunks.search_vector` with a trigger building from qualified symbol name + doc-comment (weight A) and chunk_text (weight B), plus rewrites `searchKeyword` to rank chunks directly. Page-level search_vector stays for title-heavy searches.

Both Layer 0 items are prerequisites for the 10x leap to actually move retrieval metrics.

### Tier A — Structural edges (the 10x leap)

**A1. Call-graph + reference extraction with qualified symbol identity.** Per-language tree-sitter queries at `importCodeFile` time capture:

- `calls` — function call-sites
- `imports` — module deps
- `extends` / `implements` — type hierarchies
- `mixes_in` — Ruby `include`/`extend`/`prepend`
- `type_refs` — parameter + return type usage
- `declares` — chunk owns a symbol definition

**Qualified symbol identity across all 8 langs.** `parent_symbol_path` (A3) is the source of truth for scope; edges use qualified names built from it. Examples: `Admin::UsersController#render` (Ruby instance), `Admin::UsersController.find_all` (Ruby singleton), `admin.users_controller.UsersController.render` (Python), `(*UsersController).Render` (Go), `users::UsersController::render` (Rust), `com.acme.admin.UsersController.render` (Java). Per-lang delimiter + method/class-method distinction. Ruby ships fully in ranker (CLI + A2 two-pass) — no deferral.

**Split schema (two tables, not one polymorphic):**
```sql
CREATE TABLE code_edges_chunk (
  from_chunk_id INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  to_chunk_id   INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type     TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE (from_chunk_id, to_chunk_id, edge_type)
);
CREATE TABLE code_edges_symbol (
  from_chunk_id INTEGER NOT NULL REFERENCES content_chunks(id) ON DELETE CASCADE,
  from_symbol_qualified TEXT NOT NULL,
  to_symbol_qualified   TEXT NOT NULL,
  edge_type     TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE (from_chunk_id, to_symbol_qualified, edge_type)
);
```
`code_edges_chunk` = resolved (both endpoints known). `code_edges_symbol` = unresolved (target symbol exists by qualified name, definition chunk not yet seen). Promotion from symbol→chunk table happens on later import. `source_id` is TEXT matching actual `sources.id` type.

**Shipped languages:** TypeScript, TSX, JavaScript, Ruby, Python, Go, Rust, Java (8 langs, ~85% of real brain code). Other languages chunk normally (via B1 lazy-load) but don't emit edges in v0.20.0 — extension is one query file + delimiter config per language, shippable as small follow-up PRs.

**A2. Two-pass retrieval.** Current: keyword + vector → RRF → dedup. New: keyword + vector → anchor set → expand 1–2 hops on `code_edges_chunk` with structural-distance decay → blend into RRF.

**Default OFF in all cases.** Opt-in only via `--walk-depth N` or `--near-symbol <name>`. Exact-symbol-match auto-on was unsafe (symbol names collide across files). Neighbor cap 50 per hop, depth cap 2. Dedup's per-page cap (currently 2) lifts to `min(10, walkDepth × 5)` when walking so structural neighbors from one file aren't clipped. Distance decay: `1/(1 + hop)` on expanded-neighbor RRF contributions.

**A3. Parent-scope capture + nested-chunk emission.** Two parts:

*Part 1:* Nested symbols get `parent_symbol_path text[]` on `content_chunks`. Embedded into chunk header: `[TypeScript] src/foo.ts:42-58 function formatResult (in BrainEngine.searchKeyword)`. Scope flows into embedding. Dual-use: drives A1's qualified symbol identity.

*Part 2:* Extend `splitLargeNode` to emit nested functions/methods/inner-classes as their own chunks. The current chunker is top-level-node oriented — a `class Foo { method1() {} method2() {} }` emits one chunk. Parent_symbol_path on top-level nodes is empty (no parent above top level), so A3 contributes nothing without sub-top-level chunks. Part 2 makes the scope annotation load-bearing.

**A4. Doc-comment → symbol binding.** Leading AST comment extracted to `doc_comment text`. Lands on **chunk-grain** search_vector (Layer 0b prerequisite) with FTS weight `'A'`. Natural-language queries rank docstring matches above body text and below title. `'A' > 'B' > 'C' > 'D'` per Postgres FTS weight convention.

### Tier B — Coverage (honest Chonkie parity)

**B1.** Lazy-load tree-sitter-language-pack (~165 languages). Replace 36 committed WASMs with a manifest + per-process parser cache. Cathedral I promised this and didn't deliver — Cathedral II does.

**B2.** Magika auto-detect for extension-less files (Dockerfile, Makefile, `.envrc`). ~1MB bundled asset. Falls back to null → recursive chunker if classifier fails to load.

### Tier C — Agent CLI surfaces

- `query --lang <lang>` — filter by `content_chunks.language`
- `query --symbol-kind function|class|method|type|interface|enum` — filter by `symbol_type`
- `query --near-symbol <name> --depth 1..2` — two-pass retrieval anchored at a known symbol
- `code-callers <symbol>` — uses A1 `calls` edges, reversed
- `code-callees <symbol>` — uses A1 `calls` edges, forward

All auto-JSON on non-TTY. `StructuredAgentError` envelopes on failure. `code-signature` deferred to v0.20.1 (needs per-language type captures).

### Tier D — Bridge items (cathedral I promises)

**D1.** `sync --all` cost preview. `estimateTokens` extracted from `chunkers/code.ts` to new `tokens.ts` module. Before per-source loop: walk sync-diff set, sum tokens, compute $ estimate. TTY + !json + !yes → interactive `[y/N]`. Non-TTY or `--json` or piped → emit `ConfirmationRequired` envelope, exit 2. `--yes` skips. `--dry-run` previews + exit 0. Preview on `--all` only, not single-source (DX review pain is first-time large-sync surprise bills).

**D2.** Markdown fence extraction in `importFromContent`. After `parseMarkdown`, iterate marked lexer tokens for `{type:'code', lang, text}`. Map fence tag → language. Chunk each fence through `chunkCodeText`. Persist as `chunk_source='fenced_code'`. Cap 100 fences per markdown page (DOS defense). Per-fence try/catch — one bad fence doesn't break the page import.

**D3.** `reconcile-links` batch command. Walks markdown pages, calls existing v0.19.0 `extractCodeRefs` per page, emits `addLink(md, code, ..., 'documents')` + reverse. `ON CONFLICT DO NOTHING` handles idempotency. Statement-timeout scoped via `sql.begin` + `SET LOCAL`. Progress reporter + final summary (edges added / existed / missing-target). Respects `auto_link` config.

### Tier E — Eval, backfill, honesty

**E1.** BrainBench code sub-categories: `call_graph_recall` (callers of X → expected set), `parent_scope_coverage` (nested-symbol queries return correct scope), `doc_comment_matching` (NL queries rank doc-comments above prose). Regression gates against A1/A3/A4 drift.

**E2.** Backfill: schema migrates automatically (zero cost). **`CHUNKER_VERSION` bumps 3 → 4** — that constant is folded into each code page's `content_hash`, so every code page's hash changes on upgrade. Next `gbrain sync` won't short-circuit on "git HEAD unchanged"; it re-chunks every code file. New `gbrain reindex-code [--source <id>] [--dry-run] [--yes] [--force]` provides explicit full backfill with cost preview (reuses D1 infra) and `--force` bypasses content_hash skip entirely. Users control when to pay; silent no-op path closed.

**E3.** Honest CHANGELOG. Retire "Chonkie superset" framing. Run BrainBench before/after for real numbers: 150+ languages loaded (after B1), MRR on NL→code queries, P@1 call-graph precision, P@k on symbol_name queries, sync cost preview on 5K-file repo. Back every claim with a runnable command.

## Implementation ordering (14 layers, post-codex)

1. **0a** — File-classification widening (sync.ts:35) + Magika reordered as fallback
2. **0b** — Chunk-grain FTS (content_chunks.search_vector + trigger + searchKeyword chunk-level rewrite)
3. **Foundation** — schema migration (split edge tables, qualified name columns on content_chunks) + engine method stubs + types
4. **B1** — lazy-load grammar manifest + bun --compile guard
5. **A1** — edge-extractor + 8 per-lang query files + qualified symbol identity + tests
6. **A3** — parent-scope column + doc-comment column + splitLargeNode nested-chunk emission
7. **A4** — doc-comment FTS weight A on chunk-grain search_vector
8. **A2** — two-pass retrieval, default OFF, opt-in only; dedup cap lifts when walking
9. **D tier bundled** — cost preview + fence extraction + reconcile-links
10. **B2** — Magika auto-detect
11. **C tier** — 5 CLI surfaces
12. **E1** — BrainBench sub-categories + CHUNKER_VERSION 3→4 bump
13. **E2** — `reindex-code` with `--force` + migration orchestrator with backfill-prompt phase
14. **E3 + release** — honest CHANGELOG + docs + migration skill + `/ship`

## Size and cost

- Diff: ~5500–6500 lines (~2.5x v0.19.0 post-codex expansion)
- Tests: ~2000 lines (8 langs × qualified-name + edge-extraction fixtures + Layer 0b FTS migration tests)
- Files: ~36 new, ~25 modified
- CC time: ~20–25 hours focused (was 14–18 pre-codex; +6h for Layer 0a/0b + qualified identity across 8 langs + nested-chunk emission + CHUNKER_VERSION bump layer)
- Human-equivalent: 3–5 weeks
- First-sync cost bump for upgraded v0.19.0 users: every code page re-chunks on first sync after upgrade (CHUNKER_VERSION bump forces invalidation). Users run `gbrain reindex-code --dry-run` for cost preview, then `--yes` or accept gradual backfill over time as files change.
- Daily autopilot cost post-backfill: unchanged (edges extracted at chunk time, no per-query LLM)

## Risks and mitigations

1. **Schema migration on live Postgres.** Test against production-shape DB before ship. v0.12.0 JSONB incident is the canary.
2. **Per-language tree-sitter queries are fiddly.** Hand-verified edge-set fixtures per language. Ruby gets extra coverage for dynamic-dispatch false negatives.
3. **Two-pass retrieval regression.** Default off for prose. BrainBench Cat 1 MUST show no regression before shipping.
4. **Backfill shape (G1 resolved).** Three composable layers: schema-auto migrates columns empty (zero cost). Lazy on-touch catches 80% over time (zero cost). Explicit `reindex-code` with cost preview for users wanting immediate full benefit. No surprise bills.
5. **Magika bundle (G2 resolved).** +1MB asset, `bun --compile` guard extension. If bundling surfaces bugs late in implementation, B2 is the only tier that can fall back to v0.20.1 without blocking the cathedral — it's self-contained at Layer 8.
6. **High-fan-out symbols.** `console.log`-style symbols have 100K callers. Neighbor cap 50, depth cap 2. Chaos test fixture required.

## Review gates

- CEO review (cathedral II) — CLEARED 2026-04-24
- Outside voice (codex) — run during cathedral II CEO review
- `/plan-devex-review` — up next (per user request, 5 new CLI surfaces + reindex-code need DX polish review before eng)
- `/plan-eng-review` — required before implementation begins
- `/review` + `/codex review` — required before `/ship`

## What's deferred to later cathedrals

- **C6** `code-signature "(A, B) => C"` — per-language type captures. v0.20.1.
- **Call-graph langs beyond 8 shipped** — PHP, Swift, Kotlin, Scala, C#, C++, Elixir, etc. One small PR per language.
- **LSP integration** for live precision. v0.22+ cathedral.
- **Code-tour generator** (cathedral I T1).
- **Private-code redaction pre-embed** (cathedral I T3).
- **`gbrain doctor --chunker-debug`** AST dump.
