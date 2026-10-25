import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isImageFilePath } from '../import-file.ts';

/** Read already-canonical image bytes without a disk sink. Publication
 * still verifies the owner's placement, real path and both byte hashes. */
export function isCanonicalImageRead(intent: Record<string, unknown>, root: string): boolean {
  if (intent.kind !== 'managed_file_import' || typeof intent.inputPath !== 'string'
    || typeof intent.sourcePath !== 'string' || !isImageFilePath(intent.sourcePath)
    || typeof intent.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(intent.inputHash)
    || intent.targetHash !== intent.inputHash) return false;
  const path = typeof intent.path === 'string' ? intent.path : intent.sourcePath;
  const target = resolve(root, path), within = relative(resolve(root), target);
  return !!within && !isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`)
    && resolve(intent.inputPath) === target;
}
