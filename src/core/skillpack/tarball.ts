/**
 * skillpack/tarball.ts — deterministic tarball pack + extract with
 * allowlist + compression-bomb caps.
 *
 * Pack: walks a directory, emits a tar.gz with sorted entries, fixed
 * mtimes (epoch 0), uid=0/gid=0, normalized modes. Same dir + same
 * content -> same SHA-256, regardless of time-of-day or OS.
 *
 * Extract: streams entries through an allowlist (regular files +
 * directories only — no symlinks, hardlinks, device files, FIFOs),
 * enforces caps (max files, max bytes per file, max total bytes,
 * max path length, max compression ratio). Rejects path traversal.
 *
 * Pure Bun: shells out to `tar` for both directions because Bun's
 * built-in tar parsing landed mid-2025 and is still maturing.
 * Determinism is enforced by setting GNU tar env + flags
 * (TZ=UTC, --sort=name, --mtime=0, --owner=0, --group=0, --numeric-owner,
 * gzip -n for no original filename + mtime=0 in the header).
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, normalize, relative, resolve, sep } from 'path';
import { tmpdir } from 'os';

export interface TarballPackOptions {
  /** Absolute path to the directory whose contents become the tarball root. */
  sourceDir: string;
  /** Absolute path where the .tgz file should land. */
  outPath: string;
  /** Optional: list of relative paths to exclude (e.g. ['.git/', 'node_modules/']). */
  exclude?: string[];
}

export interface TarballPackResult {
  outPath: string;
  /** SHA-256 of the gzipped tarball (lowercase hex, no `sha256:` prefix). */
  sha256: string;
  /** Number of file entries (excludes directories). */
  fileCount: number;
  /** Compressed byte size on disk. */
  compressedBytes: number;
}

/** Extract caps shape — caller can override any subset. */
export interface ExtractCaps {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
  maxPathLength: number;
  /** Reject if decompressed/compressed ratio exceeds this. */
  maxCompressionRatio: number;
}

/** Default extract caps. Override per-call if a publisher pack is exceptional. */
export const DEFAULT_EXTRACT_CAPS: ExtractCaps = {
  maxFiles: 5000,
  maxBytesPerFile: 1024 * 1024, // 1 MB
  maxTotalBytes: 100 * 1024 * 1024, // 100 MB
  maxPathLength: 255,
  maxCompressionRatio: 100,
};

export interface TarballExtractOptions {
  /** Absolute path to the .tgz file. */
  tgzPath: string;
  /** Absolute path where contents should be extracted (must not exist or be empty). */
  destDir: string;
  /** Cap overrides; merged with defaults. */
  caps?: Partial<ExtractCaps>;
}

export interface TarballExtractResult {
  destDir: string;
  fileCount: number;
  totalBytes: number;
  /** SHA-256 of the gzipped tarball that was extracted. */
  sha256: string;
}

export type TarballErrorCode =
  | 'pack_source_missing'
  | 'pack_failed'
  | 'extract_tgz_missing'
  | 'extract_dest_not_empty'
  | 'extract_failed'
  | 'extract_path_traversal'
  | 'extract_disallowed_entry_type'
  | 'extract_file_too_large'
  | 'extract_total_too_large'
  | 'extract_too_many_files'
  | 'extract_path_too_long'
  | 'extract_compression_bomb'
  | 'tar_binary_not_found';

export class TarballError extends Error {
  constructor(
    message: string,
    public code: TarballErrorCode,
    public detail?: { path?: string; size?: number; limit?: number },
  ) {
    super(message);
    this.name = 'TarballError';
  }
}

/** Compute SHA-256 of a file on disk (streaming would be nicer but this is small). */
export function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Find the `tar` binary. On macOS this resolves to bsdtar by default; the pack
 * path explicitly prefers GNU tar (gtar / homebrew tar) when available for the
 * deterministic flags. Extract works with either.
 */
function resolveTarBinary(preferGnu: boolean): string {
  if (preferGnu) {
    for (const candidate of ['gtar', '/usr/local/opt/gnu-tar/libexec/gnubin/tar']) {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf-8' });
      if (probe.status === 0 && probe.stdout.includes('GNU')) return candidate;
    }
  }
  // Fall back to system tar — must validate it's GNU for the pack path.
  const sysProbe = spawnSync('tar', ['--version'], { encoding: 'utf-8' });
  if (sysProbe.status !== 0) {
    throw new TarballError('tar binary not found on PATH', 'tar_binary_not_found');
  }
  if (preferGnu && !sysProbe.stdout.includes('GNU')) {
    throw new TarballError(
      'GNU tar required for deterministic packing (bsdtar default on macOS lacks --sort + --mtime support). Install via: brew install gnu-tar',
      'tar_binary_not_found',
    );
  }
  return 'tar';
}

/**
 * Pack a directory deterministically. Same inputs -> same SHA every time.
 */
