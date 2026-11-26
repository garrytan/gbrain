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
import type { BrainEngine } from '../engine.ts';
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

/** What a fence append restores on its page after the page write (trust/fence-append.ts withPageTierKept). */
export interface PageTrustRestore { pageId: number; trustTier: string; /** JSON text, or null for none. */ writeOrigin: string | null }

/**
 * Puts back the page's trust tier and write origin a fence append's page write restamped. The tier trigger still runs: a
 * raise back to the prior tier needs the promotion the caller opens (persistence/context.ts withTrustPromotion).
 */
export async function restorePageTrust(raw: Pick<BrainEngine, 'executeRaw'>, spec: PageTrustRestore): Promise<void> {
  await raw.executeRaw('UPDATE pages SET trust_tier=$2, write_origin=$3::text::jsonb WHERE id=$1', [spec.pageId, spec.trustTier, spec.writeOrigin]);
}

/** The tables whose rows a lower-tier write may be held from deleting or overwriting (trust/fence-guard.ts). */
export type HeldTable = 'takes' | 'timeline_entries';

const OPEN_CONTEST_TAKES_SQL = `EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'forget'
  AND tp.target_table = 'takes' AND tp.target_id = x.id)`;
const OPEN_CONTEST_TIMELINE_SQL = `EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'forget'
  AND tp.target_table = 'timeline_entries' AND tp.target_id = x.id)`;

/** SQL for an open owner contest of row `x`: a pending `forget` proposal that targets it. */
export const OPEN_CONTEST_SQL = (table: HeldTable) => table === 'takes' ? OPEN_CONTEST_TAKES_SQL : OPEN_CONTEST_TIMELINE_SQL;

/** What `heldRows` asks: of the page's rows `ids` in `table`, which ones a write by `writer` (the declared tier when omitted) may not touch. */
export interface HeldRowsQuery { table: HeldTable; pageId: number; ids: readonly number[]; writer?: string; pending?: boolean }

/**
 * Of the page's rows `ids`, the rows a write may not delete or overwrite, by id and locked (`FOR UPDATE OF x`): rows more
 * trusted than `writer` (the transaction's declared tier when omitted; a name that is no tier ranks 0) and, with
 * `pending`, rows an open contest already holds. `trust_tier` is the stored tier. This is the statement
 * `trust/fence-guard.ts` `heldRows` sent through `executeRaw`, scoped to the page that owns the rows, with the values
 * bound as fragment parameters (a named writer once, as `w.writer`).
 */
export async function listHeldRows(exec: LegacyUnscopedRead, q: HeldRowsQuery): Promise<Array<{ id: number; trust_tier: string }>> {
  if (q.table !== 'takes' && q.table !== 'timeline_entries') throw new Error(`listHeldRows: unknown table ${String(q.table)}`);
  if (!q.ids.length) return [];
  const table = trustedSql(q.table === 'takes' ? 'takes' : 'timeline_entries');
  const named = q.writer !== undefined;
  const writerFrom = named ? sqlFragment` CROSS JOIN (SELECT ${q.writer}::text AS writer) w` : sqlFragment``;
  const rank = trustedSql(trustRankSql('x.trust_tier'));
  const writer = named ? trustedSql(trustRankSql('w.writer')) : trustedSql(WRITER_RANK_SQL);
  const contest = !q.pending ? sqlFragment``
    : q.table === 'takes' ? sqlFragment` OR ${trustedSql(OPEN_CONTEST_TAKES_SQL)}` : sqlFragment` OR ${trustedSql(OPEN_CONTEST_TIMELINE_SQL)}`;
  const rows = (await exec.run<{ id: number | string; trust_tier: string }>(sqlFragment`SELECT x.id, x.trust_tier FROM ${table} x${writerFrom}
      WHERE x.page_id = ${q.pageId} AND x.id = ANY(${[...q.ids]}::bigint[]) AND (${rank} > ${writer}${contest}) ORDER BY x.id FOR UPDATE OF x`)).rows;
  return rows.map(r => ({ id: Number(r.id), trust_tier: r.trust_tier }));
}

/** What `listGuardedTakeRows` asks: the incoming take rows of a reconcile batch, the rows it deletes, and whether an open contest holds too. */
export interface GuardedTakeRowsQuery {
  incoming: ReadonlyArray<{ page_id: number; row_num: number; claim: string; kind: string; holder: string; active: boolean }>;
  gone: ReadonlyArray<{ page_id: number; row_num: number }>;
  pending?: boolean;
}

