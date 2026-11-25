/**
 * The ontology statements the repair paths ran through `executeRaw`: the re-key duplicate drop that runs before a
 * writer moves facts onto another entity or source slug (facts/ontology-rekey.ts), and the `repair ontology-facts`
 * candidate read, source read and restore (repair/ontology-facts.ts). The text and binds are the ones the callers
 * built inline; the engines run them through typed members, so a transaction handle reaches them too.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { UNBACKED_FACT_SQL } from './fact-relink-writes.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { CONVERSATION_SLOT_SQL, NOT_CONVERSATION_SLOT_SQL } from '../chronicle/ontology.ts';

export type { EngineRawRead };

// ─── The re-key duplicate drop ───────────────────────────────────────────

/**
 * What a re-key moves: `where` selects the moving rows of alias `f`; `entity` and `sms` are the SQL values they take.
 * Each is one of the closed shapes below (`$1` is the source id, `$2` and `$3` are `params`); any other text is refused.
 */
export interface RekeyMove { where: string; entity: string; sms: string; params: [unknown, unknown] }

const REKEY_WHERE_BY_ID = 'f.id = $2::bigint AND ';
export const REKEY_WHERE_SHAPES: readonly string[] = [
  'f.entity_slug = $2 AND f.row_num IS NULL',
  REKEY_WHERE_BY_ID + UNBACKED_FACT_SQL,
  'f.entity_slug = $2 AND f.source_markdown_slug IS DISTINCT FROM $2',
  'f.entity_slug = $2',
  'f.source_markdown_slug = $2',
  'f.source_markdown_slug = $3 AND f.expired_at IS NULL',
];
export const REKEY_ENTITY_SHAPES: readonly string[] = ['$3::text', 'f.entity_slug', '$2::text'];
export const REKEY_SMS_SHAPES: readonly string[] = ['f.source_markdown_slug', '$3::text', '$2::text'];

/** A re-key move's text, when it is one of the closed shapes; the move never carries a value. */
function rekeyMoveSql(text: string, shapes: readonly string[]): string {
  if (!shapes.includes(text)) throw new Error(`rekey move is not one of the supported shapes: ${text}`);
  return text;
}

/** The conversation-slot test the survivor ranking orders by (a conversation fact always loses); no values. */
function rekeyConversationSlotSql(): string { return CONVERSATION_SLOT_SQL; }

const REKEY_LOSERS_1 = `WITH m AS (
      SELECT f.id, f.expired_at, `;
const REKEY_LOSERS_2 = ` AS e, `;
const REKEY_LOSERS_3 = ` AS s, f.dimension, f.value_hash, f.valid_from, f.source
        FROM facts f WHERE f.source_id = $1 AND f.dimension IS NOT NULL AND `;
const REKEY_LOSERS_4 = `),
    cand AS (
      SELECT m.id, m.expired_at, m.e, m.s, m.dimension, m.value_hash, m.valid_from, m.source, 1 AS moving FROM m
      UNION ALL
      SELECT t.id, t.expired_at, t.entity_slug, t.source_markdown_slug, t.dimension, t.value_hash, t.valid_from, t.source, 0 FROM facts t
       WHERE t.source_id = $1 AND t.dimension IS NOT NULL AND NOT EXISTS (SELECT 1 FROM m WHERE m.id = t.id)
         AND EXISTS (SELECT 1 FROM m WHERE m.e = t.entity_slug AND m.s = t.source_markdown_slug AND m.dimension = t.dimension
                       AND m.value_hash = t.value_hash AND m.valid_from = t.valid_from)),
    ranked AS (
      SELECT id, row_number() OVER w AS rn, first_value(id) OVER w AS keep FROM cand
       WHERE e IS NOT NULL AND s IS NOT NULL AND value_hash IS NOT NULL AND valid_from IS NOT NULL
      WINDOW w AS (PARTITION BY e, s, dimension, value_hash, valid_from ORDER BY `;
const REKEY_LOSERS_5 = `, (expired_at IS NULL) DESC, moving, id))
    SELECT id, keep FROM ranked WHERE rn > 1`;

/**
 * Of each set of facts that would share an ontology key once `move` is applied, every row but the survivor: the
 * active one, then the one already at the target, then the oldest; a conversation fact loses to an ontology
 * observation. `keep` is the survivor's id.
 */
