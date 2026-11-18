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
 */
import { openedFactRowSql } from '../persistence/context.ts';
import { trustRankSql } from '../trust/tier.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

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
