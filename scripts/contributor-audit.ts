#!/usr/bin/env bun
/**
 * scripts/contributor-audit.ts — mechanical audit of contributor merges and open PRs.
 *
 *   bun run audit:contributors <base>..<head> [--prs <manifest>] [--json]
 *
 * For every first-parent commit in <base>..<head> (each merged PR) and every PR
 * head named in the --prs manifest (trial-merged onto <head>), the driver asks
 * one question: do the tests that change brought fail when its product code is
 * taken away? In an isolated checkout of <head> (or of the trial merge) it:
 *
 *   1. runs the change's test files and requires a green baseline;
 *   2. reverses exactly that change's product hunks (non-test, non-doc):
 *      `git diff --binary M^1 M -- <product files> | git apply -R`, so later
 *      fixes to the same files stay in place (no whole-file revert);
 *   3. re-runs the tests and classifies the run;
 *   4. re-applies the hunks, checks the tree is byte-identical, and re-verifies
 *      green.
 *
 * When the hunks no longer apply at <head> (later commits rewrote them), the
 * merge is audited at its own merge commit instead and the row says so.
 *
 * Results reuse the vocabulary of scripts/check-test-discriminates.sh plus
 * three of their own:
 *   discriminates          tests fail with the product hunks reversed
 *   does_not_discriminate  tests pass with the product hunks reversed
 *   vacuous_failure        non-zero exit but no executed test failed (crash, timeout)
 *   setup_failed           baseline red, install failed, hunks would not reverse,
 *                          or the restored tree did not go green again
 *   conflict               the PR head does not merge cleanly onto <head>
 *   not_audited            nothing to prove (no product change, no tests, none ran)
 * Mechanical results never overwrite human verdicts; those live in a separate
 * verdicts file (accept | rework | reject | not_yet_proven) and print in their
 * own column.
 *
 * Untrusted code (bun install, the tests) runs under `env -i` with an
 * allowlist: a temporary HOME and GBRAIN_HOME, no credential files, and both
 * DATABASE_URL and GBRAIN_DATABASE_URL cleared unless --postgres names a
 * test-shaped database. Lifecycle scripts are skipped (`--ignore-scripts`).
 *
 * Global checks run from THIS checkout (never the audited tree's copy):
 * scripts/wave-security-scan.sh over the range and each PR, and
 * scripts/check-postgres-lane-coverage.ts over <head> and each trial merge.
 *
 * Exit codes:
 *   0    every change discriminates (or changes no product code) and every check passed
 *   1    at least one change or check needs a human look
 *   2    usage or preflight refusal (an agent-contract error envelope)
 *   130  interrupted; finished cases are saved, rerun with --resume
 *
 * Docs: docs/TESTING.md ("Contributor audit"), docs/RELEASING.md (community PR wave).
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Action } from '../src/core/agent-output.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { parseReleasePackage } from '../src/core/bun-floor.ts';
import { opError } from '../src/core/ops/contract.ts';
import { assertSafeE2eDatabaseUrl } from '../test/helpers/db-guard.ts';

const TOOL_ROOT = join(import.meta.dir, '..');
const COMMAND = 'audit:contributors';
const DOCS = 'docs/TESTING.md#contributor-audit';
const STATE_VERSION = 1;

export type Mechanical = 'discriminates' | 'does_not_discriminate' | 'vacuous_failure' | 'setup_failed' | 'conflict' | 'not_audited';
export type HumanVerdict = 'accept' | 'rework' | 'reject' | 'not_yet_proven';
const HUMAN_VERDICTS: readonly HumanVerdict[] = ['accept', 'rework', 'reject', 'not_yet_proven'];

export interface Options {
  range: string; prs?: string; json: boolean; postgres?: string; resume: boolean; runDir?: string;
  stepTimeoutSec: number; verdicts?: string; skipSecurity: boolean; skipLanes: boolean; keepWorktrees: boolean; help: boolean;
}
export interface RunCounts { exit: number; pass: number; fail: number; timedOut: boolean }
export interface CaseResult {
  id: string; kind: 'merge' | 'pr'; sha: string; parent: string; pr?: number; author: string; subject: string;
  result: Mechanical; reason?: string; audited_at?: string; tests: string[]; product_files: number;
  runs: { baseline?: RunCounts; reversed?: RunCounts; restored?: RunCounts };
  lanes?: CheckResult; security?: CheckResult; seconds: number;
}
export interface CheckResult { status: 'pass' | 'review' | 'skipped'; detail: string }
interface PinnedPr { number?: number; head: string; ref?: string }
interface State {
  version: number; base: string; head: string; prs: PinnedPr[];
  cases: Record<string, CaseResult>; checks: { security?: CheckResult; lanes?: CheckResult };
}

const action = (argv: string[], why: string, extra: Partial<Action> = {}): Action =>
  ({ argv, consent: [], actor: 'agent', why, requires_exclusive: false, ...extra });
const helpFix = () => action(['bun', 'run', COMMAND, '--help'], 'Prints every flag, the range form and the exit codes.');

// ── pure helpers (exported for tests) ──────────────────────────────────────

const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const DOC_PATH = /(^|\/)docs\/|\.(md|mdx)$|^llms(-full)?\.txt$/i;
const RUNNABLE_TEST = /\.test\.[cm]?[jt]sx?$/;

export function classifyPath(path: string): 'test' | 'doc' | 'product' {
  if (TEST_PATH.test(path)) return 'test';
  if (DOC_PATH.test(path)) return 'doc';
  return 'product';
}

export function parseCounts(output: string): { pass: number; fail: number } {
  const last = (re: RegExp) => { const all = [...output.matchAll(re)]; return all.length ? Number(all[all.length - 1][1]) : 0; };
  return { pass: last(/^\s*(\d+) pass\b/gm), fail: last(/^\s*(\d+) fail\b/gm) };
}

/** The discrimination verdict for the run with the product hunks reversed. */
export function classifyReversed(run: RunCounts): { result: Mechanical; reason?: string } {
  if (run.timedOut) return { result: 'vacuous_failure', reason: 'timeout' };
  if (run.exit === 0) return { result: 'does_not_discriminate' };
  if (run.fail === 0) return { result: 'vacuous_failure', reason: 'no_test_failed' };
  return { result: 'discriminates' };
}

