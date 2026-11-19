/**
 * The fence guard's read of a page's facts-fence rows with their trust tier (trust/fence-guard.ts `guardFenceRows`): the
 * rows a page publish may not simply expire, because the writer is less trusted than the row, a widening proposal holds
 * the row narrower, or `gbrain repair open-facts` opens it. One SQL implementation for both engines; the statement is the
 * text `guardFenceRows` sent through `executeRaw`, except that the incoming fence document is bound once (`v.incoming`) in
 * place of a hand-numbered `$3` (test/fixtures/fold-hook-noop-6712.json pins the statement). The decisions (which rows
 * are kept, moved or contested) stay in the caller.
 *
 * The writer's tier (`gbrain.write_trust_tier`) and the opened fact ids (`gbrain.write_open_facts`) are transaction-local
 * settings the SQL reads itself; this member passes neither.
 *
 * `listHeldTimelineRows` is `heldRows`' read of the timeline rows a write may not delete or overwrite (rows above the
 * writer, and rows an open `forget` contest holds), the statement `heldRows` sent through `executeRaw` for
 * `timeline_entries`, with the named writer's rank bound as a number.
 *
 * `listHeldTakeRows` is the same read for `takes`: the statement `heldRows` sent through `executeRaw`, byte for byte
 * (the named writer bound as text and ranked by the tier CASE), now one member PGLite, Postgres and the Rust store serve.
 */
import { openedFactRowSql } from '../persistence/context.ts';
import { TRUST_TIER_RANK, trustRankArmsSql, trustRankSql, type TrustTier } from '../trust/tier.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** SQL for the writer's trust rank: the transaction's declared tier (`gbrain.write_trust_tier`), `unknown` when undeclared. */
export const WRITER_RANK_SQL = trustRankSql(`COALESCE(NULLIF(current_setting('gbrain.write_trust_tier', true), ''), 'unknown')`);

/** What `guardFenceRows` asks of a page: its source, slug and the incoming fence (`jsonb_to_recordset` text of row_num, fact, visibility). */
export interface FenceRowsTarget { sourceId: string; slug: string; incoming: string }

/**
 * A live fence row of the page that the incoming fence does not state as it is and that the guard must look at: `above`
 * says it is more trusted than the writer, `opened` that `gbrain repair open-facts` opens it. `trust_tier` is the stored
 * tier.
 */
export interface FenceFactRow { id: number; row_num: number; fact: string; visibility: string; trust_tier: string; above: boolean; opened: boolean }

/**
 * The page's fence rows the writer may not supersede, by row number, locked (`FOR UPDATE OF f`): live, numbered, not a
 * conversation-extractor row unless the incoming fence claims its number, not stated unchanged by the incoming fence, and
 * more trusted than the writer, held narrower by a widening proposal that the fence still asks to widen, or opened.
 */
export async function listFenceFactRows(exec: LegacyUnscopedRead, target: FenceRowsTarget): Promise<FenceFactRow[]> {
  // A contested row a widening proposal stored narrower (pending, rejected or undone) is held while the fence still asks for world at its position.
  const held = trustedSql(`f.visibility <> 'world' AND EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.action IN ('supersede_fact', 'confirm') AND tp.related_table = 'facts'
      AND tp.related_id = f.id AND tp.status IN ('pending', 'rejected', 'undone') AND tp.before_state->'visibility' IS NOT NULL)
    AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v.incoming::text::jsonb) AS w(row_num integer, fact text, visibility text)
      WHERE w.row_num = f.row_num AND w.fact = f.fact AND w.visibility = 'world')`);
  const opened = trustedSql(openedFactRowSql('f', 'v.incoming'));
  const above = trustedSql(`${trustRankSql('f.trust_tier')} > ${WRITER_RANK_SQL}`);
  const rows = (await exec.run<FenceFactRow>(sqlFragment`SELECT f.id, f.row_num, f.fact, f.visibility, f.trust_tier, ${above} AS above, ${opened} AS opened FROM facts f
      CROSS JOIN (SELECT ${target.incoming}::text AS incoming) v
      WHERE f.source_id = ${target.sourceId} AND f.source_markdown_slug = ${target.slug} AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND (COALESCE(f.source, '') NOT LIKE 'cli:extract-conversation-facts%'
          OR EXISTS (SELECT 1 FROM jsonb_to_recordset(v.incoming::text::jsonb) AS c(row_num integer) WHERE c.row_num = f.row_num))
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v.incoming::text::jsonb) AS n(row_num integer, fact text, visibility text)
          WHERE n.row_num = f.row_num AND n.fact = f.fact AND n.visibility = f.visibility)
        AND (${above} OR (${held}) OR ${opened})
      ORDER BY f.row_num FOR UPDATE OF f`)).rows;
  return rows;
}

