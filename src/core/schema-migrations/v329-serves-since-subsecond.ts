import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-3199: v309's gbrain_access_refresh_serves() wrote access.serves_since to
// the whole second, and the requester-scope gate gives an unbound credential its
// grace only when it was created before that time. A token minted in the same
// second the brain started serving several people, but before the second member,
// was refused at once instead. The function now records the time to the
// microsecond, and credential creation times are read to the millisecond, so the
// comparison stays strict (created < since) at that precision. It is still set
// once and never cleared: a value an older gbrain wrote at whole seconds is kept
// as it is, and against it the gate answers exactly as before. The function body
// is v309's with only the format changed; the triggers already call it.
export const v329: Migration = {
  version: 329,
  name: 'serves_since_subsecond',
  idempotent: true,
  sql: `
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
    INSERT INTO config (key, value) VALUES ('access.serves_since', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      ON CONFLICT (key) DO NOTHING;
  END IF;
END
$fn$;
`,
};
