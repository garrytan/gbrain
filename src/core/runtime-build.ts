/**
 * #7245: the build a long-running foresights process runs, next to the build its
 * install holds on disk now. A process keeps the code it loaded at start, so
 * after a checkout reset or an upgrade on disk its `VERSION` (in memory) and
 * the `package.json` beside the code it loaded (on disk) differ until it
 * restarts, and every `jobs run-child` it spawns from that install runs the
 * newer code. `install_root` is local-only evidence: it names a filesystem
 * path, so no remote-facing output carries it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.ts';

const VERSION_PATTERN = /^\d+(?:\.\d+){2,3}$/;

/** The package root this process loaded its code from; null when it has no readable package.json there (a compiled binary). */
export function runtimeInstallRoot(): string | null {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    return existsSync(join(root, 'package.json')) ? root : null;
  } catch {
    return null;
  }
}

/** The foresights version installed at `root` now, read from disk; null when unknown or unreadable. */
export function installedVersion(root: string | null | undefined): string | null {
  if (!root) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
    return pkg.name === 'gbrain' && typeof pkg.version === 'string' && VERSION_PATTERN.test(pkg.version) ? pkg.version : null;
  } catch {
    return null;
  }
}

export interface ServeBuild {
  version: string;
  /** The version the install this process loaded from holds on disk now; null when unknown. */
  installed_version: string | null;
  /** The install on disk moved to another build since this process started. */
  restart_pending: boolean;
}

const BUILD_CACHE_MS = 10_000;
let cached: { at: number; build: ServeBuild } | null = null;

/** This process's build for `/health`: versions only, never a path. The disk read is cached for 10 s. */
export function serveBuild(now: number = Date.now()): ServeBuild {
  if (cached && now - cached.at < BUILD_CACHE_MS) return cached.build;
  const installed = installedVersion(runtimeInstallRoot());
  const build = { version: VERSION, installed_version: installed, restart_pending: installed !== null && installed !== VERSION };
  cached = { at: now, build };
  return build;
}
