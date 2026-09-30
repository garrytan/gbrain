import type { Migration } from './types.ts';

export const v149: Migration = {
  version: 149,
  name: 'minion_submission_authority',
  // NULL preserves unknown legacy provenance; only reviewed local work may backfill it.
  sql: `
      LOCK TABLE minion_jobs IN ACCESS EXCLUSIVE MODE;
      DO $cutover$ BEGIN
        IF EXISTS (SELECT 1 FROM minion_jobs WHERE status = 'active') THEN
          RAISE EXCEPTION 'Drain or cancel active minion jobs and stop all producers/workers before the authority cutover';
        END IF;
      END $cutover$;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS submission_authority JSONB;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS claim_generation BIGINT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION enforce_minion_queue_protocol() RETURNS trigger SET search_path = pg_catalog, public AS $protocol$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.submission_authority IS NULL OR NEW.claim_generation <> 0 THEN
      RAISE EXCEPTION 'Minion queue protocol 1 required: upgrade every producer and worker before restart';
    END IF;
  ELSIF NEW.status = 'active' AND (OLD.status <> 'active' OR NEW.lock_token IS DISTINCT FROM OLD.lock_token) THEN
    IF NEW.submission_authority IS NULL OR NEW.claim_generation IS DISTINCT FROM OLD.claim_generation + 1 THEN
      RAISE EXCEPTION 'Minion queue protocol 1 required: old workers cannot claim upgraded queue jobs';
    END IF;
  ELSIF NEW.claim_generation IS DISTINCT FROM OLD.claim_generation THEN
    RAISE EXCEPTION 'Minion queue claim generation may advance only with a claim';
  END IF;
  RETURN NEW;
END;
$protocol$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS minion_queue_protocol ON minion_jobs;
CREATE TRIGGER minion_queue_protocol BEFORE INSERT OR UPDATE ON minion_jobs
  FOR EACH ROW EXECUTE FUNCTION enforce_minion_queue_protocol();
    `,
};
