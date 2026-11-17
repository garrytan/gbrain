/**
 * Engine graduation doctor findings (filesystem only: the manifest, the
 * intent marker and the tombstone; never a lock attempt, never a connect).
 *
 *   - graduation_interrupted (fail): a manifest or intent marker is in a
 *     non-terminal state and no live run owns it (or a stray brain sits at
 *     the graduated path). Fix: `foresights migrate --resume`, rollback named.
 *     The run named by GBRAIN_GRADUATION_RUN (the verify step's own doctor
 *     child) is exempt.
 *   - A live run reports `ok` with its PID; a brain that never graduated
 *     emits nothing.
 *
 * The retained `.graduated-*` copy is reported by pglite_leftovers.
 */
import type { Check } from '../../doctor.ts';
import { inspectGraduationPath } from '../../../core/persistence/graduation-custody.ts';
import { interruptedError, splitBrainError } from '../../../core/persistence/graduation-errors.ts';
import {
  TERMINAL_MANIFEST_STATES, hostPgliteDataDir, readGraduationManifestSummary, type GraduationManifestSummary,
} from '../../../core/persistence/graduation-serve-guard.ts';
import type { GraduationPathState } from '../../../core/persistence/engine-graduation.types.ts';

export function graduationStateCheck(opts: { env?: NodeJS.ProcessEnv; home?: string; manifest?: GraduationManifestSummary | null; path?: GraduationPathState | null } = {}): Check | null {
  const env = opts.env ?? process.env;
  const manifest = opts.manifest !== undefined ? opts.manifest : readGraduationManifestSummary(opts.home);
  const dataDir = manifest?.dataDir ?? hostPgliteDataDir();
  const path = opts.path !== undefined ? opts.path : dataDir ? inspectGraduationPath(dataDir) : null;
  const runId = manifest?.runId ?? path?.marker?.runId;
  const state = manifest?.state ?? path?.marker?.state;
  if (!runId || !state) return null;
  if (env.GBRAIN_GRADUATION_RUN && env.GBRAIN_GRADUATION_RUN === runId) return null;
  if (path?.state === 'in_progress') {
    return { name: 'graduation_interrupted', status: 'ok', message: `Engine graduation ${runId} is running (PID ${path.marker?.pid}, ${state}).`, details: { run_id: runId, state, live: true } };
  }
  if (path?.state === 'split_brain') {
    const e = splitBrainError({ sourcePath: path.dataDir, strayPath: path.dataDir });
    return { name: 'graduation_interrupted', status: 'fail', message: e.message, fix: e.fix, details: { run_id: runId, state, split_brain: true } };
  }
  if (TERMINAL_MANIFEST_STATES.has(state) && path?.state !== 'interrupted') return null;
  const e = interruptedError({ runId, state, ...(dataDir ? { dataDir } : {}) });
  return { name: 'graduation_interrupted', status: 'fail', message: `${e.message} ${e.why}`, fix: e.fix, details: { run_id: runId, state, live: false } };
}