/** A stored take a lower-tier write may not change, and how the write would change it. `trust_tier` is the stored tier. */
export interface GuardedTakeRow { id: number; page_id: number; row_num: number; trust_tier: string; change: 'removed' | 'replaced' | 'deactivated' }

/**
 * Of the stored takes on the pages of `incoming` and `gone`, by page and row number and locked (`FOR UPDATE OF x`): those
 * the write would delete (`gone`), overwrite with another claim, kind or holder (`replaced`) or deactivate, and that are
 * more trusted than the writer (the transaction's declared tier) or, with `pending`, held by an open `forget` contest.
 * This is the statement `trust/fence-guard.ts` `guardTakeRows` sent through `executeRaw`; an empty batch reads nothing.
 */
export async function listGuardedTakeRows(exec: LegacyUnscopedRead, q: GuardedTakeRowsQuery): Promise<GuardedTakeRow[]> {
  if (!q.incoming.length && !q.gone.length) return [];
  const rank = trustedSql(trustRankSql('x.trust_tier'));
  const writer = trustedSql(WRITER_RANK_SQL);
  const contest = q.pending ? sqlFragment` OR ${trustedSql(OPEN_CONTEST_TAKES_SQL)}` : sqlFragment``;
  const pageIds = [...new Set([...q.incoming, ...q.gone].map(r => r.page_id))];
  const rows = (await exec.run<{ id: number | string; page_id: number | string; row_num: number | string; trust_tier: string; change: GuardedTakeRow['change'] }>(sqlFragment`SELECT x.id, x.page_id, x.row_num, x.trust_tier,
      CASE WHEN n.row_num IS NULL THEN 'removed' WHEN (x.claim, x.kind, x.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder) THEN 'replaced'
        ELSE 'deactivated' END AS change
    FROM takes x
    LEFT JOIN jsonb_to_recordset(${JSON.stringify(q.incoming)}::text::jsonb) AS n(page_id integer, row_num integer, claim text, kind text, holder text, active boolean)
      ON n.page_id = x.page_id AND n.row_num = x.row_num
    LEFT JOIN jsonb_to_recordset(${JSON.stringify(q.gone)}::text::jsonb) AS g(page_id integer, row_num integer) ON g.page_id = x.page_id AND g.row_num = x.row_num
    WHERE x.page_id = ANY(${pageIds}::integer[]) AND (${rank} > ${writer}${contest})
      AND (g.row_num IS NOT NULL OR (n.row_num IS NOT NULL
        AND ((x.claim, x.kind, x.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder) OR (x.active AND NOT n.active))))
    ORDER BY x.page_id, x.row_num FOR UPDATE OF x`)).rows;
  return rows.map(r => ({ id: Number(r.id), page_id: Number(r.page_id), row_num: Number(r.row_num), trust_tier: r.trust_tier, change: r.change }));
}

/**
 * The fence guard's statements around its decisions (trust/fence-guard.ts `guardFenceRows` and `factsAboveWriter`): the
 * detach of the guarded rows, the read of the page's occupied row numbers, the move of guarded rows to the numbers the
 * guard picked, the read of trusted narrower copies a world restatement widens, the read of the live row at one number,
 * and the page's live fence facts above the writer. Each is the text the guard sent through `executeRaw`, byte for byte,
 * with the same parameters; the writer's rank is the transaction's declared tier, which the SQL reads itself.
 */
const DETACH_FENCE_ROWS_SQL = 'UPDATE facts SET row_num = NULL WHERE id = ANY($1::bigint[])';
const OCCUPIED_ROWS_SQL = 'SELECT row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL AND expired_at IS NULL';
const MOVE_GUARDED_ROWS_SQL = `UPDATE facts f SET row_num = m.row_num, visibility = m.visibility FROM jsonb_to_recordset($1::text::jsonb) AS m(id bigint, row_num integer, visibility text)
    WHERE f.id = m.id`;
const LIVE_ROW_AT_SQL = `SELECT id, trust_tier FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num = $3 AND expired_at IS NULL`;

/** A guarded row's move: its new row number and visibility. */
export interface FenceRowMove { id: number; row_num: number; visibility: string }
/** A fence row that restates a claim at world, and the entity it names. */
export interface FenceRestatement { row_num: number; fact: string; entity: string | null }
/** A live narrower fact more trusted than the writer that a world restatement at `row_num` widens. */
export interface TrustedPrivateCopy { row_num: number; id: number; visibility: string; trust_tier: string }

