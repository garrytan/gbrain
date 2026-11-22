import type { Migration } from './types.ts';

// Publication and replay read the persistence journal by request ID. The
// journal's affected_skills identifies every revision from that request.
export const v332: Migration = {
  version: 332,
  name: 'retire_shared_skill_revision_request_index',
  idempotent: true,
  sql: `DO $idx$ BEGIN
    IF to_regclass('public.shared_skill_revision_request_idx') IS NULL THEN
      RETURN;
    END IF;
    LOCK TABLE public.shared_skill_revisions IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.shared_skill_revision_request_idx')
        AND i.indrelid = 'public.shared_skill_revisions'::regclass
        AND i.indisvalid AND i.indisready AND i.indislive
        AND NOT (i.indisunique OR i.indisclustered OR i.indisreplident)
        AND obj_description(i.indexrelid, 'pg_class') IS NULL
        AND pg_get_indexdef(i.indexrelid) =
            'CREATE INDEX shared_skill_revision_request_idx ON public.shared_skill_revisions USING btree (request_id)'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE (d.refclassid = 'pg_class'::regclass AND d.refobjid = i.indexrelid)
             OR (d.classid = 'pg_class'::regclass AND d.objid = i.indexrelid AND d.deptype = 'e')
        )
    ) THEN
      DROP INDEX public.shared_skill_revision_request_idx;
    END IF;
  END $idx$;`,
};
