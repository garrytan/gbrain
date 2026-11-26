import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2476 gap 1: access_read_log, one row per read a non-owner member or audience made (an enforced member CLI read,
// or a remote read bound to a member or asserting an audience): when, who, which operation, over which transport, its
// result code and the ids of the pages it returned. No page text and no query terms. Written off the response path by
// src/core/access/read-log.ts, only for those callers, so a brain with no members never writes a row; that module also
// keeps it to a year and a million rows. Operational state, not brain content: a repo-less brain gets it unchanged.
// RLS is enabled here (v275's list is frozen). No schema.sql mirror: like v310, it exists only through migrations.
export const v331: Migration = {
  version: 331,
  name: 'access_read_log',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS access_read_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  member TEXT,
  audience TEXT[],
  operation TEXT NOT NULL,
  transport TEXT NOT NULL,
  result_code TEXT NOT NULL,
  page_ids INTEGER[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_access_read_log_time ON access_read_log (created_at);
CREATE INDEX IF NOT EXISTS idx_access_read_log_member_time ON access_read_log (member, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_read_log_pages ON access_read_log USING GIN (page_ids);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE access_read_log ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
