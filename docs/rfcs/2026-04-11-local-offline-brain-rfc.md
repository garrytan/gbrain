# RFC: Fully Local / Offline GBrain for Claude Code and Codex

**Status:** Proposed  
**Date:** 2026-04-11  
**Authors:** Codex + Meghendra  
**Decision type:** Product + architecture

---

## 1. Summary

GBrain should support a **fully local, fully offline, zero-cloud-spend** operating mode for personal use.

In this mode:

- the **markdown repo remains the source of truth**
- the **search/index database runs locally** on SQLite
- **embeddings and query rewriting run on local open-source models**
- **Claude Code and Codex connect through a local MCP server**
- **no Supabase, OpenAI API, Anthropic API, S3, or other paid cloud service is required**

This RFC intentionally targets the **final desired product state**, not a cloud-first intermediate. Implementation can still be executed in workstreams, but the design target is a single coherent end state: **a sovereign local knowledge brain that costs nothing to operate beyond the user's existing Claude Code / Codex subscriptions and local hardware**.

---

## 2. Motivation

The current project is optimized for a managed Postgres/Supabase deployment with hosted embeddings and query expansion:

- the repo currently presents GBrain as **Postgres + pgvector + Supabase** first (`README.md`, `CLAUDE.md`)
- CLI and bootstrap paths instantiate `PostgresEngine` directly (`src/cli.ts`, `src/commands/init.ts`)
- embedding generation is hard-wired to **OpenAI embeddings** (`src/core/embedding.ts`)
- query expansion is hard-wired to **Anthropic Haiku** (`src/core/search/expansion.ts`)
- hybrid search assumes an online embedding provider at query time (`src/core/search/hybrid.ts`)

That architecture is excellent for a hosted personal brain, but it conflicts with the desired user outcome:

1. **No recurring cloud cost**
2. **No dependency on Supabase free/pro tiers**
3. **No separate OpenAI/Anthropic API billing**
4. **Works when offline**
5. **Safe to use as a private local brain with Claude Code and Codex**

This RFC resolves that tension by making the engine, search, and model layers genuinely local-first.

---

## 3. Problem Statement

Today, the project has a documented SQLite direction (`docs/ENGINES.md`, `docs/SQLITE_ENGINE.md`) but not a usable local/offline product.

The missing pieces are not only storage. A true local/offline GBrain requires all of the following:

1. **A local engine**  
   SQLite must become a real `BrainEngine` implementation rather than a future note.

2. **A local search stack**  
   Keyword search must work on SQLite, and semantic search must not require cloud APIs.

3. **A local model strategy**  
   Embeddings and optional query expansion must run against local open-source model runtimes.

4. **A non-blocking indexing policy**  
   Local embedding can be slow during first backfill; import/sync must remain usable anyway.

5. **A local MCP integration path**  
   Claude Code and Codex must attach to the same local brain over stdio MCP with no remote service.

6. **An offline-safe operational profile**  
   Update checks, remote deploy helpers, and cloud-only assumptions must not break or degrade local mode.

---

## 4. Goals

### 4.1 Primary goals

- Support a **fully local** GBrain profile with **no paid cloud dependencies**
- Preserve the current product's core value:
  - markdown repo as source of truth
  - fast keyword search
  - useful semantic retrieval
  - MCP access for AI agents
  - incremental sync from local files
- Make the local mode suitable for **daily use** from:
  - **Codex CLI**
  - **Claude Code**
- Keep the architecture aligned with the existing `BrainEngine` abstraction rather than forking the product into separate codebases

### 4.2 Quality goals

- **Offline by default** in local mode
- **Graceful degradation** if local semantic features are disabled or still backfilling
- **Incremental indexing** so normal day-to-day operation is fast after initial setup
- **No mandatory external API keys**
- **No mandatory background daemon requirement** for correctness

---

## 5. Non-goals

- Perfect result parity with the hosted Postgres/Supabase stack
- Exact reproduction of pgvector HNSW performance on commodity laptops
- Mandatory local LLM query expansion on every search
- Requiring GPU hardware
- Removing Postgres support entirely
- Rebuilding the agent playbook or brain schema from scratch

The target is **functional equivalence of purpose**, not byte-for-byte behavior parity.

---

