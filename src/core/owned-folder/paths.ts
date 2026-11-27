/**
 * Owned folders (GST-3022): a source of a kind in OWNED_FOLDER_KINDS keeps its pages as files under
 * `.gbrain-owned/<source-id>/` inside the default source's own Git checkout. Only that source's writer
 * (owned-folder/writer.ts) reads or writes there: the default source's sync, import, repairs and every
 * commit door treat the folder as reserved (isPathPruned, commit-push admission), whatever --include-hidden says.
 * Dependency-light: sync.ts and the commit door import it.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { OperationError } from '../ops/contract.ts';

export { OWNED_FOLDER_ROOT } from './root.ts';
import { OWNED_FOLDER_ROOT } from './root.ts';

/** Source kinds whose pages live in an owned folder. Signal, WhatsApp and Notes add theirs in their own PRs. */
export const OWNED_FOLDER_KINDS: readonly string[] = ['imessage'];

export function isOwnedFolderKind(config: unknown): boolean {
  const kind = config && typeof config === 'object' ? (config as Record<string, unknown>).kind : undefined;
  return typeof kind === 'string' && OWNED_FOLDER_KINDS.includes(kind);
}

/** The checkout-relative folder of one source. */
export function ownedFolderRel(sourceId: string): string {
  return `${OWNED_FOLDER_ROOT}/${sourceId}`;
}

/** A slash-separated path (checkout- or source-relative) with a segment that is the reserved folder. */
export function isOwnedRelPath(path: string): boolean {
  return path.split(/[\\/]/).includes(OWNED_FOLDER_ROOT);
}

export function ownedPathRefused(paths: readonly string[], what: string): OperationError {
  return new OperationError('owned_folder_conflict',
    `${what} ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}: ${OWNED_FOLDER_ROOT}/ belongs to the sources that own it, and nothing else reads or writes it.`,
    `Leave ${OWNED_FOLDER_ROOT}/ to its source: gbrain sources status shows which source keeps its pages there, and removing that source stops them.`,
    'docs/guides/apple-setup.md#where-the-pages-live');
}

/** Refuses any path in the reserved folder; the owning writer passes `owned`. */
export function assertNotOwnedPaths(paths: readonly string[], what: string): void {
  const hits = paths.filter(isOwnedRelPath);
  if (hits.length) throw ownedPathRefused(hits, what);
}

/** Refuses a sync root, import target or uploaded file whose real path is inside a reserved folder (symlinks resolved). */
export function assertNotOwnedRoot(path: string, what: string): void {
  let real: string;
  try { real = realpathSync(resolve(path)); } catch { real = resolve(path); }
  if (isOwnedRelPath(real)) throw ownedPathRefused([path], what);
}
