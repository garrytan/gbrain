import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';

/** Optional recoverable cleanup for hosts whose maintenance forbids deletion.
 * A failed move retains the claim and refuses reacquisition; never fall back to
 * unlink. The dependency seam lets the contract run without touching files.
 */
export async function releaseCorpusClaim(
  claimPath: string,
  preserve = process.env.GBRAIN_SWEEP_PRESERVE_CLAIMS === '1',
  io = { mkdir, rename, rm },
): Promise<boolean> {
  try {
    if (preserve) {
      const trash = join(homedir(), '.Trash');
      await io.mkdir(trash, { recursive: true, mode: 0o700 });
      await io.rename(claimPath, join(trash, `gbrain-corpus-claim-${randomUUID()}`));
    } else {
      await io.rm(claimPath, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}
