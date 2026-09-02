/**
 * src/core/brain-dir.ts — the ONE place that decides where a cycle's
 * filesystem phases run (`gbrain dream`, the autopilot-cycle and
 * autopilot-global-maintenance job handlers, and the per-phase job wrappers).
 *
 * Resolution order and the seven reason codes:
 *
 *   explicit path given
 *     ├─ exists on disk ───────────▶ { dir: explicit,   reason: 'explicit' }
 *     └─ missing ──────────────────▶ { dir: null,       reason: 'explicit_missing' }
 *                                     (the CALLER decides: the CLI exits 1,
 *                                      a job handler fails the job — this
 *                                      module never exits the process)
 *   sourceId given (and an engine)
 *     ├─ local_path exists ────────▶ { dir: local_path, reason: 'source_path' }
 *     └─ no local_path / not on disk ▶ { dir: null,     reason: 'source_no_path' }
 *                                     (NEVER falls through to the global key:
 *                                      that path belongs to the default brain
 *                                      and would mix scopes — #2227)
 *   otherwise, the global `sync.repo_path` key (and an engine)
 *     ├─ configured and exists ────▶ { dir: repo_path,  reason: 'global' }
 *     └─ configured but missing ───▶ { dir: null,       reason: 'global_missing' }
 *   nothing configured ────────────▶ { dir: null,       reason: 'none' }
 *
 * A null `dir` means "no on-disk checkout here": filesystem phases skip with
 * `no_brain_dir` and the DB-only phases still run. Before this module, the
 * job handlers read `sync.repo_path` unchecked, so a brain whose checkout
 * lives on another machine (a laptop path inside a container) threw
 * "Directory not found" inside every filesystem phase instead of skipping.
 *
 * Never walks cwd for a `.git`: only the explicit / source / config signals
 * are trusted. Never throws on a missing path; a database error from the
 * sources or config read propagates (the caller's job fails with it).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { fetchSource } from './sources-load.ts';

export type BrainDirReason =
  | 'explicit'
  | 'explicit_missing'
  | 'source_path'
  | 'source_no_path'
  | 'global'
  | 'global_missing'
  | 'none';

export interface BrainDirResolution {
  /** Absolute checkout path, or null when no usable checkout exists. */
  dir: string | null;
  reason: BrainDirReason;
  /**
   * The path that was consulted but not usable (diagnostics only): the
   * explicit path for `explicit_missing`, the source's `local_path` for a
   * `source_no_path` whose path is configured but absent, the config value
   * for `global_missing`.
   */
  configured?: string;
}

/** Config key of the legacy (pre-multi-source) default checkout. */
export const GLOBAL_REPO_PATH_KEY = 'sync.repo_path';

export async function resolveBrainDir(
  engine: BrainEngine | null,
  explicit: string | null | undefined,
  sourceId?: string,
): Promise<BrainDirResolution> {
  if (explicit) {
    if (!existsSync(explicit)) {
      return { dir: null, reason: 'explicit_missing', configured: explicit };
    }
    // Absolute so downstream writeFileSync(join(brainDir, slug)) can't land
    // at cwd when explicit is `.` / `./brain`.
    return { dir: resolve(explicit), reason: 'explicit' };
  }

  if (engine && sourceId) {
    const src = await fetchSource(engine, sourceId);
    const localPath =
      typeof src?.local_path === 'string' && src.local_path.length > 0 ? src.local_path : null;
    if (localPath && existsSync(localPath)) {
      return { dir: resolve(localPath), reason: 'source_path' };
    }
    return { dir: null, reason: 'source_no_path', ...(localPath ? { configured: localPath } : {}) };
  }

  if (engine) {
    const configured = (await engine.getConfig(GLOBAL_REPO_PATH_KEY)) ?? null;
    if (configured && existsSync(configured)) {
      return { dir: resolve(configured), reason: 'global' };
    }
    if (configured) {
      return { dir: null, reason: 'global_missing', configured };
    }
  }

  return { dir: null, reason: 'none' };
}
