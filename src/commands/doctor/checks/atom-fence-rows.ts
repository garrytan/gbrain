/**
 * `atom_fence_rows`: world atoms whose title, body or source_quote carries the claim of a fence row their source page
 * shows only to the owner (repair/atom-fence-rows.ts holds the rule and the scan). A `WAVE_CHECKS` entry, host-only:
 * `ok` when none; `warn` with the count per source and the read-only preview as fix, never a slug or row text. The
 * apply narrows the previewed atoms to private and needs the user's agreement on that set. Each statement is bounded
 * by PLAN_STATEMENT_MS; an overrun reports the count as unknown.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { findAtomFenceRows } from '../../../core/repair/atom-fence-rows.ts';
import { PLAN_STATEMENT_MS } from '../../../core/repair/visibility.ts';

const DOCS = 'docs/guides/repair.md#atom-fence-rows';

export async function atomFenceRowsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'atom_fence_rows';
  try {
    const sources = sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
    const bySource: Array<{ source_id: string; count: number }> = [];
    let originUnread = 0;
    for (const source of sources) {
      const scan = await findAtomFenceRows(engine, [source], { timeoutMs: PLAN_STATEMENT_MS });
      originUnread += scan.origin_unread;
      if (scan.atoms.length) bySource.push({ source_id: source, count: scan.atoms.length });
    }
    const count = bySource.reduce((sum, row) => sum + row.count, 0);
    const details = { count, by_source: bySource, origin_unread: originUnread, repair: 'atom-fence-rows', docs: DOCS };
    if (!count) {
      return { name, status: 'ok', details, message: 'No world atom carries a fence row its source page shows only to the owner.' };
    }
    const preview = ['gbrain', 'repair', 'atom-fence-rows', '--source', bySource[0]!.source_id, '--json'];
    return { name, status: 'warn', details,
      message: `${count} world atom(s) carry the claim of a fence row their source page shows only to the owner, so remote callers can read it `
        + `(${bySource.map(row => `${row.source_id}: ${row.count}`).join('; ')}). Preview them with ${preview.join(' ')} (read-only); `
        + 'narrow the previewed set to private only after the user agrees.',
      fix: agentFix(preview, 'Lists each atom with its source page and the fence row kinds and numbers it carries, and prints the apply command bound to that set; '
        + 'it writes nothing. Narrowing the atoms is the user\'s call: show them the preview before running the apply.', name, { docs: DOCS }) };
  } catch (error) {
    const timedOut = (error as { code?: string } | null)?.code === '57014';
    return { name, status: 'warn', details: { count: 'unknown' },
      message: timedOut ? `The world atom scan did not finish within ${PLAN_STATEMENT_MS} ms; preview it with gbrain repair atom-fence-rows --source <id>. Health is unknown.`
        : `World atoms could not be checked for owner-only fence rows: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
