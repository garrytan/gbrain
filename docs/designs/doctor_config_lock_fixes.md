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

### 3. `links_extraction_lag` pinned near 100% on any pre-versionTs corpus
`countStalePagesForExtraction` marks a page stale when `links_extracted_at IS
NULL OR links_extracted_at < versionTs OR updated_at > links_extracted_at`
(versionTs = `LINK_EXTRACTOR_VERSION_TS`, currently 2026-05-31). The
`extract --stale` sweep stamps `links_extracted_at = page.updated_at` (the read
value, a deliberate D4 race fix). For any page whose CONTENT predates versionTs,
`updated_at < versionTs`, so the stamp lands below versionTs and condition 2
(`links_extracted_at < versionTs`) stays true FOREVER — the sweep re-processes
the same pages every run and the lag metric never drops. Verified on a live
brain: 956/991 pages had `updated_at < 2026-05-31`; repeated `extract --stale
--catch-up` left all 956 "stale" via condition 2 while conditions 1 and 3 were
clean (0 NULL, 0 `updated_at > links_extracted_at`). My earlier guess (cycle
phase ordering bumping `updated_at`) was WRONG — the live breakdown disproved it.

Fix (extract.ts `extractStaleFromDB`): stamp `max(updated_at, versionTs)` instead
of `updated_at`. Clears condition 2 (the page WAS just processed by the current
extractor version — that's what the stamp should record) AND keeps the D4
race-safety (a concurrent edit advances `updated_at` to now() > versionTs, still
> the floored stamp, so it re-extracts). Validated on the live brain: stale count
956 → 0, `links_extraction_lag` flips to OK (0/991). Done in this branch.

## Partially addressed — doctor message fixed, index feature deferred

### 4. `embedding_column_registry` recommended an impossible index DDL (message fixed; index work deferred)
Column is `vector(2048)`. pgvector caps `vector` HNSW at 2000 dims, so
`chunkEmbeddingIndexSql` already SKIPS the index above 2000 dims by design and
search uses exact seq scan — this is intentional, not a silent failure. The
actual defect was the doctor's `embedding_column_registry` check, which still
told the operator to run `CREATE INDEX ... USING hnsw (embedding
vector_cosine_ops)` — a statement that ALWAYS errors above 2000 dims. Fixed in
this branch: for a `vector` column wider than the cap the check now explains
seq scan is expected and points to the halfvec migration path instead of
emitting the failing DDL.

ENABLING an index for >2000-dim columns (the real feature) is deliberately NOT
done here. It requires migrating the column to `halfvec` (storage + the
`embedding_columns` registry so `buildVectorCastFragment` casts the column to
`halfvec_cosine_ops`, matching the index) — `facts`/`query_cache` already do
this (migrate.ts), `content_chunks` does not — plus a retrieval-recall eval
(halfvec is float16; HNSW is approximate). This overlaps the in-flight
`origin/garrytan/vector-search-max-pool` branch, so it should be coordinated
there rather than landed as a competing change. Benign to defer: seq scan is
sub-second at ~1k pages.
