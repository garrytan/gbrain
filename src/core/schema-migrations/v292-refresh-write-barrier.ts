import type { Migration } from './types.ts';
import { buildIndexOnline, migrationNotice, runMigrationStatement } from './helpers.ts';

const PERSISTENCE_OPEN_INDEX = { name: 'persistence_requests_open', table: 'persistence_requests',
  sql: `CREATE INDEX IF NOT EXISTS persistence_requests_open ON persistence_requests(worktree_id, sequence) WHERE state IN ('queued','deferred','running','recovering')` } as const;

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Convergence PR B (docs/designs/REFRESH_WRITE_BARRIER.md): the refresh write barrier.
// - persistence_requests.state gains 'deferred': a page write admitted while a
//   `gbrain sources refresh` holds its worktree waits there, invisible to every
//   claim, drain and head selector (old binaries included), until its refresh
//   is released; deferred_refresh_id names that refresh.
// - persistence_worktree_refreshes.released_at is set by trigger when the refresh
//   reaches completed or aborted, whoever moves it (a mixed-version window
//   included); barrier_sequence is diagnostic.
// - gbrain_request_deferred: a deferred row leaves the state only to running (a
//   barrier-aware claim of a released refresh), conflict, failed or cancelled.
// - persistence_consumers.capabilities: what a live consumer can drain; admission
//   defers only when every live consumer of the owner host can.
// Postgres swaps the state CHECK and adds the deferred_refresh_id foreign key NOT
// VALID in the SQL batch, then validates each in its own statement from the handler
// (SHARE UPDATE EXCLUSIVE, after the batch's ACCESS EXCLUSIVE is released, so the
// scan of the permanent receipts blocks no reader or writer), and builds the
// open-request index CONCURRENTLY like v223; PGLite does each in one shot. The open index covers the four open states
// together, so the predicates that list 'deferred' beside queued/running/recovering (receipt polls, drains, doctor) stay
// index-served on a permanent receipt history; persistence_requests_pending keeps serving the three-state ones.
export const v292: Migration = {
  version: 292,
  name: 'refresh_write_barrier',
  idempotent: true,
  transaction: false,
  sql: '',
  sqlFor: {
    postgres: `
    ALTER TABLE persistence_worktree_refreshes ADD COLUMN IF NOT EXISTS barrier_sequence bigint;
    ALTER TABLE persistence_worktree_refreshes ADD COLUMN IF NOT EXISTS released_at timestamptz;
    UPDATE persistence_worktree_refreshes SET released_at=COALESCE(completed_at,updated_at) WHERE state IN ('completed','aborted') AND released_at IS NULL;
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS deferred_refresh_id uuid;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='persistence_requests_deferred_refresh_id_fkey' AND conrelid='persistence_requests'::regclass) THEN
        ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_deferred_refresh_id_fkey
          FOREIGN KEY (deferred_refresh_id) REFERENCES persistence_worktree_refreshes(id) NOT VALID;
      END IF;
    END $$;
    ALTER TABLE persistence_consumers ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';
    CREATE OR REPLACE FUNCTION gbrain_release_refresh_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      NEW.released_at := COALESCE(NEW.released_at, now());
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS gbrain_refresh_release ON persistence_worktree_refreshes;
    CREATE TRIGGER gbrain_refresh_release BEFORE UPDATE OF state ON persistence_worktree_refreshes FOR EACH ROW
      WHEN (NEW.state IN ('completed','aborted') AND OLD.state NOT IN ('completed','aborted'))
      EXECUTE FUNCTION gbrain_release_refresh_barrier();
    CREATE OR REPLACE FUNCTION gbrain_guard_deferred_request() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF NEW.state='deferred' THEN
        IF OLD.state<>'deferred' THEN RAISE EXCEPTION 'unsupported_mutation_protocol: only admission defers a request' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.state IN ('conflict','failed','cancelled') THEN RETURN NEW; END IF;
      IF NEW.state='running' AND COALESCE(current_setting('gbrain.refresh_barrier',true),'')='1'
        AND EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=OLD.deferred_refresh_id AND f.released_at IS NOT NULL) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'writer_upgrade_required: a deferred request is claimed only by a refresh-barrier consumer after its refresh is released' USING ERRCODE='42501';
    END $$;
    DROP TRIGGER IF EXISTS gbrain_request_deferred ON persistence_requests;
    CREATE TRIGGER gbrain_request_deferred BEFORE UPDATE OF state ON persistence_requests FOR EACH ROW
      WHEN (OLD.state='deferred' OR NEW.state='deferred')
      EXECUTE FUNCTION gbrain_guard_deferred_request();
    ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_state_check;
    ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_state_check
      CHECK (state IN ('queued','deferred','running','recovering','committed','conflict','failed','cancelled')) NOT VALID;
  `,
    pglite: `
    ALTER TABLE persistence_worktree_refreshes ADD COLUMN IF NOT EXISTS barrier_sequence bigint;
    ALTER TABLE persistence_worktree_refreshes ADD COLUMN IF NOT EXISTS released_at timestamptz;
    UPDATE persistence_worktree_refreshes SET released_at=COALESCE(completed_at,updated_at) WHERE state IN ('completed','aborted') AND released_at IS NULL;
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS deferred_refresh_id uuid REFERENCES persistence_worktree_refreshes(id);
    ALTER TABLE persistence_consumers ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';
    CREATE OR REPLACE FUNCTION gbrain_release_refresh_barrier() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      NEW.released_at := COALESCE(NEW.released_at, now());
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS gbrain_refresh_release ON persistence_worktree_refreshes;
    CREATE TRIGGER gbrain_refresh_release BEFORE UPDATE OF state ON persistence_worktree_refreshes FOR EACH ROW
      WHEN (NEW.state IN ('completed','aborted') AND OLD.state NOT IN ('completed','aborted'))
      EXECUTE FUNCTION gbrain_release_refresh_barrier();
    CREATE OR REPLACE FUNCTION gbrain_guard_deferred_request() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      IF NEW.state='deferred' THEN
        IF OLD.state<>'deferred' THEN RAISE EXCEPTION 'unsupported_mutation_protocol: only admission defers a request' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.state IN ('conflict','failed','cancelled') THEN RETURN NEW; END IF;
      IF NEW.state='running' AND COALESCE(current_setting('gbrain.refresh_barrier',true),'')='1'
        AND EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=OLD.deferred_refresh_id AND f.released_at IS NOT NULL) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'writer_upgrade_required: a deferred request is claimed only by a refresh-barrier consumer after its refresh is released' USING ERRCODE='42501';
    END $$;
    DROP TRIGGER IF EXISTS gbrain_request_deferred ON persistence_requests;
    CREATE TRIGGER gbrain_request_deferred BEFORE UPDATE OF state ON persistence_requests FOR EACH ROW
      WHEN (OLD.state='deferred' OR NEW.state='deferred')
      EXECUTE FUNCTION gbrain_guard_deferred_request();
    ALTER TABLE persistence_requests DROP CONSTRAINT IF EXISTS persistence_requests_state_check;
    ALTER TABLE persistence_requests ADD CONSTRAINT persistence_requests_state_check
      CHECK (state IN ('queued','deferred','running','recovering','committed','conflict','failed','cancelled'));
  `,
  },
  handler: async engine => {
    if (engine.kind === 'postgres') {
      for (const name of ['persistence_requests_deferred_refresh_id_fkey', 'persistence_requests_state_check']) {
        await runMigrationStatement(engine, 292, `ALTER TABLE persistence_requests VALIDATE CONSTRAINT ${name}`);
      }
    }
    await buildIndexOnline(engine, 292, PERSISTENCE_OPEN_INDEX, { notice: migrationNotice });
  },
};
