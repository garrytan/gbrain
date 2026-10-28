/**
 * GBRA-217 (B1/B6): a page write's valid-time advisory. After the publication applies, the page before and after are
 * compared (`validTimeWriteAdvisory`): a `valid_from` that is not a date warns `valid_from_unparsed`; a body change
 * under an unchanged `valid_from` is reported as a correction of that edition; a date-only change asks whether it is a
 * correction or a renewal. The advisory rides the write outcome as `valid_time`; nothing else changes. Same on a
 * repo-less brain: it reads only the database rows the write's own transaction produced.
 */
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';
import { validTimeWriteAdvisory } from '../valid-time.ts';

const ADVISED = ['put_page', 'capture', 'revert_version', 'edit_page'];

type BodyRow = { frontmatter: unknown; compiled_truth: string | null; timeline: string | null; body_storage?: string | null; content_hash?: string | null };
/** What a body comparison sees: the stored text, or a segmented page's content hash (its text is not on the row). */
const bodyKey = (p: BodyRow) => p.body_storage === 'segmented' ? `s:${p.content_hash ?? ''}` : `t:${p.compiled_truth ?? ''}\u0001${p.timeline ?? ''}`;
const asObject = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? {}) as Record<string, unknown>;

export function withValidTimeAdvisory(row: WriteRequest, prepared: PreparedMutation): PreparedMutation {
  if (!ADVISED.includes(row.operation)) return prepared;
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => {
    const outcome = await apply(tx, preimage);
    if (prepared.noop) return outcome;
    const [after] = await tx.executeRaw<BodyRow>(`SELECT frontmatter, compiled_truth, timeline, body_storage, content_hash FROM pages
      WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [row.source_id, row.slug]);
    if (!after) return outcome;
    const before = preimage && !preimage.page.deleted_at
      ? { frontmatter: asObject(preimage.page.frontmatter), body: bodyKey(preimage.page as BodyRow) } : null;
    const advisory = validTimeWriteAdvisory(before, { frontmatter: asObject(after.frontmatter), body: bodyKey(after) });
    return advisory ? { ...outcome, valid_time: advisory } : outcome;
  };
  return prepared;
}