## 6. User Scenarios

### Scenario A: Personal local brain

A user maintains a markdown knowledge repo on disk, runs `gbrain init --local`, indexes it into a local SQLite database, and asks Codex or Claude Code to search and update the brain without any internet dependency.

### Scenario B: Laptop offline operation

The user is on a plane or otherwise disconnected. They can still:

- read pages
- sync local markdown edits
- run keyword search
- run semantic search if embeddings already exist
- write new knowledge
- enqueue or generate embeddings locally

### Scenario C: Large initial import, normal incremental maintenance

The user imports thousands of files once. Initial embedding backfill may take time, but from then on only changed/new chunks are embedded, so ongoing cost is incremental rather than full-rebuild.

### Scenario D: Claude Code / Codex as local clients

The user keeps GBrain as a local stdio MCP server and connects both Codex and Claude Code to the same local process contract.

---

## 7. Alternatives Considered

### Option A: SQLite + FTS-only local mode

**Description**  
Use SQLite strictly for storage and FTS5 keyword search. Drop semantic search entirely in local mode.

**Pros**

- simplest implementation
- zero local model runtime complexity
- fastest path to a usable local brain
- excellent offline reliability

**Cons**

- weakens GBrain's core retrieval story
- poorer recall for concept-level or fuzzy semantic questions
- diverges sharply from the current product thesis

**Verdict**  
Rejected as the primary architecture. Useful as a fallback mode, but too reductive as the final design.

### Option B: SQLite + local hybrid search (**chosen**)

**Description**  
Use SQLite for storage and FTS5, local embeddings for semantic retrieval, reciprocal-rank-fused hybrid search, and optional local query rewriting.

**Pros**

- preserves GBrain's central value proposition
- zero cloud spend
- aligns with existing `BrainEngine` design
- degrades gracefully to keyword-only when embeddings are unavailable

**Cons**

- implementation complexity is materially higher
- initial indexing can be slow on CPU-only machines
- local model runtime integration adds operational surface area

**Verdict**  
Chosen. Best match for the user's actual goal.

### Option C: Full local AI-native rewrite

**Description**  
Redesign not only storage/search but also chunking, expansion, summarization, and future maintenance workflows around local model runtimes from day one.

**Pros**

- maximal ideological purity
- strongest long-term local-first posture

**Cons**

- too much surface area at once
- risks blocking the essential local brain on optional local-AI niceties
- increases delivery risk substantially

**Verdict**  
Rejected as the immediate architecture. Elements can be added later inside the chosen architecture.

---

## 8. Chosen Architecture

### 8.1 System overview

```text
Markdown Brain Repo (source of truth)
        |
        v
  gbrain sync / import
        |
        v
 Local SQLite Brain DB
  - pages
  - chunks
  - tags
  - links
  - timeline
  - versions
  - embedding metadata
        |
        +----------------------+
        |                      |
        v                      v
  FTS5 keyword search    Local embedding + vector search
        \                      /
         \                    /
          ---- RRF fusion ----
                   |
                   v
            gbrain MCP server
                   |
          +--------+--------+
          |                 |
          v                 v
      Codex CLI        Claude Code
```

### 8.2 Architecture principles

1. **Markdown remains canonical**  
   The repo is still the source of truth. SQLite is an index + operational store.

2. **Local-first, offline-safe**  
   No network dependency is required for steady-state use in offline profile.

3. **Cloud-free by default**  
   No OpenAI, Anthropic, Supabase, or object-storage dependency exists in the local profile.

4. **Keyword search is always available**  
   Semantic features enhance retrieval, but do not gate functionality.

5. **Embeddings are incremental, never full-rebuild by default**  
   Initial backfill is a one-time cost. Ongoing work is delta-based.

6. **Agent contract remains stable**  
   CLI and MCP continue to expose the same conceptual operations even as the backend changes.

---

## 9. Storage and Engine Design

### 9.1 Engine selection

The codebase must stop instantiating `PostgresEngine` directly from user-facing entrypoints.

Required refactor:

- add an engine factory such as `createEngine(config.engine)`
- route CLI, MCP, import, sync, doctor, and init through the selected engine
- make `sqlite` a first-class configured engine, not a dormant enum value

### 9.2 SQLite as the local engine

