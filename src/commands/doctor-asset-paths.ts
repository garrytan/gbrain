/**
 * #1835 — storage_path resolution for the doctor `image_assets` check.
 *
 * `files.storage_path` rows written by a Windows gbrain install carry Windows
 * drive paths (`D:/foo/img.jpg`, `D:\foo\img.jpg`). On POSIX,
 * `path.isAbsolute()` is false for those, so the old code joined them onto the
 * repo root and produced a path that can never exist — a false-positive
 * "missing from disk, restore from git" WARN under WSL and macOS.
 *
 * Policy:
 *   - win32: drive paths are absolute; stat them as-is.
 *   - WSL (linux + "microsoft" in /proc/version): translate `D:/x` to
 *     `<automount root>/d/x` (automount root read from /etc/wsl.conf
 *     `[automount] root`, default `/mnt`) and stat that.
 *   - any other POSIX host (macOS, plain Linux): the path is unresolvable on
 *     this platform — report it as foreign so the caller SKIPS the stat
 *     instead of inventing a path that will never exist.
 *
 * The drive-shape detection, wsl.conf parse, and mechanical translation live
 * in `src/core/wsl-paths.ts` (shared with the hook transcript confinement,
 * #4522); this module keeps the doctor-facing policy and re-exports the
 * helpers its tests and callers always imported.
 */
import { join, posix, win32 } from 'node:path';
import {
  WINDOWS_DRIVE_PATH_RE,
  detectWslMountRoot,
  parseWslAutomountRoot,
  translateWindowsPath,
} from '../core/wsl-paths.ts';

export { detectWslMountRoot, parseWslAutomountRoot };

export interface AssetPathResolution {
  /** Absolute path to stat, or null when the path is unresolvable here. */
  abs: string | null;
  /** True when storage_path is a Windows drive path this host cannot stat. */
  foreign: boolean;
}

/**
 * Resolve a files.storage_path to a stat-able absolute path.
 * `opts.platform` / `opts.wslMountRoot` exist for tests; production callers
 * pass neither (process.platform + detected WSL automount root).
 * `wslMountRoot: null` means "not under WSL".
 */
export function resolveAssetPath(
  storagePath: string,
  repoRoot: string,
  opts: { platform?: NodeJS.Platform; wslMountRoot?: string | null } = {},
): AssetPathResolution {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' && WINDOWS_DRIVE_PATH_RE.test(storagePath)) {
    const root = opts.wslMountRoot !== undefined ? opts.wslMountRoot : detectWslMountRoot();
    if (root === null) return { abs: null, foreign: true };
    return { abs: translateWindowsPath(storagePath, root), foreign: false };
  }
  // Platform-appropriate absoluteness (not the host's) so injected-platform
  // tests behave identically everywhere; in production platform === host.
  const isAbs = platform === 'win32' ? win32.isAbsolute(storagePath) : posix.isAbsolute(storagePath);
  return {
    abs: isAbs ? storagePath : join(repoRoot, storagePath),
    foreign: false,
  };
}

/**
 * Resolve an image asset against the source that owns the files row. The
 * global sync.repo_path is only a legacy fallback for rows without source root
 * metadata.
 */
export function resolveImageAssetPath(
  storagePath: string,
  sourceLocalPath: string | null,
  fallbackRepoRoot: string,
): AssetPathResolution {
  return resolveAssetPath(storagePath, sourceLocalPath ?? fallbackRepoRoot);
}
