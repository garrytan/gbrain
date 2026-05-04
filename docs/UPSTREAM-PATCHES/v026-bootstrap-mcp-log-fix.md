# Upstream PR candidate: extend `applyForwardReferenceBootstrap` to v0.26.3 columns

> 2026-05-04 | Jarvis KOS v2 fork | Filed during v0.26.7 sync.
> Pending upstream PR (no fork-local patch — file directly to
> `garrytan/gbrain` master so the next sync drops this doc).

## What broke

Production Postgres (Jarvis KOS v2 brain, ~2477 pages, schema v31)
sat at v31 because two prior `gbrain apply-migrations --yes` runs
silently failed. After the v0.25.0 → v0.26.7 fork merge,
`gbrain doctor --json` reported:

```json
"connection": "fail",
"message": "column \"deleted_at\" does not exist"
```

`gbrain init --migrate-only` (run from a v0.26.7 binary against the
v31 brain) failed earlier in the chain with:

```
column "agent_name" does not exist
```

`GBRAIN_DEBUG=1` traced the error to the **SCHEMA_SQL replay phase**
that runs **before** any v32/v33/v34 migration. That phase replays
`src/schema.sql` (embedded in `src/core/schema-embedded.ts`) under the
"create-if-not-exists" assumption.

The offending line in v0.26.7 SCHEMA_SQL:

```sql
-- src/schema.sql:420
CREATE INDEX IF NOT EXISTS idx_mcp_log_agent_time
  ON mcp_request_log(agent_name, created_at DESC);
```

`mcp_request_log` exists from v0.22.7 (5-column form: `id`, `token_name`,
`operation`, `latency_ms`, `status`, `created_at`). The `agent_name`
column was added in v0.26.3 (migration v33,
`admin_dashboard_columns_v0_26_3` in `src/core/migrate.ts`). When SCHEMA_SQL
replay hits the `CREATE INDEX … (agent_name, …)` line on a v31 brain,
the column doesn't exist yet (the migration hasn't run because we're
still in the *pre-migration* SCHEMA replay phase) and `CREATE INDEX
IF NOT EXISTS` raises `column does not exist` — not `index does not
exist` — so `IF NOT EXISTS` doesn't help.

## Why the existing forward-reference bootstrap missed this

Both engine `initSchema` paths call `applyForwardReferenceBootstrap()`
**before** `conn.unsafe(SCHEMA_SQL)`. The bootstrap probes for specific
forward-referenced columns and adds only what's missing
(`src/core/postgres-engine.ts:144`, `src/core/pglite-engine.ts` mirror).

Current bootstrap covers (verified against v0.26.7 source):

- `sources` table + default seed (FK target of `pages.source_id`) — v0.18
- `pages.source_id` column (indexed by `idx_pages_source_id`) — v0.18
- `links.link_source` column (indexed by `idx_links_source`) — v0.13
- `links.origin_page_id` column (indexed by `idx_links_origin`) — v0.13
- `content_chunks.symbol_name` column (indexed by `idx_chunks_symbol_name`) — v0.19
- `content_chunks.language` column (indexed by `idx_chunks_language`) — v0.19
- `pages.deleted_at` column (indexed by `pages_deleted_at_purge_idx`) — v0.26.5

**Missing**: the v0.26.3 columns on `mcp_request_log`:

- `mcp_request_log.agent_name` (indexed by `idx_mcp_log_agent_time`)
- `mcp_request_log.params`
- `mcp_request_log.error_message`

CLAUDE.md (project root) describes the `REQUIRED_BOOTSTRAP_COVERAGE`
CI guard in `test/schema-bootstrap-coverage.test.ts` as "structurally
prevent[ing]" this class of bug. The guard caught nothing in v0.26.3
because the v0.26.3 PR added `agent_name` to `schema.sql` and to
migration v33, but **didn't extend** `REQUIRED_BOOTSTRAP_COVERAGE` /
`applyForwardReferenceBootstrap()`.

## Reproducer

Any brain with `schema_version <= 31` upgrading to gbrain ≥ v0.26.3 hits
this. Quick repro on a fresh PGLite brain:

```bash
# Fresh v0.22.7 brain
gbrain init  # version pin to 0.22.7 here
echo "schema_version=31" >>  ~/.gbrain/config

# Upgrade to v0.26.7+
gbrain init --migrate-only
# → "column \"agent_name\" does not exist"
```

## Manual unblock (what we ran)

