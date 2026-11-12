import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2521: the per-page label guard. The owner's label door (`gbrain repair visibility`, its `--readers` setter,
// `gbrain repair private-labels`) keeps a page's trust tier, so labels the owner set on an agent-written page were
// guarded only at the agent tier, and a later agent write at that tier could drop them. The door now records
// operator_curated here, and the GST-2518 label guard (trust/page-write.ts privacyLabelGuard) reads it as a floor. One
// row per page, removed with the page. A separate table, not a pages column, so writing it fires none of the page
// triggers (trust stamp, revision, generation). Database only, so a repo-less brain gets it unchanged; on a managed Git
// brain it is not in the files, so a brain rebuilt from a clone starts with no rows (the owner's label door sets them
// again). No schema.sql mirror: like v282, v283 and v300, it exists only through migrations.
export const v307: Migration = {
  version: 307,
  name: 'page_label_guards',
  idempotent: true,
  sql: `
CREATE TABLE IF NOT EXISTS page_label_guards (
  page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('user_confirmed', 'operator_curated', 'tool_observed', 'agent_written', 'unknown', 'external_untrusted')),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) THEN
    ALTER TABLE page_label_guards ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;
`,
};
