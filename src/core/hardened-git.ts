/**
 * Git invocation for directories gbrain does not trust (a user-chosen checkout,
 * a candidate clone): the repository's own configuration must not run code or
 * reach the network. Every call scrubs `GIT_*` from the environment, ignores
 * system and global config, and disables fsmonitor, hooks, the untracked
 * cache, submodule recursion, protocols, credential helpers and automatic
 * maintenance. Arguments are an argv array, never a shell string. Callers
 * bound time and output (`company-brain/revision.ts` streams with its own
 * caps; `hardenedGitSync` takes a timeout and a byte cap).
 *
 * Git has no switch that turns off `filter.<driver>.clean|process` or
 * `diff.<driver>.textconv` from the repository's config, and porcelain such as
 * `status`, `diff`, `show` or `add` runs them whenever it converts working-tree
 * bytes. So only plumbing that never converts content is allowed
 * (`assertHardenedGitArgs`, wave 12 W4.3), and `hardenedPathDirty` answers
 * "is this file changed from HEAD" without `git status`.
 */
import { spawn, spawnSync } from './spawn.ts';
import { lstatSync } from 'node:fs';
import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { join } from 'node:path';
import { envSafeDirectories, gitChildEnv, safeDirectoryEnv } from './git-env.ts';

export const HARDENED_GIT_ARGS: readonly string[] = ['--no-pager', '--no-optional-locks', '--no-replace-objects',
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false',
  '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'credential.helper=',
  '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

const OPERATOR_CONFIG_TTL_MS = 30_000;
let operatorConfig: { key: string; at: number; values: string[] } | null = null;

/**
 * #7584: the `safe.directory` entries in the operator's system and global Git config, in Git's order, read from `/` so no
 * repository's config takes part. Re-read every 30 s, so a running server picks up an edit without a restart.
 */
function operatorConfigSafeDirectories(): string[] {
  const key = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'PATH'].map(name => process.env[name] ?? '').join('\0');
  if (operatorConfig?.key === key && Date.now() - operatorConfig.at < OPERATOR_CONFIG_TTL_MS) return operatorConfig.values;
  const run = spawnSync('git', ['config', '--includes', '--show-scope', '-z', '--get-all', 'safe.directory'],
    { cwd: '/', env: { ...gitChildEnv(), LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
  const fields = run.status === 0 ? run.stdout.toString('utf8').split('\0') : [];
  const values: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (fields[i] === 'system' || fields[i] === 'global') values.push(fields[i + 1]!);
  operatorConfig = { key, at: Date.now(), values };
  return values;
}

export function __resetOperatorGitConfigForTests(): void { operatorConfig = null; }

/**
 * System and global config stay off and every `GIT_*` variable is dropped, except the operator's `safe.directory` entries
 * (system, global, then environment, as Git orders them), carried as environment config (#7584). They relax only Git's
 * ownership check for a repository owned by another user, which the operator allowed for their own `git` too.
 */
export function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', LC_ALL: 'C',
    ...safeDirectoryEnv([...operatorConfigSafeDirectories(), ...envSafeDirectories()]) };
}

export type HardenedGitResult = { ok: true; stdout: Buffer } | { ok: false; reason: 'exit' | 'timeout' | 'too_large' | 'unavailable'; status?: number };

/**
 * The exact options each allowed plumbing subcommand may take; anything not
 * listed here refuses.
 */
const ALLOWED_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['rev-parse', new Set(['--show-toplevel', '--absolute-git-dir', '--verify', '--quiet', '--show-object-format'])],
  ['ls-files', new Set(['-s', '--stage', '--eol', '-z', '--cached', '--others', '--exclude-standard'])],
  ['ls-tree', new Set(['-r', '-l', '-z', '--full-tree'])],
  ['cat-file', new Set(['--batch'])],
  ['hash-object', new Set(['--no-filters', '--stdin-paths'])],
  ['check-attr', new Set(['-z', '--stdin'])],
  ['check-ignore', new Set(['-z', '--stdin'])],
  ['diff-index', new Set(['--cached', '--quiet'])],
  ['diff-tree', new Set(['-r', '-z', '--no-renames'])],
]);