The SQLite engine will implement the existing `BrainEngine` contract using:

- **Bun's built-in SQLite driver** (`bun:sqlite`) for the primary DB path
- **FTS5** for keyword search
- **BLOB-stored embeddings** in `content_chunks`
- recursive CTEs or equivalent traversal for graph features
- JSON-as-text for frontmatter/raw-data payloads

Why Bun SQLite:

- zero additional paid service
- no mandatory npm/native dependency for the base engine
- aligned with current Bun runtime already used by the project

### 9.3 Local database path

Default local profile:

```json
{
  "engine": "sqlite",
  "database_path": "~/.gbrain/brain.db",
  "offline": true,
  "embedding_provider": "local",
  "query_rewrite_provider": "heuristic"
}
```

Backward-compatibility rule:

- existing configs with no explicit `engine` continue to resolve to Postgres
- env-only `DATABASE_URL` / `GBRAIN_DATABASE_URL` setups continue to resolve to Postgres unless local mode is explicitly selected

### 9.4 Schema policy

The SQLite schema should mirror the conceptual shape already described in `docs/SQLITE_ENGINE.md`:

- `pages`
- `pages_fts`
- `content_chunks`
- `links`
- `tags`
- `raw_data`
- `timeline_entries`
- `page_versions`
- `ingest_log`
- `config`

Additional local-mode metadata may be added for:

- embedding job bookkeeping
- model/runtime provenance
- local index capabilities

---

## 10. Search Design

### 10.1 Keyword search

Keyword search is mandatory and always-on in local mode.

Implementation:

- SQLite `FTS5` virtual table over `title`, `compiled_truth`, `timeline`
- BM25 ranking
- result shape normalized to existing `SearchResult[]`

### 10.2 Vector search

Semantic search remains part of the final architecture, but must be local.

Required behavior:

- store chunk embeddings as BLOB or float arrays in SQLite
- embed queries locally
- search nearest chunks locally
- return normalized `SearchResult[]`

### 10.3 Vector index strategy

To avoid introducing a hard dependency on a fragile native extension from day one, vector search should use a **provider abstraction**:

#### Required baseline provider: exact cosine scan

- reads embeddings from SQLite
- computes cosine distance locally in-process
- no extra native dependency required
- slower than ANN/HNSW, but deterministic and offline-safe

This baseline guarantees correctness and eliminates the risk that local mode becomes unusable because a vector extension cannot be installed.

#### Optional accelerator provider: SQLite vector extension

If available, a local vector extension such as `sqlite-vec` can be used as an acceleration layer. This is an optimization, not a correctness dependency.

**Decision:** local mode must work without the accelerator.

### 10.4 Hybrid ranking

The current RRF fusion model is worth preserving:

1. keyword results from FTS5
2. vector results from local embeddings
3. reciprocal rank fusion
4. dedup / per-page caps / type diversity logic

If embeddings are not yet available for some or all chunks:

- keyword search still runs
- vector search contributes only where embeddings exist
- result ranking degrades gracefully instead of failing

---

## 11. Local Embedding Design

### 11.1 Requirement

Embeddings must be generated without OpenAI API calls.

### 11.2 Runtime contract

The embedding layer must be abstracted behind a provider interface, for example:

```ts
interface EmbeddingProvider {
  kind: 'none' | 'local';
  dimensions(): Promise<number>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
```

### 11.3 Supported local runtime shape

The offline architecture should support local open-source model runtimes, with **Ollama-compatible local endpoints as the primary default target**.

Why:

- free
- common local setup
- easy for users already experimenting with local models
- conceptually aligned with Codex CLI's local-provider support

This RFC does **not** require Codex or Claude Code themselves to provide embeddings. They are clients of GBrain, not the embedding runtime.

### 11.4 Performance policy

Local embeddings are slower than hosted embedding APIs for large first-time imports. The architecture must explicitly design around that.

#### The policy

1. **Initial full backfill may take a long time**
2. **Import/sync must not block correctness on embedding completion**
3. **Incremental updates only embed changed/new chunks**
4. **Query remains usable during partial backfill**

This is acceptable because the existing project already has the right conceptual model:

- content hashing skips unchanged imports
- stale-only embedding exists conceptually
- large syncs already defer embedding in the current codebase

