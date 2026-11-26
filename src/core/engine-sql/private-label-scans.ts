/**
 * The scans of `gbrain repair private-labels` (src/core/repair/private-labels.ts) that ran through `executeRaw`: the
 * labelled pages (listLabelledPages), the live rows a restore rereads (listLiveLabelRows) and the pages a window of clears
 * exposes (listClearDependents, over dependentsSql('clear'), whose text lives in repair/dependents-sql.ts; origin-carry.ts
 * still runs dependentsSql('remove') itself). Each runs the statement its caller ran, with the
 * same text, parameters and options; only its home moved.
 */
import { privacyAliasSql } from '../search/private-visibility.ts';
import { dependentsSql } from '../repair/dependents-sql.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** A page a label makes private, with its revision, its stored body size and whether its source publishes to Git. */
export interface LabelledPageRow { id: number; source_id: string; slug: string; type: string; frontmatter: Record<string, unknown> | null; revision: string | null; chars: number; git: boolean }
/** The cleared pages of a window: page ids, their sources and slugs, and each one's comma-joined removed label keys. */
export interface ClearedLabels { ids: number[]; sourceIds: string[]; slugs: string[]; keys: string[] }
/** A page a window's clears expose, the cleared page it is tied to, and its category. */
export interface ClearDependentRow { id: number; cleared_id: number; category: 'derived_from' | 'atom' | 'concept' | 'life_chronicle' }

/** Live pages of the sources that a label makes private, in page id order after `after` (`ids` narrows to those pages), at most 5000. */
export async function listLabelledPages(raw: EngineRawRead, sourceIds: string[], after: number, ids: number[] | null, timeoutMs: number): Promise<LabelledPageRow[]> {
  const { text, params } = renderFragment(sqlFragment`${trustedSql(`SELECT p.id, p.source_id, p.slug, p.type, p.frontmatter, p.knowledge_revision::text AS revision,
        COALESCE(p.body_bytes, 0) AS chars, COALESCE(s.config->>'canonical' = 'git', false) AS git
      FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND p.id > $2
        AND (p.frontmatter->>'visibility' = 'private' OR (p.frontmatter->>'visibility' IS NULL AND `)}${trustedSql(privacyAliasSql('p'))}${trustedSql(`))
        AND ($3::integer[] IS NULL OR p.id = ANY($3::integer[]))
      ORDER BY p.id LIMIT 5000`)}`);
  if (params.length !== 0) throw new Error('listLabelledPages: a fragment bound a value ahead of the hand-numbered parameters');
  // body_bytes is a bigint: Postgres hands it back as one, PGLite as a number.
  return (await raw<LabelledPageRow>(text, [sourceIds, after, ids], { timeoutMs })).map(row => ({ ...row, chars: Number(row.chars) }));
}

/** The live rows of the named pages, as a restore rereads them. */
export async function listLiveLabelRows(raw: EngineRawRead, ids: number[], timeoutMs: number): Promise<Array<Omit<LabelledPageRow, 'git'>>> {
  return (await raw<Omit<LabelledPageRow, 'git'>>(`SELECT id, source_id, slug, type, frontmatter, knowledge_revision::text AS revision, COALESCE(body_bytes, 0) AS chars
    FROM pages WHERE id = ANY($1::integer[]) AND deleted_at IS NULL`, [ids], { timeoutMs })).map(row => ({ ...row, chars: Number(row.chars) }));
}

/**
 * The pages a window of clears exposes besides themselves (dependentsSql('clear')), with jit off and no prepared plan. The
 * caller reads the brain's alias setting first (readHonorAliases), which the privacy predicate renders.
 */
export async function listClearDependents(raw: EngineRawRead, cleared: ClearedLabels, timeoutMs: number): Promise<ClearDependentRow[]> {
  return raw<ClearDependentRow>(dependentsSql(), [cleared.ids, cleared.sourceIds, cleared.slugs, cleared.keys], { timeoutMs, jitOff: true, prepare: false });
}

/** The named pages stored under a contextual-retrieval mode, with that mode (the re-embedding preview). */
export async function listContextualRetrievalModes(raw: EngineRawRead, ids: number[], timeoutMs: number): Promise<Array<{ id: number; mode: string }>> {
  return raw<{ id: number; mode: string }>(`SELECT id, contextual_retrieval_mode AS mode FROM pages
    WHERE id = ANY($1::integer[]) AND contextual_retrieval_mode IS NOT NULL`, [ids], { timeoutMs });
}

/** The named pages with a chunk of their live body that has no vector yet (the re-embedding preview). */
export async function listUnembeddedChunkPages(raw: EngineRawRead, ids: number[], timeoutMs: number): Promise<number[]> {
  // chunk-visibility-ok: the statement keeps only live-body chunks through chunkGenerationFilter, spliced on its next line.
  const { text, params } = renderFragment(sqlFragment`${trustedSql(`SELECT DISTINCT cc.page_id AS id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
    WHERE cc.page_id = ANY($1::integer[]) AND cc.embedding IS NULL AND `)}${trustedSql(chunkGenerationFilter('p', 'cc'))}`);
  if (params.length !== 0) throw new Error('listUnembeddedChunkPages: a fragment bound a value ahead of the hand-numbered parameters');
  return (await raw<{ id: number }>(text, [ids], { timeoutMs })).map(row => Number(row.id));
}