/** Options a subcommand must carry, so its output stays raw and machine-readable. */
const REQUIRED_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['hash-object', ['--no-filters']],
  ['diff-index', ['--cached']],
  ['diff-tree', ['-r', '-z', '--no-renames']],
]);

/**
 * Refuses (throws) any Git invocation that could run a repository-configured
 * clean/process filter or textconv: only the allow-listed plumbing with its
 * exact options before `--`/`--end-of-options`, `hash-object` only under
 * `--no-filters`, `diff-index` only `--cached` and `diff-tree` only as
 * `-r -z --no-renames` (a raw listing: no patch, textconv or rename scoring).
 */
export function assertHardenedGitArgs(args: readonly string[]): void {
  const sub = args[0] ?? '';
  const allowed = ALLOWED_OPTIONS.get(sub);
  const end = args.findIndex(arg => arg === '--' || arg === '--end-of-options');
  const options = args.slice(1, end < 0 ? undefined : end).filter(arg => arg.startsWith('-'));
  const ok = allowed !== undefined && options.every(arg => allowed.has(arg))
    && (REQUIRED_OPTIONS.get(sub) ?? []).every(arg => options.includes(arg));
  if (!ok) throw new Error(`hardened git refuses \`git ${args.slice(0, 2).join(' ')}\`: only filter-free plumbing may run in an untrusted checkout (see src/core/hardened-git.ts)`);
}

/** Runs `git -C <root> <args>` synchronously under the hardening above, within `timeoutMs` and `maxBytes` of stdout. */
export function hardenedGitSync(root: string, args: string[], limits: { timeoutMs: number; maxBytes: number }): HardenedGitResult {
  assertHardenedGitArgs(args);
  const run = spawnSync('git', [...HARDENED_GIT_ARGS, '-C', root, ...args],
    { env: hardenedGitEnvironment(), stdio: ['ignore', 'pipe', 'ignore'], timeout: limits.timeoutMs, maxBuffer: limits.maxBytes, killSignal: 'SIGKILL' });
  const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
  if (code === 'ENOBUFS') return { ok: false, reason: 'too_large' };
  if (run.error) return { ok: false, reason: 'unavailable' };
  if (run.status !== 0) return { ok: false, reason: 'exit', ...(run.status === null ? {} : { status: run.status }) };
  return { ok: true, stdout: run.stdout };
}

export type HardenedGitStreamResult = { ok: true; exitCode: 0; signal: null; bytes: number; endsWithNul: boolean }
  | { ok: false; reason: 'exit' | 'signal' | 'timeout' | 'too_large' | 'unavailable' | 'stalled'; status?: number; signal?: NodeJS.Signals };

/**
 * How long stdout may sit idle after Git exited while it is being read (not held by `onChunk`). Bun can lose the readiness
 * of a child's stdout that turns readable as the child exits (#7053: the one-shot poll fired and was never re-armed, the
 * output and EOF left unread), so `close` never comes; such a run fails as `stalled` instead of waiting forever.
 */
const EXITED_STDOUT_IDLE_MS = 5_000;
export type HardenedGitInput = string | Buffer | Iterable<Buffer | string> | AsyncIterable<Buffer | string>;

/**
 * Runs `git -C <root> <args>` asynchronously under the same hardening and
 * allow-list as `hardenedGitSync`, streaming stdout to `onChunk` (nothing is
 * buffered here) and feeding `stdin` with backpressure. The process is killed
 * with SIGKILL past `timeoutMs` or `maxBytes` of stdout. A throw from
 * `onChunk` or from a `stdin` iterable kills the process and rejects, so a
 * caller never mistakes a run cut short for a finished one. An `onChunk` that
 * returns a promise holds stdout until it settles (a large read yields to the
 * event loop between chunks); a rejection fails the run like a throw.
 */
