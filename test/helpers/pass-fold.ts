import { installFaultHook } from '../../src/core/persistence/fault-points.ts';

/**
 * #6926 (folded into 4b): runs `run` with each pass's folded stamp refused at its `sync:pass_fold` seam, so the pass stamps
 * by its checkpoint request, as a build before the fold did. For tests of that request, of a released brain's receipts, or of
 * the window between a pass's last import and its checkpoint, which a folded stamp closes.
 */
export async function stampByCheckpoint<T>(run: () => Promise<T>): Promise<T> {
  installFaultHook(point => { if (point === 'sync:pass_fold') throw new Error('The test refuses the folded stamp.'); });
  try { return await run(); } finally { installFaultHook(undefined); }
}
