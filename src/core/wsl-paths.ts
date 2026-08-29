/**
 * WSL Windows-drive path translation (shared by doctor asset checks and the
 * hook transcript confinement, #1835 / #4522).
 *
 * A Windows-side writer (a Windows gbrain install, or Claude Code running on
 * the Windows host invoking hooks via `wsl.exe`) hands the Linux side Windows
 * drive literals (`C:\Users\x\file`, `D:/foo/img.jpg`). Inside WSL those are
 * reachable through the automount tree (`/mnt/c/Users/x/file` by default; the
 * root is configurable via /etc/wsl.conf `[automount] root`). This module owns
 * the drive-shape detection, the wsl.conf parse, and the mechanical
 * translation; callers decide policy (skip vs stat vs confine).
 */
import { readFileSync } from 'node:fs';

/** `C:\x`, `C:/x` — a Windows drive-letter absolute path. */
export const WINDOWS_DRIVE_PATH_RE = /^([A-Za-z]):[\\/](.*)$/;

/**
 * Translate a Windows drive literal to its WSL automount form
 * (`C:\Users\x` → `<mountRoot>/c/Users/x`). Returns null when `p` is not a
 * drive-letter path — callers use the null to keep the original untouched.
 */
export function translateWindowsPath(p: string, mountRoot: string): string | null {
  const m = WINDOWS_DRIVE_PATH_RE.exec(p);
  if (!m) return null;
  return `${mountRoot.replace(/\/+$/, '')}/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
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
