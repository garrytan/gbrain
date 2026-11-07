import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-1582 (docs/designs/REFRESH_WRITE_BARRIER.md, "Writes that wait for an import"): with the refresh write barrier on,
// a page write whose file holds a committed change managed sync has not imported yet waits instead of being refused.
// - persistence_requests.deferred_import_from: the source's last imported commit ('' when it had none) when a claimed
//   write was held for an import; the row waits in state 'deferred' until sources.last_commit moves past it.
// - gbrain_guard_deferred_request: a refresh-barrier consumer may move its own running claim to 'deferred' when it names
//   the import it waits for; a deferred row is claimed only once every hold it names (refresh, import) is released.
// A nullable column with no backfill; fresh installs get it from this migration too, so fresh and upgraded brains share
// column ordinals. The number is a placeholder restamped at the merge slot.
export const v294: Migration = {
  version: 294,
  name: 'refresh_barrier_import_deferral',
  idempotent: true,
  sql: `
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS deferred_import_from text;
    CREATE OR REPLACE FUNCTION gbrain_guard_deferred_request() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF NEW.state='deferred' THEN
        IF OLD.state='deferred' THEN RETURN NEW; END IF;
        IF OLD.state='running' AND NEW.deferred_import_from IS NOT NULL AND COALESCE(current_setting('gbrain.refresh_barrier',true),'')='1' THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'unsupported_mutation_protocol: only admission, or a refresh-barrier consumer holding its claim for an import, defers a request' USING ERRCODE='42501';
      END IF;
      IF NEW.state IN ('conflict','failed','cancelled') THEN RETURN NEW; END IF;
      IF NEW.state='running' AND COALESCE(current_setting('gbrain.refresh_barrier',true),'')='1'
        AND (OLD.deferred_refresh_id IS NOT NULL OR OLD.deferred_import_from IS NOT NULL)
        AND (OLD.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=OLD.deferred_refresh_id AND f.released_at IS NOT NULL))
        AND (OLD.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources s WHERE s.id=OLD.source_id AND COALESCE(s.last_commit,'')<>OLD.deferred_import_from)) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'writer_upgrade_required: a deferred request is claimed only by a refresh-barrier consumer after its refresh and import are released' USING ERRCODE='42501';
    END $$;
  `,
};
