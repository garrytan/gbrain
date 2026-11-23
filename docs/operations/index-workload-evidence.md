# Retain evidence for a zero-scan index

`gbrain doctor --index-audit` reports actual PostgreSQL counters. Catalog evidence identifies physical indexes that enforce writes and indexes on empty heap tables. A zero-scan index on a populated table remains open until a scan is observed or the local operator retains supporting workload evidence.

For long-lived or intermittent workloads, record a positive historical scan linked to the same physical object or compare the actual query with and without the index in a disposable copy. Preserve equivalent results, the planner-selected index and the supporting plans. Use the current PostgreSQL major version for the comparison.

The optional owner-only file `doctor/index-workload-evidence.json` lives under the brain configuration directory. The object contains `version: 1`, a `location` with `cluster_system_identifier`, `database_oid`, and `postgres_major`, and an `indexes` array. Each item holds `index` and `proof`.

- `index` contains `name`, `index_oid`, `table_oid`, `index_filenode`, `table_filenode`, and `definition_sha256`. Use decimal strings for relation identifiers. Compute the definition digest from UTF-8 `pg_get_indexdef(index_oid)` with `search_path = pg_catalog`.
- A `recorded_scan` proof has `kind`, `observed_at`, a positive `scans` count, `snapshot_sha256`, and `lineage_sha256`.
- A `workload` proof has `kind`, `observed_at`, a stable `workload_id`, `selected_by_planner: true`, `equivalent_results: true`, and `plan_sha256`. Keep the supporting artifact linked to each digest.

PostgreSQL must allow the Doctor connection to read the cluster identifier for a retained receipt to count. Rebuilt or replaced objects require new evidence. The report preserves the raw zero-scan count and lists the findings that still lack evidence.
