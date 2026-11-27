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
/**
 * A live fence row of the page that the incoming fence does not state as it is and that the guard must look at: `above`
 * says it is more trusted than the writer, `opened` that `gbrain repair open-facts` opens it. `trust_tier` is the stored
 * tier.
 */
export interface FenceFactRow { id: number; row_num: number; fact: string; visibility: string; trust_tier: string; above: boolean; opened: boolean }

/** A stored take a lower-tier write may not change, and how the write would change it. `trust_tier` is the stored tier. */
export interface GuardedTakeRow { id: number; page_id: number; row_num: number; trust_tier: string; change: 'removed' | 'replaced' | 'deactivated' }

/** What `listGuardedTakeRows` asks: the incoming take rows of a reconcile batch, the rows it deletes, and whether an open contest holds too. */
export interface GuardedTakeRowsQuery {
  incoming: ReadonlyArray<{ page_id: number; row_num: number; claim: string; kind: string; holder: string; active: boolean }>;
  gone: ReadonlyArray<{ page_id: number; row_num: number }>;
  pending?: boolean;
}

/** What `heldRows` asks: of the page's rows `ids` in `table`, which ones a write by `writer` (the declared tier when omitted) may not touch. */
export interface HeldRowsQuery { table: HeldTable; pageId: number; ids: readonly number[]; writer?: string; pending?: boolean }

/** What a fence append restores on its page after the page write (trust/fence-append.ts withPageTierKept). */
export interface PageTrustRestore { pageId: number; trustTier: string; /** JSON text, or null for none. */ writeOrigin: string | null }

/**
 * A live fence row of the page that the incoming fence does not state as it is and that the guard must look at: `above`
 * says it is more trusted than the writer, `opened` that `gbrain repair open-facts` opens it. `trust_tier` is the stored
 * tier.
 */
export interface FenceFactRow { id: number; row_num: number; fact: string; visibility: string; trust_tier: string; above: boolean; opened: boolean }

/** What `guardFenceRows` asks of a page: its source, slug and the incoming fence (`jsonb_to_recordset` text of row_num, fact, visibility). */
export interface FenceRowsTarget { sourceId: string; slug: string; incoming: string }

/** A stored take a lower-tier write may not change, and how the write would change it. `trust_tier` is the stored tier. */
export interface GuardedTakeRow { id: number; page_id: number; row_num: number; trust_tier: string; change: 'removed' | 'replaced' | 'deactivated' }

/** What `listGuardedTakeRows` asks: the incoming take rows of a reconcile batch, the rows it deletes, and whether an open contest holds too. */
export interface GuardedTakeRowsQuery {
  incoming: ReadonlyArray<{ page_id: number; row_num: number; claim: string; kind: string; holder: string; active: boolean }>;
  gone: ReadonlyArray<{ page_id: number; row_num: number }>;
  pending?: boolean;
}

/** The tables whose rows a lower-tier write may be held from deleting or overwriting (trust/fence-guard.ts). */
export type HeldTable = 'takes' | 'timeline_entries';

const OPEN_CONTEST_TAKES_SQL = `EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = 'pending' AND tp.action = 'forget'
  AND tp.target_table = 'takes' AND tp.target_id = x.id)`;

/** SQL for the writer's trust rank: the transaction's declared tier (`gbrain.write_trust_tier`), `unknown` when undeclared. */
export const WRITER_RANK_SQL = trustRankSql(`COALESCE(NULLIF(current_setting('gbrain.write_trust_tier', true), ''), 'unknown')`);


/** SQL for the writer's trust rank: the transaction's declared tier (`gbrain.write_trust_tier`), `unknown` when undeclared. */

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
