#!/usr/bin/env bun
/**
 * Rust engine census: every CLI command and every MCP tool, run on a Rust brain and on a PGLite brain (and a Postgres
 * brain when GBRAIN_CENSUS_PG_URL names a server), on the same synthetic fixture, compared value for value.
 *
 *   bun run rust:build
 *   bun scripts/rust-census/census.ts [--only cli|mcp] [--filter <substring>] [--concurrency N] [--work-dir DIR]
 *        [--out docs/research/rust-census.md] [--json docs/research/rust-census.json] [--no-member] [--composition <text>]
 *   bun scripts/rust-census/census.ts --from-json docs/research/rust-census.json   (re-render the report and packages only)
 *  The report also counts hidden refusals: equal rows that log a refusal a fail-soft path caught (see hiddenRefusals).
 *   GBRAIN_CENSUS_PG_URL=postgres://postgres:postgres@127.0.0.1:5439/postgres  (optional Postgres arm)
 *
 * How it works:
 *  - Seeds one base brain per arm through the real CLI (src/cli.ts): `import <fixture> --no-embed`, then
 *    `extract all --source db`. The fixture is test/fixtures/rust-cli-parity-brain (20 synthetic pages). When a Rust
 *    setup step fails, a third brain, the mirror (PGLite with only the steps Rust completed), becomes the reference.
 *  - Runs every case in scripts/rust-census/cases.ts on a fresh copy of each base brain (Postgres: a database made
 *    from the base as a template), so writes never leak between cases. Each MCP tool runs through a real stdio
 *    `gbrain serve` (remote caller) on a fresh copy too.
 *  - The member-caller pass (scripts/rust-census/member-pass.ts; off with --no-member) runs every MCP tool again
 *    through `serve --stdio-member`, on base copies where `access member add` and `access owner set` made a live
 *    member with a group. Its results are the member column and section; they are not in the totals.
 *  - On the Rust arm the child loads scripts/rust-census/trace-preload.ts, which records the first capability
 *    refusal (capability, member, call site file:line) and every engine member and raw-SQL statement the case hit.
 *  - Keyless and isolated: HOME and GBRAIN_HOME point at the case directory, provider keys and DATABASE_URL are
 *    removed from the child environment. Nothing reads or writes a real brain.
 *
 * Status per case (Rust compared with the reference brain, PGLite or the mirror):
 *   equal    same exit code and the same JSON after normalising clocks, ids, uuids and temp paths
 *   differs  both ran, the answers differ (a queued write, a fail-soft read that swallowed a refusal, other JSON)
 *   refused  Rust ended on the typed engine_capability_missing refusal
 *   crash    Rust died (signal, timeout, panic) or failed with an untyped error where the reference succeeded
 *   skipped  the case is not run (cases.ts says why)
 *
 * The report's generated part sits between the GENERATED markers in --out; text outside them is kept.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { CLI_CASES, MCP_OVERRIDES, MCP_PARAM_FILL, type CliCase } from './cases.ts';
import { buildPackages, renderPackages } from './packages.ts';
import { firstDiff, maskedExcerpt, normalize, type FirstDiff } from './normalize.ts';
import { MEMBER_SERVE_ARGS, MEMBER_SETUP, memberCell, optionRefusals, renderMemberPass, type MemberResult } from './member-pass.ts';

const ROOT = resolve(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const PRELOAD = join(import.meta.dir, 'trace-preload.ts');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'rust-cli-parity-brain');
const TARGET = detectAddonTarget();
const ADDON = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON ?? (TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY = flag('--only');
const FILTER = flag('--filter');
const CONCURRENCY = Number(flag('--concurrency') ?? 6);
const OUT_MD = resolve(flag('--out') ?? join(ROOT, 'docs', 'research', 'rust-census.md'));
const OUT_JSON = resolve(flag('--json') ?? join(ROOT, 'docs', 'research', 'rust-census.json'));
const PG_URL = process.env.GBRAIN_CENSUS_PG_URL;
const TIMEOUT_MS = Number(flag('--timeout-ms') ?? 120_000);
/** --no-member skips the member-caller pass; --composition names a tree that is not one commit (written to the meta). */
const NO_MEMBER = process.argv.includes('--no-member');
const COMPOSITION = flag('--composition');

if (!flag('--from-json') && (!ADDON || !existsSync(ADDON))) throw new Error(`the Rust addon ${ADDON || '(no target)'} does not exist; run bun run rust:build`);

type Arm = 'pglite' | 'rust' | 'postgres' | 'mirror';
interface Brain { arm: Arm; dir: string; home: string; db: string; url?: string }
interface Run { exitCode: number; signal: string | null; stdout: string; stderr: string; timedOut: boolean; ms: number; censusRef?: number }
interface Refusal { seq?: number; capability: string; member: string; site: string; frames: string[] }
interface Trace { first?: Refusal; all: Refusal[]; bySeq: Map<number, Refusal>; refusals: number; members: string[]; raw: Array<{ member: string; sql: string; site: string }> }
type Status = 'equal' | 'differs' | 'refused' | 'crash' | 'skipped';
interface Row {
  surface: 'cli' | 'mcp';
  name: string;          // command or tool name
  invocation: string;    // the args (cli) or the JSON params (mcp)
  status: Status;
  pgStatus?: Status;     // Postgres compared with PGLite, when the arm ran
  refExit?: number;
  rustExit?: number;
  decisive?: string;     // the member named by the refusal the command ended on
  endSite?: string;      // where that refusal was raised (first frame outside the Rust shell)
  first?: Refusal;       // the first refusal the run built (caught or not)
  sites?: string[];      // every distinct refusal the run built, as member@site, in order (caught or not)
  refusals?: number;
  members?: string[];
  raw?: Array<{ member: string; sql: string; site: string }>;
  note: string;
  /** The first 600 characters of each arm's output (JSON report only), for reading a differs row without a rerun. */
  rustExcerpt?: string;
  refExcerpt?: string;
  /** The Postgres arm's output the same way, when the arm ran. */
  pgExcerpt?: string;
  /** Where Rust (rustDiff) and Postgres (pgDiff) first differ from the reference, on a row that is not equal. */
  rustDiff?: FirstDiff;
  pgDiff?: FirstDiff;
  /** MCP: the run's "(option X)" refusals (member-pass.ts optionRefusals), minus the serve's startup refusals. */
  options?: string[];
  /** MCP: the same tool for the member caller (member-pass.ts); never counted in the totals. */
  member?: MemberResult;
}

