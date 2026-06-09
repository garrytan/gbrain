# Doctor / config / lock fixes — investigation notes

Branch `fix/doctor-config-lock-bugs`. Found while remediating a live
postgres/Supabase brain (voyage-4-large, 2048d, ~990 pages) whose `gbrain
doctor` reported a `cycle_freshness` FAIL and a wall of warnings.

## Fixed in this branch

### 1. Federated source `config` stored as a double-encoded JSONB string
`addSource` (both paths) wrote `config` via
`engine.executeRaw(... $4::jsonb, [JSON.stringify(config)])`. Through postgres-js
the stringified param + `::jsonb` cast double-encodes into a JSONB **string
scalar** (`"{\"federated\":true}"`), not an object — the exact failure the
`updateSourceConfig` comment documents. Effects on the live brain:
- `config->>'last_full_cycle_at'` returns null forever (can't key into a scalar).
- Each per-cycle stamp ran `string || object`, producing a JSONB **array** that
  grew one element per cycle (~190 entries) and never an object with the key.
- `cycle_freshness` therefore FAILed permanently for every federated source,
  while `default` (created via an inline `'{"federated":true}'::jsonb` literal in
  migrate.ts) was fine.

Fix: route both INSERTs through `executeRawJsonb` (gbrain#1861 contract) so the
object is bound as real jsonb on both postgres-js and PGLite.
Data repair on the live brain was done out-of-band (rebuild config as a clean
object). The `check-jsonb-pattern.sh` guard did NOT catch this because it scans
for `${..}::jsonb` string interpolation, not a `JSON.stringify` *parameter*.
Consider widening that guard.

### 2. Autopilot lock liveness (systemd flap)
`runAutopilot` treated a lock file with mtime < 10 min as "another instance
running" and `exit(0)` — without checking whether the stored pid is alive.
A SIGTERM'd autopilot (`systemctl restart`) can leave the lock with a fresh
mtime but a dead pid (the SIGTERM unlink at autopilot.ts has a TOCTOU window and
`process.on('exit')` is intentionally not used). Every relaunch then exits and
the unit flaps in `activating (auto-restart)`. Fix: read the lock's pid and
probe it with `process.kill(pid, 0)`; take over when the holder is dead
regardless of mtime.

### 5. doctor-categories drift for onboard checks
7 checks defined in `src/core/onboard/checks.ts` (embed_staleness,
entity_link_coverage, timeline_coverage, takes_count, type_proliferation,
pack_upgrade_available, dangling_aliases) are surfaced through the doctor and run
through `categorizeCheck`, but were absent from the category sets → a
once-per-run stderr warn and miscategorization to 'meta'. Fix: add them
(brain×5, meta×2) AND extend the drift-guard test's `enumerateCheckNames()` to
scan `onboard/checks.ts`, not just `doctor.ts` — otherwise the categorized names
read as "stale". Both directions of the guard now pass.

## NOT fixed here — need retrieval/eval validation before landing

### 3. `links_extraction_lag` is a structural false positive under autopilot
`countStalePagesForExtraction` (postgres-engine.ts) marks a page stale when
`links_extracted_at IS NULL OR links_extracted_at < versionTs OR updated_at >
links_extracted_at`. Within one cycle, `extract` runs BEFORE the page-mutating
phases (`recompute_emotional_weight`, `consolidate`) which bump `updated_at`, so
by end of cycle every touched page satisfies `updated_at > links_extracted_at`
again. Under continuous autopilot the lag pins near 100% even when no edges are
missing (verified: a full `extract --stale --catch-up` left 0 truly-stale rows
by the NULL/updated_at breakdown, yet the doctor still reported 96%).
Proposed approaches (pick one, needs a cycle-semantics decision):
- Re-stamp `links_extracted_at` at end of cycle after the mutating phases, or
- Compare staleness against a content-changed watermark (content_hash) rather
  than `updated_at`, which bumps on extraction-irrelevant column writes, or
- Order `extract` last among page-touching phases.

### 4. No HNSW index possible on `content_chunks.embedding` for >2000-dim models
Column is `vector(2048)`; pgvector caps `vector` HNSW at 2000 dims, so the
canonical `CREATE INDEX ... hnsw(embedding vector_cosine_ops)` (schema.sql,
vector-index.ts, retrieval-upgrade-planner.ts) fails silently and search falls
back to seq scan. `facts`/`query_cache` already switch to
`halfvec_cosine_ops` above 2000 dims (migrate.ts), but `content_chunks` does
not, and the runtime query (postgres-engine.ts `embedding <=> '...'::vector`)
casts to `::vector`, so even a halfvec expression index wouldn't be used.
Proposed fix (gated on embedding_dimensions > 2000): build the index as
`hnsw((embedding::halfvec(N)) halfvec_cosine_ops)` AND cast the query to
`embedding::halfvec(N) <=> $1::halfvec(N)`, mirroring the facts/query_cache
path. Needs the retrieval eval suite to confirm no recall regression. Benign at
small scale (seq scan is sub-second at ~1k pages).