export function hardenedGitStream(root: string, args: string[],
  opts: { stdin?: HardenedGitInput; timeoutMs: number; maxBytes?: number; onChunk?: (chunk: Buffer) => void | Promise<void> }): Promise<HardenedGitStreamResult> {
  try { assertHardenedGitArgs(args); } catch (error) { return Promise.reject(error); }
  // GBRA-133: not an async function and no callback below names `opts`, so no timer or listener closes over the caller's
  // options, and the chunk handler is dropped once the read settled. Before, an async function's parameters were captured by
  // every callback here: the exited-stdout idle timer kept the caller's `onChunk` (and through it the whole pass that read)
  // reachable for seconds after the read had ended.
  const { stdin, timeoutMs, maxBytes } = opts;
  let onChunk = opts.onChunk;
  return new Promise<HardenedGitStreamResult>((accept, reject) => {
    const child = spawn('git', [...HARDENED_GIT_ARGS, '-C', root, ...args],
      { env: hardenedGitEnvironment(), stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    let bytes = 0;
    let last = -1;
    let stopped: 'timeout' | 'too_large' | undefined;
    let failure: { error: unknown } | undefined;
    let settled = false;
    let exited = false;
    let holding = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: () => void): void => { if (settled) return; settled = true; onChunk = undefined; clearTimeout(timer); clearTimeout(idle); outcome(); };
    const fail = (error: unknown): void => { failure ??= { error }; child.kill('SIGKILL'); };
    const timer = setTimeout(() => { stopped ??= 'timeout'; child.kill('SIGKILL'); }, timeoutMs);
    const watchIdle = (): void => {
      clearTimeout(idle);
      if (exited && !holding) idle = setTimeout(() => settle(() => failure ? reject(failure.error) : accept({ ok: false, reason: stopped ?? 'stalled' })), EXITED_STDOUT_IDLE_MS);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || stopped || failure) return;
      bytes += chunk.length;
      if (maxBytes !== undefined && bytes > maxBytes) { stopped = 'too_large'; child.kill('SIGKILL'); return; }
      last = chunk[chunk.length - 1] ?? last;
      let held: void | Promise<void>;
      try { held = onChunk?.(chunk); } catch (error) { fail(error); return; }
      if (held) { holding = true; child.stdout?.pause(); held.then(() => { holding = false; watchIdle(); child.stdout?.resume(); }, fail); }
      watchIdle();
    });
    child.on('exit', () => { exited = true; watchIdle(); });
    child.on('error', () => { if (child.pid === undefined) settle(() => accept({ ok: false, reason: 'unavailable' })); });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => settle(() => {
      if (failure) reject(failure.error);
      else if (stopped) accept({ ok: false, reason: stopped });
      else if (signal) accept({ ok: false, reason: 'signal', signal });
      else if (code !== 0) accept({ ok: false, reason: 'exit', ...(code === null ? {} : { status: code }) });
      else accept({ ok: true, exitCode: 0, signal: null, bytes, endsWithNul: last === 0 });
    }));
    if (stdin !== undefined && child.stdin) void feedStdin(child.stdin, stdin, fail);
  });
}

async function feedStdin(stdin: Writable, input: HardenedGitInput, fail: (error: unknown) => void): Promise<void> {
  stdin.on('error', () => {});
  if (typeof input === 'string' || Buffer.isBuffer(input)) { stdin.end(input); return; }
  try {
    for await (const piece of input) {
      if (stdin.destroyed) return;
      if (!stdin.write(piece)) await once(stdin, 'drain');
    }
    stdin.end();
  } catch (error) {
    if (stdin.destroyed) return;
    fail(error);
  }
}

/**
 * Splits a NUL-terminated record stream (`-z` output) into complete records
 * across chunk boundaries; bytes after the last NUL wait for the next chunk.
 */