const work = flag('--work-dir') ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'gbrain-census-'));
mkdirSync(work, { recursive: true });

// ---- child processes -----------------------------------------------------------------------------------------

function childEnv(brain: Brain, trace?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  for (const k of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON|GBRAIN_CENSUS_PG_URL|GBRAIN_SURFACE)$/.test(k)) delete out[k];
    if (/(_API_KEY|_API_TOKEN|_SECRET)(__|$)/.test(k)) delete out[k];
    if (/^(OPENAI|ANTHROPIC|VOYAGE|OPENROUTER|GROQ|GEMINI|GOOGLE|SLACK|CAPY|EXA)_/.test(k)) delete out[k];
  }
  return {
    ...out,
    HOME: brain.home, GBRAIN_HOME: brain.home, TZ: 'UTC',
    GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_NO_TELEMETRY: '1',
    ...(brain.arm === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
    ...(trace ? { GBRAIN_CENSUS_TRACE: trace } : {}),
  };
}

async function spawnCli(brain: Brain, args: string[], opts: { trace?: string; stdin?: string; cwd?: string } = {}): Promise<Run> {
  const started = Date.now();
  const cmd = ['bun', ...(opts.trace ? ['--preload', PRELOAD] : []), CLI, ...args];
  const proc = Bun.spawn(cmd, { cwd: opts.cwd ?? brain.dir, env: childEnv(brain, opts.trace), stdin: opts.stdin !== undefined ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (opts.stdin !== undefined) { proc.stdin!.write(opts.stdin); proc.stdin!.end(); }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return takeCensusRef({ exitCode, signal: proc.signalCode ?? null, stdout, stderr, timedOut, ms: Date.now() - started });
}

/**
 * The tracer tags each refusal's detail with ` census_ref=<seq>`. The first tag in the output names the refusal that
 * reached the caller (not one a fail-soft path caught); the tag is then stripped so outputs compare as the user sees them.
 */
const CENSUS_REF = / census_ref=(\d+)/g;
function takeCensusRef<R extends Run & { response?: any }>(run: R): R {
  const m = / census_ref=(\d+)/.exec(run.stdout + '\n' + run.stderr);
  if (!m) return run;
  const strip = (x: string) => x.replace(CENSUS_REF, '');
  return { ...run, censusRef: Number(m[1]), stdout: strip(run.stdout), stderr: strip(run.stderr),
    ...(run.response ? { response: JSON.parse(strip(JSON.stringify(run.response))) } : {}) };
}

/** One MCP tools/call through a real stdio `gbrain serve` (remote caller), then stdin closes. */
async function mcpCall(brain: Brain, method: string, params: Record<string, unknown>, trace?: string, serveArgs: readonly string[] = []): Promise<Run & { response?: any }> {
  const started = Date.now();
  const cmd = ['bun', ...(trace ? ['--preload', PRELOAD] : []), CLI, 'serve', ...serveArgs];
  // GBRAIN_NO_ONBOARD_NUDGE: at boot `serve` starts the onboarding refresher (src/mcp/server.ts), whose first check
  // loads the active schema pack into the pack cache. It races the tools/call on every engine, so reload_schema_pack
  // answered [gbrain-base] or [] by timing alone. Turning the refresher off makes MCP rows depend on the call only.
  const env = { ...childEnv(brain, trace), GBRAIN_NO_ONBOARD_NUDGE: '1' };
  const proc = Bun.spawn(cmd, { cwd: brain.dir, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const send = (msg: unknown) => { proc.stdin!.write(JSON.stringify(msg) + '\n'); proc.stdin!.flush?.(); };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-rust-census', version: '1' } } });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, TIMEOUT_MS);
  const stderrP = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let all = '';
  let response: any;
  let sent = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      buf += chunk; all += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && !sent) {
          sent = true;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method, params });
        } else if (msg.id === 2) { response = msg; }
      }
      if (response) break;
    }
  } catch { /* the process died; the run says how */ }
  try { proc.stdin!.end(); } catch { /* closed */ }
  const killer = setTimeout(() => proc.kill('SIGKILL'), 15_000);
  const exitCode = await proc.exited;
  clearTimeout(killer); clearTimeout(timer);
  return takeCensusRef({ exitCode, signal: proc.signalCode ?? null, stdout: all, stderr: await stderrP, timedOut, ms: Date.now() - started, response });
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, n) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!, i); }
  }));
  return out;
}

// ---- brains --------------------------------------------------------------------------------------------------

async function pgExec(sql: string): Promise<void> {
  const { default: postgres } = await import('#postgres');
  const db = postgres(PG_URL!, { max: 1, onnotice: () => undefined });
  try { await db.unsafe(sql); } finally { await db.end(); }
}

function writeConfig(brain: Brain): void {
  mkdirSync(join(brain.home, '.gbrain'), { recursive: true });
  const cfg = brain.arm === 'postgres' ? { engine: 'postgres', database_url: brain.url } : { engine: brain.arm === 'mirror' ? 'pglite' : brain.arm, database_path: brain.db };
  writeFileSync(join(brain.home, '.gbrain', 'config.json'), JSON.stringify(cfg));
}

function newBrain(arm: Arm, dir: string, url?: string): Brain {
  const b: Brain = { arm, dir, home: join(dir, 'home'), db: join(dir, 'db'), url };
  mkdirSync(b.dir, { recursive: true });
  writeConfig(b);
  return b;
}

let pgSeq = 0;
/** A fresh copy of a base brain for one case. */
async function cloneBrain(base: Brain, dir: string): Promise<Brain> {
  mkdirSync(dir, { recursive: true });
  if (base.arm === 'postgres') {
    const name = `census_case_${process.pid}_${++pgSeq}`;
    await pgExec(`CREATE DATABASE ${name} TEMPLATE ${dbName(base.url!)}`);
    const b = newBrain('postgres', dir, withDb(PG_URL!, name));
    return b;
  }
  // Stale owner/resolve sockets a finished `serve` left behind cannot be copied and belong to no case.
  const filter = (src: string) => !lstatSync(src).isSocket();
  cpSync(base.home, join(dir, 'home'), { recursive: true, filter });
  if (existsSync(base.db)) cpSync(base.db, join(dir, 'db'), { recursive: true, filter });
  const b: Brain = { arm: base.arm, dir, home: join(dir, 'home'), db: join(dir, 'db') };
  writeConfig(b);
  return b;
}