export async function listRekeyLosers(raw: EngineRawRead, sourceId: string, move: RekeyMove): Promise<Array<{ id: number | string; keep: number | string }>> {
  const sql = renderFragment(sqlFragment`${trustedSql(REKEY_LOSERS_1)}${trustedSql(rekeyMoveSql(move.entity, REKEY_ENTITY_SHAPES))}${trustedSql(REKEY_LOSERS_2)}${
    trustedSql(rekeyMoveSql(move.sms, REKEY_SMS_SHAPES))}${trustedSql(REKEY_LOSERS_3)}${trustedSql(rekeyMoveSql(move.where, REKEY_WHERE_SHAPES))}${
    trustedSql(REKEY_LOSERS_4)}${trustedSql(rekeyConversationSlotSql())}${trustedSql(REKEY_LOSERS_5)}`);
  return raw<{ id: number | string; keep: number | string }>(sql.text, [sourceId, ...move.params]);
}

/** Repoints supersession links at a dropped row to its survivor (a survivor's own link is cleared). `ids[i]` was dropped for `keeps[i]`. */
export async function repointSupersededToKept(raw: EngineRawRead, ids: number[], keeps: number[]): Promise<void> {
  await raw(`UPDATE facts f SET superseded_by = CASE WHEN f.id = x.keep THEN NULL ELSE x.keep END
    FROM unnest($1::bigint[], $2::bigint[]) AS x(id, keep) WHERE f.superseded_by = x.id`, [ids, keeps]);
}

/** A losing conversation fact keeps its row and gives up its ontology slot. */
export async function clearOntologySlots(raw: EngineRawRead, ids: number[]): Promise<void> {
  const sql = renderFragment(sqlFragment`UPDATE facts SET dimension = NULL, value = NULL, value_hash = NULL, dim_status = NULL
    WHERE id = ANY(${ids}::bigint[]) AND ${trustedSql(rekeyConversationSlotSql())}`);
  await raw(sql.text, sql.params);
}

/** Deletes the dropped ontology rows. */
export async function deleteRekeyLosers(raw: EngineRawRead, ids: number[]): Promise<void> {
  await raw('DELETE FROM facts WHERE id = ANY($1::bigint[]) AND dimension IS NOT NULL', [ids]);
}

// ─── repair ontology-facts ───────────────────────────────────────────────

/** The expiry instant of `f` as UTC text with microseconds; a bound timestamp parameter can lose them. */
const EXPIRY_TEXT_F = `to_char(f.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** An observation with the same dedup key as `f` once its provenance is restored (the ontology unique index). */
const DUPLICATE_F = `EXISTS (SELECT 1 FROM facts d WHERE d.source_id=f.source_id AND d.entity_slug=f.entity_slug
  AND d.dimension=f.dimension AND d.value_hash=f.value_hash AND d.source_markdown_slug=f.source
  AND d.valid_from=f.valid_from AND d.id<>f.id)`;

/** The test that a row is not a conversation fact; no values. */
function ontologyConversationSlotSql(): string { return NOT_CONVERSATION_SLOT_SQL; }

/** The candidate row of `listOntologyFactCandidates`, which lives in facts-repair.ts with the other repair previews. */
export type { OntologyCandidateRow as OntologyFactCandidateRow } from './facts-repair.ts';

export interface OntologyFactRestore { id: number; source_id: string; row_num: number | null; page: string | null; expired_at: string | null }

/** Restores one fenced or retired observation to its own provenance, only while its row number, page and expiry are as the preview saw them. Returns the restored row, none when it changed. */
export async function restoreOntologyFact(raw: EngineRawRead, f: OntologyFactRestore): Promise<Array<{ id: number | string; expired: boolean }>> {
  const sql = renderFragment(sqlFragment`UPDATE facts f SET row_num=NULL, source_markdown_slug=f.source, expired_at=NULL
        WHERE f.id=${f.id} AND f.source_id=${f.source_id} AND f.dimension IS NOT NULL AND ${trustedSql(ontologyConversationSlotSql())}
          AND f.row_num IS NOT DISTINCT FROM ${f.row_num}::integer AND f.source_markdown_slug IS NOT DISTINCT FROM ${f.page}::text
          AND ${trustedSql(EXPIRY_TEXT_F)} IS NOT DISTINCT FROM ${f.expired_at}::text AND NOT ${trustedSql(DUPLICATE_F)}
        RETURNING f.id, f.expired_at IS NOT NULL AS expired`);
  return raw<{ id: number | string; expired: boolean }>(sql.text, sql.params);
}