### 11.5 Why the local-embedding cost is acceptable

The user concern is valid: a full local backfill over thousands of chunks can be slow.

The answer is architectural, not rhetorical:

- **one-time initial cost:** potentially large
- **steady-state cost:** small, because only new/changed chunks are embedded

That means the real operating model is:

```text
Initial import -> large one-time embedding pass
Daily operation -> embed only the delta
```

This is the same economic shape as the current hosted system, just paid in local CPU/GPU time instead of cloud API spend.

### 11.6 Embedding execution model

The current code embeds inline before writing chunks. That is acceptable for hosted APIs but too blocking for local-first operation.

The offline architecture should change this:

#### Write path

1. parse markdown
2. compute content hash
3. write page + chunk rows immediately
4. mark chunks as needing embedding
5. return success

#### Background / explicit embedding path

- `gbrain embed --stale`
- optional watch-mode or background worker
- optional inline flag for small imports

This makes local mode feel fast even when semantic indexing is still catching up.

### 11.7 Model storage and reproducibility

Each embedded chunk should store:

- model identifier
- embedding dimensions
- embedded timestamp
- optional runtime family metadata

This is necessary so the system knows when embeddings are stale due to a model switch.

---

## 12. Local Query Rewrite / Expansion

### 12.1 Requirement

Current cloud query expansion must no longer depend on Anthropic.

### 12.2 Design

Query rewrite becomes a **budgeted local enhancement**, not a mandatory search dependency.

Modes:

1. **none** — disabled
2. **heuristic** — deterministic rewrites/sanitization only
3. **local_llm** — use a small local instruct model to generate alternate phrasings

### 12.3 Default policy

Default local profile:

- start with **heuristic or disabled rewrite**
- preserve high reliability
- avoid turning every query into an LLM call

Rationale:

- embeddings already recover semantic recall
- local query rewriting can add latency and model-management complexity
- it should remain optional and bounded

### 12.4 Why this is still aligned with the product vision

The point of query expansion is improved recall, not ideological attachment to an LLM call. In offline mode, the retrieval stack should prefer:

1. reliable keyword search
2. reliable vector search
3. optional local rewrite when configured

That keeps the core system useful even on modest hardware.

---

## 13. Import, Sync, and Incremental Maintenance

### 13.1 Import contract

Import must remain idempotent:

- unchanged files skipped via content hash
- changed files rewritten
- deleted files removed
- renamed files preserve identity when possible

### 13.2 Embedding delta policy

Only the following should trigger re-embedding:

- new chunks
- changed chunk text
- embedding model switch
- explicit forced rebuild

### 13.3 Watch / maintenance pattern

The steady-state operational loop in local mode should be:

```text
file change -> sync changed markdown -> mark affected chunks stale -> embed stale chunks locally
```

This can be driven by:

- manual commands
- `gbrain sync --watch`
- editor-triggered scripts
- cron/launch-agent jobs on the local machine

### 13.4 Failure behavior

If local embedding fails:

- content import must still succeed
- the page remains searchable by keyword
- the health report surfaces pending/failed embeddings
- recovery is explicit and local

---

## 14. MCP Integration for Codex and Claude Code

### 14.1 MCP shape

The preferred client integration remains a **local stdio MCP server**:

```bash
gbrain serve
```

This is the correct fit for a local/offline personal brain because:

- no remote auth layer is needed
- no edge deployment is needed
- secrets stay on the local machine
- both clients can talk to the same local command surface

### 14.2 Codex integration

Codex CLI currently exposes local MCP management through `codex mcp add`.

Target installation flow:

```bash
codex mcp add gbrain -- gbrain serve
```

If environment variables are needed:

```bash
codex mcp add gbrain --env GBRAIN_CONFIG_PROFILE=local -- gbrain serve
```

### 14.3 Claude Code integration

Claude Code should connect to the same local stdio server using its MCP configuration model. The project already documents the same shape in `README.md` for local stdio MCP.

Target contract:

