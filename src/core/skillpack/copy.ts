/**
 * skillpack/copy.ts — shared file-copy primitive for scaffold (gbrain→host)
 * and harvest (host→gbrain).
 *
 * Inverse directions, identical mechanics: walk a source dir, mirror it
 * under a destination, refuse to overwrite existing files. Optional
 * safety gates for the harvest path (symlink rejection, canonical-path
 * containment) keep user-controlled `--from` inputs from leaking
 * secrets into gbrain's tree or escaping the intended skill dir.
 *
 * Atomic-refusal contract (mirrors the old uninstall.ts D11 guard):
 * the helper validates every item BEFORE any write. If any item
 * violates rejectSymlinks or confineRealpath, the helper throws
 * CopyError BEFORE the filesystem is touched. Either every safe item
 * gets a chance to copy, or nothing does.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';

export interface CopyItem {
  /** Absolute source path. */
  source: string;
  /** Absolute target path. */
  target: string;
}

export interface CopyArtifactsOpts {
  /** Reject any source that is a symlink (lstat-based). For harvest's
   *  user-controlled `--from` paths. */
  rejectSymlinks?: boolean;
  /** Every source path must canonicalize to a path inside this dir.
   *  For harvest's path-confinement gate. */
  confineRealpath?: string;
  /** Dry-run: validate + report; no writes. */
  dryRun?: boolean;
}

export type CopyOutcome = 'wrote_new' | 'skipped_existing';

export interface CopyFileResult {
  source: string;
  target: string;
  outcome: CopyOutcome;
}

export interface CopyResult {
  dryRun: boolean;
  files: CopyFileResult[];
  summary: {
    wroteNew: number;
    skippedExisting: number;
  };
}

export class CopyError extends Error {
  constructor(
    message: string,
    public code: 'symlink_rejected' | 'path_traversal' | 'source_missing',
    public offendingPath?: string,
  ) {
    super(message);
    this.name = 'CopyError';
  }
}

/**
 * Walk a source directory recursively, returning `{source, target}`
 * pairs mirrored under `dstDir`. Symlinks in the source are returned
 * as-is (callers that want to reject them pass `rejectSymlinks: true`
 * to `copyArtifacts`).
 *
 * Returns `[]` for a non-existent or empty source. Callers can detect
 * missing sources by checking `existsSync` first or by inspecting the
 * length of the returned array.
 */
export function walkSourceDir(srcDir: string, dstDir: string): CopyItem[] {
  if (!existsSync(srcDir)) return [];
  const items: CopyItem[] = [];
  walk(srcDir, srcDir, dstDir, items);
  return items;
}

function walk(rootSrc: string, curSrc: string, rootDst: string, out: CopyItem[]): void {
  let entries: string[];
  try {
    entries = readdirSync(curSrc);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(curSrc, name);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch {
      continue;
    }
    const rel = relative(rootSrc, abs);
    const dst = join(rootDst, rel);
    if (stat.isDirectory()) {
      walk(rootSrc, abs, rootDst, out);
    } else {
      out.push({ source: abs, target: dst });
    }
  }
}

/**
 * Copy files according to `items`. Existing targets are always skipped
 * (the new scaffold model: user owns the file once it lands). Optional
 * safety gates fire BEFORE any write so a half-copy can't happen.
 *
 * Throws `CopyError` (with `offendingPath`) on the first violation when
 * `rejectSymlinks` or `confineRealpath` is set.
 */
export function copyArtifacts(items: CopyItem[], opts: CopyArtifactsOpts = {}): CopyResult {
  const dryRun = opts.dryRun ?? false;

  // Pre-flight: realpath the containment root once (validation only —
  // confineRealpath itself must exist for the gate to be meaningful).
  let confineRoot: string | null = null;
  if (opts.confineRealpath) {
    if (!existsSync(opts.confineRealpath)) {
      throw new CopyError(
        `confineRealpath does not exist: ${opts.confineRealpath}`,
        'source_missing',
        opts.confineRealpath,
      );
    }
    confineRoot = realpathSync(opts.confineRealpath);
  }

  // Validate every item first (atomic-refusal contract).
  for (const item of items) {
    if (!existsSync(item.source)) {
      throw new CopyError(
        `Source path does not exist: ${item.source}`,
        'source_missing',
        item.source,
      );
    }
    if (opts.rejectSymlinks) {
      const stat = lstatSync(item.source);
      if (stat.isSymbolicLink()) {
        throw new CopyError(
          `${item.source}: symlink rejected (security). Copy the real file into the skill dir before retrying.`,
          'symlink_rejected',
          item.source,
        );
      }
    }
    if (confineRoot) {
      const real = realpathSync(item.source);
      // realpathSync returns paths without trailing slash; add path
      // separator to the prefix check so /a/b doesn't match /a/bb.
      const prefix = confineRoot.endsWith('/') ? confineRoot : confineRoot + '/';
      if (real !== confineRoot && !real.startsWith(prefix)) {
        throw new CopyError(
          `${item.source}: path traversal rejected. Source canonicalizes outside the confinement root (${confineRoot}).`,
          'path_traversal',
          item.source,
        );
      }
    }
  }

  // Copy (or skip).
  const files: CopyFileResult[] = [];
  for (const item of items) {
    if (existsSync(item.target)) {
      files.push({ source: item.source, target: item.target, outcome: 'skipped_existing' });
      continue;
    }
    if (!dryRun) {
      const content = readFileSync(item.source);
      mkdirSync(dirname(item.target), { recursive: true });
      writeFileSync(item.target, content);
    }
    files.push({ source: item.source, target: item.target, outcome: 'wrote_new' });
  }

  return {
    dryRun,
    files,
    summary: {
      wroteNew: files.filter(f => f.outcome === 'wrote_new').length,
      skippedExisting: files.filter(f => f.outcome === 'skipped_existing').length,
    },
  };
}