```sql
ALTER TABLE mcp_request_log
  ADD COLUMN IF NOT EXISTS agent_name TEXT,
  ADD COLUMN IF NOT EXISTS params JSONB,
  ADD COLUMN IF NOT EXISTS error_message TEXT;
```

After this, `gbrain init --migrate-only` proceeded, applied 3 migrations
(v32 + v33 + v34), and `gbrain doctor --json` returned `connection: ok,
schema_version 34 (latest: 34)`.

## Proposed upstream fix (for the PR)

### `src/core/postgres-engine.ts#applyForwardReferenceBootstrap`

Extend the probe SELECT and the column-add block:

```typescript
// Add to probe row type:
mcp_log_exists: boolean;
mcp_log_agent_name_exists: boolean;
mcp_log_params_exists: boolean;
mcp_log_error_message_exists: boolean;

// Add to probe SELECT:
EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'mcp_request_log') AS mcp_log_exists,
EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'mcp_request_log' AND column_name = 'agent_name') AS mcp_log_agent_name_exists,
EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'mcp_request_log' AND column_name = 'params') AS mcp_log_params_exists,
EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'mcp_request_log' AND column_name = 'error_message') AS mcp_log_error_message_exists,

// Add bootstrap block after pages.deleted_at:
if (probe.mcp_log_exists && !probe.mcp_log_agent_name_exists) {
  await conn.unsafe(`ALTER TABLE mcp_request_log ADD COLUMN agent_name TEXT`);
}
if (probe.mcp_log_exists && !probe.mcp_log_params_exists) {
  await conn.unsafe(`ALTER TABLE mcp_request_log ADD COLUMN params JSONB`);
}
if (probe.mcp_log_exists && !probe.mcp_log_error_message_exists) {
  await conn.unsafe(`ALTER TABLE mcp_request_log ADD COLUMN error_message TEXT`);
}
```

### `src/core/pglite-engine.ts`

Mirror the same change in the PGLite engine (single-row probe via
`EXEC` against `pg_catalog`).

### `test/schema-bootstrap-coverage.test.ts`

Extend `REQUIRED_BOOTSTRAP_COVERAGE` array:

```typescript
['mcp_request_log', 'agent_name'],
['mcp_request_log', 'params'],
['mcp_request_log', 'error_message'],
```

### `test/e2e/postgres-bootstrap.test.ts`

Add a regression case "v0.22.7 brain (mcp_request_log without agent_name)
→ v0.26.7 SCHEMA_SQL replay must not throw":

```typescript
it("bootstraps v0.26.3 columns when SCHEMA_SQL forward-references them", async () => {
  // Seed a v0.22.7-shape mcp_request_log table (5 cols, no agent_name)
  await sql.unsafe(`
    CREATE TABLE mcp_request_log (
      id SERIAL PRIMARY KEY,
      token_name TEXT,
      operation TEXT NOT NULL,
      latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'success',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // initSchema must not throw on the agent_name index forward reference
  await engine.initSchema();
  // Verify agent_name was bootstrapped
  const cols = await sql.unsafe(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='mcp_request_log' AND column_name='agent_name'`,
  );
  expect(cols.length).toBe(1);
});
```

## Action items

- [ ] **Filed by fork**: this PR. Single commit, ~50 lines src + ~30
      lines test.
- [ ] After upstream merge: drop this doc, drop the corresponding
      `P0 upstream PR` row from `skills/kos-jarvis/TODO.md`.
- [ ] If upstream pushes back on the e2e test (PgBouncer transaction-mode
      shape), keep the unit-level coverage in
      `test/schema-bootstrap-coverage.test.ts` only.

## Why fork-local patch is *not* the right path

This is a **2-line probe extension** in code paths the fork doesn't own
(`src/core/postgres-engine.ts`, `src/core/pglite-engine.ts`). Patching
fork-local would (a) collide with every future upstream sync, and (b)
mask the bug from upstream's CI. File the PR; carry the manual ALTER
runbook (above) until merge.

If upstream takes more than 30 days to merge, revisit and consider a
fork-local prepend to `applyForwardReferenceBootstrap` mirroring the
existing patch shape — but the diff is small enough that the PR path
should win.

---

**Production patch trail (this fork)**: 2026-05-04, manual `ALTER TABLE
mcp_request_log ADD COLUMN IF NOT EXISTS …` ran from `chenyuanquan@…`
psql session. `init --migrate-only` then completed v32/v33/v34. doctor
status: warnings (85), schema_version=34 (latest). No data loss; all
three columns are nullable additions.
