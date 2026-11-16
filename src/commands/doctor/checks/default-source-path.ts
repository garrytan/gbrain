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
 * for every other source whose local_path is relative (a path absolute only on
 * another OS belongs to the host that set it, so it is not listed). #7646:
 * that scan runs on its own, so a failed read leaves the rest of the check, and
 * the database-only note names every live source with no local_path whose
 * pages a relative sibling keeps out of sync.repo_path.
 *
 * Lives in the doctor module dir per the peeled-façade rule — new code goes
 * here, not back into doctor.ts. Returns null for the 'skip' verdict when no
 * other source needs a note, so the caller pushes nothing.
 */
import { existsSync, statSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { assessDefaultSourcePath } from '../../../core/default-source-path-check.ts';
import { isForeignAbsolutePath, isHostAbsolutePath } from '../../../core/path-confine.ts';
import { otherSourceOwning } from '../../../core/write-through.ts';

type PathRow = { id: string; local_path: string };

/** Every other live source whose local_path is relative on this host (not absolute here or on another OS). */
async function relativeSources(engine: BrainEngine): Promise<PathRow[]> {
  return (await engine.executeRaw<PathRow>(
    `SELECT id, local_path FROM sources WHERE id <> 'default' AND local_path IS NOT NULL AND local_path <> '' AND archived IS NOT TRUE ORDER BY id`,
  )).filter(row => !isHostAbsolutePath(row.local_path) && !isForeignAbsolutePath(row.local_path));
}

function siblingNote(relative: PathRow[], pathless: string[]): string {
  const parts: string[] = [];
  if (relative.length > 0) {
    parts.push(`${relative.map(row => `source "${row.id}" has the relative local_path "${row.local_path}"`).join('; ')}, which names whatever directory ` +
      'gbrain runs from, so sync refuses it (sync_anchor_relative). Ask the user which directory holds its files, then run ' +
      '`gbrain sources set-path <id> <absolute-directory>`, or clear the pointer with `gbrain sources set-path <id> --clear`.');
  }
  if (pathless.length > 0) {
    parts.push(pathless.includes('default')
      ? 'Until then, pages of every source with no local_path (the default source and any `.sources/<id>` source) are saved to the database only, not written under sync.repo_path.'
      : `Until then, pages of ${pathless.map(id => `"${id}"`).join(', ')} (no local_path) are saved to the database only, not written under sync.repo_path.`);
  }
  return parts.join(' ');
}

export async function defaultSourceLocalPathCheck(engine: BrainEngine): Promise<Check | null> {
  const [defaultSource] = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = 'default'`,
  );

  let livePages = 0;
  let fileBackedPages = 0;
  let repoPath: string | null = null;
  let repoPathIsDir = false;
  let collidingSourceId: string | null = null;
  let sharedPages = 0;
  let relative: PathRow[] = [];
  let scanFailed: string | null = null;
  try {
    relative = await relativeSources(engine);
  } catch (error) {
    scanFailed = error instanceof Error ? error.message : String(error);
  }
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
    if (repoPath && isHostAbsolutePath(repoPath)) {
      try {
        repoPathIsDir = existsSync(repoPath) && statSync(repoPath).isDirectory();
      } catch {
        repoPathIsDir = false;
      }
      // Mirror resolvePageWriteTarget's #2018 leak guard: sync.repo_path
      // being another source's own working tree silently skips the write.
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
  // A live relative sibling makes the leak guard refuse every write under sync.repo_path, so pages of any live source
  // with no local_path go database-only, whether or not default has a path of its own.
  let pathless: string[] = [];
  if (relative.length > 0) {
    const globalRepo = repoPath ?? ((await engine.getConfig('sync.repo_path')) || null);
    if (globalRepo && isHostAbsolutePath(globalRepo)) {
      pathless = (await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE (local_path IS NULL OR local_path = '') AND archived IS NOT TRUE ORDER BY id`,
      )).map(row => row.id);
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
  const note = siblingNote(relative, pathless);
  const failedNote = scanFailed === null ? '' : `Other sources' local_path values could not be read, so they were not checked (${scanFailed}).`;
  if (assessment.status === 'skip' && !note && !failedNote) return null;
  if (!note && !failedNote) return { name: 'default_source_local_path', status: assessment.status === 'ok' ? 'ok' : 'warn', message: assessment.message };
  const hidesFallback = pathless.includes('default') && assessment.status === 'ok';
  const message = [note, hidesFallback ? '' : assessment.message, failedNote].filter(Boolean).map(part => /[.!?]$/.test(part) ? part : `${part}.`).join(' ');
  return { name: 'default_source_local_path', status: 'warn', message };
}
