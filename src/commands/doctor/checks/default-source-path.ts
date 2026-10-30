/**
 * default_source_local_path doctor check (#4739, narrowed).
 *
 * Gathers the inputs (sources row, page counts, sync.repo_path resolution,
 * #2018 leak-guard collision) and delegates the verdict to the pure
 * `assessDefaultSourcePath` helper in src/core/default-source-path-check.ts.
 * A null `default.local_path` is the DESIGNED fallback topology (pages nest
 * under sync.repo_path), so the check only warns when the fallback
 * demonstrably fails — see the helper's doc comment for the exact gates.
 * #7630: it also warns on a relative default local_path or sync.repo_path and
 * for every other source whose local_path is relative.
 *
 * Lives in the doctor module dir per the peeled-façade rule — new code goes
 * here, not back into doctor.ts. Returns null for the 'skip' verdict when no
 * source has a relative local_path, so the caller pushes nothing.
 */
import { existsSync, statSync } from 'fs';
import { isAbsolute, posix, win32 } from 'path';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { assessDefaultSourcePath } from '../../../core/default-source-path-check.ts';
import { otherSourceOwning } from '../../../core/write-through.ts';

export async function defaultSourceLocalPathCheck(engine: BrainEngine): Promise<Check | null> {
  const [defaultSource] = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = 'default'`,
  );

  let livePages = 0;
  let fileBackedPages = 0;
  let repoPath: string | null = null;
  let repoPathIsDir = false;
  let collidingSourceId: string | null = null;
  let blockedByRelative = false;
  let sharedPages = 0;
  // #7630: any other source with a relative local_path is refused by sync the same way, so name it here too.
  const relative = (await engine.executeRaw<{ id: string; local_path: string }>(
    `SELECT id, local_path FROM sources WHERE id <> 'default' AND local_path IS NOT NULL AND local_path <> '' AND archived IS NOT TRUE ORDER BY id`,
  )).filter(row => !posix.isAbsolute(row.local_path) && !win32.isAbsolute(row.local_path));
  // Only gather the fallback-topology inputs when the pointer is actually
  // null — the set case resolves from the row alone.
  if (defaultSource && !defaultSource.local_path) {
    const [counts] = await engine.executeRaw<{ live: number; file_backed: number }>(
      `SELECT COUNT(*)::int AS live,
              COUNT(*) FILTER (WHERE source_path IS NOT NULL)::int AS file_backed
         FROM pages
        WHERE source_id = 'default' AND deleted_at IS NULL`,
    );
    livePages = Number(counts?.live ?? 0);
    fileBackedPages = Number(counts?.file_backed ?? 0);
    repoPath = (await engine.getConfig('sync.repo_path')) || null;
    if (repoPath && isAbsolute(repoPath)) {
      try {
        repoPathIsDir = existsSync(repoPath) && statSync(repoPath).isDirectory();
      } catch {
        repoPathIsDir = false;
      }
      // Mirror resolvePageWriteTarget's #2018 leak guard: sync.repo_path
      // being another source's own working tree silently skips the write.
      blockedByRelative = relative.length > 0;
      collidingSourceId = await otherSourceOwning(engine, 'default', repoPath, false);
      if (collidingSourceId) {
        const [shared] = await engine.executeRaw<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM pages a
            WHERE a.source_id = 'default' AND a.deleted_at IS NULL AND a.source_path IS NOT NULL
              AND EXISTS (SELECT 1 FROM pages b WHERE b.source_id = $1 AND b.source_path = a.source_path AND b.deleted_at IS NULL)`,
          [collidingSourceId],
        );
        sharedPages = Number(shared?.n ?? 0);
      }
    }
  }

  const assessment = assessDefaultSourcePath({
    defaultSource,
    livePages,
    fileBackedPages,
    repoPath,
    repoPathIsDir,
    collidingSourceId,
    sharedPages,
  });
  if (assessment.status === 'skip' && relative.length === 0) return null;
  const relativeNote = relative.length === 0 ? '' :
    `${relative.map(row => `source "${row.id}" has the relative local_path "${row.local_path}"`).join('; ')}, which names whatever directory ` +
    'gbrain runs from, so sync refuses it (sync_anchor_relative). Ask the user which directory holds its files, then run ' +
    '`gbrain sources set-path <id> <absolute-directory>`, or clear the pointer with `gbrain sources set-path <id> --clear`.' +
    (blockedByRelative ? ' Until then, pages of every source with no local_path (the default source and any `.sources/<id>` source) are saved to the database only, not written under sync.repo_path.' : '');
  return {
    name: 'default_source_local_path',
    status: relative.length > 0 || assessment.status === 'skip' ? 'warn' : assessment.status,
    message: relativeNote ? [relativeNote, blockedByRelative && assessment.status === 'ok' ? '' : assessment.message].filter(Boolean).map(part => /[.!?]$/.test(part) ? part : `${part}.`).join(' ') : assessment.message,
  };
}