export function isTestShapedDatabaseUrl(url: string): boolean {
  try { assertSafeE2eDatabaseUrl(url, {}); return true; } catch { return false; }
}

/** The complete environment untrusted code sees. Nothing from the caller's environment passes through. */
export function sandboxEnv(o: { home: string; bunPath: string; cacheDir: string; postgresUrl?: string }): Record<string, string> {
  return {
    PATH: [dirname(o.bunPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: o.home,
    GBRAIN_HOME: join(o.home, '.gbrain'),
    TMPDIR: join(o.home, 'tmp'),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    BUN_INSTALL_CACHE_DIR: o.cacheDir,
    DATABASE_URL: o.postgresUrl ?? '',
    GBRAIN_DATABASE_URL: '',
    ...(o.postgresUrl ? { GBRAIN_TEST_ALLOW_DATABASE_URL: '1' } : {}),
  };
}

export function prNumberFromSubject(subject: string): number | undefined {
  const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

const short = (sha: string) => sha.slice(0, 9);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(state: State, verdicts: Record<string, { verdict?: string; note?: string }>): string {
  const counts = (r?: RunCounts) => r ? `${r.pass}✓/${r.fail}✗${r.timedOut ? ' (timeout)' : ''}` : '–';
  const lines = [
    `## Contributor audit \`${short(state.base)}..${short(state.head)}\``,
    '',
    '| Case | PR | Author | Mechanical | Detail | Baseline → reversed → restored | Lanes | Security | Human verdict |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const c of Object.values(state.cases)) {
    const detail = [c.reason, c.audited_at ? `audited at ${short(c.audited_at)}` : '', c.tests.length ? `${c.tests.length} test file(s)` : ''].filter(Boolean).join('; ');
    const human = verdicts[c.id] ? `${verdicts[c.id].verdict}${verdicts[c.id].note ? `: ${verdicts[c.id].note}` : ''}` : 'pending';
    lines.push(`| ${c.kind} \`${short(c.sha)}\` ${cell(c.subject.slice(0, 60))} | ${c.pr ? `#${c.pr}` : '–'} | ${cell(c.author)} | **${c.result}** | ${cell(detail || '–')} | ${counts(c.runs.baseline)} → ${counts(c.runs.reversed)} → ${counts(c.runs.restored)} | ${c.lanes?.status ?? '–'} | ${c.security?.status ?? '–'} | ${cell(human)} |`);
  }
  const check = (name: string, r?: CheckResult) => `- ${name}: **${r?.status ?? 'not run'}**${r?.detail ? ` (${cell(r.detail)})` : ''}`;
  lines.push('', check('wave-security-scan over the range', state.checks.security), check('check:postgres-lanes at head', state.checks.lanes), '',
    'Mechanical results come from the driver; human verdicts come only from the verdicts file. A green mechanical row is evidence, not acceptance.');
  return lines.join('\n') + '\n';
}

export function exitCodeFor(state: State): 0 | 1 {
  const clean = (c: CaseResult) => c.result === 'discriminates' || (c.result === 'not_audited' && c.reason === 'no_product_change');
  const checkOk = (r?: CheckResult) => !r || r.status !== 'review';
  const casesOk = Object.values(state.cases).every(c => clean(c) && checkOk(c.lanes) && checkOk(c.security));
  return casesOk && checkOk(state.checks.security) && checkOk(state.checks.lanes) ? 0 : 1;
}

const USAGE = `usage: bun run ${COMMAND} <base>..<head> [flags]

Audits every first-parent commit in <base>..<head>, plus each PR head in --prs
trial-merged onto <head>: green baseline, reverse the change's product hunks,
classify, restore, re-verify green.

  --prs <manifest>     JSON {"prs":[{"number":N}|{"head":"<sha>"}|{"ref":"<ref>"}]}; heads are
                       pinned into <run-dir>/prs.pinned.json — pass that file on reruns
  --json               print the report as JSON instead of the Markdown table
  --postgres <url>     run tests with DATABASE_URL=<url>; the database name must be test-shaped
  --resume             keep finished cases from <run-dir>/state.json (same refs and pins only)
  --run-dir <dir>      state, logs and pinned manifest (default: <git-dir>/contributor-audit/<base>-<head>)
  --verdicts <file>    human verdicts {"<case id>":{"verdict":"accept|rework|reject|not_yet_proven","note":"…"}}
                       (default: <run-dir>/verdicts.json when present)
  --step-timeout <s>   per-step timeout in seconds (default 900)
  --skip-security      opt out of wave-security-scan (and the gitleaks preflight)
  --skip-lanes         opt out of check:postgres-lanes
  --keep-worktrees     leave the isolated checkouts on disk for inspection

Exit: 0 clean, 1 needs a human look, 2 usage/preflight refusal, 130 interrupted (rerun with --resume).
Docs: ${DOCS}
`;

export function parseArgs(argv: string[]): Options {
  const o: Options = { range: '', json: false, resume: false, stepTimeoutSec: 900, skipSecurity: false, skipLanes: false, keepWorktrees: false, help: false };
  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw opError('invalid_params', `${flag} needs a value`, `Pass ${flag} followed by its value.`, { why: `${flag} was the last argument or was followed by another flag.`, fix: helpFix() });
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h': o.help = true; break;
      case '--json': o.json = true; break;
      case '--resume': o.resume = true; break;
      case '--skip-security': o.skipSecurity = true; break;
      case '--skip-lanes': o.skipLanes = true; break;
      case '--keep-worktrees': o.keepWorktrees = true; break;
      case '--prs': o.prs = value(i, a); i++; break;
      case '--postgres': o.postgres = value(i, a); i++; break;
      case '--run-dir': o.runDir = value(i, a); i++; break;
      case '--verdicts': o.verdicts = value(i, a); i++; break;
      case '--step-timeout': {
        const n = Number(value(i, a)); i++;
        if (!Number.isInteger(n) || n <= 0) throw opError('invalid_params', `--step-timeout must be a positive whole number of seconds`, 'Pass --step-timeout 900 (or another positive integer).', { why: `Got "${argv[i]}".`, fix: helpFix() });
        o.stepTimeoutSec = n; break;
      }
      default:
        if (a.startsWith('-')) throw opError('unknown_flag', `${COMMAND} does not accept ${a}`, `Drop ${a}; run with --help for the accepted flags.`, { why: 'Unknown flags are refused rather than ignored so a typo never changes what gets audited.', fix: helpFix() });
        if (o.range) throw opError('invalid_params', `only one range is accepted (got "${o.range}" and "${a}")`, 'Pass a single <base>..<head> range.', { why: 'The audit compares one base against one head.', fix: helpFix() });
        o.range = a;
    }
  }
  if (!o.help && !/^[^.\s]+\.\.[^.\s]+$/.test(o.range)) {
    throw opError('invalid_params', o.range ? `range must be <base>..<head> (got "${o.range}")` : 'a <base>..<head> range is required',
      'Pass the range of merges to audit, e.g. the commit before the merge train and origin/master.', {
        why: 'The audit needs both ends of the range to list the merges it re-tests.',
        fix: action(['bun', 'run', COMMAND, '<base>..<head>'], 'Audits every merge between the two refs.', { inputs: [{ name: 'base>..<head', how: 'base = the last commit before the merges to audit; head = usually origin/master' }] }),
      });
  }
  if (o.postgres && !isTestShapedDatabaseUrl(o.postgres)) {
    throw opError('invalid_params', '--postgres must name a test-shaped database', 'Point --postgres at a throwaway database whose name has "test" as a segment (e.g. gbrain_test).', {
      why: 'The audited tests are untrusted and run destructive SQL against whatever database they are given.',
      fix: action(['docker', 'run', '-d', '--name', 'gbrain-audit-pg', '-p', '5435:5432', '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=gbrain_test', 'pgvector/pgvector:pg16'], 'Starts a disposable test-shaped database at postgres://postgres:postgres@localhost:5435/gbrain_test.', { consent: ['persistent_install'] }),
    });
  }
  return o;
}

// ── process + git plumbing ─────────────────────────────────────────────────

class Interrupted extends Error {}
let interrupted = false;
let activeChild: number | undefined;

function git(args: string[], cwd: string, allowFail = false): { ok: boolean; out: string; raw: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const ok = r.status === 0;
  if (!ok && !allowFail) throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  return { ok, out: (r.stdout || '').trim(), raw: r.stdout || '', err: (r.stderr || '').trim() };
}

/** Runs one step in its own process group with output to a log file; kills the group on timeout. */
async function runStep(cmd: string[], o: { cwd: string; env?: Record<string, string>; log: string; timeoutMs: number }): Promise<{ exit: number; timedOut: boolean; output: string }> {
  mkdirSync(dirname(o.log), { recursive: true });
  const fd = openSync(o.log, 'w');
  writeSync(fd, `$ ${o.env ? 'env -i <allowlist> ' : ''}${cmd.join(' ')}\n`);
  const argv = o.env ? ['env', '-i', ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`), ...cmd] : cmd;
  const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, stdio: ['ignore', fd, fd], detached: true });
  activeChild = child.pid;
  let timedOut = false;
  const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
  const exit = await new Promise<number>(res => {
    child.on('exit', (code, signal) => res(code ?? (signal ? 128 : 1)));
    child.on('error', () => res(127));
  });
  clearTimeout(timer);
  kill();
  activeChild = undefined;
  closeSync(fd);
  if (interrupted) throw new Interrupted();
  return { exit, timedOut, output: readFileSync(o.log, 'utf8') };
}

const progress = (msg: string) => process.stderr.write(`[audit] ${msg}\n`);

function refuse(e: unknown, json: boolean): number {
  const r = renderCliError(e, { json, command: COMMAND, tty: false });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return 2;
}

function semverAtLeast(have: string, floor: string): boolean {
  const a = have.split('.').map(Number), b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}

// ── preflight ──────────────────────────────────────────────────────────────

async function preflight(o: Options, repo: string): Promise<{ base: string; head: string; runDir: string; prs: PinnedPr[] }> {
  const resolveRef = (ref: string) => git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], repo, true);
  const [baseRef, headRef] = o.range.split('..');
  for (const ref of [baseRef, headRef]) {
    if (!resolveRef(ref).ok) throw opError('invalid_params', `cannot resolve "${ref}" to a commit`, `Fetch the ref first, then rerun.`, { why: `"${ref}" is not a commit in ${repo}.`, fix: action(['git', 'fetch', 'origin'], 'Brings remote branches and tags into this clone.', { verify: { argv: ['git', 'rev-parse', '--verify', `${ref}^{commit}`] } }) });
  }
  const base = resolveRef(baseRef).out, head = resolveRef(headRef).out;
  if (!git(['merge-base', '--is-ancestor', base, head], repo, true).ok) {
    throw opError('invalid_params', `${baseRef} is not an ancestor of ${headRef}`, 'Swap the ends or pick a base that the head contains.', { why: 'The audit walks the first-parent history from base to head.', fix: helpFix() });
  }
  const pkg = git(['show', `${head}:package.json`], repo, true);
  const floor = pkg.ok ? parseReleasePackage(pkg.out).floor : null;
  if (floor && !semverAtLeast(Bun.version, floor)) {
    throw opError('config_error', `Bun ${Bun.version} is older than the audited tree's floor ${floor}`, 'Upgrade Bun, then rerun.', { why: 'Tests run under an older Bun fail for reasons unrelated to the change and would read as setup failures.', fix: action(['bun', 'upgrade'], 'Installs a Bun that meets engines.bun.', { actor: 'user', consent: ['persistent_install'], verify: { argv: ['bun', '--version'] } }) });
  }
  if (!o.skipSecurity) {
    for (const tool of ['gitleaks', 'python3']) {
      if (spawnSync(tool, ['--version'], { stdio: 'ignore' }).error) {
        throw opError('config_error', `${tool} is not installed; the security scan cannot run`, `Install ${tool}, or rerun with --skip-security to audit without the security scan.`, {
          why: tool === 'gitleaks' ? 'wave-security-scan fails closed without its secrets lane.' : 'wave-security-scan does its pattern checks in python3.',
          fix: action(['brew', 'install', tool], `Installs ${tool} for the wave-security-scan lane.`, { actor: 'user', consent: ['persistent_install'], verify: { argv: [tool, '--version'] } }),
        });
      }
    }
  }
  if (o.postgres) {
    const { default: postgres } = await import('#postgres');
    const sql = postgres(o.postgres, { max: 1, connect_timeout: 5, onnotice: () => {} });
    try { await sql`select 1`; } catch (e) {
      throw opError('config_error', 'the --postgres database is unreachable', 'Start the test database (or fix the URL), then rerun.', { why: `Connecting failed: ${(e instanceof Error ? e.message || (e as { code?: string }).code || e.name : String(e)).replace(/postgres(ql)?:\/\/\S+/g, '<url>')}.`, fix: action(['docker', 'ps'], 'Shows whether the test database container is running.') });
    } finally { await sql.end({ timeout: 1 }); }
  }
  const gitDir = resolve(repo, git(['rev-parse', '--git-common-dir'], repo).out);
  const runDir = resolve(o.runDir ?? join(gitDir, 'contributor-audit', `${short(base)}-${short(head)}`));
  mkdirSync(runDir, { recursive: true });

  const prs: PinnedPr[] = [];
  if (o.prs) {
    let manifest: { prs?: Array<{ number?: number; head?: string; ref?: string }> };
    try { manifest = JSON.parse(readFileSync(o.prs, 'utf8')); } catch (e) {
      throw opError('invalid_params', `cannot read the --prs manifest ${o.prs}`, 'Pass a JSON file shaped {"prs":[{"number":123}]}.', { why: e instanceof Error ? e.message : String(e), fix: helpFix() });
    }
    for (const entry of manifest.prs ?? []) {
      let sha: string | undefined;
      if (entry.head) {
        if (!resolveRef(entry.head).ok && entry.number) git(['fetch', '--no-tags', 'origin', `refs/pull/${entry.number}/head`], repo, true);
        sha = resolveRef(entry.head).ok ? resolveRef(entry.head).out : undefined;
      } else if (entry.ref) {
        sha = resolveRef(entry.ref).ok ? resolveRef(entry.ref).out : undefined;
      } else if (entry.number) {
        progress(`fetching refs/pull/${entry.number}/head`);
        const f = git(['fetch', '--no-tags', 'origin', `refs/pull/${entry.number}/head`], repo, true);
        sha = f.ok ? git(['rev-parse', 'FETCH_HEAD'], repo).out : undefined;
      }
      if (!sha) {
        throw opError('invalid_params', `cannot pin PR entry ${JSON.stringify(entry)}`, 'Check the PR number, ref or head SHA, and that origin is reachable.', { why: 'Every trial merge is pinned to an exact commit so reruns test the same code.', fix: action(['git', 'fetch', 'origin'], 'Brings remote refs into this clone.') });
      }
      prs.push({ ...(entry.number ? { number: entry.number } : {}), ...(entry.ref ? { ref: entry.ref } : {}), head: sha });
    }
    const pinned = join(runDir, 'prs.pinned.json');
    writeJson(pinned, { base, head, prs });
    progress(`pinned ${prs.length} PR head(s) → ${pinned} (pass it as --prs on reruns)`);
  }
  return { base, head, runDir, prs };
}

// ── the driver ─────────────────────────────────────────────────────────────

interface Ctx { o: Options; repo: string; runDir: string; scratch: string; cacheDir: string; head: string; timeoutMs: number }

/** One fresh Bun process per test file (as the unit loop runs them), each in its own throwaway HOME. */
async function runTests(ctx: Ctx, wt: string, tests: string[], log: string): Promise<RunCounts> {
  const total: RunCounts = { exit: 0, pass: 0, fail: 0, timedOut: false };
  for (const [i, test] of tests.entries()) {
    const home = mkdtempSync(join(ctx.scratch, 'home-'));
    mkdirSync(join(home, 'tmp'));
    const env = sandboxEnv({ home, bunPath: process.execPath, cacheDir: ctx.cacheDir, postgresUrl: ctx.o.postgres });
    const fileLog = tests.length === 1 ? log : log.replace(/\.log$/, `.${i + 1}.log`);
    const r = await runStep([process.execPath, '--no-env-file', 'test', '--timeout=60000', `./${test}`], { cwd: wt, env, log: fileLog, timeoutMs: ctx.timeoutMs });
    rmSync(home, { recursive: true, force: true });
    const counts = parseCounts(r.output);
    total.pass += counts.pass;
    total.fail += counts.fail;
    total.timedOut ||= r.timedOut;
    if (total.exit === 0) total.exit = r.exit;
  }
  return total;
}

async function install(ctx: Ctx, wt: string, log: string): Promise<boolean> {
  if (!existsSync(join(wt, 'package.json'))) return true;
  const home = mkdtempSync(join(ctx.scratch, 'home-'));
  mkdirSync(join(home, 'tmp'));
  const env = sandboxEnv({ home, bunPath: process.execPath, cacheDir: ctx.cacheDir });
  const lock = existsSync(join(wt, 'bun.lock')) || existsSync(join(wt, 'bun.lockb'));
  const r = await runStep([process.execPath, 'install', ...(lock ? ['--frozen-lockfile'] : []), '--ignore-scripts'], { cwd: wt, env, log, timeoutMs: ctx.timeoutMs });
  rmSync(home, { recursive: true, force: true });
  return r.exit === 0 && !r.timedOut;
}

function addWorktree(ctx: Ctx, sha: string, name: string): string {
  const wt = join(ctx.scratch, name);
  git(['worktree', 'add', '--detach', '--force', wt, sha], ctx.repo);
  return wt;
}

function removeWorktree(ctx: Ctx, wt: string): void {
  if (ctx.o.keepWorktrees) { progress(`kept worktree ${wt}`); return; }
  git(['worktree', 'remove', '--force', wt], ctx.repo, true);
  rmSync(wt, { recursive: true, force: true });
}

/** Steps 1–4 on a prepared tree; `patchFrom` renders the change's diff limited to the given paths. */
async function discriminate(ctx: Ctx, wt: string, c: CaseResult, files: string[], patchFrom: (paths: string[]) => string, logs: string, step: (s: string) => void): Promise<'reverse_failed' | void> {
  const products = files.filter(f => classifyPath(f) === 'product');
  c.product_files = products.length;
  c.tests = files.filter(f => classifyPath(f) === 'test' && RUNNABLE_TEST.test(f) && !f.includes('fixtures/') && existsSync(join(wt, f)));
  if (!products.length) { c.result = 'not_audited'; c.reason = 'no_product_change'; return; }
  if (!c.tests.length) { c.result = 'not_audited'; c.reason = 'no_tests'; return; }
  const patch = join(logs, 'product.patch');
  writeFileSync(patch, patchFrom(products));
  const lockTouched = products.some(f => /(^|\/)(package\.json|bun\.lockb?)$/.test(f));

  step(`baseline (${c.tests.length} test file(s))`);
  c.runs.baseline = await runTests(ctx, wt, c.tests, join(logs, 'baseline.log'));
  if (c.runs.baseline.exit !== 0 || c.runs.baseline.timedOut) { c.result = 'setup_failed'; c.reason = c.runs.baseline.timedOut ? 'baseline_timeout' : 'baseline_red'; return; }
  if (c.runs.baseline.pass === 0) { c.result = 'not_audited'; c.reason = 'no_tests_ran'; return; }

  step(`reverse ${products.length} product file(s)`);
  if (!git(['apply', '-R', '--binary', patch], wt, true).ok) return 'reverse_failed';
  if (lockTouched && !(await install(ctx, wt, join(logs, 'install-reversed.log')))) { c.result = 'setup_failed'; c.reason = 'install_failed_reversed'; }
  else {
    step('tests with the change reversed');
    c.runs.reversed = await runTests(ctx, wt, c.tests, join(logs, 'reversed.log'));
    Object.assign(c, classifyReversed(c.runs.reversed));
  }

  step('restore and re-verify green');
  const restored = git(['apply', '--binary', patch], wt, true).ok && git(['diff', '--quiet'], wt, true).ok;
  if (!restored) { c.result = 'setup_failed'; c.reason = 'restore_mismatch'; return; }
  if (lockTouched && !(await install(ctx, wt, join(logs, 'install-restored.log')))) { c.result = 'setup_failed'; c.reason = 'install_failed_restored'; return; }
  c.runs.restored = await runTests(ctx, wt, c.tests, join(logs, 'restored.log'));
  if (c.runs.restored.exit !== 0) { c.reason = `restore_red (reversed run said ${c.result})`; c.result = 'setup_failed'; }
}

async function lanesCheck(ctx: Ctx, tree: string, log: string): Promise<CheckResult> {
  if (ctx.o.skipLanes) return { status: 'skipped', detail: '--skip-lanes' };
  const r = await runStep([process.execPath, join(TOOL_ROOT, 'scripts', 'check-postgres-lane-coverage.ts')], {
    cwd: tree, log, timeoutMs: ctx.timeoutMs, env: { ...sandboxEnv({ home: ctx.scratch, bunPath: process.execPath, cacheDir: ctx.cacheDir }), GBRAIN_GUARD_ROOT: tree },
  });
  const summary = r.output.trim().split('\n').filter(l => !l.startsWith('$ ') && /postgres-lane|FAIL/.test(l)).slice(-3).join(' / ');
  return r.exit === 0 ? { status: 'pass', detail: summary } : { status: 'review', detail: `${summary || 'lane check failed'} (log: ${log})` };
}

async function securityCheck(ctx: Ctx, range: string, log: string): Promise<CheckResult> {
  if (ctx.o.skipSecurity) return { status: 'skipped', detail: '--skip-security' };
  const r = await runStep(['bash', join(TOOL_ROOT, 'scripts', 'wave-security-scan.sh'), '--json', range], { cwd: ctx.repo, log, timeoutMs: ctx.timeoutMs });
  const json = r.output.trim().split('\n').reverse().find(l => l.startsWith('{'));
  try {
    const s = JSON.parse(json ?? '') as { gate: string; alarm: number; gitleaks_hits: string; dependency_changed: boolean };
    const detail = `alarm=${s.alarm} gitleaks=${s.gitleaks_hits}${s.dependency_changed ? ' deps changed' : ''}`;
    return { status: s.gate === 'clean' ? 'pass' : 'review', detail };
  } catch { return { status: 'review', detail: `scan exited ${r.exit} without a report (log: ${log})` }; }
}

async function auditMerge(ctx: Ctx, c: CaseResult, headTree: string, logs: string, step: (s: string) => void): Promise<void> {
  const files = git(['diff', '--name-only', '--no-renames', c.parent, c.sha], ctx.repo).out.split('\n').filter(Boolean);
  const patchFrom = (paths: string[]) => git(['diff', '--binary', '--no-renames', c.parent, c.sha, '--', ...paths], ctx.repo).raw;
  c.audited_at = ctx.head;
  if (!git(['diff', '--quiet'], headTree, true).ok) git(['checkout', '--', '.'], headTree);
  if ((await discriminate(ctx, headTree, c, files, patchFrom, logs, step)) !== 'reverse_failed') return;
  step('hunks do not reverse at head; auditing at the merge commit');
  c.runs = {};
  const wt = addWorktree(ctx, c.sha, `at-${short(c.sha)}`);
  try {
    if (!(await install(ctx, wt, join(logs, 'install-at-merge.log')))) { c.result = 'setup_failed'; c.reason = 'install_failed'; return; }
    c.audited_at = c.sha;
    const r = await discriminate(ctx, wt, c, files, patchFrom, logs, step);
    if (r === 'reverse_failed') { c.result = 'setup_failed'; c.reason = 'reverse_failed'; }
  } finally { removeWorktree(ctx, wt); }
}

async function auditPr(ctx: Ctx, c: CaseResult, logs: string, step: (s: string) => void): Promise<void> {
  const wt = addWorktree(ctx, ctx.head, `pr-${short(c.sha)}`);
  try {
    step('trial merge');
    c.audited_at = ctx.head;
    if (git(['merge-base', '--is-ancestor', c.sha, ctx.head], ctx.repo, true).ok) { c.result = 'not_audited'; c.reason = 'already_merged'; return; }
    const m = git(['merge', '--no-ff', '--no-commit', '--no-edit', c.sha], wt, true);
    if (!m.ok) {
      const conflicted = git(['diff', '--name-only', '--diff-filter=U'], wt, true).out.split('\n').filter(Boolean);
      c.result = 'conflict'; c.reason = conflicted.length ? `conflicts in ${conflicted.slice(0, 5).join(', ')}` : m.err.split('\n')[0];
      git(['merge', '--abort'], wt, true);
      return;
    }
    const files = git(['diff', '--cached', '--name-only', '--no-renames', ctx.head], wt).out.split('\n').filter(Boolean);
    if (!(await install(ctx, wt, join(logs, 'install.log')))) { c.result = 'setup_failed'; c.reason = 'install_failed'; return; }
    const patchFrom = (paths: string[]) => git(['diff', '--cached', '--binary', '--no-renames', ctx.head, '--', ...paths], wt).raw;
    if ((await discriminate(ctx, wt, c, files, patchFrom, logs, step)) === 'reverse_failed') { c.result = 'setup_failed'; c.reason = 'reverse_failed'; }
    step('lanes on the trial merge');
    c.lanes = await lanesCheck(ctx, wt, join(logs, 'lanes.log'));
  } finally { removeWorktree(ctx, wt); }
  const mergeBase = git(['merge-base', ctx.head, c.sha], ctx.repo).out;
  step('security scan of the PR commits');
  c.security = await securityCheck(ctx, `${mergeBase}..${c.sha}`, join(logs, 'security.log'));
}

function loadVerdicts(path: string | undefined): Record<string, { verdict?: string; note?: string }> {
  if (!path || !existsSync(path)) return {};
  let raw: Record<string, { verdict?: string; note?: string }>;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    throw opError('invalid_params', `cannot parse the verdicts file ${path}`, 'Fix the JSON: {"<case id>":{"verdict":"accept","note":"…"}}.', { why: e instanceof Error ? e.message : String(e), fix: helpFix() });
  }
  for (const [id, v] of Object.entries(raw)) {
    if (!HUMAN_VERDICTS.includes(v?.verdict as HumanVerdict)) {
      throw opError('invalid_params', `verdict for ${id} must be one of ${HUMAN_VERDICTS.join(', ')}`, `Set "verdict" for ${id} to accept, rework, reject or not_yet_proven.`, { why: `Got ${JSON.stringify(v?.verdict)}.`, fix: helpFix() });
    }
  }
  return raw;
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json');
  let o: Options;
  try { o = parseArgs(argv); } catch (e) { return refuse(e, json); }
  if (o.help) { process.stdout.write(USAGE); return 0; }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return refuse(opError('config_error', 'not inside a git repository', 'Run the audit from the repository whose merges it audits.', { why: 'The range is resolved against the current directory\'s repository.', fix: action(['git', 'rev-parse', '--show-toplevel'], 'Shows which repository the current directory belongs to.') }), json);
  const repo = top.stdout.trim();

  let pre: Awaited<ReturnType<typeof preflight>>;
  let verdicts: Record<string, { verdict?: string; note?: string }>;
  let state: State;
  try {
    pre = await preflight(o, repo);
    const statePath = join(pre.runDir, 'state.json');
    const fresh: State = { version: STATE_VERSION, base: pre.base, head: pre.head, prs: pre.prs, cases: {}, checks: {} };
    state = fresh;
    if (o.resume && existsSync(statePath)) {
      const prev = JSON.parse(readFileSync(statePath, 'utf8')) as State;
      if (prev.version !== STATE_VERSION || prev.base !== pre.base || prev.head !== pre.head || JSON.stringify(prev.prs) !== JSON.stringify(pre.prs)) {
        throw opError('preview_changed', 'the saved run audited different refs or PR pins', 'Rerun with the pinned manifest from the saved run, or drop --resume to start over.', {
          why: `Saved run: ${short(prev.base)}..${short(prev.head)} with ${prev.prs.length} PR(s); this run: ${short(pre.base)}..${short(pre.head)} with ${pre.prs.length}. Mixing them would report results for code that was not tested.`,
          fix: action(['bun', 'run', COMMAND, o.range, '--prs', join(pre.runDir, 'prs.pinned.json'), '--resume'], 'Resumes against the exact PR heads the saved run pinned.'),
        });
      }
      state = prev;
      progress(`resuming: ${Object.keys(prev.cases).length} case(s) already done`);
    } else if (existsSync(statePath)) {
      progress(`starting over; the previous results in ${statePath} are replaced (pass --resume to keep them)`);
    }
    verdicts = loadVerdicts(o.verdicts ?? join(pre.runDir, 'verdicts.json'));
  } catch (e) { return refuse(e, json); }

  const statePath = join(pre.runDir, 'state.json');
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-contributor-audit-'));
  const ctx: Ctx = { o, repo, runDir: pre.runDir, scratch, cacheDir: join(pre.runDir, 'bun-cache'), head: pre.head, timeoutMs: o.stepTimeoutSec * 1000 };
  const onSigint = () => { interrupted = true; if (activeChild) { try { process.kill(-activeChild, 'SIGKILL'); } catch { /* gone */ } } };
  process.on('SIGINT', onSigint);
  const commits = git(['rev-list', '--first-parent', '--reverse', `${pre.base}..${pre.head}`], repo).out.split('\n').filter(Boolean);
  const total = commits.length + pre.prs.length;
  let headTree: string | undefined;
  let n = 0;
  try {
    for (const sha of commits) {
      n++;
      const id = `merge-${short(sha)}`;
      if (state.cases[id]) continue;
      const subject = git(['log', '-1', '--format=%s', sha], repo).out;
      const c: CaseResult = { id, kind: 'merge', sha, parent: git(['rev-parse', `${sha}^1`], repo).out, pr: prNumberFromSubject(subject), author: git(['log', '-1', '--format=%an', git(['rev-parse', '-q', '--verify', `${sha}^2`], repo, true).out || sha], repo).out, subject, result: 'not_audited', tests: [], product_files: 0, runs: {}, seconds: 0 };
      const started = Date.now();
      const step = (s: string) => progress(`(${n}/${total}) ${id}${c.pr ? ` #${c.pr}` : ''}: ${s}`);
      const logs = join(pre.runDir, 'logs', id);
      mkdirSync(logs, { recursive: true });
      if (!headTree) {
        step('preparing the head checkout');
        headTree = addWorktree(ctx, pre.head, 'head');
        if (!(await install(ctx, headTree, join(pre.runDir, 'logs', 'install-head.log')))) {
          c.result = 'setup_failed'; c.reason = 'install_failed_at_head';
        }
      }
      if (c.reason !== 'install_failed_at_head') await auditMerge(ctx, c, headTree, logs, step);
      c.seconds = Math.round((Date.now() - started) / 1000);
      step(`${c.result}${c.reason ? ` (${c.reason})` : ''} in ${c.seconds}s`);
      state.cases[id] = c;
      writeJson(statePath, state);
    }
    for (const pr of pre.prs) {
      n++;
      const id = `pr-${pr.number ?? short(pr.head)}`;
      if (state.cases[id]) continue;
      const subject = git(['log', '-1', '--format=%s', pr.head], repo).out;
      const c: CaseResult = { id, kind: 'pr', sha: pr.head, parent: pre.head, pr: pr.number, author: git(['log', '-1', '--format=%an', pr.head], repo).out, subject, result: 'not_audited', tests: [], product_files: 0, runs: {}, seconds: 0 };
      const started = Date.now();
      const step = (s: string) => progress(`(${n}/${total}) ${id}: ${s}`);
      const logs = join(pre.runDir, 'logs', id);
      mkdirSync(logs, { recursive: true });
      await auditPr(ctx, c, logs, step);
      c.seconds = Math.round((Date.now() - started) / 1000);
      step(`${c.result}${c.reason ? ` (${c.reason})` : ''} in ${c.seconds}s`);
      state.cases[id] = c;
      writeJson(statePath, state);
    }
    if (commits.length && !state.checks.security) {
      progress('wave-security-scan over the range');
      state.checks.security = await securityCheck(ctx, `${pre.base}..${pre.head}`, join(pre.runDir, 'logs', 'security-range.log'));
      writeJson(statePath, state);
    }
    if (!state.checks.lanes) {
      progress('check:postgres-lanes at head');
      headTree ??= addWorktree(ctx, pre.head, 'head');
      state.checks.lanes = await lanesCheck(ctx, headTree, join(pre.runDir, 'logs', 'lanes-head.log'));
      writeJson(statePath, state);
    }
  } catch (e) {
    if (!(e instanceof Interrupted)) throw e;
    progress(`interrupted; ${Object.keys(state.cases).length} finished case(s) saved in ${statePath}. Rerun with --resume.`);
    return 130;
  } finally {
    process.off('SIGINT', onSigint);
    if (headTree) removeWorktree(ctx, headTree);
    git(['worktree', 'prune'], repo, true);
    if (!o.keepWorktrees) rmSync(scratch, { recursive: true, force: true });
  }

  if (o.json) process.stdout.write(JSON.stringify({ ...state, verdicts, run_dir: pre.runDir, exit_code: exitCodeFor(state) }, null, 2) + '\n');
  else process.stdout.write(renderMarkdown(state, verdicts));
  progress(`report: ${statePath}; logs: ${join(pre.runDir, 'logs')}`);
  return exitCodeFor(state);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

