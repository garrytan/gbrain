import type { Migration } from './types.ts';

// The unique transcript key already supports ordered reads by job and message number.
export const v331: Migration = {
  version: 331,
  name: 'subagent_transcript_index',
  idempotent: true,
  sql: `
DO $repair$
BEGIN
    IF to_regclass('public.idx_subagent_messages_job') IS NULL THEN
        RETURN;
    END IF;

    -- Once acquired, the table lock holds the checked definitions stable until commit.
    LOCK TABLE public.subagent_messages IN ACCESS EXCLUSIVE MODE;
    IF NOT EXISTS (
        SELECT 1 FROM pg_index old_i
        JOIN pg_index keep_i ON keep_i.indrelid = old_i.indrelid
        WHERE old_i.indexrelid = to_regclass('public.idx_subagent_messages_job')
          AND keep_i.indexrelid = to_regclass('public.uniq_subagent_messages_idx')
          AND old_i.indrelid = 'public.subagent_messages'::regclass
          AND pg_get_indexdef(old_i.indexrelid) =
            'CREATE INDEX idx_subagent_messages_job ON public.subagent_messages USING btree (job_id, message_idx)'
          AND pg_get_indexdef(keep_i.indexrelid) =
            'CREATE UNIQUE INDEX uniq_subagent_messages_idx ON public.subagent_messages USING btree (job_id, message_idx)'
          AND old_i.indisvalid AND old_i.indisready AND old_i.indislive
          AND keep_i.indisvalid AND keep_i.indisready AND keep_i.indislive
          AND NOT old_i.indisunique AND NOT old_i.indisprimary
          AND keep_i.indisunique AND NOT keep_i.indisprimary
          AND old_i.indkey = keep_i.indkey AND old_i.indoption = keep_i.indoption
          AND old_i.indclass = keep_i.indclass AND old_i.indcollation = keep_i.indcollation
          AND EXISTS (SELECT FROM pg_constraint c WHERE c.conrelid = keep_i.indrelid
                      AND c.conindid = keep_i.indexrelid AND c.contype = 'u'
                      AND c.conname = 'uniq_subagent_messages_idx' AND c.convalidated)
          AND NOT (old_i.indisclustered OR old_i.indisreplident OR old_i.indisexclusion)
          AND obj_description(old_i.indexrelid, 'pg_class') IS NULL
          AND NOT EXISTS (SELECT FROM pg_constraint WHERE conindid = old_i.indexrelid)
          AND NOT EXISTS (SELECT FROM pg_depend WHERE refclassid = 'pg_class'::regclass AND refobjid = old_i.indexrelid)
          AND NOT EXISTS (SELECT FROM pg_depend WHERE classid = 'pg_class'::regclass AND objid = old_i.indexrelid AND deptype IN ('e','x','P','S'))
    ) THEN
        -- Leave operator changes and unhealthy definitions for explicit review.
        RAISE NOTICE 'Preserving idx_subagent_messages_job because the original index pair has changed';
        RETURN;
    END IF;
    DROP INDEX public.idx_subagent_messages_job RESTRICT;
END
$repair$;
`,
};
