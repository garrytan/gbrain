import { statSync } from 'node:fs';
import { join } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { hasUnresolvedDbOnlyDeclaration, isDeclaredDbOnlySlug, loadStorageConfig, type StorageConfig } from '../storage-config.ts';

type Loaded = { version: string; config: StorageConfig | null } | { version: string; cause: unknown };
// One parse per gbrain.yml version per source root: bulk scans and migrations
// ask once per page, and a rejected file is logged once rather than per page.
const loaded = new Map<string, Loaded>();

function load(root: string): StorageConfig | null {
  const path = join(root, 'gbrain.yml');
  let version: string;
  let statError: unknown;
  try {
    const stat = statSync(path);
    // On 1s-granularity filesystems a same-size rewrite within one second keeps this key.
    version = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { loaded.delete(root); return null; }
    version = 'unreadable'; statError = error;
  }
  let entry = loaded.get(root);
  if (entry?.version !== version) {
    try {
      if (statError) throw statError;
      const config = loadStorageConfig(root);
      if (hasUnresolvedDbOnlyDeclaration(root, config)) throw new Error('storage.db_only is declared but no directory resolved from it');
      entry = { version, config };
    } catch (cause) {
      console.warn(`[persistence] Rejected ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
      entry = { version, cause };
    }
    loaded.set(root, entry);
  }
  // A fresh error per throw: callers may annotate the instance they receive.
  if ('cause' in entry) throw Object.assign(new OperationError('storage_error', 'The source storage configuration in gbrain.yml is invalid.',
    'Run `gbrain storage status` for the exact problem, then fix gbrain.yml at the source root before writing to this source.'), { cause: entry.cause });
  return entry.config;
}

/**
 * Whether a page slug falls under a `storage.db_only` dir declared in the
 * gbrain.yml at this source root. A gbrain.yml that cannot be read, whose
 * tiers overlap, or that declares db_only in syntax resolving nothing is
 * logged once per version; `refuse` then throws `storage_error`, while
 * `not_db_only` answers false so the caller keeps its non-db_only behavior.
 */
export function isSourceDbOnlySlug(root: string, slug: string, onInvalid: 'refuse' | 'not_db_only'): boolean {
  try {
    return isDeclaredDbOnlySlug(slug, load(root));
  } catch (error) {
    if (onInvalid === 'refuse') throw error;
    return false;
  }
}