/** What `heldRows` asks of timeline rows (trust/fence-guard.ts): the row ids, the writer and whether an open contest holds. */
export interface HeldTimelineRowsSpec {
  ids: readonly number[];
  /** The writer's tier; the transaction's declared tier (`gbrain.write_trust_tier`, `unknown` when undeclared) when omitted. */
  writer?: TrustTier;
  /** Also hold a row a pending `forget` proposal targets (an open contest). */
  pending?: boolean;
}

/** A held timeline row and its stored tier. */
export interface HeldTimelineRow { id: number; trust_tier: string }

/**
 * Of `spec.ids`, the timeline rows a write may not delete or overwrite, by id and locked (`FOR UPDATE`): rows more trusted
 * than the writer and, with `pending`, rows a pending `forget` proposal targets. An id with no row reads no row.
 */
export async function listHeldTimelineRows(exec: LegacyUnscopedRead, spec: HeldTimelineRowsSpec): Promise<HeldTimelineRow[]> {
  if (!spec.ids.length) return [];
  // A name that is no tier ranks 0, as `trustRankSql` does: below every tier.
  const writer = spec.writer === undefined ? null : Object.hasOwn(TRUST_TIER_RANK, spec.writer) ? TRUST_TIER_RANK[spec.writer] : 0;
  const contest = trustedSql(spec.pending ? ` OR EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'forget'
      AND tp.target_table = 'timeline_entries' AND tp.target_id = x.id)` : '');
  return exec.run<HeldTimelineRow>(sqlFragment`SELECT x.id, x.trust_tier FROM timeline_entries x WHERE x.id = ANY(${[...spec.ids]}::bigint[])
      AND (${trustedSql(trustRankSql('x.trust_tier'))} > COALESCE(${writer}::int, ${trustedSql(WRITER_RANK_SQL)})${contest}) ORDER BY x.id FOR UPDATE`)
    .then(result => result.rows.map(row => ({ id: Number(row.id), trust_tier: row.trust_tier })));
}

/** What `heldRows` asks of takes (trust/fence-guard.ts): the row ids, the writer and whether an open contest holds. */
export interface HeldTakeRowsSpec {
  ids: readonly number[];
  /** The writer's tier; the transaction's declared tier (`gbrain.write_trust_tier`, `unknown` when undeclared) when omitted. */
  writer?: TrustTier;
  /** Also hold a row a pending `forget` proposal targets (an open contest). */
  pending?: boolean;
}

/** A held take and its stored tier. */
export interface HeldTakeRow { id: number; trust_tier: string }

/**
 * Of `spec.ids`, the takes a write may not delete or overwrite, by id and locked (`FOR UPDATE`): rows more trusted than
 * the writer and, with `pending`, rows a pending `forget` proposal targets. An id with no row reads no row. The text and
 * the bound values are the ones `heldRows` sent through `executeRaw` (pinned by test/engine-sql-held-take-rows-golden.test.ts).
 */
export async function listHeldTakeRows(exec: LegacyUnscopedRead, spec: HeldTakeRowsSpec): Promise<HeldTakeRow[]> {
  if (!spec.ids.length) return [];
  const writer = spec.writer === undefined ? sqlFragment`${trustedSql(WRITER_RANK_SQL)}` : sqlFragment`(CASE ${spec.writer}::text${trustedSql(trustRankArmsSql())}`;
  const contest = trustedSql(spec.pending ? ` OR EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'forget'
  AND tp.target_table = 'takes' AND tp.target_id = x.id)` : '');
  // `executeRaw`, the path `heldRows` took (Postgres counts it on the raw gauge), not `run`.
  const { text, params } = renderFragment(sqlFragment`SELECT x.id, x.trust_tier FROM takes x WHERE x.id = ANY(${[...spec.ids]}::bigint[])
      AND (${trustedSql(trustRankSql('x.trust_tier'))} > ${writer}${contest}) ORDER BY x.id FOR UPDATE`);
  const rows = await exec.executeRaw<HeldTakeRow>(text, params);
  return rows.map(row => ({ id: Number(row.id), trust_tier: row.trust_tier }));
}
