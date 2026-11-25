import type { Migration } from './types.ts';
import { FACT_FINGERPRINT_FUNCTION_STATEMENTS, FACT_SPACE_CLASS, FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL, factFingerprintV2Sql } from '../facts/withdrawal-schema.ts';
import { FACT_INSERT_GUARD_FUNCTION_SQL } from '../facts/insert-guard-schema.ts';
import { REFUSE_PURGED_FACT_FUNCTION_SQL, REFUSE_PURGED_TAKE_FUNCTION_SQL } from '../facts/purge-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// The fact fingerprint folds one explicit whitespace list (FACT_SPACE_CLASS) on every engine. Postgres folded the
// locale's [[:space:]] before, which on en_US.utf8 leaves out U+0085 and adds U+1680, so a claim holding one of them
// had a different fingerprint on Postgres than on PGLite and the Rust store, and a withdrawal could miss its claim in
// the export. gbrain_fact_fingerprint (and its version name _v3) now folds the explicit list; _v2 keeps the old
// locale fold, and every ledger match takes fingerprint, _v2 and _v1, so no stored hash is rewritten. _v2 and _v1
// answer NULL where the old fold folded a character the new one keeps (U+1680), since that old hash is the current
// hash of another spelling and matching it would differ from PGLite: a ledger row stored under it matches that
// spelling only, unless the twin rows below name the claim.
//
// On a database whose [[:space:]] differs from the list (computed here, never assumed from the locale name), every
// withdrawal of a claim holding a differing character (matched by the full locale fold of _v2, so an upgrade keeps every
// claim it withdrew) gets a twin row under the new fingerprint, found through the
// facts rows and the fence cells (pages and segment texts) that hold the claim; the export overlay hashes the new
// fingerprint only. The fingerprint index is rebuilt when a fact holds a differing character, and an active fact the
// new fingerprint now matches to a withdrawal is stamped by the preserve trigger itself (a no-op UPDATE of expired_at).
// A body decoded from bytea (segment texts) is read under the database's default collation, not the C collation
// convert_from carries, so U+1680 and a non-ASCII capital fold as the old fingerprint folded them. A database whose
// server_encoding is not UTF8 is skipped: it has no such characters to repair and chr() above 255 raises there.
// Only the guard functions are replaced: their triggers already call them. PGLite folds the same list, so there the
// block finds no differing character and reads no row.
export const FACT_FINGERPRINT_V3_SQL = `${FACT_FINGERPRINT_FUNCTION_STATEMENTS.join(';\n')};
${FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL};
${FACT_INSERT_GUARD_FUNCTION_SQL};
${REFUSE_PURGED_FACT_FUNCTION_SQL};
${REFUSE_PURGED_TAKE_FUNCTION_SQL};
DO $fp_v3$
DECLARE differing text[];
BEGIN
  -- chr() takes a code point only up to what the database encoding holds: every BMP point on UTF8, 255 on a single-byte
  -- encoding (LATIN1 holds U+0085), and ASCII on SQL_ASCII and the other multibyte encodings. A larger argument raises,
  -- and such a brain keeps running with a database_encoding warning, so the sweep stays inside the range.
  SELECT array_agg(chr(g)) INTO differing FROM generate_series(1, CASE
      WHEN current_setting('server_encoding') = 'UTF8' THEN 65535
      WHEN current_setting('server_encoding') <> 'SQL_ASCII'
        AND pg_catalog.pg_encoding_max_length(pg_catalog.pg_char_to_encoding(current_setting('server_encoding'))) = 1 THEN 255
      ELSE 127 END) g
    WHERE g NOT BETWEEN 55296 AND 57343 AND (chr(g) ~ '[[:space:]]') IS DISTINCT FROM (chr(g) ~ '${FACT_SPACE_CLASS}');
  IF differing IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM fact_withdrawals) THEN
    INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
      SELECT w.source_id, w.visibility, w.subject, c.fp, min(w.withdrawn_at)
      FROM (SELECT DISTINCT f.source_id, f.visibility, gbrain_fact_fingerprint(f.fact) AS fp,
          ${factFingerprintV2Sql('f.fact')} AS v2, gbrain_fact_fingerprint_v1(f.fact) AS v1
        FROM facts f WHERE EXISTS (SELECT 1 FROM unnest(differing) d(ch) WHERE strpos(f.fact, d.ch) > 0)) c
      JOIN fact_withdrawals w ON w.source_id = c.source_id AND w.visibility = c.visibility
        AND w.fact_hash IN (c.v2, c.v1) AND w.fact_hash <> c.fp
      GROUP BY w.source_id, w.visibility, w.subject, c.fp
      ON CONFLICT DO NOTHING;
    INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
      SELECT w.source_id, w.visibility, w.subject, c.fp, min(w.withdrawn_at)
      FROM (SELECT DISTINCT t.source_id, gbrain_fact_fingerprint(btrim(cell)) AS fp,
          ${factFingerprintV2Sql('btrim(cell)')} AS v2, gbrain_fact_fingerprint_v1(btrim(cell)) AS v1
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
            ${factFingerprintV2Sql('btrim(cell)')} AS v2, gbrain_fact_fingerprint_v1(btrim(cell)) AS v1
          FROM (SELECT s.source_id, convert_from(s.body, 'UTF8') COLLATE "default" AS body FROM page_segment_texts s) t,
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

export const v341: Migration = {
  version: 341,
  name: 'fact_fingerprint_v3',
  idempotent: true,
  sql: FACT_FINGERPRINT_V3_SQL,
};
