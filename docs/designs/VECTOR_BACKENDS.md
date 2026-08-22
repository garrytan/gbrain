# Pluggable vector backends: pgvectorscale + VectorChord alongside pgvector (#3673)

Status: **proposal** (maintainer asked for a design before implementation).
Scope: Postgres engine only — PGLite has no pgvectorscale/VectorChord WASM
builds and always resolves to `pgvector` (see Degrade path).

## Problem

GBrain's ANN indexing is hardcoded to pgvector HNSW:

1. **Dimension cap.** HNSW indexes at most 2000 dims on `vector` columns and
   4000 on `halfvec` (`src/core/vector-index.ts:hnswMaxDimsForType`). Models
   above that (e.g. a 4096-dim embedding model) lose indexed search entirely
   and fall back to exact scans — today's degrade path, honest but slow at
   scale.
2. **RAM-bound scaling.** HNSW graphs must fit in memory; disk-resident ANN
   (StreamingDiskANN) scales past that for million-chunk brains.
3. **No backend choice.** Installed extensions (pgvectorscale, VectorChord)
   are ignored even when they would serve the brain better.

## Design answers to the three maintainer questions

### 1. Config key shape

    vector.backend = pgvector | pgvectorscale | vchord | auto     (default: pgvector)

- Dotted config namespace matches repo convention (`search.mode`, `pace.mode`,
  `cache.*`); the issue's `embedding_backend` spelling is folded into the
  `vector.*` namespace where future knobs (`vector.diskann.*` tuning GUCs)
  will live.
- Resolution chain mirrors pace-mode (env above config, incident escape
  hatch; no per-call override — the backend is a property of the INSTALL, not
  of a query):

      GBRAIN_VECTOR_BACKEND env → config vector.backend → 'pgvector'

- `auto` = probe `pg_extension` once at `initSchema`/connect: pick
  `pgvectorscale` when installed, else `pgvector`. `vchord` is never
  auto-selected until phase 2 is proven (explicit opt-in only).
- The REQUESTED backend (config) and the RESOLVED backend (what the probe
  actually found usable) are distinct values. The resolved value is what
  every downstream consumer keys off (index DDL, cache key, doctor). It is
  re-derived per process from a cheap `pg_extension` lookup — never persisted
  as truth, so a restored dump onto a host without the extension degrades
  correctly instead of trusting a stale config row.

### 2. Degrade path when the extension is absent

Fail-open, loud, and recorded — the same posture as the existing
`chunkEmbeddingIndexSql` dims-too-big skip:

- `initSchema`/migration probes `SELECT extname FROM pg_extension`. If the
  requested extension is missing, GBrain:
  1. warns once per process on stderr
     (`[vector] vector.backend=pgvectorscale requested but extension not
     installed — resolved to pgvector`),
  2. resolves the backend to `pgvector` and emits pgvector DDL (search keeps
     working; never a hard failure),
  3. surfaces a `gbrain doctor` finding with the exact fix
     (`CREATE EXTENSION vectorscale CASCADE;` + rebuild command).
- `CREATE EXTENSION IF NOT EXISTS vectorscale` is attempted (managed hosts
  like Timescale/self-hosted allow it; Supabase currently does not ship
  pgvectorscale — the probe result, not the attempt, decides resolution).
- PGLite: config may carry any value (a brain can be opened by both engines);
  the PGLite engine always resolves `pgvector` and warns once when the config
  asks for more. This preserves engine parity of BEHAVIOR (same query
  results, same SQL operators) while the index access method differs by
  engine capability.
- Dimension interplay: each backend gets its own max-dims policy replacing
  the bare `hnswMaxDimsForType`:

      backendMaxDims('pgvector', 'vector')   = 2000
      backendMaxDims('pgvector', 'halfvec')  = 4000
      backendMaxDims('pgvectorscale', ...)   = diskann cap (verify at impl; SBQ
                                               lifts it well past 4096)
      over cap → same "index skipped, exact scan" comment DDL as today

### 3. What the cache key must fold in

`knobsHash` (src/core/search/mode.ts) gains an append-only part:

    vb=<resolved_backend>            e.g. vb=pgvectorscale

with a `KNOBS_HASH_VERSION` bump in the same commit (the same discipline as
the v=10 relationalRetrieval fold). Rationale:

