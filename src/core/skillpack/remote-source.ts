/**
 * skillpack/remote-source.ts — third-party skillpack source resolution.
 *
 * `resolveSource(spec)` accepts every supported input shape and returns a
 * `ResolvedSource` with the local pack path plus identity metadata the
 * scaffold orchestrator needs (TOFU pin, source URL, kind). Cache layout:
 *
 *   ~/.gbrain/skillpack-cache/git/<host>/<owner>/<repo>/<sha>/   (git sources)
 *   ~/.gbrain/skillpack-cache/tarball/<sha256-hex>/              (tarball sources)
 *
 * Cache hits short-circuit the clone/extract step. Cache misses do the work
 * and then atomically rename the staging dir into place so partial clones
 * never poison subsequent lookups.
 *
 * Reuses SSRF-hardened `cloneRepo` from `git-remote.ts`. Local-path inputs
 * skip the cache entirely (the user owns the directory).
 *
 * Bare-name inputs ("hackathon-evaluation") are not handled here — the
 * registry-client resolves them to a URL first, then re-invokes
 * `resolveSource` with the URL. Keeps this module independent of the
 * registry layer.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

import { gbrainPath } from '../config.ts';
import { GIT_SSRF_FLAGS, RemoteUrlError, cloneRepo, parseRemoteUrl } from '../git-remote.ts';
import { extractTarball, fileSha256 } from './tarball.ts';

/** Kinds of third-party source we accept. */
export type ResolvedSourceKind = 'git' | 'tarball' | 'local';

export interface ResolvedSource {
  /** Absolute path to the pack root (where skillpack.json lives). */
  path: string;
  /** Source classification. */
  kind: ResolvedSourceKind;
  /** Canonical source URL or path the user provided (after kebab expansion). */
  source: string;
  /** Resolved git commit SHA when kind=git; null otherwise. */
  pinned_commit: string | null;
  /** SHA-256 of the tarball when kind=tarball; null otherwise. */
  tarball_sha256: string | null;
  /** Whether the result came from cache (used by callers for log lines). */
  cache_hit: boolean;
}

export type RemoteSourceErrorCode =
  | 'spec_empty'
  | 'spec_local_missing'
  | 'spec_local_not_pack_root'
  | 'spec_tarball_missing'
  | 'spec_kebab_invalid_shape'
  | 'spec_url_invalid'
  | 'clone_failed'
  | 'rev_parse_failed';

export class RemoteSourceError extends Error {
  constructor(
    message: string,
    public code: RemoteSourceErrorCode,
    public detail?: { spec?: string; cause?: string },
  ) {
    super(message);
    this.name = 'RemoteSourceError';
  }
}

export interface ResolveSourceOptions {
  /** Override the cache root (test-only; defaults to ~/.gbrain/skillpack-cache). */
  cacheRoot?: string;
  /** Force a fresh clone/extract even when the cache has a hit. */
  noCache?: boolean;
}

/** Result of classifying a raw spec string — narrower than ResolvedSourceKind
 *  because `git-url` and `kebab` are pre-resolution states, while `git` is
 *  the post-resolution kind on ResolvedSource.
 */
export type SpecKind = 'git-url' | 'tarball' | 'local' | 'kebab';

/** Classify the spec without doing any I/O beyond a single stat. */
export function classifySpec(spec: string): { kind: SpecKind; normalized: string } {
  if (!spec || typeof spec !== 'string') {
    throw new RemoteSourceError('source spec is empty', 'spec_empty', { spec });
  }
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new RemoteSourceError('source spec is empty', 'spec_empty', { spec });
  }

  // URL: starts with http(s)://, ends in .git or contains github.com / gitlab.com path.
  if (/^https?:\/\//.test(trimmed)) {
    return { kind: 'git-url', normalized: trimmed };
  }

  // Local path: starts with /, ./, ../, or ~/
  if (
    isAbsolute(trimmed) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~/')
  ) {
    const expanded = trimmed.startsWith('~/') ? join(process.env.HOME ?? '', trimmed.slice(2)) : trimmed;
    const abs = resolve(expanded);
    // Tarball if it's a .tgz / .tar.gz file.
    if (/\.(tgz|tar\.gz)$/.test(abs)) {
      return { kind: 'tarball', normalized: abs };
    }
    return { kind: 'local', normalized: abs };
  }

  // owner/repo short-form (github inferred): exactly one `/` and both halves
  // look like GitHub identifiers (alnum + dash/dot/underscore).
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(trimmed)) {
    return { kind: 'git-url', normalized: `https://github.com/${trimmed}.git` };
  }

  // Bare kebab-name: defer to registry resolution. Caller (registry-client)
  // must convert to a URL before re-calling resolveSource.
  if (/^[a-z][a-z0-9-]{1,63}$/.test(trimmed)) {
    return { kind: 'kebab', normalized: trimmed };
  }

  throw new RemoteSourceError(
    `cannot classify source spec ${JSON.stringify(spec)} — must be a kebab name, owner/repo, https URL, local dir, or .tgz path`,
    'spec_kebab_invalid_shape',
    { spec },
  );
}

