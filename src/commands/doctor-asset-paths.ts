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
 * Kept in its own module (not doctor.ts) so the pure tests don't pull the
 * 7k-line doctor dep graph, and so open PRs rewriting the image_assets block
 * (e.g. a `resolveImageAssetPath` helper) can adopt it with a one-line call.
 */
import { readFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

const WINDOWS_DRIVE_RE = /^([A-Za-z]):[\\/](.*)$/;

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
  if (platform !== 'win32') {
    const m = WINDOWS_DRIVE_RE.exec(storagePath);
    if (m) {
      const root = opts.wslMountRoot !== undefined ? opts.wslMountRoot : detectWslMountRoot();
      if (root === null) return { abs: null, foreign: true };
      const abs = `${root.replace(/\/+$/, '')}/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
      return { abs, foreign: false };
    }
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
 * Extract the `[automount] root` value from /etc/wsl.conf content.
 * Defaults to `/mnt` (WSL's own default) when absent/unparseable.
 */
export function parseWslAutomountRoot(conf: string): string {
  let inAutomount = false;
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim();
    if (line.startsWith('[')) {
      inAutomount = /^\[automount\]$/i.test(line);
      continue;
    }
    if (!inAutomount) continue;
    const m = /^root\s*=\s*"?([^"]+?)"?\s*$/.exec(line);
    if (m) return m[1];
  }
  return '/mnt';
}

let cachedWslMountRoot: string | null | undefined;

/**
 * Detect the WSL Windows-drive automount root. Returns null when not running
 * under WSL (including macOS and plain Linux). Memoized per process.
 */
export function detectWslMountRoot(): string | null {
  if (cachedWslMountRoot === undefined) cachedWslMountRoot = computeWslMountRoot();
  return cachedWslMountRoot;
}

function computeWslMountRoot(): string | null {
  if (process.platform !== 'linux') return null;
  try {
    // The standard WSL tell: kernel version string names Microsoft.
    if (!/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return null;
  } catch {
    return null;
  }
  try {
    return parseWslAutomountRoot(readFileSync('/etc/wsl.conf', 'utf8'));
  } catch {
    return '/mnt'; // WSL default when wsl.conf is absent.
  }
}
