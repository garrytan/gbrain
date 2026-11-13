import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-363: a brain that serves several people refuses remote reads from a
// connection bound to nobody (src/core/access/requester-scope.ts). The request
// reads whom the brain serves from config, never by counting members:
// gbrain_access_refresh_serves() keeps config access.serves_derived (`several`
// while two or more members are enabled, `one` otherwise; absent, which reads
// as `one`, until the brain first serves several people) and, the first time
// the brain serves several people (that, or an explicit access.serves =
// several), sets access.serves_since once; nothing ever clears it, so disabling
// and re-enabling a member does not restart the grace. One transaction lock
// serializes the recount, so a member added while another is disabled is
// counted once it commits instead of leaving `one` behind; a transaction above
// read committed, whose count may miss a member committed after its snapshot,
// never lowers the value. Triggers on access_members and on config
// access.serves and access.serves_derived call it, so a hand edit or unset of
// the derived key is derived again at once. The one call below
// derives both keys for an existing brain (a brain that already serves several
// people starts its 14-day grace at this upgrade). reads_unscoped records when
// the brain operator let one credential read unscoped on purpose (gbrain auth
// rescope --reads-unscoped --yes); NULL, with no backfill. Nothing else is
// rewritten. No schema.sql mirror: like v282, these exist only through
// migrations. The number is a placeholder restamped at the merge slot.
export const v309: Migration = {
  version: 309,
  name: 'requester_scope',
  idempotent: true,
  sql: `
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS reads_unscoped TIMESTAMPTZ;
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS reads_unscoped TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION gbrain_access_refresh_serves() RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE
  derived TEXT;
  explicit TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('gbrain:access-serves', 0));
  SELECT CASE WHEN count(*) >= 2 THEN 'several' ELSE 'one' END INTO derived
    FROM access_members WHERE disabled_at IS NULL AND tombstoned_at IS NULL;
  IF derived = 'several' THEN
    INSERT INTO config (key, value) VALUES ('access.serves_derived', derived)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE config.value IS DISTINCT FROM EXCLUDED.value;
  ELSIF current_setting('transaction_isolation') = 'read committed' THEN
    UPDATE config SET value = derived WHERE key = 'access.serves_derived' AND value IS DISTINCT FROM derived;
  END IF;
  SELECT lower(btrim(value)) INTO explicit FROM config WHERE key = 'access.serves';
  IF (CASE WHEN explicit IN ('one', 'several') THEN explicit ELSE derived END) = 'several' THEN
    INSERT INTO config (key, value) VALUES ('access.serves_since', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
      ON CONFLICT (key) DO NOTHING;
  END IF;
END
$fn$;
CREATE OR REPLACE FUNCTION gbrain_access_refresh_serves_trigger() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
BEGIN
  PERFORM gbrain_access_refresh_serves();
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS access_members_refresh_serves ON access_members;
CREATE TRIGGER access_members_refresh_serves AFTER INSERT OR DELETE OR UPDATE OF disabled_at, tombstoned_at ON access_members
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_access_refresh_serves_trigger();
DROP TRIGGER IF EXISTS config_serves_refresh ON config;
CREATE TRIGGER config_serves_refresh AFTER INSERT OR UPDATE ON config
  FOR EACH ROW WHEN (NEW.key IN ('access.serves', 'access.serves_derived')) EXECUTE FUNCTION gbrain_access_refresh_serves_trigger();
DROP TRIGGER IF EXISTS config_serves_refresh_delete ON config;
CREATE TRIGGER config_serves_refresh_delete AFTER DELETE ON config
  FOR EACH ROW WHEN (OLD.key IN ('access.serves', 'access.serves_derived')) EXECUTE FUNCTION gbrain_access_refresh_serves_trigger();
SELECT gbrain_access_refresh_serves();
`,
};
