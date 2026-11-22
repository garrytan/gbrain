import { getPgliteKernelLockPath } from '../core/pglite-lock.ts';
/** Fail-first stub: the path only (no writer, no reader). */
export function brainRefSidecarPath(dataDir: string): string {
  return getPgliteKernelLockPath(dataDir)!.replace(/\.gbrain-owner\.lock$/, '.gbrain-brain-ref.json');
}
