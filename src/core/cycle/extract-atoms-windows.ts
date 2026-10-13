/**
 * #6503: per-window idempotency for extract_atoms items longer than the input
 * cap.
 *
 * An oversized item is read as overlapping windows (text-windows.ts), one
 * model call each. The item is published and stamped complete only after
 * every window settled, so a window that fails (malformed output, provider
 * error, budget stop) leaves the item unstamped and retryable. To keep that
 * retry from paying again for windows that already succeeded, each settled
 * window's parsed atoms are banked in `op_checkpoints` under a key built from
 * the item's identity, the cap, the window's index and count, and the hash of
 * the exact window text. A retry reuses a banked window instead of calling the
 * model; an edited item, a changed cap or a re-planned window is a new key, so
 * stale answers are never reused. The rows are cleared when the item
 * completes and otherwise expire with the cycle's 7-day checkpoint purge.
 *
 * Single-window items never touch this table (their behavior and cost are
 * unchanged). Every read and write is fail-soft: a lost row only costs a
 * repeated model call, never correctness.
 */
import type { BrainEngine } from '../engine.ts';
import { digest, sha256 } from '../persistence/digest.ts';
import type { TextWindow } from '../text-windows.ts';
import type { ExtractedAtom } from './extract-atoms-parse.ts';

export const ATOM_WINDOW_OP = 'extract-atoms-window';
/** Characters consecutive windows share, so an idea straddling a boundary is read whole once (~2% of the default cap). */
export const ATOM_WINDOW_OVERLAP_CHARS = 1_000;

export interface AtomWindowItem {
  kind: 'page' | 'transcript';
  /** Page slug or transcript file path. */
  locator: string;
  contentHash: string;
}

/** The per-window idempotency key: item identity + cap + window position + window content hash. */
export function atomWindowKey(sourceId: string, item: AtomWindowItem, maxInputChars: number, window: TextWindow): string {
  return digest(['extract-atoms-window-v1', sourceId, item.kind, item.locator, item.contentHash, maxInputChars,
    window.index, window.count, window.start, window.end, sha256(window.text)]);
}

/** The atoms a settled window returned, or null when it has not settled (or the read failed). */
export async function readSettledAtomWindow(engine: BrainEngine, key: string): Promise<ExtractedAtom[] | null> {
  try {
    const [row] = await engine.executeRaw<{ atoms: unknown }>(
      `SELECT completed_keys->0->'atoms' AS atoms FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`, [ATOM_WINDOW_OP, key]);
    const atoms = typeof row?.atoms === 'string' ? JSON.parse(row.atoms) : row?.atoms;
    return Array.isArray(atoms) ? atoms as ExtractedAtom[] : null;
  } catch {
    return null;
  }
}

/** Bank a settled window's parsed atoms (an empty list is a settled zero-yield window). */
export async function recordSettledAtomWindow(engine: BrainEngine, sourceId: string, item: AtomWindowItem, key: string,
  window: TextWindow, atoms: ExtractedAtom[]): Promise<void> {
  const entry = [{ sourceId, kind: item.kind, locator: item.locator, contentHash: item.contentHash,
    window: window.index, of: window.count, atoms }];
  try {
    await engine.executeRaw(
      `INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
       ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()`,
      [ATOM_WINDOW_OP, key, JSON.stringify(entry)]);
  } catch (err) {
    console.error(`[extract_atoms] ${item.locator}: could not bank window ${window.index + 1}/${window.count} (a retry calls the model for it again): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Drop every banked window of an item (all content versions) once it completed. */
export async function clearSettledAtomWindows(engine: BrainEngine, sourceId: string, item: AtomWindowItem): Promise<void> {
  try {
    await engine.executeRaw(
      `DELETE FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'sourceId'=$2 AND completed_keys->0->>'kind'=$3 AND completed_keys->0->>'locator'=$4`,
      [ATOM_WINDOW_OP, sourceId, item.kind, item.locator]);
  } catch { /* fail-soft: the 7-day checkpoint purge removes them */ }
}

/** The prompt line that tells the model which window it reads and that windows overlap. */
export function atomWindowLine(window: TextWindow, totalChars: number): string {
  return `This is window ${window.index + 1} of ${window.count} of one longer source (characters ${window.start}-${window.end} of ${totalChars}). ` +
    'Neighbouring windows overlap slightly, so an idea near the edge may also appear in the next window: ' +
    'extract only what this window states; repeated atoms are merged afterwards.';
}
