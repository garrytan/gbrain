import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-1856: ingest_applied_captures records that an ingest_capture job's write
// landed, keyed by the job's idempotency key and written in the page write's
// own transaction (or, on a managed brain, right after the door commits). A
// later run of the same key returns the stored result instead of writing the
// body again, so a stalled attempt re-run or a POST /ingest replayed after
// `gbrain jobs prune` no longer reverts a newer edit. The dream cycle's purge
// phase drops rows past 90 days (purgeStaleAppliedCaptures). Operational
// state, not brain content: a repo-less brain gets it unchanged. Created empty;
// nothing is rewritten on upgrade. No schema.sql mirror: like v282-v290, it
// exists only through migrations. The number is a placeholder restamped at the
// merge slot.
export const v296: Migration = {
  version: 296,
  name: 'ingest_applied_captures',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS ingest_applied_captures (
  idempotency_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  result JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_applied_captures_applied_at_idx ON ingest_applied_captures (applied_at);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE ingest_applied_captures ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