async function dropBrain(b: Brain): Promise<void> {
  if (b.arm === 'postgres' && b.url) await pgExec(`DROP DATABASE IF EXISTS ${dbName(b.url)} WITH (FORCE)`).catch(() => undefined);
  rmSync(b.dir, { recursive: true, force: true });
}

const dbName = (url: string) => new URL(url).pathname.replace(/^\//, '');
const withDb = (url: string, name: string) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };

/** A git repository holding the fixture, for sync / sources cases. */
function makeRepo(dir: string): string {
  const repo = join(dir, 'repo');
  cpSync(FIXTURE, repo, { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'census', GIT_AUTHOR_EMAIL: 'census@example.com', GIT_COMMITTER_NAME: 'census', GIT_COMMITTER_EMAIL: 'census@example.com', GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture');
  return repo;
}

// ---- normalising and comparing ---------------------------------------------------------------------------------

function parseOut(text: string): unknown {
  const t = text.trim();
  if (!t) return '';
  try { return JSON.parse(t); } catch { /* not one document */ }
  const lines = t.split('\n').filter((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
  if (lines.length) { try { return JSON.parse(lines[lines.length - 1]!); } catch { /* text */ } }
  return t.split('\n').map((l) => l.trimEnd()).filter((l) => !/^\[gbrain notice|^\s*$/.test(l)).join('\n');
}

const pathsOf = (b: Brain): Array<[string, string]> => [[b.db, '<db>'], [b.home, '<home>'], [b.dir, '<case>'], [work, '<work>'], [ROOT, '<root>']];

const REFUSAL_TEXT = /engine_capability_missing|does not support (\S+) yet \(it needs the (\w+) capability\)/;
function decisiveMember(run: Run): string | null {
  const text = run.stdout + '\n' + run.stderr;
  if (!REFUSAL_TEXT.test(text)) return null;
  return memberOf(text);
}

/** The refused member as the error names it, with its option when the member is served but the option is not. */
function memberOf(text: string): string {
  return /member=(.+?) capability=/.exec(text)?.[1] ?? /does not support (.+?) yet \(it needs/.exec(text)?.[1] ?? 'unknown';
}

function readTrace(file: string): Trace {
  const t: Trace = { all: [], bySeq: new Map(), refusals: 0, members: [], raw: [] };
  if (!existsSync(file)) return t;
  const members = new Set<string>();
  const callSite = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (r.kind === 'call') {
      members.add(r.member);
      if (!callSite.has(r.member)) callSite.set(r.member, siteOf(r.frames ?? []));
      if (r.sql) t.raw.push({ member: r.member, sql: r.sql, site: siteOf(r.frames ?? []) });
    } else if (r.kind === 'refusal') {
      t.refusals++;
      // A refusal raised after an await inside the shell has only shell frames; the member's call record names the caller.
      let site = siteOf(r.frames ?? []);
      const base = String(r.member).replace(/ \(.*$/, '');
      if (site.startsWith('src/core/rust-engine') && callSite.get(base) && !callSite.get(base)!.startsWith('src/core/rust-engine')) site = callSite.get(base)!;
      const ref = { seq: typeof r.seq === 'number' ? r.seq : undefined, capability: r.capability, member: String(r.member), site, frames: r.frames ?? [] };
      if (ref.seq !== undefined) t.bySeq.set(ref.seq, ref);
      if (!t.first) t.first = ref;
      if (!t.all.some((x) => x.member === ref.member && x.site === ref.site)) t.all.push(ref);
    }
  }
  t.members = [...members].sort();
  return t;
}

/** The site of the refusal that reached the output (its census_ref tag), else the last refusal of that member. */
function endSiteOf(t: Trace, member?: string, ref?: number): string | undefined {
  if (ref !== undefined && t.bySeq.has(ref)) return t.bySeq.get(ref)!.site;
  if (!member) return undefined;
  const hit = [...t.all].reverse().find((x) => x.member === member);
  return hit ? hit.site : undefined;
}

/** The first frame outside the Rust engine shell: the code that asked for the refused member. */
function siteOf(frames: string[]): string {
  return frames.find((f) => !f.startsWith('src/core/rust-engine.ts') && !f.startsWith('src/core/rust-engine/')) ?? frames[0] ?? '';
}

const PANIC = /panicked at|"code":\s*"internal_error"|Segmentation fault|SIGSEGV|RuntimeError: unreachable/;
/** A timeout, a signal, or panic text the reference run does not also print (`gbrain errors` lists internal_error). */
function crashed(run: Run, ref?: Run): string | null {
  if (run.timedOut) return `timeout after ${TIMEOUT_MS} ms`;
  if (run.signal) return `signal ${run.signal}`;
  const m = PANIC.exec(run.stderr + run.stdout);
  if (m && !(ref && (ref.stderr + ref.stdout).includes(m[0]))) return `panic or native error (${m[0]})`;
  return null;
}

function snippet(run: Run): string {
  const body = parseOut(run.stdout);
  const pick = (o: any) => (o && typeof o === 'object' ? (o.code ?? o.error ?? o.status ?? '') : '');
  const err = (run.stderr.split('\n').find((l) => /error|Error|refus/.test(l)) ?? '').trim();
  return [pick(body), typeof body === 'object' ? (body as any)?.message ?? '' : String(body).slice(0, 160), err.slice(0, 160)].filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 240);
}

function excerpt(run: Run, b: Brain): string {
  return maskedExcerpt(run.stdout.trim() || run.stderr.trim(), pathsOf(b));
}

function classify(ref: { exit: number; out: unknown }, rust: Run, rustOut: unknown, refRun: Run): { status: Status; note: string; decisive?: string } {
  const crash = crashed(rust, refRun);
  if (crash) return { status: 'crash', note: crash };
  const same = rust.exitCode === ref.exit && JSON.stringify(rustOut) === JSON.stringify(ref.out);
  if (same) return { status: 'equal', note: ref.exit === 0 ? '' : `both exit ${ref.exit}` };
  const decisive = decisiveMember(rust);
  if (decisive && rust.exitCode !== 0) return { status: 'refused', note: '', decisive };
  const body = parseOut(rust.stdout) as any;
  if (rust.exitCode === 10 && body?.code === 'write_pending') return { status: 'differs', note: `queued: write_pending (state ${body?.write_request?.state ?? '?'}), never applied` };
  if (rust.exitCode !== 0 && refRun.exitCode === 0) {
    // A named error code is a wrong answer, not a crash; only an error with no code counts as a crash.
    if (typeof body?.code === 'string') return { status: 'differs', note: `error ${body.code} (exit ${rust.exitCode}) where the reference succeeded: ${snippet(rust)}` };
    return { status: 'crash', note: `untyped error, exit ${rust.exitCode}: ${snippet(rust)}` };
  }
  return { status: 'differs', note: `exit ${rust.exitCode} vs ${ref.exit}${decisive ? `; output quotes refusal ${decisive}` : ''}` };
}

// ---- cases -----------------------------------------------------------------------------------------------------

function expand(args: string[], dir: string, repo: string): string[] {
  return args.map((a) => a.replaceAll('{fixture}', FIXTURE).replaceAll('{repo}', repo).replaceAll('{tmp}', join(dir, 'scratch')).replaceAll('{uuid}', randomUUID()));
}
const labelOf = (args: string[]) => args.map((a) => (a === FIXTURE ? '<fixture>' : /[\s"]/.test(a) ? JSON.stringify(a.length > 60 ? a.slice(0, 57) + '...' : a) : a)).join(' ');

interface Bases { ref: Brain; rust: Brain; pg?: Brain; pglite: Brain; useMirror: boolean }

async function runCliCase(cs: CliCase, i: number, bases: Bases): Promise<Row> {
  const label = labelOf(cs.args);
  if (cs.skip) return { surface: 'cli', name: cs.cmd, invocation: label, status: 'skipped', note: cs.skip };
  const caseDir = join(work, 'cases', `cli-${i}`);
  const arms = { ref: bases.ref, rust: bases.rust, ...(bases.pg ? { pg: bases.pg } : {}) } as Record<string, Brain>;
  const clones: Record<string, Brain> = {};
  for (const [k, b] of Object.entries(arms)) clones[k] = await cloneBrain(b, join(caseDir, k));
  const trace = join(caseDir, 'rust-trace.jsonl');
  const runs: Record<string, Run> = {};
  const beforeFailed: string[] = [];
  await Promise.all(Object.entries(clones).map(async ([k, b]) => {
    const repo = makeRepo(b.dir); mkdirSync(join(b.dir, 'scratch'), { recursive: true });
    for (const step of cs.before ?? []) {
      const r = await spawnCli(b, expand(step.slice(), b.dir, repo));
      if (r.exitCode !== 0) beforeFailed.push(`${k}: before step \`${labelOf(step)}\` exited ${r.exitCode}`);
    }
    runs[k] = await spawnCli(b, expand(cs.args.slice(), b.dir, repo), { trace: k === 'rust' ? trace : undefined, stdin: cs.stdin });
  }));
  const refOut = normalize(parseOut(runs.ref!.stdout), pathsOf(clones.ref!));
  const rustOut = normalize(parseOut(runs.rust!.stdout), pathsOf(clones.rust!));
  const verdict = classify({ exit: runs.ref!.exitCode, out: refOut }, runs.rust!, rustOut, runs.ref!);
  const t = readTrace(trace);
  let pgStatus: Status | undefined; let pgDiff: FirstDiff | undefined; let pgExcerpt: string | undefined;
  if (runs.pg) {
    const pgOut = normalize(parseOut(runs.pg.stdout), pathsOf(clones.pg!));
    pgStatus = crashed(runs.pg, runs.ref!) ? 'crash' : runs.pg.exitCode === runs.ref!.exitCode && JSON.stringify(pgOut) === JSON.stringify(refOut) ? 'equal' : 'differs';
    pgExcerpt = excerpt(runs.pg, clones.pg!);
    pgDiff = firstDiff({ exit: runs.ref!.exitCode, out: refOut }, { exit: runs.pg.exitCode, out: pgOut }) ?? undefined;
  }
  const rustDiff = verdict.status === 'equal' ? undefined : firstDiff({ exit: runs.ref!.exitCode, out: refOut }, { exit: runs.rust!.exitCode, out: rustOut }) ?? undefined;
  for (const b of Object.values(clones)) await dropBrain(b);
  rmSync(caseDir, { recursive: true, force: true });
  return { surface: 'cli', name: cs.cmd, invocation: label, status: verdict.status, pgStatus, refExit: runs.ref!.exitCode, rustExit: runs.rust!.exitCode,
    decisive: verdict.decisive, endSite: endSiteOf(t, verdict.decisive, runs.rust!.censusRef), first: t.first, sites: t.all.slice(0, 40).map((x) => `${x.member}@${x.site}`), refusals: t.refusals, members: t.members, raw: t.raw,
    rustExcerpt: excerpt(runs.rust!, clones.rust!), refExcerpt: excerpt(runs.ref!, clones.ref!), pgExcerpt, rustDiff, pgDiff,
    note: [...beforeFailed.sort(), verdict.note, verdict.status !== 'equal' && runs.ref!.exitCode !== 0 ? `reference exit ${runs.ref!.exitCode}: ${snippet(runs.ref!)}` : ''].filter(Boolean).join('; ') };
}

function fillParams(tool: { name: string; inputSchema?: any }): Record<string, unknown> {
  if (MCP_OVERRIDES[tool.name]) return MCP_OVERRIDES[tool.name]!;
  const required: string[] = tool.inputSchema?.required ?? [];
  const props = tool.inputSchema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const name of required) {
    if (name in MCP_PARAM_FILL) out[name] = MCP_PARAM_FILL[name];
    else {
      const p = props[name] ?? {};
      out[name] = p.enum?.[0] ?? (p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? false : p.type === 'array' ? [] : p.type === 'object' ? {} : 'census');
    }
  }
  return out;
}

function mcpOut(r: Run & { response?: any }): { exit: number; out: unknown; text: string } {
  if (!r.response) return { exit: -1, out: `no response (exit ${r.exitCode})`, text: r.stderr.slice(-400) };
  if (r.response.error) return { exit: 2, out: { jsonrpc_error: r.response.error.code, message: r.response.error.message }, text: JSON.stringify(r.response.error) };
  const res = r.response.result ?? {};
  const text = (res.content ?? []).map((c: any) => c.text ?? '').join('\n');
  return { exit: res.isError ? 1 : 0, out: { isError: !!res.isError, body: parseOut(text) }, text };
}

/** The refusals the anonymous `serve` builds at startup (the anonymous pass's baseline; hiddenRefusals and --from-json read it). */
const SERVE_BASELINE = new Set<string>();

/** One MCP caller: its base brains, its serve arguments and the refusals its serve builds at startup (not counted per tool). */
interface McpPass { tag: string; bases: Bases; serveArgs: readonly string[]; baseline: Set<string>; baselineRaw: Set<string> }

async function runMcpTool(tool: { name: string; inputSchema?: any }, i: number, pass: McpPass): Promise<Row> {
  const { bases, serveArgs, baseline: startup, baselineRaw: startupRaw } = pass;
  const params = fillParams(tool);
  const caseDir = join(work, 'cases', `mcp${pass.tag}-${i}`);
  const arms = { ref: bases.ref, rust: bases.rust, ...(bases.pg ? { pg: bases.pg } : {}) } as Record<string, Brain>;
  const clones: Record<string, Brain> = {};
  for (const [k, b] of Object.entries(arms)) clones[k] = await cloneBrain(b, join(caseDir, k));
  const trace = join(caseDir, 'rust-trace.jsonl');
  const runs: Record<string, Run & { response?: any }> = {};
  await Promise.all(Object.entries(clones).map(async ([k, b]) => {
    runs[k] = await mcpCall(b, 'tools/call', { name: tool.name, arguments: params }, k === 'rust' ? trace : undefined, serveArgs);
  }));
  const ref = mcpOut(runs.ref!), rust = mcpOut(runs.rust!);
  const refN = normalize(ref.out, pathsOf(clones.ref!)), rustN = normalize(rust.out, pathsOf(clones.rust!));
  const t = readTrace(trace);
  // Refusals every `serve` builds before the call (startup, notifier) are listed once in Setup, not per tool.
  t.first = t.all.find((x) => !startup.has(`${x.member}@${x.site}`));
  t.raw = t.raw.filter((x) => !startupRaw.has(`${x.member}@${x.site}`));
  t.refusals = t.all.filter((x) => !startup.has(`${x.member}@${x.site}`)).length;
  let status: Status; let note = ''; let decisive: string | undefined;
  const crash = crashed(runs.rust!, runs.ref!) ?? (rust.exit === -1 ? `no MCP response: ${rust.text.replace(/\s+/g, ' ').slice(-200)}` : null);
  if (crash) { status = 'crash'; note = crash; }
  else if (rust.exit === ref.exit && JSON.stringify(rustN) === JSON.stringify(refN)) { status = 'equal'; note = ref.exit ? 'both isError' : ''; }
  else if (REFUSAL_TEXT.test(rust.text) && rust.exit !== 0) { status = 'refused'; decisive = memberOf(rust.text); }
  else if (/write_pending/.test(rust.text)) { status = 'differs'; note = 'queued: write_pending, never applied'; }
  else if (rust.exit !== 0 && ref.exit === 0) {
    const code = (rust.out as any)?.body?.code;
    if (typeof code === 'string') { status = 'differs'; note = `error ${code} where the reference succeeded`; }
    else { status = 'crash'; note = `untyped error: ${rust.text.replace(/\s+/g, ' ').slice(0, 200)}`; }
  }
  else { status = 'differs'; note = `isError ${rust.exit} vs ${ref.exit}`; }
  if (status !== 'equal' && ref.exit !== 0) note = [note, `reference isError: ${ref.text.replace(/\s+/g, ' ').slice(0, 160)}`].filter(Boolean).join('; ');
  let pgStatus: Status | undefined; let pgDiff: FirstDiff | undefined; let pgExcerpt: string | undefined;
  if (runs.pg) {
    const pg = mcpOut(runs.pg); const pgN = normalize(pg.out, pathsOf(clones.pg!));
    pgStatus = pg.exit === -1 ? 'crash' : pg.exit === ref.exit && JSON.stringify(pgN) === JSON.stringify(refN) ? 'equal' : 'differs';
    pgExcerpt = maskedExcerpt(pg.text, pathsOf(clones.pg!));
    pgDiff = firstDiff({ exit: ref.exit, out: refN }, { exit: pg.exit, out: pgN }) ?? undefined;
  }
  const rustDiff = status === 'equal' ? undefined : firstDiff({ exit: ref.exit, out: refN }, { exit: rust.exit, out: rustN }) ?? undefined;
  for (const b of Object.values(clones)) await dropBrain(b);
  rmSync(caseDir, { recursive: true, force: true });
  const options = optionRefusals(t.all.filter((x) => !startup.has(`${x.member}@${x.site}`)).map((x) => `${x.member}@${x.site}`));
  return { surface: 'mcp', name: tool.name, invocation: JSON.stringify(params).slice(0, 120), status, pgStatus, refExit: ref.exit, rustExit: rust.exit, decisive, endSite: endSiteOf(t, decisive, runs.rust!.censusRef), first: t.first, sites: t.all.slice(0, 40).map((x) => `${x.member}@${x.site}`), refusals: t.refusals, members: t.members, raw: t.raw, note, options,
    rustExcerpt: maskedExcerpt(rust.text, pathsOf(clones.rust!)), refExcerpt: maskedExcerpt(ref.text, pathsOf(clones.ref!)), pgExcerpt, rustDiff, pgDiff };
}

// ---- report ----------------------------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Hidden refusals: rows that show equal but log one or more refusal sites. A fail-soft path caught each refusal, so
 * the answer matched, but the Rust arm took a fallback there. MCP rows leave out the refusals every `serve` builds at
 * startup (Setup lists them once). Sites rank by impact as packages.ts scores a package (10 per hot case, 1 per other case).
 */
interface HiddenSite { site: string; score: number; rows: number; hot: string[]; cases: string[] }
function hiddenRefusals(rows: Row[]): { rows: Row[]; sites: HiddenSite[] } {
  const sitesOf = (r: Row) => [...new Set((r.sites ?? []).filter((x) => r.surface !== 'mcp' || !SERVE_BASELINE.has(x)))];
  const hidden = rows.filter((r) => r.status === 'equal' && sitesOf(r).length > 0);
  const bySite = new Map<string, Row[]>();
  for (const r of hidden) for (const x of sitesOf(r)) bySite.set(x, [...(bySite.get(x) ?? []), r]);
  const sites = [...bySite].map(([site, rs]): HiddenSite => {
    const at = site.lastIndexOf('@');
    const asRefused = rs.map((r) => ({ ...r, status: 'refused' as const, decisive: site.slice(0, at), endSite: site.slice(at + 1), sites: undefined }));
    const pkg = buildPackages(asRefused, ROOT)[0]!;
    return { site, score: pkg.score, rows: rs.length, hot: pkg.hot, cases: pkg.cases };
  }).sort((a, b) => b.score - a.score || b.rows - a.rows || a.site.localeCompare(b.site));
  return { rows: hidden, sites };
}

/** The one-line summary (also the line other lanes quote): rows, rows per surface, distinct sites. */
function hiddenLine(h: { rows: Row[]; sites: HiddenSite[] }): string {
  const by = (surface: string) => h.rows.filter((r) => r.surface === surface).length;
  return `Hidden refusals: ${h.rows.length} equal rows (cli ${by('cli')}, mcp ${by('mcp')}) log ${h.sites.length} distinct refusal sites; serve startup refusals are not counted.`;
}

function report(rows: Row[], setup: string[], meta: Record<string, string>, tools: number, cliCommands: string[], memberSetup: string[] = []): string {
  const count = (surface: string, s: Status) => rows.filter((r) => r.surface === surface && r.status === s).length;
  const lines: string[] = [];
  lines.push('<!-- BEGIN GENERATED census (scripts/rust-census/census.ts; do not edit by hand) -->', '');
  lines.push('## Run', '', ...Object.entries(meta).map(([k, v]) => `- ${k}: ${v}`), '', '### Setup', '', ...setup.map((s) => `- ${s}`), '');
  lines.push('## Totals', '', '| surface | cases | equal | differs | refused | crash | skipped |', '|---|---|---|---|---|---|---|');
  for (const s of ['cli', 'mcp']) {
    const n = rows.filter((r) => r.surface === s).length;
    lines.push(`| ${s} | ${n} | ${count(s, 'equal')} | ${count(s, 'differs')} | ${count(s, 'refused')} | ${count(s, 'crash')} | ${count(s, 'skipped')} |`);
  }
  lines.push('', `CLI commands covered: ${new Set(rows.filter((r) => r.surface === 'cli').map((r) => r.name)).size} of ${cliCommands.length}. MCP tools covered: ${rows.filter((r) => r.surface === 'mcp').length} of ${tools}.`, '');
  const uncovered = cliCommands.filter((c) => !rows.some((r) => r.surface === 'cli' && r.name === c));
  if (uncovered.length) lines.push(`CLI commands with no case: ${uncovered.join(', ')}`, '');
  const hidden = hiddenRefusals(rows);
  lines.push(hiddenLine(hidden), '');

  lines.push(renderPackages(buildPackages(rows, ROOT)));

  // failure clusters: the decisive member (else the first refusal), with the call site
  const fails = rows.filter((r) => r.status !== 'equal' && r.status !== 'skipped');
  const key = (r: Row) => r.decisive ?? r.first?.member ?? (r.status === 'crash' ? `crash: ${r.note.slice(0, 60)}` : 'no refusal traced');
  const clusters = new Map<string, Row[]>();
  for (const r of fails) clusters.set(key(r), [...(clusters.get(key(r)) ?? []), r]);
  lines.push('## Failure clusters (by the member the case ended on, else its first refusal)', '', '| member | cases | capability | call sites | cases (surface:name) |', '|---|---|---|---|---|');
  for (const [k, rs] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const caps = [...new Set(rs.map((r) => r.first?.capability).filter(Boolean))].join(', ');
    const sites = [...new Set(rs.map((r) => r.first?.site).filter(Boolean))].slice(0, 4).join(', ');
    lines.push(`| ${esc(k)} | ${rs.length} | ${caps} | ${esc(sites)} | ${esc(rs.map((r) => `${r.surface}:${r.name}`).filter((v, i, a) => a.indexOf(v) === i).join(', '))} |`);
  }
  lines.push('');
  lines.push('## Hidden refusals (equal rows that log a refusal site, by impact)', '',
    'A fail-soft path caught the refusal, so the answer matched, but Rust took a fallback there. Score: 10 per hot case, 1 per other case.', '',
    '| refusal site | score | equal rows | hot cases | cases (surface:name) |', '|---|---|---|---|---|');
  for (const h of hidden.sites) lines.push(`| ${esc(h.site)} | ${h.score} | ${h.rows} | ${h.hot.length} | ${esc(h.cases.join(', '))} |`);
  lines.push('');
  for (const s of ['cli', 'mcp'] as const) {
    const memberCol = s === 'mcp' && rows.some((r) => r.member);
    lines.push(`## ${s === 'cli' ? 'CLI commands' : 'MCP tools'}`, '', `| ${s === 'cli' ? 'invocation' : 'tool (params)'} | status | pg | first refusal (capability, member, site) | ended on | members / raw SQL hit | note |${memberCol ? ' member caller |' : ''}`, `|---|---|---|---|---|---|---|${memberCol ? '---|' : ''}`);
    for (const r of rows.filter((x) => x.surface === s)) {
      const first = r.first ? `${r.first.capability}: ${r.first.member} @ ${r.first.site}` : '';
      const raw = (r.raw ?? []).map((x) => `${x.member} \`${x.sql.slice(0, 70)}\` @ ${x.site}`).join('; ');
      const members = (r.members ?? []).filter((m) => !/^(connect|disconnect|reconnect|kind|capabilities|registerBeforeDisconnect)$/.test(m));
      const hit = [members.length ? members.slice(0, 12).join(', ') + (members.length > 12 ? ` (+${members.length - 12})` : '') : '', raw].filter(Boolean).join(' / ');
      const inv = s === 'cli' ? r.invocation : `${r.name} ${r.invocation}`;
      lines.push(`| ${esc(inv)} | ${r.status} | ${r.pgStatus ?? ''} | ${esc(first)} | ${esc(r.decisive ? `${r.decisive}${r.endSite ? ` @ ${r.endSite}` : ''}` : '')} | ${esc(hit)} | ${esc(r.note)} |${memberCol ? ` ${esc(memberCell(r))} |` : ''}`);
    }
    lines.push('');
  }
  if (rows.some((r) => r.surface === 'mcp')) lines.push(renderMemberPass(rows, memberSetup));
  lines.push('<!-- END GENERATED census -->');
  return lines.join('\n');
}

function writeReport(generated: string): void {
  const head = '# Rust engine census\n\nEvery CLI command and MCP tool on a Rust brain, compared with PGLite (and Postgres). Regenerate with\n`bun run rust:build && bun scripts/rust-census/census.ts`; the part between the GENERATED markers is rewritten.\n\n';
  const old = existsSync(OUT_MD) ? readFileSync(OUT_MD, 'utf8') : head;
  const b = old.indexOf('<!-- BEGIN GENERATED census'), e = old.indexOf('<!-- END GENERATED census -->');
  const next = b >= 0 && e > b ? old.slice(0, b) + generated + old.slice(e + '<!-- END GENERATED census -->'.length) : old.trimEnd() + '\n\n' + generated + '\n';
  writeFileSync(OUT_MD, next);
}

// ---- main ------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const from = flag('--from-json');
  if (from) {
    const d = JSON.parse(readFileSync(resolve(from), 'utf8'));
    for (const x of d.serveBaseline ?? []) SERVE_BASELINE.add(x);
    d.packages = buildPackages(d.rows, ROOT);
    d.hidden = hiddenRefusals(d.rows).sites;
    writeFileSync(OUT_JSON, JSON.stringify(d, null, 1) + '\n');
    writeReport(report(d.rows, d.setup, d.meta, d.tools.length, d.cliCommands, d.memberSetup ?? []));
    if (!flag('--work-dir')) rmSync(work, { recursive: true, force: true });
    process.stderr.write(`[census] re-rendered ${OUT_MD} from ${from}\n`);
    return;
  }
  const t0 = Date.now();
  const base = join(work, 'base');
  const pglite = newBrain('pglite', join(base, 'pglite'));
  const rust = newBrain('rust', join(base, 'rust'));
  let pg: Brain | undefined;
  if (PG_URL) {
    const name = `census_base_${process.pid}`;
    await pgExec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await pgExec(`CREATE DATABASE ${name}`);
    pg = newBrain('postgres', join(base, 'postgres'), withDb(PG_URL, name));
  }
  const SETUP = [['import', FIXTURE, '--no-embed', '--json'], ['extract', 'all', '--source', 'db', '--json']];
  const setup: string[] = [];
  const rustDone: string[][] = [];
  let useMirror = false;
  for (const args of SETUP) {
    const [p, r, q] = await Promise.all([spawnCli(pglite, args), spawnCli(rust, args), pg ? spawnCli(pg, args) : Promise.resolve(null)]);
    if (p.exitCode !== 0) throw new Error(`PGLite setup ${labelOf(args)} failed: ${p.stdout}\n${p.stderr}`);
    if (q && q.exitCode !== 0) throw new Error(`Postgres setup ${labelOf(args)} failed: ${q.stdout}\n${q.stderr}`);
    if (r.exitCode === 0) rustDone.push(args); else useMirror = true;
    setup.push(`${labelOf(args)}: pglite exit ${p.exitCode}, rust exit ${r.exitCode}${r.exitCode ? ` (${decisiveMember(r) ?? snippet(r)})` : ''}${q ? `, postgres exit ${q.exitCode}` : ''}`);
  }
  let ref = pglite;
  if (useMirror) {
    ref = newBrain('mirror', join(base, 'mirror'));
    for (const args of rustDone) await spawnCli(ref, args);
    setup.push('a Rust setup step failed: the reference is the mirror (PGLite with only the steps Rust completed)');
  }
  const bases: Bases = { ref, rust, pg, pglite, useMirror };

  // MCP tool list from the reference brain's stdio server (full surface). Each baseline `serve` runs on a throwaway
  // copy: stdin closes while serve may still be registering its local writers, and a registration cut short there
  // must not ride into the base brains every case is copied from.
  const baselineOf = async (b: Brain, name: string, trace?: string, serveArgs: readonly string[] = []) => {
    const copy = await cloneBrain(b, join(work, `baseline-${name}`));
    try { return await mcpCall(copy, 'tools/list', {}, trace, serveArgs); } finally { await dropBrain(copy); }
  };
  const list = await baselineOf(ref, 'ref');
  const tools: Array<{ name: string; inputSchema?: any }> = list.response?.result?.tools ?? [];
  if (!tools.length) throw new Error(`tools/list returned no tools: ${list.stderr.slice(-500)}`);
  const anon: McpPass = { tag: '', bases, serveArgs: [], baseline: SERVE_BASELINE, baselineRaw: new Set() };
  const baseTrace = join(work, 'serve-baseline.jsonl');
  const rustList = await baselineOf(rust, 'rust', baseTrace);
  const bt = readTrace(baseTrace);
  for (const x of bt.all) anon.baseline.add(`${x.member}@${x.site}`);
  for (const x of bt.raw) anon.baselineRaw.add(`${x.member}@${x.site}`);
  setup.push(`Rust \`serve\` startup (tools/list) built ${bt.all.length} refusal(s), caught and not counted per tool: ${bt.all.map((x) => `${x.capability}: ${x.member} @ ${x.site}`).join('; ') || 'none'}`);
  const rustTools = new Set<string>((rustList.response?.result?.tools ?? []).map((t: any) => t.name));
  const missingOnRust = tools.map((t) => t.name).filter((n) => !rustTools.has(n));
  setup.push(`tools/list: ${tools.length} tools on the reference, ${rustTools.size} on Rust${missingOnRust.length ? ` (missing on Rust: ${missingOnRust.join(', ')})` : ''}`);

  // CLI command inventory: the public surface manifest, the CLI-only table and the operations' CLI names.
  const ps = JSON.parse(readFileSync(join(ROOT, 'docs', 'contracts', 'public-surface.json'), 'utf8'));
  const { CLI_COMMANDS } = await import('../../src/cli/command-table.ts');
  const { OPERATION_MANIFEST } = await import('../../src/core/operation-manifest.generated.ts');
  const cliCommands = [...new Set<string>([
    ...(ps['cli-command'] as string[]).map((c) => c.replace(/^gbrain /, '')),
    ...CLI_COMMANDS.map((c) => c.name),
    ...(OPERATION_MANIFEST as any[]).map((o) => o.cliHints?.name).filter(Boolean),
  ])].sort();

  const cliCases = ONLY === 'mcp' ? [] : CLI_CASES.filter((c) => !FILTER || c.args.join(' ').includes(FILTER));
  const mcpTools = ONLY === 'cli' ? [] : tools.filter((t) => !FILTER || t.name.includes(FILTER));
  let done = 0;
  const total = cliCases.length + mcpTools.length;
  const tick = (r: Row) => { done++; process.stderr.write(`[census] ${done}/${total} ${r.surface} ${r.surface === 'cli' ? r.invocation.slice(0, 50) : r.name}: ${r.status}\n`); return r; };
  // A harness failure (not a gbrain failure) becomes a visible row instead of ending the run.
  const harness = (surface: 'cli' | 'mcp', name: string, invocation: string, e: unknown): Row =>
    ({ surface, name, invocation, status: 'crash', note: `census harness error: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
  const cliRows = await pool(cliCases, CONCURRENCY, async (c, i) => tick(await runCliCase(c, i, bases).catch((e) => harness('cli', c.cmd, labelOf(c.args), e))));
  const mcpRows = await pool(mcpTools, CONCURRENCY, async (t, i) => tick(await runMcpTool(t, i, anon).catch((e) => harness('mcp', t.name, '', e))));
  const rows = [...cliRows, ...mcpRows];

  // The member-caller pass (member-pass.ts): the same MCP tools through a serve bound to a live member.
  const memberSetup: string[] = [];
  const memberBrains: Brain[] = [];
  if (mcpTools.length && !NO_MEMBER) {
    const mb = async (b: Brain | undefined, k: string) => { if (!b) return undefined; const c = await cloneBrain(b, join(base, `member-${k}`)); memberBrains.push(c); return c; };
    const m: Bases = { ref: (await mb(ref, 'ref'))!, rust: (await mb(rust, 'rust'))!, pg: await mb(pg, 'pg'), pglite: useMirror ? (await mb(pglite, 'pglite'))! : undefined as unknown as Brain, useMirror };
    if (!useMirror) m.pglite = m.ref;
    let ok = true;
    for (const args of MEMBER_SETUP) {
      const arms = [m.ref, m.rust, ...(m.pg ? [m.pg] : [])];
      const tr = join(work, `member-setup-${memberSetup.length}.jsonl`);
      const res = await Promise.all(arms.map((b) => spawnCli(b, args, b === m.rust ? { trace: tr } : {})));
      const why = (b: Brain, r: Run) => { const d = decisiveMember(r); const site = b === m.rust && d ? endSiteOf(readTrace(tr), d) : undefined; return d ? `${d}${site ? ` @ ${site}` : ''}` : snippet(r); };
      memberSetup.push(`${labelOf(args)}: ${arms.map((b, j) => `${b.arm} exit ${res[j]!.exitCode}${res[j]!.exitCode ? ` (${why(b, res[j]!)})` : ''}`).join(', ')}`);
      if (res.some((r) => r.exitCode !== 0)) ok = false;
    }
    if (!ok) memberSetup.push('member setup failed on an arm: the member pass did not run (every member cell is skipped, with the first failed step as its note)');
    const pass: McpPass = { tag: '-member', bases: m, serveArgs: MEMBER_SERVE_ARGS, baseline: new Set(), baselineRaw: new Set() };
    if (ok) {
      const mt = join(work, 'serve-baseline-member.jsonl');
      await baselineOf(m.rust, 'rust-member', mt, MEMBER_SERVE_ARGS);
      const t = readTrace(mt);
      for (const x of t.all) pass.baseline.add(`${x.member}@${x.site}`);
      for (const x of t.raw) pass.baselineRaw.add(`${x.member}@${x.site}`);
      memberSetup.push(`member \`serve ${MEMBER_SERVE_ARGS.join(' ')}\` startup (tools/list) built ${t.all.length} refusal(s), not counted per tool: ${t.all.map((x) => `${x.capability}: ${x.member} @ ${x.site}`).join('; ') || 'none'}`);
    }
    let mdone = 0;
    const byName = new Map(mcpRows.map((r) => [r.name, r]));
    await pool(mcpTools, CONCURRENCY, async (tool, i) => {
      const row = byName.get(tool.name)!;
      const r = ok ? await runMcpTool(tool, i, pass).catch((e) => harness('mcp', tool.name, '', e)) : { status: 'skipped' as Status, note: `member setup failed: ${memberSetup.find((x) => / exit [1-9]/.test(x)) ?? ''}` } as Row;
      row.member = { status: r.status, decisive: r.decisive, endSite: r.endSite, sites: r.sites?.filter((x) => !pass.baseline.has(x)), options: r.options, note: r.note };
      process.stderr.write(`[census] member ${++mdone}/${mcpTools.length} ${tool.name}: ${r.status}\n`);
    });
  }

  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim();
  const meta = {
    'gbrain commit': head, 'addon': ADDON.replace(ROOT + '/', ''), 'bun': Bun.version, 'fixture': 'test/fixtures/rust-cli-parity-brain (20 synthetic pages)',
    'reference': useMirror ? 'mirror (PGLite with the Rust-completed setup steps)' : 'PGLite', 'postgres arm': pg ? 'on (pgvector, a template database per case)' : 'off (set GBRAIN_CENSUS_PG_URL)',
    'filter': FILTER ?? 'none', 'only': ONLY ?? 'cli and mcp', 'member-caller pass': NO_MEMBER || !mcpTools.length ? 'off' : `on (serve ${MEMBER_SERVE_ARGS.join(' ')})`,
    ...(COMPOSITION ? { 'composition': COMPOSITION } : {}), 'wall time': `${Math.round((Date.now() - t0) / 1000)} s`,
  };
  writeFileSync(OUT_JSON, JSON.stringify({ meta, setup, memberSetup, cliCommands, tools: tools.map((t) => t.name), serveBaseline: [...SERVE_BASELINE], packages: buildPackages(rows, ROOT), hidden: hiddenRefusals(rows).sites, rows }, null, 1) + '\n');
  writeReport(report(rows, setup, meta, tools.length, cliCommands, memberSetup));
  for (const b of [pglite, rust, ...(pg ? [pg] : []), ...(useMirror ? [ref] : []), ...memberBrains]) await dropBrain(b);
  if (!flag('--work-dir')) rmSync(work, { recursive: true, force: true });
  process.stderr.write(`[census] wrote ${OUT_MD} and ${OUT_JSON}\n`);
}

await main();