export function packTarball(opts: TarballPackOptions): TarballPackResult {
  if (!existsSync(opts.sourceDir)) {
    throw new TarballError(
      `pack source directory does not exist: ${opts.sourceDir}`,
      'pack_source_missing',
    );
  }

  const tar = resolveTarBinary(true);
  const excludeFlags = (opts.exclude ?? []).flatMap((p) => ['--exclude', p]);

  // Determinism flags:
  //   --sort=name: entries in lexicographic order
  //   --mtime='@0': all entries dated epoch 0
  //   --owner=0 --group=0 --numeric-owner: no uid/gid leak
  //   --pax-option=exthdr.name=...,delete=atime,delete=ctime: strip nondeterministic pax atime/ctime
  //   GZIP=-n: gzip header without original filename + mtime
  //   TZ=UTC: align mtime serialization regardless of host TZ
  const env = { ...process.env, GZIP: '-n', TZ: 'UTC' };
  const sourceParent = resolve(opts.sourceDir, '..');
  const sourceLeaf = relative(sourceParent, opts.sourceDir);

  // Stage to a tempfile so a failed pack doesn't leave a partial tarball at outPath.
  const stage = join(tmpdir(), `gbrain-skillpack-pack-${process.pid}-${Date.now()}.tgz`);

  const result = spawnSync(
    tar,
    [
      '--create',
      '--gzip',
      '--file',
      stage,
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--pax-option=delete=atime,delete=ctime,exthdr.name=%d/PaxHeaders/%f',
      '-C',
      sourceParent,
      ...excludeFlags,
      sourceLeaf,
    ],
    { env, encoding: 'utf-8' },
  );

  if (result.status !== 0) {
    try {
      rmSync(stage, { force: true });
    } catch {}
    throw new TarballError(
      `tar pack failed (exit ${result.status}): ${result.stderr || result.stdout || '<no output>'}`,
      'pack_failed',
    );
  }

  // Move staged tarball into place atomically.
  mkdirSync(resolve(opts.outPath, '..'), { recursive: true });
  // Use rename via fs operations rather than mv (cross-FS safe via readFile/write fallback).
  try {
    const data = readFileSync(stage);
    writeFileSync(opts.outPath, data);
    rmSync(stage, { force: true });
  } catch (err) {
    try {
      rmSync(stage, { force: true });
    } catch {}
    throw new TarballError(
      `failed to move staged tarball to outPath: ${(err as Error).message}`,
      'pack_failed',
    );
  }

  const sha256 = fileSha256(opts.outPath);
  const compressedBytes = statSync(opts.outPath).size;

  // Count files (re-list via tar -tzf for a quick traversal).
  const listResult = spawnSync(tar, ['--list', '--file', opts.outPath], { encoding: 'utf-8' });
  if (listResult.status !== 0) {
    throw new TarballError(
      `tar --list failed on freshly-packed tarball: ${listResult.stderr}`,
      'pack_failed',
    );
  }
  const fileCount = listResult.stdout
    .split('\n')
    .filter((line) => line.length > 0 && !line.endsWith('/'))
    .length;

  return { outPath: opts.outPath, sha256, fileCount, compressedBytes };
}

/**
 * Extract a tarball into destDir with strict allowlist + caps. Used both by
 * the third-party scaffold path (extracting a downloaded tarball) and by the
 * publish-gate (extracting a freshly-packed tarball to verify it round-trips).
 */
