import type { Migration } from './types.ts';
import { FACT_FINGERPRINT_FUNCTION_STATEMENTS, FACT_SPACE_CLASS, FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL, factFingerprintV1Sql, factFingerprintV2Sql } from '../facts/withdrawal-schema.ts';
import { pgliteLowerSql } from '../pg-fold.ts';
import { FACT_INSERT_GUARD_FUNCTION_SQL } from '../facts/insert-guard-schema.ts';
import { REFUSE_PURGED_FACT_FUNCTION_SQL, REFUSE_PURGED_TAKE_FUNCTION_SQL } from '../facts/purge-schema.ts';

/**
 * One guard's CREATE OR REPLACE in its own block. Like v321, a guard another role owns (42501) is left, never an abort,
 * and the handler names it on stderr; until a role that owns it runs a migration (failClosedLedgerGuards reads the
 * v330 marker, legacy_fold), it matches purge tombstones by the earlier fold only. The fingerprint functions stay
 * fail-closed: the fingerprint index is built from them.
 */
const replaceGuardIfOwned = (sql: string): string =>
  `DO $v330_guard$ BEGIN EXECUTE $v330_body$${sql}$v330_body$; EXCEPTION WHEN insufficient_privilege THEN NULL; END $v330_guard$;`;

const GUARD_SQL = [FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL, FACT_INSERT_GUARD_FUNCTION_SQL, REFUSE_PURGED_FACT_FUNCTION_SQL, REFUSE_PURGED_TAKE_FUNCTION_SQL];
/** Each guard's name and the body v330 installs (the text between its $fn$ quotes, as pg_proc.prosrc holds it). */
const GUARD_BODIES = GUARD_SQL.map(sql => ({ name: /FUNCTION\s+(?:public\.)?(\w+)\(/.exec(sql)![1]!, body: /\$fn\$([\s\S]*)\$fn\$/.exec(sql)![1]! }));

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// The fact fingerprint folds case by PGLite's map (pgliteLowerSql, src/core/pg-fold.ts) and whitespace by one explicit
// list (FACT_SPACE_CLASS) on every engine. Postgres folded with the locale's lower() and [[:space:]] before: glibc
// lowers letters PGLite keeps (U+24B6), and en_US.utf8 leaves out U+0085 and adds U+1680, so such a claim had a
// different fingerprint on Postgres than on PGLite and the Rust store, and a withdrawal could miss or overreach.
// gbrain_fact_fingerprint (and its version name _v3) now folds the PGLite way; _v2 keeps the old locale fold, and
// every ledger match takes fingerprint, _v2 and _v1, so no stored hash is rewritten. _v2 and _v1 answer NULL where the
// old fold changed text the new one keeps (U+1680, a letter only glibc lowers), since that old hash is the current
// hash of another spelling and matching it would differ from PGLite: a ledger row stored under it matches that
// spelling only, unless the twin rows below name the claim. A purge row keeps no claim, so it gets no twin.
//
// On a database whose lower() or [[:space:]] differs from PGLite's (computed here over every code point below 131072,
// never assumed from the locale name), every withdrawal of a claim holding a differing character (matched by the full
// old fold of _v2, or of _v1 for rows stored before v174, so an upgrade keeps every claim it withdrew) gets a twin row
// under the new fingerprint, found through the facts rows and the fence cells (pages and segment texts) that hold the
// claim; the export overlay hashes the new fingerprint only. The fingerprint index is rebuilt when a fact holds a
// differing character, and an active fact the new fingerprint now matches to a withdrawal is stamped by the preserve
// trigger itself (a no-op UPDATE of expired_at). Only the guard functions are replaced: their triggers already call
// them. A brain with no fact and no withdrawal skips the scan. PGLite folds the same way, so there the block finds no
// differing character and reads no row.
export const FACT_FINGERPRINT_V3_SQL = `${FACT_FINGERPRINT_FUNCTION_STATEMENTS.join(';\n')};
${GUARD_SQL.map(replaceGuardIfOwned).join('\n')}
DO $fp_v3$
DECLARE differing text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM facts) AND NOT EXISTS (SELECT 1 FROM fact_withdrawals) THEN RETURN; END IF;
  SELECT array_agg(chr(g)) INTO differing FROM generate_series(1, 131071) g
    WHERE g NOT BETWEEN 55296 AND 57343 AND ((chr(g) ~ '[[:space:]]') IS DISTINCT FROM (chr(g) ~ '${FACT_SPACE_CLASS}')
      OR pg_catalog.lower(chr(g)) IS DISTINCT FROM ${pgliteLowerSql('chr(g)')});
  IF differing IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fact_withdrawals) THEN
    INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
      SELECT w.source_id, w.visibility, w.subject, c.fp, min(w.withdrawn_at)
      FROM (SELECT DISTINCT f.source_id, f.visibility, gbrain_fact_fingerprint(f.fact) AS fp,
          ${factFingerprintV2Sql('f.fact')} AS v2, ${factFingerprintV1Sql('f.fact')} AS v1
        FROM facts f WHERE EXISTS (SELECT 1 FROM unnest(differing) d(ch) WHERE strpos(f.fact, d.ch) > 0)) c
      JOIN fact_withdrawals w ON w.source_id = c.source_id AND w.visibility = c.visibility
        AND w.fact_hash IN (c.v2, c.v1) AND w.fact_hash <> c.fp
      GROUP BY w.source_id, w.visibility, w.subject, c.fp
      ON CONFLICT DO NOTHING;
    INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
      SELECT w.source_id, w.visibility, w.subject, c.fp, min(w.withdrawn_at)
      FROM (SELECT DISTINCT t.source_id, gbrain_fact_fingerprint(btrim(cell)) AS fp,
          ${factFingerprintV2Sql('btrim(cell)')} AS v2, ${factFingerprintV1Sql('btrim(cell)')} AS v1
        FROM (SELECT p.source_id, COALESCE(p.compiled_truth, '') || chr(10) || COALESCE(p.timeline, '') AS body FROM pages p
          WHERE strpos(COALESCE(p.compiled_truth, '') || COALESCE(p.timeline, ''), 'gbrain:facts:begin') > 0) t,
          LATERAL unnest(string_to_array(t.body, chr(10))) line, LATERAL unnest(string_to_array(line, '|')) cell
        WHERE starts_with(ltrim(line), '|') AND EXISTS (SELECT 1 FROM unnest(differing) d(ch) WHERE strpos(cell, d.ch) > 0)) c
      JOIN fact_withdrawals w ON w.source_id = c.source_id AND w.fact_hash IN (c.v2, c.v1) AND w.fact_hash <> c.fp
      GROUP BY w.source_id, w.visibility, w.subject, c.fp
      ON CONFLICT DO NOTHING;
    IF to_regclass('page_segment_texts') IS NOT NULL THEN
      INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
        SELECT w.source_id, w.visibility, w.subject, c.fp, min(w.withdrawn_at)
        FROM (SELECT DISTINCT t.source_id, gbrain_fact_fingerprint(btrim(cell)) AS fp,
            ${factFingerprintV2Sql('btrim(cell)')} AS v2, ${factFingerprintV1Sql('btrim(cell)')} AS v1
          FROM (SELECT s.source_id, convert_from(s.body, 'UTF8') AS body FROM page_segment_texts s) t,
            LATERAL unnest(string_to_array(t.body, chr(10))) line, LATERAL unnest(string_to_array(line, '|')) cell
          WHERE starts_with(ltrim(line), '|') AND EXISTS (SELECT 1 FROM unnest(differing) d(ch) WHERE strpos(cell, d.ch) > 0)) c
        JOIN fact_withdrawals w ON w.source_id = c.source_id AND w.fact_hash IN (c.v2, c.v1) AND w.fact_hash <> c.fp
        GROUP BY w.source_id, w.visibility, w.subject, c.fp
        ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM facts f WHERE EXISTS (SELECT 1 FROM unnest(differing) d(ch) WHERE strpos(f.fact, d.ch) > 0)) THEN
    IF to_regclass('idx_facts_withdrawal_fingerprint') IS NOT NULL THEN
      EXECUTE 'REINDEX INDEX idx_facts_withdrawal_fingerprint';
    END IF;
    UPDATE facts f SET expired_at = f.expired_at
      WHERE f.expired_at IS NULL AND EXISTS (SELECT 1 FROM unnest(differing) d(ch) WHERE strpos(f.fact, d.ch) > 0)
        AND EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
          AND w.fact_hash = gbrain_fact_fingerprint(f.fact));
  END IF;
END
$fp_v3$`;

export const v330: Migration = {
  version: 330,
  name: 'fact_fingerprint_v3',
  idempotent: true,
  sql: FACT_FINGERPRINT_V3_SQL,
  // Names each guard the block above left: another role owns it and its body is not the one v330 installs.
  handler: async engine => {
    const left = await engine.executeRaw<{ sig: string; qualified: string; role: string }>(
      `SELECT p.oid::regprocedure::text AS sig, quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || oidvectortypes(p.proargtypes) || ')' AS qualified,
              quote_ident(current_user) AS role
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN unnest($1::text[], $2::text[]) AS g(name, body) ON g.name = p.proname
        WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosrc IS DISTINCT FROM g.body AND NOT pg_has_role(current_user, p.proowner, 'USAGE') ORDER BY 1`,
      [GUARD_BODIES.map(g => g.name), GUARD_BODIES.map(g => g.body)]);
    if (left.length === 0) return;
    process.stderr.write(`  guards: ${left.length} purge or withdrawal guard(s) keep their body from before the PGLite case fold (${left.map(g => g.sig).join(', ')}): `
      + `CREATE OR REPLACE FUNCTION needs the owner. As that role run ${left.map(g => `ALTER FUNCTION ${g.qualified} OWNER TO ${g.role};`).join(' ')} or connect gbrain as it; the next migration run re-creates them (docs/ENGINES.md#purge-and-withdrawal-guards).\n`);
  },
};
