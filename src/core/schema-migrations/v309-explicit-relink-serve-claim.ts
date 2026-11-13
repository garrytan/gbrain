import type { Migration } from './types.ts';

// The legacy refresh/import predicate cannot release this deferred operation.
// A protocol-aware Serve on the admitting host is the only initial claimant.
export const v309: Migration = {
  version: 309,
  name: 'explicit_relink_serve_claim',
  idempotent: true,
  sql: `
    CREATE OR REPLACE FUNCTION gbrain_keep_relink_deferred() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      -- The same rule covers normal release, claim expiry, backoff and publication recovery.
      IF NEW.operation='relink_fact_by_id' AND NEW.intent->>'serve_only'='true' AND NEW.state='queued' THEN
        NEW.state := 'deferred';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS gbrain_keep_relink_deferred ON persistence_requests;
    CREATE TRIGGER gbrain_keep_relink_deferred BEFORE INSERT OR UPDATE OF state ON persistence_requests
      FOR EACH ROW EXECUTE FUNCTION gbrain_keep_relink_deferred();
    CREATE OR REPLACE FUNCTION gbrain_guard_deferred_request() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF NEW.state='deferred' THEN
        IF OLD.state='deferred' OR (OLD.operation='relink_fact_by_id' AND OLD.intent->>'serve_only'='true'
          AND OLD.state IN ('running','recovering') AND NEW.execution_token IS NULL AND NEW.recovery IS NULL) THEN RETURN NEW; END IF;
        IF OLD.state='running' AND NEW.deferred_import_from IS NOT NULL AND COALESCE(current_setting('gbrain.refresh_barrier',true),'')='1' THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'unsupported_mutation_protocol: only admission, or a refresh-barrier consumer holding its claim for an import, defers a request' USING ERRCODE='42501';
      END IF;
      IF NEW.state IN ('conflict','failed','cancelled') THEN RETURN NEW; END IF;
      IF OLD.operation='relink_fact_by_id' AND OLD.intent->>'serve_only'='true'
        AND OLD.deferred_refresh_id IS NULL AND OLD.deferred_import_from IS NULL
        AND NEW.state='running' AND COALESCE(current_setting('gbrain.explicit_relink_serve',true),'')='1'
        AND NEW.claim_phase->'owner'->>'kind'='serve'
        AND EXISTS (SELECT 1 FROM persistence_consumers c WHERE c.host_id=OLD.admitter_host_id
          AND c.pid::text=NEW.claim_phase->'owner'->>'pid' AND c.nonce=NEW.claim_phase->'owner'->>'nonce'
          AND c.kind='serve' AND c.mode='full' AND NOT c.restart_required
          AND c.renewed_at>now()-interval '30 seconds' AND 'explicit_fact_relink_1'=ANY(c.capabilities)) THEN
        RETURN NEW;
      END IF;
      IF NEW.state='running' AND COALESCE(current_setting('gbrain.refresh_barrier',true),'')='1'
        AND (OLD.deferred_refresh_id IS NOT NULL OR OLD.deferred_import_from IS NOT NULL)
        AND (OLD.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=OLD.deferred_refresh_id AND f.released_at IS NOT NULL))
        AND (OLD.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources s WHERE s.id=OLD.source_id AND COALESCE(s.last_commit,'')<>OLD.deferred_import_from)) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'writer_upgrade_required: a deferred request is claimed only by a compatible owner after its hold is released' USING ERRCODE='42501';
    END $$;
  `,
};
