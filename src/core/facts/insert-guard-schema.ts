/**
 * Set-based insert guards on facts (#7105). One statement-level AFTER INSERT
 * trigger reads the statement's inserted rows from a transition table and
 * applies both insert-time guards once per statement instead of once per row
 * (the withdrawal stamp only for inserts that defer it, see below):
 *
 * - Purge refusal (purge-schema.ts `gbrain_refuse_purged_fact`): an inserted
 *   row whose fingerprint has a fact_purges tombstone for its source,
 *   visibility and subject ('*' or its entity_slug) aborts the statement with
 *   the same P0001 `purged_content` message and `{table, hash8}` detail,
 *   whatever its expired_at. When several rows match, the detail names the
 *   first one in insertion order, as the per-row trigger did.
 * - Withdrawal preservation (withdrawal-schema.ts
 *   `gbrain_preserve_fact_withdrawal`): an inserted active row matching a
 *   fact_withdrawals row (v2 or v1 fingerprint) is stamped expired_at =
 *   min(withdrawn_at) and valid_until = LEAST(valid_until, withdrawn_at).
 *   By default the per-row BEFORE INSERT trigger facts_preserve_withdrawal_insert
 *   stamps the row before it is written, so `INSERT ... RETURNING` reads the
 *   stamp. An insert made under FACT_WITHDRAWAL_STAMP_DEFERRED_SETTING (the
 *   bulk fence insert in engine-sql/facts.ts, whose RETURNING reads only ids)
 *   skips that trigger through its WHEN clause, which calls no function, and
 *   this guard stamps the rows by an UPDATE of just the matching ones at the
 *   end of the statement. The setting only moves the stamp, never skips it:
 *   the guard stamps every inserted active row still matching, whoever set
 *   it. That UPDATE runs under FACT_WITHDRAWAL_STAMP_SETTING
 *   (attribution-schema.ts), so the row keeps the last_write_* values its
 *   INSERT stamped or supplied, and resets it afterwards. A deferred row's
 *   RETURNING (or a CTE over it) reads it unstamped; the next statement reads
 *   the stamp.
 *
 * Both take the per-row guards' lock: FOR SHARE on each inserted source row
 * before the ledgers are read, so an insert still serializes with a purge or
 * a withdrawal that holds the source FOR UPDATE. A ledger with no row for the
 * inserted sources costs one index probe, not a fingerprint per row.
 *
 * Transition tables cannot be combined with a column list, so updates keep
 * the per-row BEFORE UPDATE OF triggers under their old names and functions;
 * only the insert half moves here. A statement trigger sees only the rows the
 * statement wrote: a row ON CONFLICT DO NOTHING skipped is not checked (it is
 * not saved either). Installed by migration v264.
 */
import { FACT_WITHDRAWAL_STAMP_SETTING } from '../persistence/attribution-schema.ts';

export const FACT_INSERT_GUARD_TRIGGER = 'facts_guard_inserted';
/** Transaction-local; 'on' defers the withdrawal stamp of the following inserts to facts_guard_inserted. */
export const FACT_WITHDRAWAL_STAMP_DEFERRED_SETTING = 'gbrain.fact_withdrawal_stamp_deferred';
export const FACT_INSERT_GUARD_FUNCTION = 'gbrain_guard_inserted_facts';

/**
 * #7778: `outcomeMarkerSql('i')` from facts/audit-sources.ts, spelled out so this schema fragment imports no module
 * outside the PGLite snapshot inputs; test/conversation-facts-outcome-marker-purge-7778.test.ts pins the two equal.
 */
export const GUARD_OUTCOME_MARKER_SQL = "(i.source IN ('cli:extract-conversation-facts:terminal:v2','cli:extract-conversation-facts:non-extractable:v2','cli:extract-conversation-facts:terminal') AND i.fact IN ('EXTRACTION_COMPLETE','EXTRACTION_NOT_APPLICABLE'))";

/**
 * The guard function alone (#7778 re-creates it without touching the triggers). The purge refusal skips an extraction
 * outcome row (facts/audit-sources.ts `isOutcomeMarker`): that bookkeeping marker is not a claim, and a subject-'*'
 * tombstone on its fingerprint, which a page purge wrote before #7778, kept every page of the source from completing.
 */
