import { MANAGED_WRITER_GUARD_SQL } from './writer-guard-schema.ts';
/** Permanent terminal receipts stay outside owner recovery scans after cleanup. */
export const PERSISTENCE_REQUEST_RECOVERY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_recovery
  ON persistence_requests(worktree_id,sequence) WHERE recovery IS NOT NULL`;
export const PERSISTENCE_DATABASE_PENDING_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_database_pending
  ON persistence_requests(source_incarnation,sequence) WHERE worktree_id IS NULL AND state IN ('queued','running','recovering')`;
/**
 * #5762: the managed sync checkpoint validation probes (sync-prepare.ts) read a
 * run's open page receipts and its committed siblings through these. Postgres
 * builds them CONCURRENTLY in a schema migration (never inside the blob);
 * PGLite and a brand-new request table (v151) build them inline.
 */
export const PERSISTENCE_SYNC_RUN_OPEN_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_sync_run_open
  ON persistence_requests(worktree_id,(intent->>'runId')) WHERE state<>'committed' AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete')`;
export const PERSISTENCE_SYNC_RUN_COMMITTED_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_sync_run_committed
  ON persistence_requests(source_id,(intent->>'runId'),(intent->>'index')) WHERE state='committed' AND intent ? 'runId'`;
export const PERSISTENCE_SYNC_RUN_INDEXES = [
  { name: 'persistence_requests_sync_run_open', sql: PERSISTENCE_SYNC_RUN_OPEN_INDEX_SQL },
  { name: 'persistence_requests_sync_run_committed', sql: PERSISTENCE_SYNC_RUN_COMMITTED_INDEX_SQL },
] as const;
/**
 * #6317: the movement watermark (the newest committed receipt of a worktree)
 * that `writer movement`, `data_moving` and doctor `managed_sync_not_moving`
 * read; the baseline indexes cover pending, recovery and principal reads
 * only. Postgres builds it CONCURRENTLY in migration v222; PGLite inline.
 * Superseded by the sync watermark below: v223 drops it, and fresh installs
 * build only the new one.
 */
export const PERSISTENCE_COMMITTED_WATERMARK_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_committed_watermark
  ON persistence_requests(worktree_id,completed_at DESC) WHERE state='committed'`;
export const PERSISTENCE_COMMITTED_WATERMARK_INDEX = { name: 'persistence_requests_committed_watermark', table: 'persistence_requests', sql: PERSISTENCE_COMMITTED_WATERMARK_INDEX_SQL } as const;
/**
 * The movement watermark read (sync-movement.ts): the newest committed managed
 * sync receipt of one worktree and incarnation. v222's index above holds every
 * committed receipt, so on a brain whose newest receipts are imports or
 * maintenance writes the read walked all of them and detoasted each intent to
 * test its kind (about 1 s at 50k receipts). Receipts are permanent (compaction
 * after `persistence.receipt_retention_days` only drops the intent), so that
 * walk grew with every write. This index holds only the receipts the read can
 * return, and compaction removes a receipt from it. Postgres builds it
 * CONCURRENTLY in migration v223, which drops v222's index; PGLite inline.
 */
export const PERSISTENCE_SYNC_WATERMARK_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_sync_watermark
  ON persistence_requests(worktree_id,source_incarnation,completed_at DESC) WHERE state='committed' AND COALESCE(intent->>'kind','') LIKE 'managed_sync_%'`;
export const PERSISTENCE_SYNC_WATERMARK_INDEX = { name: 'persistence_requests_sync_watermark', table: 'persistence_requests', sql: PERSISTENCE_SYNC_WATERMARK_INDEX_SQL } as const;
/**
 * Receipt compaction's candidate scan (journal.ts `compactWriteReceipts`, on
 * every idle maintenance tick of a resident consumer): terminal receipts not
 * yet compacted whose `completed_at` is past the retention window. Without it
 * the scan read every receipt ever written (82 ms at 50k receipts, growing with
 * each write) to find none. Compaction removes a receipt from the index.
 * Postgres builds it CONCURRENTLY in migration v223; PGLite inline.
 */
export const PERSISTENCE_COMPACTABLE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_compactable
  ON persistence_requests(completed_at) WHERE recovery IS NULL AND NOT compacted AND state IN ('committed','conflict','failed','cancelled')`;
export const PERSISTENCE_COMPACTABLE_INDEX = { name: 'persistence_requests_compactable', table: 'persistence_requests', sql: PERSISTENCE_COMPACTABLE_INDEX_SQL } as const;
/**
 * #6317: one row per process that runs a full persistence consumer on a host
 * (consumer-heartbeat.ts). The primary key carries the process nonce, so a
 * reused pid after a container restart is a new row; `pid_ns` tells pid
 * namespaces apart. `renewed_at` is the liveness signal (live within 30 s,
 * lapsed at 60 s, purged by a renewal after 90 s); `restart_required` and
 * `root_barrier_age_ms` are the owner's own wedge report; `host_json_path`,
 * `persistence_home` and `minted_under` let doctor name the owner's identity
 * file without reading its filesystem.
 */
