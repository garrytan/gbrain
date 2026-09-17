import { MANAGED_WRITER_GUARD_SQL } from './writer-guard-schema.ts';
/** Permanent terminal receipts stay outside owner recovery scans after cleanup. */
export const PERSISTENCE_REQUEST_RECOVERY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS persistence_requests_recovery
  ON persistence_requests(worktree_id,sequence) WHERE recovery IS NOT NULL`;
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
  MANAGED_WRITER_GUARD_SQL,
] as const;
