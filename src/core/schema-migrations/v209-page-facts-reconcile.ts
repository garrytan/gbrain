import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Facts reconcile watermark (#5151, src/core/facts/reconcile-watermark.ts):
// per page, the knowledge_revision extract_facts last reconciled completely
// and the outcome of its latest attempt. A side table, not a pages column, so
// stamping it never fires the pages triggers. Created empty: every page starts
// due, and the cycle drains them in bounded batches. Migration-only like
// page_mention_state. Placeholder number: the fix wave 9 integrator renumbers it.
export const v209: Migration = {
  version: 209,
  name: 'page_facts_reconcile',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS page_facts_reconcile (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      reconciled_revision UUID,
      reconciled_at TIMESTAMPTZ,
      outcome TEXT NOT NULL CHECK (outcome IN ('complete','deferred','invalid','cancelled')),
      attempted_revision UUID,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    DO $rls$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls) THEN
        ALTER TABLE page_facts_reconcile ENABLE ROW LEVEL SECURITY;
      END IF;
    END $rls$;
  `,
};
