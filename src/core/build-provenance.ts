import { which } from 'bun';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

declare const __GBRAIN_BUILD_COMMIT__: string | undefined;

const GIT_SHA1_RE = /^[a-f0-9]{40}$/;
const BUN_TAG_RE = /^(.+)-gbrain-([a-f0-9]{7,40})$/;
const GITHUB_OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const CACHE_NAME = '.gbrain-build-commit';
let buildCommitForTests: string | null = null;
let resolvedBuildCommit: string | null = null;

type FetchCommit = (url: string) => Promise<Response>;

function fetchGitHubCommit(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gbrain-build-provenance',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

function assertExactCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_SHA1_RE.test(value)) {
    throw new Error(`${label} is not an exact lowercase Git SHA-1`);
  }
}

function safeProcessEnvironment(gitDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      !name.startsWith('GIT_')
      && !name.startsWith('DYLD_')
      && name !== 'LD_PRELOAD'
      && name !== 'LD_LIBRARY_PATH'
      && name !== 'BUN_OPTIONS'
      && name !== 'NODE_OPTIONS'
    ) {
      env[name] = value;
    }
  }
  return {
    ...env,
    PATH: process.platform === 'win32' ? `${gitDirectory};C:\\Windows\\System32` : `${gitDirectory}:/usr/bin:/bin`,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function protectedExecutable(candidate: string, label: string): string {
  const executable = realpathSync(candidate);
  const stat = lstatSync(executable);
  if (!stat.isFile()) throw new Error(`${label} is not a regular executable: ${executable}`);
  if (process.platform !== 'win32') {
    const trustedOwner = stat.uid === 0 || stat.uid === process.getuid?.();
    if (!trustedOwner || (stat.mode & 0o022) !== 0) {
      throw new Error(`${label} is not a protected executable: ${executable}`);
    }
  }
  return executable;
}

function protectedGitCandidate(): string {
  const windowsRoots = ['C:\\Program Files', 'C:\\Program Files (x86)'];
  const systemCandidates = process.platform === 'win32'
    ? windowsRoots.flatMap((root) => [
      join(root, 'Git', 'cmd', 'git.exe'),
      join(root, 'Git', 'bin', 'git.exe'),
    ])
    : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  const candidate = systemCandidates.find((path) => {
    try { return lstatSync(path).isFile(); } catch { return false; }
  }) ?? (process.platform === 'win32' ? null : which('git'));
  if (!candidate) throw new Error('Git is required to verify a source checkout');
  return candidate;
}

function runGit(root: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, ['-C', root, ...args], {
    encoding: 'utf8',
    env: safeProcessEnvironment(dirname(executable)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Git exited with status ${result.status ?? 1}`);
  }
  return result.stdout.trim();
}

export function resolveSourceCheckoutCommit(packageRoot: string, gitCandidate?: string): string {
  const candidate = gitCandidate ?? protectedGitCandidate();
  const executable = protectedExecutable(candidate, 'Git');
  const status = runGit(packageRoot, executable, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') {
    throw new Error('create_page requires a clean source checkout for exact build provenance');
  }
  const commit = runGit(packageRoot, executable, ['rev-parse', '--verify', 'HEAD^{commit}']);
  assertExactCommit(commit, 'source checkout commit');
  return commit;
}

interface InstalledCommitCache {
  owner: string;
  short_commit: string;
  commit: string;
}

function readCachedCommit(packageRoot: string, owner: string, shortCommit: string): string | null {
  const path = join(packageRoot, CACHE_NAME);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('installed build commit cache is not a regular file');
  if (process.platform !== 'win32') {
    const trustedOwner = stat.uid === 0 || stat.uid === process.getuid?.();
    if (!trustedOwner || (stat.mode & 0o022) !== 0) {
      throw new Error('installed build commit cache is not protected');
    }
  }
  const cached = JSON.parse(readFileSync(path, 'utf8')) as Partial<InstalledCommitCache>;
  if (cached.owner !== owner || cached.short_commit !== shortCommit) return null;
  assertExactCommit(cached.commit, 'cached installed build commit');
  if (!cached.commit.startsWith(shortCommit)) {
    throw new Error('cached installed build commit does not match its Bun tag');
  }
  return cached.commit;
}

function cacheCommit(packageRoot: string, cached: InstalledCommitCache): void {
  const path = join(packageRoot, CACHE_NAME);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(cached)}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    rmSync(temporary, { force: true });
  }
}

export async function resolveInstalledBuildCommit(
  packageRoot: string,
  fetchCommit: FetchCommit = fetchGitHubCommit,
): Promise<string> {
  const tag = readFileSync(join(packageRoot, '.bun-tag'), 'utf8').trim();
  const match = tag.match(BUN_TAG_RE);
  if (!match) throw new Error('Bun install lacks a verifiable GitHub commit tag');
  const [, owner, shortCommit] = match;
  if (!GITHUB_OWNER_RE.test(owner)) {
    throw new Error('Bun install has an invalid GitHub owner');
  }
  const cached = readCachedCommit(packageRoot, owner, shortCommit);
  if (cached) return cached;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/gbrain/commits/${shortCommit}`;
  const response = await fetchCommit(url);
  if (!response.ok) throw new Error(`GitHub could not resolve installed commit (${response.status})`);
  const body = await response.json() as { sha?: unknown };
  assertExactCommit(body.sha, 'GitHub installed build commit');
  if (!body.sha.startsWith(shortCommit)) {
    throw new Error('GitHub commit does not match the installed Bun tag');
  }
  cacheCommit(packageRoot, { owner, short_commit: shortCommit, commit: body.sha });
  return body.sha;
}

export function __setServerBuildCommitForTests(commit: string | null): void {
  if (commit !== null) assertExactCommit(commit, 'test server build commit');
  buildCommitForTests = commit;
  resolvedBuildCommit = null;
}

export async function serverBuildCommit(): Promise<string> {
  const embedded = typeof __GBRAIN_BUILD_COMMIT__ === 'string'
    ? __GBRAIN_BUILD_COMMIT__
    : undefined;
  if (embedded !== undefined) {
    assertExactCommit(embedded, 'compile-time server build commit');
    return embedded;
  }
  if (buildCommitForTests !== null) return buildCommitForTests;
  if (resolvedBuildCommit !== null) return resolvedBuildCommit;

  const packageRoot = resolve(import.meta.dir, '../..');
  const commit = existsSync(join(packageRoot, '.git'))
    ? resolveSourceCheckoutCommit(packageRoot)
    : await resolveInstalledBuildCommit(packageRoot);
  resolvedBuildCommit = commit;
  return commit;
}