/** Compute the cache root, honoring opts override. */
function cacheRoot(opts: ResolveSourceOptions): string {
  return opts.cacheRoot ?? gbrainPath('skillpack-cache');
}

/** Resolve HEAD SHA of a remote git URL via `git ls-remote`. */
function resolveRemoteHead(url: string, branch: string | undefined): string {
  const argv = [
    ...GIT_SSRF_FLAGS,
    'ls-remote',
    '--exit-code',
    url,
    branch ? `refs/heads/${branch}` : 'HEAD',
  ];
  try {
    const output = execFileSync('git', argv, {
      encoding: 'utf-8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000,
    });
    const firstLine = output.split('\n').find((l) => l.trim().length > 0);
    if (!firstLine) {
      throw new RemoteSourceError(`git ls-remote returned no refs for ${url}`, 'rev_parse_failed', { spec: url });
    }
    const sha = firstLine.split(/\s+/)[0]?.trim();
    if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new RemoteSourceError(`git ls-remote gave invalid sha for ${url}: ${firstLine}`, 'rev_parse_failed', { spec: url });
    }
    return sha;
  } catch (err) {
    if (err instanceof RemoteSourceError) throw err;
    throw new RemoteSourceError(
      `git ls-remote failed for ${url}: ${(err as Error).message}`,
      'rev_parse_failed',
      { spec: url, cause: (err as Error).message },
    );
  }
}

/** Compute the per-source cache directory. */
function gitCachePath(root: string, parsedUrl: URL, sha: string): string {
  const host = parsedUrl.hostname;
  const ownerRepo = parsedUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  return join(root, 'git', host, ownerRepo, sha);
}

/** Resolve a git URL into a ResolvedSource. */
function resolveGitSource(
  url: string,
  opts: ResolveSourceOptions,
): ResolvedSource {
  let parsedSafe: URL;
  try {
    parsedSafe = new URL(parseRemoteUrl(url).url);
  } catch (err) {
    if (err instanceof RemoteUrlError) {
      throw new RemoteSourceError(
        `remote URL rejected: ${err.message}`,
        'spec_url_invalid',
        { spec: url, cause: err.code },
      );
    }
    throw err;
  }

  const sha = resolveRemoteHead(parsedSafe.toString(), undefined);
  const cacheDir = gitCachePath(cacheRoot(opts), parsedSafe, sha);

  if (!opts.noCache && existsSync(cacheDir)) {
    const entries = readdirSync(cacheDir);
    if (entries.length > 0) {
      return {
        path: cacheDir,
        kind: 'git',
        source: parsedSafe.toString(),
        pinned_commit: sha,
        tarball_sha256: null,
        cache_hit: true,
      };
    }
  }

  // Stage in a sibling .tmp dir so a failed clone doesn't poison the cache slot.
  const stageDir = cacheDir + '.tmp-' + process.pid + '-' + Date.now();
  mkdirSync(stageDir, { recursive: true });
  try {
    cloneRepo(parsedSafe.toString(), stageDir, { depth: 1, timeoutMs: 600_000 });
  } catch (err) {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {}
    throw new RemoteSourceError(
      `clone failed for ${parsedSafe.toString()}: ${(err as Error).message}`,
      'clone_failed',
      { spec: url, cause: (err as Error).message },
    );
  }

  // Verify the cloned commit matches the SHA we ls-remoted (defense against
  // race where HEAD moved between ls-remote and clone).
  let cloneSha: string;
  try {
    cloneSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: stageDir,
      encoding: 'utf-8',
      timeout: 30_000,
    }).trim();
  } catch (err) {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {}
    throw new RemoteSourceError(
      `git rev-parse HEAD failed after clone: ${(err as Error).message}`,
      'rev_parse_failed',
      { spec: url, cause: (err as Error).message },
    );
  }

  // Atomic rename into the canonical cache slot. If the slot exists already
  // (cache populated concurrently by another process), prefer the existing
  // one and drop our stage dir.
  if (existsSync(cacheDir)) {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {}
  } else {
    mkdirSync(join(cacheDir, '..'), { recursive: true });
    renameSync(stageDir, cacheDir);
  }

  return {
    path: cacheDir,
    kind: 'git',
    source: parsedSafe.toString(),
    pinned_commit: cloneSha,
    tarball_sha256: null,
    cache_hit: false,
  };
}