- Two backends are two different ANN approximations over the same vectors —
  recall sets differ, so a diskann-built result row must never be served to a
  pgvector-resolved lookup (and vice versa after a backend switch).
- Folding the RESOLVED backend (not the requested one) means a degraded
  install (asked for pgvectorscale, got pgvector) shares cache rows with
  plain pgvector installs — correct, they run identical plans.
- One-time cold-miss spike on upgrade/backend-switch; refills within
  `cache.ttl_seconds` (3600s). Same accepted pattern as prior bumps.

## Phase 1 — pgvectorscale (StreamingDiskANN)

Smallest possible diff; everything is DDL-level. pgvectorscale reuses
pgvector's column types and operators, so **no query SQL changes**:

- `src/core/vector-index.ts`: `chunkEmbeddingIndexSql(dims)` grows a backend
  parameter → emits `USING diskann (embedding vector_cosine_ops)` when
  resolved backend is `pgvectorscale` (pure function, unit-testable without a
  DB). Same treatment for the other emitter sites:
  `src/schema.sql:336/343` (via `applyChunkEmbeddingIndexPolicy`),
  `src/core/migrate.ts` takes/facts/query_cache/embedding_image index blocks,
  and the alt-embedding-column index path.
- Candidate-pool sizing seam: `hnsw.ef_search` (set transaction-locally in
  both engines' `searchVector`) has a diskann analogue
  (`diskann.query_rescore` / search-list sizing). `hnswEfSearchFor` becomes
  `backendCandidateGucs(backend, candidateLimit)` returning the right
  `set_config` calls; pgvector path byte-identical to today.
- Backend switch on an existing brain: reuse the atomic-swap machinery
  (`vector-index.ts:dropAndRebuild`) — build the diskann index under a temp
  name, swap, drop HNSW. Exposed as `gbrain embed reindex --backend=<b>`;
  doctor flags a resolved-backend vs actual-index-method mismatch
  (`pg_index` joined to `pg_am.amname`) as WARN with that exact command.
- `gbrain doctor` additions: requested vs resolved backend, extension
  presence/version, index method per embedding column.

## Phase 2 — VectorChord (vchordrq)

Explicit opt-in only, after phase 1 ships. Modern VectorChord builds its
`vchordrq` index on pgvector column types (unlike legacy pgvecto.rs, which
had incompatible column types — the issue's `vchord(N)` column concern; to be
re-verified at implementation). If column types stay pgvector, phase 2
collapses to another index-DDL + GUC variant of the phase-1 seam. If a
target VectorChord version does require its own types, phase 2 must also
touch `readContentChunksEmbeddingDim`/column-registry parsing and the
`::vector` casts in both engines — that cost is why it is sequenced second
and never auto-selected.

## Testing

- Unit (hermetic, always-on): DDL emitter matrix
  (backend × columnType × dims → exact DDL / skip comment), resolution chain
  (env > config > default), degrade resolution when the probe reports the
  extension missing, knobsHash includes `vb=` and the version bump.
- e2e (DATABASE_URL-gated, extension-gated): against a Postgres with
  pgvectorscale installed (timescale/timescaledb-ha image in CI or local),
  assert initSchema builds a diskann index, searchVector returns the same
  rows as the pgvector baseline on a small fixture (small N → exact-ish
  recall), and a backend switch rebuild swaps the index without dropping
  search availability. Skips with a named reason when the extension is
  absent — the same honest-skip pattern as existing DATABASE_URL gates.
- Engine parity: `test/e2e/engine-parity.test.ts` continues to compare
  pglite vs postgres RESULTS; backend choice must not change the parity
  contract (pgvectorscale returns pgvector-compatible operator semantics).

## Non-goals

- No per-query backend override (cache correctness + index reality make this
  meaningless).
- No automatic data migration between column types (phase 2 vchord types, if
  needed, ship behind an explicit migration command).
- No benchmark bake-off in-repo — the eval bar is "does an over-4000-dim
  model get indexed search back", proven by the gated e2e, not a research
  comparison (per North Star eval discipline).

## Rollout

1. This proposal lands for maintainer review (no behavior change).
2. Phase 1 PR: config key + resolution + DDL emitters + GUC seam + knobs_hash
   bump + doctor + gated e2e.
3. Phase 2 PR: VectorChord, after phase-1 field feedback.