export const PERSISTENCE_CONSUMERS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS persistence_consumers (
    host_id uuid NOT NULL,
    pid integer NOT NULL,
    nonce text NOT NULL,
    pid_ns text,
    kind text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('probing','full','waiter_only','promoted')),
    started_at timestamptz NOT NULL DEFAULT now(),
    renewed_at timestamptz NOT NULL DEFAULT now(),
    restart_required boolean NOT NULL DEFAULT false,
    root_barrier_age_ms integer,
    pool jsonb,
    host_json_path text NOT NULL,
    persistence_home text NOT NULL,
    minted_under jsonb,
    version text NOT NULL,
    PRIMARY KEY(host_id,pid,nonce)
  )`;
/** Indexes the Postgres blob omits because a migration builds them CONCURRENTLY. */
export const POSTGRES_CONCURRENT_PERSISTENCE_INDEXES: ReadonlySet<string> = new Set([
  PERSISTENCE_DATABASE_PENDING_INDEX_SQL, PERSISTENCE_SYNC_RUN_OPEN_INDEX_SQL, PERSISTENCE_SYNC_RUN_COMMITTED_INDEX_SQL, PERSISTENCE_SYNC_WATERMARK_INDEX_SQL, PERSISTENCE_COMPACTABLE_INDEX_SQL,
]);
/** Durable infrastructure: never reconstruct or discard these rows during page reindexing. */
export const PERSISTENCE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS persistence_brain (
    singleton integer PRIMARY KEY CHECK (singleton = 1),
    brain_id uuid NOT NULL DEFAULT gen_random_uuid(),
    enabled boolean NOT NULL DEFAULT false,
    activated_at timestamptz
  )`,
  `INSERT INTO persistence_brain(singleton) VALUES (1) ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS persistence_worktrees (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_host_id uuid,
    owner_epoch bigint NOT NULL DEFAULT 0,
    topology_generation bigint NOT NULL DEFAULT 1,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','draining','recovering')),
    manifest jsonb,
    heartbeat_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS persistence_source_bindings (
    source_id text PRIMARY KEY,
    source_incarnation uuid NOT NULL,
    worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
    relative_path text NOT NULL DEFAULT '',
    topology_generation bigint NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS persistence_host_bindings (
    worktree_id uuid NOT NULL REFERENCES persistence_worktrees(id),
    host_id uuid NOT NULL,
    local_path text NOT NULL,
    coordination_path text NOT NULL,
    PRIMARY KEY(worktree_id,host_id)
  )`,
  `CREATE TABLE IF NOT EXISTS persistence_local_writers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    lane text NOT NULL CHECK (lane IN ('cli','stdio')),
    credential_hash text NOT NULL UNIQUE,
    grant_ceiling jsonb NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS persistence_counters (
    key text PRIMARY KEY,
    outstanding_count bigint NOT NULL DEFAULT 0 CHECK (outstanding_count >= 0),
    intent_bytes bigint NOT NULL DEFAULT 0 CHECK (intent_bytes >= 0),
    lifetime_ids bigint NOT NULL DEFAULT 0 CHECK (lifetime_ids >= 0),
    terminal_bytes bigint NOT NULL DEFAULT 0 CHECK (terminal_bytes >= 0),
    recovery_bytes bigint NOT NULL DEFAULT 0 CHECK (recovery_bytes >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS persistence_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_kind text NOT NULL CHECK (principal_kind IN ('oauth_client','legacy_token','local_cli','local_stdio','application')),
    principal_id text NOT NULL,
    request_id uuid NOT NULL,
    operation text NOT NULL,
    source_id text NOT NULL,
    source_incarnation uuid NOT NULL,
    page_id integer,
    slug text NOT NULL,
    worktree_id uuid REFERENCES persistence_worktrees(id),
    topology_generation bigint,
    digest text NOT NULL,
    intent jsonb,
    authority jsonb NOT NULL,
    sequence bigserial NOT NULL UNIQUE,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','recovering','committed','conflict','failed','cancelled')),
    execution_token uuid,
    claim_expires_at timestamptz,
    recovery jsonb,
    recovery_bytes bigint NOT NULL DEFAULT 0,
    intent_bytes bigint NOT NULL,
    terminal_reservation bigint NOT NULL,
    outcome jsonb,
    error_code text,
    error_message text,
    blocked_reason text,
    compacted boolean NOT NULL DEFAULT false,
    publication_started boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE(principal_kind,principal_id,request_id)
  )`,
  `CREATE INDEX IF NOT EXISTS persistence_requests_pending ON persistence_requests(worktree_id,sequence)
    WHERE state IN ('queued','running','recovering')`,
  PERSISTENCE_REQUEST_RECOVERY_INDEX_SQL,
  PERSISTENCE_DATABASE_PENDING_INDEX_SQL,
  PERSISTENCE_SYNC_RUN_OPEN_INDEX_SQL,
  PERSISTENCE_SYNC_RUN_COMMITTED_INDEX_SQL,
  PERSISTENCE_SYNC_WATERMARK_INDEX_SQL,
  PERSISTENCE_COMPACTABLE_INDEX_SQL,
  `CREATE INDEX IF NOT EXISTS persistence_requests_principal ON persistence_requests(principal_kind,principal_id,sequence DESC)`,
  `CREATE TABLE IF NOT EXISTS persistence_effects (
    id bigserial PRIMARY KEY,
    request_id uuid NOT NULL REFERENCES persistence_requests(id),
    kind text NOT NULL,
    revision uuid,
    data jsonb NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','committed','failed')),
    execution_token uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(request_id,kind)
  )`,
  PERSISTENCE_CONSUMERS_TABLE_SQL,
  MANAGED_WRITER_GUARD_SQL,
] as const;
