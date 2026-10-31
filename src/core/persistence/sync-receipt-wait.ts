/**
 * How long a managed sync pass waits on its own admitted write: a single pass stops `writer_pending` after `pass` (`held`
 * while this process's consumer still holds the write, #6712 item 7; `checkpoint` for a sync checkpoint, #5762), and a drain
 * re-enters after `drain`. One place with a test seam (#7886), so a test can outlast a wait in milliseconds instead of
 * sleeping past 30 s.
 */
const DEFAULTS = { pass: 5000, checkpoint: 8000, held: 30_000, drain: 30_000 };
let waits = DEFAULTS;

export const syncReceiptWait = (): typeof DEFAULTS => waits;

/** Test seam: replace some of the waits (null restores the defaults). Returns a function that restores the previous ones. */
export function __setSyncReceiptWaitForTests(next: Partial<typeof DEFAULTS> | null): () => void {
  const previous = waits;
  waits = next ? { ...DEFAULTS, ...next } : DEFAULTS;
  return () => { waits = previous; };
}
