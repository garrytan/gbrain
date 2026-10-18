import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';

/**
 * #6454: live pages whose stored frontmatter still carries one of the
 * parser's reserved top-level keys (`type`, `title`, `tags`, `slug`), which an
 * older import kept. Since `comparableFrontmatter` they are not file/database
 * drift and never render, so this is hygiene: names the explicit-only,
 * preview-bound `gbrain repair frontmatter-keys` sweep per source and says
 * that each swept row advances its knowledge_revision once. Read-only.
 */
export async function staleFrontmatterKeysCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const docs = 'docs/guides/repair.md#frontmatter-keys';
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const counts = await engine.countStaleFrontmatterKeyPages({ sourceIds: sources });
    const count = counts.reduce((sum, row) => sum + row.n, 0);
    const details = { count, sources: counts, source_ids: counts.map(row => row.source_id), repair: 'frontmatter-keys', docs };
    if (!count) return { name: 'stale_frontmatter_keys', status: 'ok', details, message: 'No stored frontmatter carries a parser-reserved key (type, title, tags, slug).' };
    const preview = ['gbrain', 'repair', 'frontmatter-keys', ...(counts.length === 1 ? ['--source', counts[0].source_id] : [])];
    return { name: 'stale_frontmatter_keys', status: 'warn', details,
      message: `${count} page(s) store a parser-reserved key (type, title, tags, slug) inside their frontmatter, left by an older import: `
        + `${counts.map(row => `${row.source_id}: ${row.n}`).join(', ')}. Writes compare and render around these keys since v0.60.177.0, so this is hygiene, not a wedge. `
        + `Preview the sweep on the brain host: ${preview.join(' ')}${counts.length > 1 ? ` (every source; one at a time: ${counts.map(row => `gbrain repair frontmatter-keys --source ${row.source_id}`).join(', ')})` : ''} — it lists the pages and prints the apply command; each swept page `
        + `advances its knowledge_revision once (a client holding an older revision gets one revision_conflict).`,
      fix: agentFix(preview,
        'Read-only preview: lists the pages carrying reserved keys, saves the set under a hash and prints the apply command.', 'stale_frontmatter_keys', { docs }) };
  } catch (error) {
    return checkError('stale_frontmatter_keys', 'count stored frontmatter reserved keys', error, { details: { count: 'unknown', docs } });
  }
}