export const FACT_INSERT_GUARD_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION gbrain_guard_inserted_facts() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
  DECLARE purged TEXT; stamp_setting TEXT;
  BEGIN
    PERFORM s.id FROM sources s WHERE s.id IN (SELECT i.source_id FROM inserted_facts i) ORDER BY s.id FOR SHARE OF s;
    IF EXISTS (SELECT 1 FROM fact_purges p WHERE p.source_id IN (SELECT i.source_id FROM inserted_facts i)) THEN
      WITH n AS MATERIALIZED (
        SELECT row_number() OVER () AS ord, i.source_id, i.visibility, i.entity_slug, gbrain_fact_fingerprint(i.fact) AS fact_hash
        FROM inserted_facts i WHERE NOT ${GUARD_OUTCOME_MARKER_SQL})
      SELECT n.fact_hash INTO purged FROM n
        WHERE EXISTS (SELECT 1 FROM fact_purges p WHERE p.source_id = n.source_id AND p.visibility = n.visibility
          AND p.subject IN ('*', n.entity_slug) AND p.fact_hash = n.fact_hash)
        ORDER BY n.ord LIMIT 1;
      IF purged IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'purged_content: this claim was purged from this source and cannot be saved again',
          DETAIL = json_build_object('table', 'facts', 'hash8', left(purged, 8))::text;
      END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id IN (SELECT i.source_id FROM inserted_facts i WHERE i.expired_at IS NULL)) THEN
      stamp_setting := current_setting('${FACT_WITHDRAWAL_STAMP_SETTING}', true);
      PERFORM set_config('${FACT_WITHDRAWAL_STAMP_SETTING}', 'on', true);
      WITH n AS MATERIALIZED (
        SELECT i.id, i.source_id, i.visibility, i.entity_slug,
          gbrain_fact_fingerprint(i.fact) AS fact_hash, gbrain_fact_fingerprint_v1(i.fact) AS fact_hash_v1
        FROM inserted_facts i WHERE i.expired_at IS NULL),
      m AS (
        SELECT n.id, min(w.withdrawn_at) AS withdrawn_at FROM n JOIN fact_withdrawals w
          ON w.source_id = n.source_id AND w.visibility = n.visibility
          AND w.subject IN ('*', n.entity_slug) AND w.fact_hash IN (n.fact_hash, n.fact_hash_v1)
        GROUP BY n.id)
      UPDATE facts f SET expired_at = m.withdrawn_at, valid_until = LEAST(COALESCE(f.valid_until, m.withdrawn_at), m.withdrawn_at)
        FROM m WHERE f.id = m.id;
      PERFORM set_config('${FACT_WITHDRAWAL_STAMP_SETTING}', COALESCE(stamp_setting, ''), true);
    END IF;
    RETURN NULL;
  END
  $fn$;
`;

export const FACT_INSERT_GUARD_SQL = `${FACT_INSERT_GUARD_FUNCTION_SQL}
DROP TRIGGER IF EXISTS facts_guard_inserted ON facts;
CREATE TRIGGER facts_guard_inserted AFTER INSERT ON facts REFERENCING NEW TABLE AS inserted_facts
  FOR EACH STATEMENT EXECUTE FUNCTION gbrain_guard_inserted_facts();
DROP TRIGGER IF EXISTS facts_refuse_purged ON facts;
CREATE TRIGGER facts_refuse_purged BEFORE UPDATE OF fact, source_id, visibility, entity_slug ON facts
  FOR EACH ROW EXECUTE FUNCTION gbrain_refuse_purged_fact();
DROP TRIGGER IF EXISTS facts_preserve_withdrawal ON facts;
CREATE TRIGGER facts_preserve_withdrawal BEFORE UPDATE OF fact, source_id, visibility, entity_slug, expired_at ON facts
  FOR EACH ROW EXECUTE FUNCTION gbrain_preserve_fact_withdrawal();
DROP TRIGGER IF EXISTS facts_preserve_withdrawal_insert ON facts;
CREATE TRIGGER facts_preserve_withdrawal_insert BEFORE INSERT ON facts FOR EACH ROW
  WHEN (NEW.expired_at IS NULL AND COALESCE(current_setting('${FACT_WITHDRAWAL_STAMP_DEFERRED_SETTING}', true), '') <> 'on')
  EXECUTE FUNCTION gbrain_preserve_fact_withdrawal();
`;