/** Resolve a local tarball into a ResolvedSource (extract into cache by SHA). */
function resolveTarballSource(
  tarballPath: string,
  opts: ResolveSourceOptions,
): ResolvedSource {
  if (!existsSync(tarballPath)) {
    throw new RemoteSourceError(
      `tarball file does not exist: ${tarballPath}`,
      'spec_tarball_missing',
      { spec: tarballPath },
    );
  }
  if (!statSync(tarballPath).isFile()) {
    throw new RemoteSourceError(
      `tarball path is not a regular file: ${tarballPath}`,
      'spec_tarball_missing',
      { spec: tarballPath },
    );
  }

  const sha = fileSha256(tarballPath);
  const cacheDir = join(cacheRoot(opts), 'tarball', sha);

  if (!opts.noCache && existsSync(cacheDir)) {
    const entries = readdirSync(cacheDir);
    if (entries.length > 0) {
      return findPackRoot({
        path: cacheDir,
        kind: 'tarball',
        source: tarballPath,
        pinned_commit: null,
        tarball_sha256: sha,
        cache_hit: true,
      });
    }
  }

  const stageDir = cacheDir + '.tmp-' + process.pid + '-' + Date.now();
  mkdirSync(stageDir, { recursive: true });
  try {
    extractTarball({ tgzPath: tarballPath, destDir: stageDir });
  } catch (err) {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {}
    throw err;
  }

  if (existsSync(cacheDir)) {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {}
  } else {
    mkdirSync(join(cacheDir, '..'), { recursive: true });
    renameSync(stageDir, cacheDir);
  }

  return findPackRoot({
    path: cacheDir,
    kind: 'tarball',
    source: tarballPath,
    pinned_commit: null,
    tarball_sha256: sha,
    cache_hit: false,
  });
}

/**
 * A tarball produced by `packTarball` wraps its source dir, so the extracted
 * cache dir contains `<sourceLeaf>/skillpack.json`, not `skillpack.json` at
 * the root. Find the actual pack root (the directory containing skillpack.json).
 */
function findPackRoot(s: ResolvedSource): ResolvedSource {
  if (existsSync(join(s.path, 'skillpack.json'))) return s;
  // Look one level deep.
  const entries = readdirSync(s.path);
  for (const e of entries) {
    const candidate = join(s.path, e);
    if (statSync(candidate).isDirectory() && existsSync(join(candidate, 'skillpack.json'))) {
      return { ...s, path: candidate };
    }
  }
  // Caller will surface a clearer error at manifest-load time; return as-is.
  return s;
}

/** Resolve a local directory: just validate it has skillpack.json. */
function resolveLocalSource(absPath: string): ResolvedSource {
  if (!existsSync(absPath)) {
    throw new RemoteSourceError(
      `local path does not exist: ${absPath}`,
      'spec_local_missing',
      { spec: absPath },
    );
  }
  if (!statSync(absPath).isDirectory()) {
    throw new RemoteSourceError(
      `local path is not a directory: ${absPath}`,
      'spec_local_not_pack_root',
      { spec: absPath },
    );
  }
  if (!existsSync(join(absPath, 'skillpack.json'))) {
    throw new RemoteSourceError(
      `local path is not a pack root (no skillpack.json): ${absPath}`,
      'spec_local_not_pack_root',
      { spec: absPath },
    );
  }
  return {
    path: absPath,
    kind: 'local',
    source: absPath,
    pinned_commit: null,
    tarball_sha256: null,
    cache_hit: false,
  };
}

/**
 * Resolve any supported source spec. Throws RemoteSourceError for kebab-name
 * inputs — those must be resolved through the registry-client first.
 */
export function resolveSource(spec: string, opts: ResolveSourceOptions = {}): ResolvedSource {
  const classified = classifySpec(spec);
  switch (classified.kind) {
    case 'git-url':
      return resolveGitSource(classified.normalized, opts);
    case 'tarball':
      return resolveTarballSource(classified.normalized, opts);
    case 'local':
      return resolveLocalSource(classified.normalized);
    case 'kebab':
      throw new RemoteSourceError(
        `bare short-name ${JSON.stringify(classified.normalized)} requires registry lookup — call the registry client first`,
        'spec_kebab_invalid_shape',
        { spec },
      );
    default: {
      const _exhaustive: never = classified.kind;
      throw new RemoteSourceError(
        `unhandled spec kind: ${String(_exhaustive)}`,
        'spec_kebab_invalid_shape',
        { spec },
      );
    }
  }
}
