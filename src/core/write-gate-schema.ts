/**
 * #5575 write gate storage DDL: one canonical copy used by the schema
 * migration and, through scripts/build-schema.ts FRAGMENTS, by fresh-install
 * DDL.
 *
 * write_gate_receipts: one row per non-allow verdict (flag, quarantine) on a
 * persisted target, deduped on (target_table, target_id, content_hash,
 * detector_version); the unique index leads with (target_table, target_id),
 * so it also serves per-target lookups (ENG-22). A rejected write leaves no
 * row: its persistence request receipt records the refusal. No matched text
 * is stored, only pattern names. Pruned by `pruneWriteGateReceipts`.
 *
 * write_gate_holds: quarantined facts and takes (B4), kept out of the facts
 * and takes tables so no reader needs a new filter. `payload` is the row as
 * the writer would have inserted it; it is never searched or embedded.
 * Deduped on (source_id, slug, fingerprint, detector_version); the same
 * content arriving again re-opens a released or dropped hold.
 */

/**
 * Bumped whenever the pattern table changes meaning; stored on every receipt
 * and hold, and in the legacy-scan baseline v227 records (a brain created
 * under this detector owes no scan of rows its writers already gated).
 */
export const WRITE_GATE_DETECTOR_VERSION = 2;

/** Config key v227 seeds: the detector version and per-table max ids when the gate went live (eligibility/scan.ts). */
export const WRITE_GATE_SCAN_BASELINE_KEY = 'write_gate.scan_baseline';

export const WRITE_GATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS write_gate_receipts (
  id               BIGSERIAL PRIMARY KEY,
  target_table     TEXT NOT NULL CHECK (target_table IN ('pages','facts','takes','timeline_entries','write_gate_holds')),
  target_id        TEXT NOT NULL,
  source_id        TEXT,
  content_hash     TEXT NOT NULL,
  tier             TEXT NOT NULL,
  detector_version INTEGER NOT NULL,
  verdict          TEXT NOT NULL CHECK (verdict IN ('flag','quarantine')),
  reason_families  TEXT[] NOT NULL DEFAULT '{}',
  reasons          TEXT[] NOT NULL DEFAULT '{}',
  detector_error   BOOLEAN NOT NULL DEFAULT false,
  request_id       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS write_gate_receipts_target_idx ON write_gate_receipts (target_table, target_id, content_hash, detector_version);
CREATE INDEX IF NOT EXISTS write_gate_receipts_seen_idx ON write_gate_receipts (last_seen_at);
CREATE TABLE IF NOT EXISTS write_gate_holds (
  id               BIGSERIAL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('fact','take')),
  source_id        TEXT NOT NULL,
  slug             TEXT NOT NULL DEFAULT '',
  fingerprint      TEXT NOT NULL,
  detector_version INTEGER NOT NULL,
  tier             TEXT NOT NULL,
  reason_families  TEXT[] NOT NULL DEFAULT '{}',
  reasons          TEXT[] NOT NULL DEFAULT '{}',
  detector_error   BOOLEAN NOT NULL DEFAULT false,
  payload          JSONB NOT NULL,
  write_origin     JSONB,
  request_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','dropped')),
  seen_count       INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ,
  decided_by       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS write_gate_holds_dedupe_idx ON write_gate_holds (source_id, slug, fingerprint, detector_version);
CREATE INDEX IF NOT EXISTS write_gate_holds_status_idx ON write_gate_holds (status, source_id, id);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE write_gate_receipts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE write_gate_holds ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`;
