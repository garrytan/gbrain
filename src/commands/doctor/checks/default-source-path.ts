/**
 * default_source_local_path doctor check (#4739, narrowed).
 *
 * Gathers the inputs (sources row, page counts, sync.repo_path resolution,
 * #2018 leak-guard collision) and delegates the verdict to the pure
 * `assessDefaultSourcePath` helper in src/core/default-source-path-check.ts.
 * A null `default.local_path` is the DESIGNED fallback topology (pages nest
 * under sync.repo_path), so the check only warns when the fallback
 * demonstrably fails — see the helper's doc comment for the exact gates.
 *
 * Lives in the doctor module dir per the peeled-façade rule — new code goes
 * here, not back into doctor.ts. Returns null for the 'skip' verdict so the
 * caller pushes nothing.
 */
import { existsSync, statSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { assessDefaultSourcePath } from '../../../core/default-source-path-check.ts';

export async function defaultSourceLocalPathCheck(engine: BrainEngine): Promise<Check | null> {
  const [defaultSource] = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = 'default'`,
  );

  let livePages = 0;
  let fileBackedPages = 0;
  let repoPath: string | null = null;
  let repoPathIsDir = false;
  let collidingSourceId: string | null = null;
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
    if (repoPath) {
      try {
        repoPathIsDir = existsSync(repoPath) && statSync(repoPath).isDirectory();
      } catch {
        repoPathIsDir = false;
      }
      // Mirror resolvePageWriteTarget's #2018 leak guard: sync.repo_path
      // being another source's own working tree silently skips the write.
      const collide = await engine.executeRaw<{ id: string }>(
        `SELECT id FROM sources WHERE id <> 'default' AND local_path = $1 LIMIT 1`,
        [repoPath],
      );
      collidingSourceId = collide[0]?.id ?? null;
    }
  }

  const assessment = assessDefaultSourcePath({
    defaultSource,
    livePages,
    fileBackedPages,
    repoPath,
    repoPathIsDir,
    collidingSourceId,
  });
  if (assessment.status === 'skip') return null;
  return {
    name: 'default_source_local_path',
    status: assessment.status,
    message: assessment.message,
  };
}