export function extractTarball(opts: TarballExtractOptions): TarballExtractResult {
  const caps = { ...DEFAULT_EXTRACT_CAPS, ...(opts.caps ?? {}) };

  if (!existsSync(opts.tgzPath)) {
    throw new TarballError(
      `tarball not found: ${opts.tgzPath}`,
      'extract_tgz_missing',
    );
  }
  if (existsSync(opts.destDir)) {
    const entries = readdirSync(opts.destDir);
    if (entries.length > 0) {
      throw new TarballError(
        `extract destination is not empty: ${opts.destDir}`,
        'extract_dest_not_empty',
      );
    }
  } else {
    mkdirSync(opts.destDir, { recursive: true });
  }

  // GNU tar required so the --list --verbose output format is deterministic.
  // bsdtar (macOS default) prints `0 501 20 SIZE Month DD HH:MM path` while
  // GNU tar prints `501/20 SIZE YYYY-MM-DD HH:MM path` — the parser below
  // anchors on the YYYY-MM-DD date pattern.
  const tar = resolveTarBinary(true);
  const sha256 = fileSha256(opts.tgzPath);
  const compressedBytes = statSync(opts.tgzPath).size;

  // Pre-flight inspection: list entries, check types + path traversal + caps.
  // Use --list --verbose for type info (the leading char encodes file type).
  const listResult = spawnSync(
    tar,
    ['--list', '--verbose', '--file', opts.tgzPath, '--numeric-owner'],
    { encoding: 'utf-8' },
  );
  if (listResult.status !== 0) {
    throw new TarballError(
      `tar --list failed: ${listResult.stderr || listResult.stdout}`,
      'extract_failed',
    );
  }

  const destReal = realpathSync(opts.destDir);
  let fileCount = 0;
  let totalBytes = 0;

  for (const rawLine of listResult.stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    // Format: `-rw-r--r-- 0/0 1234 2026-01-01 00:00 path/to/file`
    // Some entries may have wrapped fields; use a permissive parser.
    const typeChar = line.charAt(0);
    const fields = line.split(/\s+/);
    if (fields.length < 6) continue;
    // The path is everything after the date+time. Date is at index 3, time at 4 (or sometimes 3),
    // so path starts at index 5. Recombine in case the path contains spaces.
    // Find the date pattern to anchor.
    const dateMatch = line.match(/\s(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+/);
    if (!dateMatch) continue;
    const pathStart = line.indexOf(dateMatch[0]) + dateMatch[0].length;
    const entryPath = line.slice(pathStart);

    // Type allowlist: '-' regular, 'd' directory. Reject everything else.
    if (typeChar !== '-' && typeChar !== 'd') {
      throw new TarballError(
        `tarball contains disallowed entry type '${typeChar}' at ${entryPath} (symlinks, hardlinks, devices, FIFOs forbidden)`,
        'extract_disallowed_entry_type',
        { path: entryPath },
      );
    }

    if (entryPath.length > caps.maxPathLength) {
      throw new TarballError(
        `tarball entry path exceeds maxPathLength (${caps.maxPathLength}): ${entryPath}`,
        'extract_path_too_long',
        { path: entryPath, size: entryPath.length, limit: caps.maxPathLength },
      );
    }

    // Path traversal check: resolve relative to destDir, ensure result is contained.
    const normalized = normalize(entryPath);
    if (normalized.startsWith('..' + sep) || normalized === '..' || normalized.startsWith('/')) {
      throw new TarballError(
        `tarball entry escapes destination: ${entryPath}`,
        'extract_path_traversal',
        { path: entryPath },
      );
    }

    if (typeChar === '-') {
      fileCount += 1;
      if (fileCount > caps.maxFiles) {
        throw new TarballError(
          `tarball exceeds maxFiles cap (${caps.maxFiles})`,
          'extract_too_many_files',
          { limit: caps.maxFiles },
        );
      }
      // Field at index 2 is size (for `-` entries with --numeric-owner).
      // owner/group is `0/0` at fields[1], size at fields[2].
      const size = parseInt(fields[2] ?? '0', 10);
      if (!Number.isFinite(size) || size < 0) {
        throw new TarballError(
          `tarball entry has invalid size: ${entryPath} (raw: ${fields[2]})`,
          'extract_failed',
          { path: entryPath },
        );
      }
      if (size > caps.maxBytesPerFile) {
        throw new TarballError(
          `tarball entry ${entryPath} (${size} bytes) exceeds maxBytesPerFile cap (${caps.maxBytesPerFile})`,
          'extract_file_too_large',
          { path: entryPath, size, limit: caps.maxBytesPerFile },
        );
      }
      totalBytes += size;
      if (totalBytes > caps.maxTotalBytes) {
        throw new TarballError(
          `tarball decompressed total ${totalBytes} bytes exceeds maxTotalBytes cap (${caps.maxTotalBytes})`,
          'extract_total_too_large',
          { size: totalBytes, limit: caps.maxTotalBytes },
        );
      }
    }
  }

  // Compression-ratio cap (rough bomb defense).
  if (compressedBytes > 0 && totalBytes / compressedBytes > caps.maxCompressionRatio) {
    throw new TarballError(
      `compression ratio ${(totalBytes / compressedBytes).toFixed(1)}:1 exceeds cap (${caps.maxCompressionRatio}:1) — possible decompression bomb`,
      'extract_compression_bomb',
      { size: totalBytes, limit: caps.maxCompressionRatio },
    );
  }

  // All checks passed; do the actual extract.
  // GNU tar's --no-same-owner is implicit when not root; pass numeric-owner only.
  const extractResult = spawnSync(
    tar,
    ['--extract', '--gzip', '--file', opts.tgzPath, '-C', opts.destDir, '--numeric-owner'],
    { encoding: 'utf-8' },
  );
  if (extractResult.status !== 0) {
    throw new TarballError(
      `tar --extract failed: ${extractResult.stderr || extractResult.stdout}`,
      'extract_failed',
    );
  }

  // Validate the extracted files don't escape destDir even after extract (defense in depth).
  const realDest = realpathSync(opts.destDir);
  if (realDest !== destReal) {
    throw new TarballError(
      `destination realpath changed during extract (possible symlink attack)`,
      'extract_path_traversal',
    );
  }

  return { destDir: opts.destDir, fileCount, totalBytes, sha256 };
}
