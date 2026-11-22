import type { Migration } from './types.ts';

// Native budget accounting addresses jobs by ID. The historical root-owner
// field remains part of each job record without a reverse-lookup index.
export const v333: Migration = {
  version: 333,
  name: 'retire_minion_budget_root_owner_index',
  idempotent: true,
  sql: `DO $idx$ BEGIN
    IF to_regclass('public.minion_jobs_budget_root_owner_idx') IS NULL THEN
      RETURN;
    END IF;
    LOCK TABLE public.minion_jobs IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.minion_jobs_budget_root_owner_idx')
        AND i.indrelid = 'public.minion_jobs'::regclass
        AND i.indisvalid AND i.indisready AND i.indislive
        AND NOT (i.indisunique OR i.indisclustered OR i.indisreplident)
        AND obj_description(i.indexrelid, 'pg_class') IS NULL
        AND pg_get_indexdef(i.indexrelid) =
            'CREATE INDEX minion_jobs_budget_root_owner_idx ON public.minion_jobs USING btree (budget_root_owner_id) WHERE (budget_root_owner_id IS NOT NULL)'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE (d.refclassid = 'pg_class'::regclass AND d.refobjid = i.indexrelid)
             OR (d.classid = 'pg_class'::regclass AND d.objid = i.indexrelid AND d.deptype = 'e')
        )
    ) THEN
      DROP INDEX public.minion_jobs_budget_root_owner_idx;
    END IF;
  END $idx$;`,
};