export class NulRecordSplitter {
  private pending: Buffer[] = [];
  push(chunk: Buffer): Buffer[] {
    const records: Buffer[] = [];
    let start = 0;
    for (let end = chunk.indexOf(0); end >= 0; end = chunk.indexOf(0, start)) {
      const piece = chunk.subarray(start, end);
      records.push(this.pending.length === 0 ? piece : Buffer.concat([...this.pending, piece]));
      this.pending = [];
      start = end + 1;
    }
    if (start < chunk.length) this.pending.push(chunk.subarray(start));
    return records;
  }
  /** Whether every byte pushed so far belongs to a NUL-terminated record (true before any byte). */
  get atRecordBoundary(): boolean { return this.pending.length === 0; }
}

/**
 * The completeness rule for a `-z` read: Git exited 0, was not signalled,
 * and its output ended exactly at a NUL (an empty output is complete). Any
 * other read may be truncated and must not be trusted for absence.
 */
export function hardenedStreamComplete(result: HardenedGitStreamResult): boolean {
  return result.ok && (result.bytes === 0 || result.endsWithNul);
}

const PATH_LIMITS = { timeoutMs: 10_000, maxBytes: 1024 * 1024 };

/**
 * Whether `rel` (repository-relative, `/`-separated) differs from HEAD the
 * way `git status --porcelain -- <rel>` would report it, computed from
 * filter-free plumbing: untracked and not ignored, staged (index differs from
 * HEAD, or unborn HEAD), or working-tree bytes differ from the index blob.
 * `null` when Git cannot say without running repository code or reading
 * config: a conversion attribute (`filter`, `text`, `eol`,
 * `working-tree-encoding`), CRLF working-tree bytes (`core.autocrlf`), a
 * symlink or gitlink, an executable-bit-only difference (`core.filemode`), or
 * any Git failure.
 */
export function hardenedPathDirty(root: string, rel: string): boolean | null {
  const pathspec = `:(literal)${rel}`;
  const indexed = hardenedGitSync(root, ['ls-files', '-s', '--eol', '-z', '--', pathspec], PATH_LIMITS);
  if (!indexed.ok) return null;
  const entry = indexed.stdout.toString('utf8').split('\0')[0];
  if (!entry) {
    const untracked = hardenedGitSync(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', pathspec], PATH_LIMITS);
    return untracked.ok ? untracked.stdout.length > 0 : null;
  }
  const [meta = '', eolInfo = ''] = entry.split('\t');
  const [mode, blob, stage] = meta.split(' ');
  const worktreeEol = eolInfo.trim().split(/\s+/)[1];
  if (!mode || !blob || !stage) return null;
  if (stage !== '0') return true;
  if (mode !== '100644' && mode !== '100755') return null;
  const head = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], PATH_LIMITS);
  if (!head.ok) return head.reason === 'exit' && head.status === 1 ? true : null;
  const staged = hardenedGitSync(root, ['diff-index', '--cached', '--quiet', 'HEAD', '--', pathspec], PATH_LIMITS);
  if (!staged.ok) return staged.reason === 'exit' && staged.status === 1 ? true : null;
  const hashed = hardenedGitSync(root, ['hash-object', '--no-filters', '--', rel], PATH_LIMITS);
  if (!hashed.ok) return null;
  let executable: boolean;
  try { executable = (lstatSync(join(root, ...rel.split('/'))).mode & 0o111) !== 0; } catch { return null; }
  if (hashed.stdout.toString('utf8').trim() === blob) return executable === (mode === '100755') ? false : null;
  if (worktreeEol === 'w/crlf' || worktreeEol === 'w/mixed') return null;
  const attrs = hardenedGitSync(root, ['check-attr', '-z', 'filter', 'text', 'eol', 'working-tree-encoding', '--', rel], PATH_LIMITS);
  if (!attrs.ok) return null;
  const values = attrs.stdout.toString('utf8').split('\0').filter((_, i) => i % 3 === 2);
  return values.every(value => value === 'unspecified' || value === 'unset') ? true : null;
}
