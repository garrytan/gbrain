/**
 * `gbrain repair google-file-modes` (security fix wave): clear the group and
 * other bits of files and directories gbrain wrote under a Google source
 * directory outside `~/.gbrain` (see `src/core/google/file-modes.ts` for what
 * counts as gbrain's own layout). Never the user-chosen root, never through a
 * symlink, never another user's file. Filesystem only: no journal admission.
 * Each run re-scans, so a rerun after `--limit` or an interruption picks up
 * exactly the entries that are still loose.
 */
import { scanGoogleFileModes, tightenGoogleEntry } from '../google/file-modes.ts';
import type { RepairHandler, RepairItem } from './core.ts';

export const googleFileModesRepair: RepairHandler = {
  kind: 'google-file-modes',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope) {
    const scans = await scanGoogleFileModes(engine, { sourceIds: scope.source_ids });
    const items: RepairItem[] = scans.flatMap((scan, phase) => scan.loose.map((entry, index) => ({
      cursor: { phase, id: index + 1 }, source_id: scan.sourceId, slug: entry.rel, chars: 0, action: `tighten_${entry.kind}`,
      change: { from: JSON.stringify({ root: scan.dir, rel: entry.rel, kind: entry.kind, mode: entry.mode.toString(8) }), to: (entry.mode & ~0o077).toString(8) },
    })));
    const residuals: Record<string, number> = {};
    for (const scan of scans) for (const [reason, count] of Object.entries(scan.skipped)) {
      if (count) residuals[`skipped_${reason}`] = (residuals[`skipped_${reason}`] ?? 0) + count;
    }
    return { items, residuals };
  },
  async apply(_ctx, item) {
    const { root, rel, kind } = JSON.parse(item.change!.from!) as { root: string; rel: string; kind: 'file' | 'dir' };
    const result = tightenGoogleEntry(root, { rel, kind });
    return { applied: result.outcome === 'tightened', outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) };
  },
};