```json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

### 14.4 Product meaning

Codex and Claude Code are **consumers of the local brain**, not required online dependencies of the brain itself.

If the user has those subscriptions already, the brain can remain fully local and free to operate.

---

## 15. Offline Profile Semantics

A new explicit offline/local profile should exist.

### 15.1 Expected defaults

- engine = sqlite
- storage backend = local filesystem
- embedding provider = local
- query rewrite provider = heuristic or none
- update checks = disabled by default in offline profile
- remote MCP deployment helpers = not part of the default path

### 15.2 User promise

When offline profile is enabled, the system should not unexpectedly attempt:

- outbound embedding calls
- outbound Anthropic calls
- Supabase bootstrap
- storage bucket access
- remote MCP deployment

The system should be honest: if a feature needs network, it should be disabled in offline mode, not silently attempted.

---

## 16. Migration and Compatibility

### 16.1 Existing markdown users

No migration needed. The markdown repo stays canonical.

### 16.2 Existing hosted GBrain users

Hosted users should be able to move to local mode by:

1. exporting or re-syncing their markdown repo
2. initializing local SQLite
3. re-indexing locally
4. optionally re-embedding locally

### 16.3 Compatibility policy

The CLI/MCP operation names should remain stable wherever feasible. Backend changes should not force agent prompt rewrites unless behavior materially changes.

---

## 17. Security and Privacy

Local mode materially improves privacy:

- data stays on-device
- model calls stay on-device
- no remote DB or storage dependency
- no API keys required for core operation

Risks that remain:

- local disk compromise
- local model/runtime compromise
- accidental outbound access if offline mode is misconfigured

Mitigations:

- explicit offline profile
- health/doctor output showing active providers
- documentation that identifies which commands are networked vs local

---

## 18. Testing and Verification

The final local/offline implementation must prove:

1. **Init works locally**
   - initializes SQLite DB
   - creates config
   - no network required

2. **Import works without embeddings**
   - keyword search succeeds immediately

3. **Local embedding backfill works**
   - embeddings written locally
   - vector search returns meaningful results

4. **Incremental sync is delta-based**
   - unchanged files skip
   - changed files re-embed only affected chunks

5. **MCP works locally**
   - Codex connects to `gbrain serve`
   - Claude Code connects to `gbrain serve`

6. **Offline profile disables cloud assumptions**
   - no OpenAI/Anthropic/Supabase calls
   - doctor/config output reflects local providers only

7. **Graceful degradation works**
   - if embeddings are incomplete, keyword search still functions

---

## 19. Implementation Workstreams

The design is one final target state, but execution should be organized into these workstreams:

1. **Engine/bootstrap refactor**
2. **SQLite engine implementation**
3. **Local embedding provider + embedding queue/backfill**
4. **Local vector search + hybrid ranking**
5. **Offline profile + MCP client integration**
6. **Tests, docs, and verification**

These workstreams are intended to map directly to GitHub issues.

---

## 20. Risks and Mitigations

### Risk: local embedding is too slow

**Mitigation**

- decouple writes from embedding
- incremental stale-only embedding
- keyword search available immediately
- optional background processing

### Risk: exact vector scan is too slow for large brains

**Mitigation**

- baseline exact scan guarantees correctness
- optional accelerated local vector provider when available
- maintain keyword-first fallback

### Risk: local runtime configuration is fragile

**Mitigation**

- provider abstraction
- explicit health checks
- offline profile diagnostics
- documented recommended runtime

### Risk: current code is too Postgres-assumptive

**Mitigation**

- central engine factory
- command-level backend-neutral refactor
- parity tests across engines

---

## 21. Decision

GBrain will gain a **fully local/offline operating mode** based on:

- **SQLite** for the local engine
- **FTS5** for mandatory keyword search
- **local embeddings** for semantic retrieval
- **local stdio MCP** for Codex and Claude Code
- **incremental stale-only embedding** as the normal operating model
- **no mandatory cloud services or paid APIs**

This is the correct architecture for users who want a sovereign personal knowledge brain with zero recurring backend cost.

---

## 22. References

- `README.md`
- `CLAUDE.md`
- `src/core/engine.ts`
- `src/core/embedding.ts`
- `src/core/search/expansion.ts`
- `src/core/search/hybrid.ts`
- `src/core/import-file.ts`
- `src/commands/sync.ts`
- `src/commands/embed.ts`
- `docs/ENGINES.md`
- `docs/SQLITE_ENGINE.md`
- `docs/GBRAIN_SKILLPACK.md`