/** Detaches facts `ids` from their fence position (row_num NULL). */
export async function detachFenceFactRows(raw: Pick<BrainEngine, 'executeRaw'>, ids: readonly number[]): Promise<void> {
  await raw.executeRaw(DETACH_FENCE_ROWS_SQL, [[...ids]]);
}

/** The row numbers the page's live positioned facts hold, in no set order. */
export async function listOccupiedFenceRowNums(raw: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<number[]> {
  return (await raw.executeRaw<{ row_num: number }>(OCCUPIED_ROWS_SQL, [sourceId, slug])).map(r => Number(r.row_num));
}

/** Moves each guarded fact to its row number and visibility, in one statement. */
export async function moveGuardedFenceRows(raw: Pick<BrainEngine, 'executeRaw'>, moves: readonly FenceRowMove[]): Promise<void> {
  await raw.executeRaw(MOVE_GUARDED_ROWS_SQL, [JSON.stringify(moves)]);
}

/**
 * For each world restatement, the first live narrower fact (the page's own first, then by id) more trusted than the
 * writer that states its claim: on the page while no live world fact of the page states it, or of its entity on another
 * page (or on none) while no live world fact of that entity states it.
 */
export async function listTrustedPrivateCopies(raw: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, restated: readonly FenceRestatement[]): Promise<TrustedPrivateCopy[]> {
  const { text, params } = renderFragment(sqlFragment`${trustedSql(`SELECT DISTINCT ON (r.row_num) r.row_num, f.id, f.visibility, f.trust_tier
      FROM jsonb_to_recordset($3::text::jsonb) AS r(row_num integer, fact text, entity text)
      JOIN facts f ON f.source_id = $1 AND f.expired_at IS NULL AND (f.source_markdown_slug = $2 OR f.entity_slug = r.entity)
        AND f.fact = r.fact AND f.visibility <> 'world' AND `)}${trustedSql(trustRankSql('f.trust_tier'))}${trustedSql(' > ')}${trustedSql(WRITER_RANK_SQL)}${trustedSql(`
      WHERE (f.source_markdown_slug = $2
          AND NOT EXISTS (SELECT 1 FROM facts w WHERE w.source_id = $1 AND w.source_markdown_slug = $2 AND w.expired_at IS NULL AND w.visibility = 'world' AND w.fact = f.fact))
        OR (f.entity_slug = r.entity AND f.source_markdown_slug IS DISTINCT FROM $2 AND (f.valid_until IS NULL OR f.valid_until > now())
          AND NOT EXISTS (SELECT 1 FROM facts w WHERE w.source_id = $1 AND w.entity_slug = r.entity AND w.expired_at IS NULL AND w.visibility = 'world'
            AND w.fact = f.fact AND (w.valid_until IS NULL OR w.valid_until > now())))
      ORDER BY r.row_num, COALESCE(f.source_markdown_slug = $2, false) DESC, f.id`)}`);
  if (params.length) throw new Error('listTrustedPrivateCopies: the statement must bind no fragment values');
  return raw.executeRaw<TrustedPrivateCopy>(text, [sourceId, slug, JSON.stringify(restated.map(r => ({ row_num: r.row_num, fact: r.fact, entity: r.entity ?? null })))]);
}

/** The id and stored tier of the page's live fact at `rowNum`, or null. */
export async function readLiveFenceFactAt(raw: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, rowNum: number): Promise<{ id: number; trust_tier: string } | null> {
  return (await raw.executeRaw<{ id: number; trust_tier: string }>(LIVE_ROW_AT_SQL, [sourceId, slug, rowNum]))[0] ?? null;
}

/** The page's live positioned facts more trusted than the writer (the transaction's declared tier): id and stored tier. */
export async function listFactsAboveWriter(raw: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<Array<{ id: number; trust_tier: string }>> {
  const { text, params } = renderFragment(sqlFragment`${trustedSql(`SELECT id, trust_tier FROM facts WHERE source_id = $1 AND source_markdown_slug = $2
      AND row_num IS NOT NULL AND expired_at IS NULL AND `)}${trustedSql(trustRankSql('trust_tier'))}${trustedSql(' > ')}${trustedSql(WRITER_RANK_SQL)}`);
  if (params.length) throw new Error('listFactsAboveWriter: the statement must bind no fragment values');
  return raw.executeRaw<{ id: number; trust_tier: string }>(text, [sourceId, slug]);
}
