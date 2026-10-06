#!/usr/bin/env bun
/**
 * bun run test:stress (scripts/stress/run.ts) — run test files repeatedly to prove they are
 * deterministic. The one runner behind the PR stress gate, the nightly race
 * hunt and local runs (scripts/stress/README.md, docs/TESTING.md#stress-gate).
 *
 *   bun run test:stress [files…] [--iterations N] [--base <ref>] [--head <ref>]
 *                       [--postgres] [--seed N] [--first-iteration N] [--randomize]
 *                       [--work <json>] [--out <dir>] [--dry-run]
 *
 * Files default to the test files changed versus the merge base with
 * origin/master (plus direct importers of changed test/helpers/ files, by the
 * fan-in rule). Each file runs in its own execution profile (unit, serial,
 * slow with the workflow's pull-request values, both arms of a
 * DATABASE_URL-gated suite, or E2E through scripts/run-e2e.sh). With
 * --postgres every database iteration gets a fresh database cloned with
 * CREATE DATABASE … TEMPLATE on the server named by GBRAIN_STRESS_ADMIN_URL or
 * a test-shaped DATABASE_URL, or on a pgvector container started from
 * docker-compose.ci.yml (the ci:local service); databases and containers it
 * creates are tracked under .context/test-stress/owned/ and removed on exit,
 * on Ctrl-C and by the next run after a crash.
 *
 * Every iteration writes an executed-test receipt (JUnit) and must execute the
 * same tests as the first; zero executed tests or an unexpected skip fails the
 * run. Output: one line per iteration, a summary with the reproduce command
 * for each failure, and a manifest (<out>/stress-manifest.json).
 * Exit: 0 every file passed, 1 a failure, 2 usage or setup error, 130/143 cancelled.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { parseJUnit, type TestCase } from '../ci-executed-counts.ts';
import {
  DEFAULT_ITERATIONS, STRESS_DOCS, TEST_PATH_RE, allTestFiles, armMode, changedFiles, defaultSeed, expandHelper,
  notStressedReason, parseFileList, profileFor, redact, reproduceLine, validRef, type HelperExpansion, type Profile,
} from './plan.ts';

/** GBRAIN_STRESS_ROOT is a test seam: a fixture tree whose test files the runner executes. */
const ROOT = process.env.GBRAIN_STRESS_ROOT ? resolve(process.env.GBRAIN_STRESS_ROOT) : resolve(import.meta.dir, '..', '..');
const ITERATION_CAP_MS = Number(process.env.GBRAIN_STRESS_ITERATION_TIMEOUT_MS ?? 15 * 60_000);

export interface Args {
  files: string[]; iterations: number; firstIteration: number; base: string; head?: string;
  postgres: boolean; seed?: number; randomize: boolean; out: string; dryRun: boolean;
  work?: Array<{ file: string; first: number; count: number }>;
}

export function parseArgs(argv: string[]): Args | string {
  const a: Args = { files: [], iterations: DEFAULT_ITERATIONS, firstIteration: 1, base: 'origin/master', postgres: false, randomize: false, out: '.context/test-stress', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    try {
      switch (arg) {
        case '--iterations': a.iterations = Number(value()); break;
        case '--first-iteration': a.firstIteration = Number(value()); break;
        case '--base': a.base = value(); break;
        case '--head': a.head = value(); break;
        case '--seed': a.seed = Number(value()); break;
        case '--out': a.out = value(); break;
        case '--work': a.work = JSON.parse(value()); break;
        case '--postgres': a.postgres = true; break;
        case '--randomize': a.randomize = true; break;
        case '--dry-run': a.dryRun = true; break;
        case '-h': case '--help': return 'help';
        default:
          if (arg.startsWith('-')) return `unknown flag ${arg}`;
          a.files.push(arg.replace(/^\.\//, ''));
      }
    } catch (e) { return (e as Error).message; }
  }
  if (!Number.isInteger(a.iterations) || a.iterations < 1) return '--iterations must be a positive integer';
  if (!Number.isInteger(a.firstIteration) || a.firstIteration < 1) return '--first-iteration must be a positive integer';
  if (a.seed !== undefined && (!Number.isInteger(a.seed) || a.seed < 0)) return '--seed must be a non-negative integer';
  if (!validRef(a.base) || (a.head && !validRef(a.head))) return '--base/--head must be a 40-hex SHA or a valid ref name';
  const bad = parseFileList(a.files.join(' ')).invalid;
  if (bad.length) return `not a repo-relative test file: ${bad.join(', ')} (expected test/…/*.test.ts)`;
  if (a.work) {
    if (!Array.isArray(a.work) || a.work.some(w => !w || typeof w.file !== 'string' || !TEST_PATH_RE.test(w.file) || w.file.includes('..') || !Number.isInteger(w.first) || w.first < 1 || !Number.isInteger(w.count) || w.count < 1)) {
      return '--work must be a JSON array of {"file":"test/…/*.test.ts","first":N,"count":N}';
    }
  }
  return a;
}

// ── Postgres: an admin connection, a template and owned databases ─────────────

interface Owned { pid: number; server: string; databases: string[]; compose?: string }
const OWNED_DIR = join(ROOT, '.context', 'test-stress', 'owned');

class PgServer {
  readonly tag = `${process.pid}_${randomBytes(2).toString('hex')}`;
  private owned: Owned;
  private template = '';
  constructor(readonly adminUrl: string, readonly origin: string, compose?: string) {
    const u = new URL(adminUrl);
    this.owned = { pid: process.pid, server: `${u.hostname}:${u.port || '5432'}`, databases: [], compose };
    this.save();
  }
  private save() { mkdirSync(OWNED_DIR, { recursive: true }); writeFileSync(join(OWNED_DIR, `${this.tag}.json`), JSON.stringify(this.owned)); }
  urlFor(db: string): string { const u = new URL(this.adminUrl); u.pathname = `/${db}`; return u.toString(); }
  private async sql<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    const sql = postgres(this.adminUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
    try {
      return await fn(sql);
    } catch (e) {
      const err = e as Error & { code?: string; errors?: Array<{ code?: string }> };
      const code = err.code ?? err.errors?.map(x => x.code).filter(Boolean).join('/') ?? '';
      if (!err.message || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|CONNECT_TIMEOUT/.test(code + err.message)) {
        throw new Error(`cannot reach the stress database server ${redact(this.adminUrl)} (${code || err.name}). Why: every database iteration clones its own database there. Fix: start the server (or unset GBRAIN_STRESS_ADMIN_URL/DATABASE_URL so --postgres starts a container) and re-run`);
      }
      throw e;
    } finally { await sql.end({ timeout: 5 }).catch(() => {}); }
  }
  async create(index: number): Promise<string> {
    if (!this.template) {
      this.template = `gbrain_stress_${this.tag}_tmpl_test`;
      this.owned.databases.push(this.template); this.save();
      await this.sql(sql => sql.unsafe(`CREATE DATABASE "${this.template}"`));
    }
    const name = `gbrain_stress_${this.tag}_i${index}_test`;
    this.owned.databases.push(name); this.save();
    await this.sql(sql => sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${this.template}"`));
    return name;
  }
  /**
   * Transactions the iteration's own database served. A fresh clone starts at
   * zero, so a positive count proves the PostgreSQL arm connected. Backends
   * flush their counters when they exit, just after the test process closes
   * them, so this waits up to 10 s for a nonzero count before reporting zero.
   */
  async activity(name: string): Promise<number> {
    return this.sql(async sql => {
      for (let waited = 0; ; waited += 250) {
        const [row] = await sql`SELECT (xact_commit + xact_rollback)::int AS n FROM pg_stat_database WHERE datname = ${name}`;
        const n = Number(row?.n ?? 0);
        if (n > 0 || waited >= 10_000) return n;
        await Bun.sleep(250);
      }
    });
  }
  async drop(name: string): Promise<void> {
    await this.sql(sql => sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    this.owned.databases = this.owned.databases.filter(d => d !== name); this.save();
  }
  async close(): Promise<void> {
    for (const db of [...this.owned.databases]) await this.drop(db).catch(() => {});
    if (this.owned.compose) composeDown(this.owned.compose);
    rmSync(join(OWNED_DIR, `${this.tag}.json`), { force: true });
  }
}

function composeDown(project: string) {
  spawnSync('docker', ['compose', '-p', project, '-f', join(ROOT, 'docker-compose.ci.yml'), 'down', '-v', '--remove-orphans'], { stdio: 'ignore' });
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Remove databases and containers a crashed earlier run left behind (its pid is gone). */
async function sweepOwned(adminUrl?: string): Promise<string[]> {
  if (!existsSync(OWNED_DIR)) return [];
  const swept: string[] = [];
  for (const entry of readdirSync(OWNED_DIR)) {
    const path = join(OWNED_DIR, entry);
    let owned: Owned;
    try { owned = JSON.parse(readFileSync(path, 'utf8')); } catch { rmSync(path, { force: true }); continue; }
    if (alive(owned.pid)) continue;
    if (owned.compose) { composeDown(owned.compose); swept.push(`container project ${owned.compose}`); rmSync(path, { force: true }); continue; }
    if (!adminUrl) continue;
    const u = new URL(adminUrl);
    if (`${u.hostname}:${u.port || '5432'}` !== owned.server) continue;
    const sql = postgres(adminUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });
    try { for (const db of owned.databases) { await sql.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`); swept.push(db); } } finally { await sql.end({ timeout: 5 }); }
    rmSync(path, { force: true });
  }
  return swept;
}

const testShaped = (url: string) => { try { return /(^|[_-])test([_-]|$)/i.test(decodeURIComponent(new URL(url).pathname.slice(1))); } catch { return false; } };

async function freePort(): Promise<number> {
  return new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => res(port)); }); });
}

async function provisionPostgres(): Promise<PgServer> {
  const explicit = process.env.GBRAIN_STRESS_ADMIN_URL || process.env.DATABASE_URL;
  if (explicit) {
    if (!testShaped(explicit)) {
      throw new Error(`refusing ${redact(explicit)}: the admin database name must carry a "test" segment (e.g. gbrain_test). Why: stress databases are created and dropped on that server. Fix: point GBRAIN_STRESS_ADMIN_URL at a disposable test server, or unset DATABASE_URL to let --postgres start a container`);
    }
    await sweepOwned(explicit);
    return new PgServer(explicit, process.env.GBRAIN_STRESS_ADMIN_URL ? 'GBRAIN_STRESS_ADMIN_URL' : 'DATABASE_URL');
  }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('--postgres needs a database server: Docker is not available and neither GBRAIN_STRESS_ADMIN_URL nor DATABASE_URL is set. Fix: start Docker (the run uses docker-compose.ci.yml postgres-1), or export GBRAIN_STRESS_ADMIN_URL=postgres://postgres:postgres@localhost:5434/gbrain_test');
  }
  await sweepOwned();
  const project = `gbrain-stress-${process.pid}`;
  const port = await freePort();
  const env = { ...process.env, GBRAIN_CI_PG_PORT: String(port) };
  const compose = ['compose', '-p', project, '-f', join(ROOT, 'docker-compose.ci.yml')];
  const server = new PgServer(`postgres://postgres:postgres@127.0.0.1:${port}/gbrain_test`, `docker-compose.ci.yml postgres-1 (project ${project})`, project);
  const up = spawnSync('docker', [...compose, 'up', '-d', 'postgres-1'], { env, encoding: 'utf8' });
  if (up.status !== 0) { await server.close(); throw new Error(`docker compose up postgres-1 failed: ${up.stderr.trim().split('\n').pop()}. Fix: check Docker, or set GBRAIN_STRESS_ADMIN_URL`); }
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', [...compose, 'exec', '-T', 'postgres-1', 'pg_isready', '-U', 'postgres', '-d', 'gbrain_test'], { env, stdio: 'ignore' }).status === 0) return server;
    await Bun.sleep(1000);
  }
  await server.close();
  throw new Error('the stress Postgres container did not become ready within 60 s. Fix: run `docker compose -f docker-compose.ci.yml logs postgres-1`, or set GBRAIN_STRESS_ADMIN_URL');
}

// ── One iteration ─────────────────────────────────────────────────────────────

export interface Failure { test: string; signature: string; message: string }
export interface IterationResult {
  index: number; seed: number; exit: number; durationMs: number; executed: number; skipped: number;
  failures: Failure[]; missing: string[]; timedOut: boolean; receipt: string;
  /** Transactions the iteration database served; -1 without a database. */
  databaseActivity: number;
}

/** Stable failure signature: the first lines of the message with numbers, temp paths and UUIDs masked. */
export function failureSignature(message: string): string {
  return message.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' ')
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/\S+/g, '<tmp>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').slice(0, 200);
}

const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (w, r: string) => r[0] === '#' ? String.fromCodePoint(r[1] === 'x' ? parseInt(r.slice(2), 16) : Number(r.slice(1))) : ENTITY[r] ?? w);

/** Executed cases plus the failure message of each failing case, in report order. */
export function readReport(xml: string): { cases: TestCase[]; messages: string[] } {
  const cases = parseJUnit(xml);
  const messages: string[] = [];
  for (const [, body] of xml.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const m = /<(?:failure|error)\b[^>]*?message="([^"]*)"/.exec(body ?? '');
    if (m || /<(?:failure|error)\b/.test(body ?? '')) messages.push(decode(m?.[1] ?? 'failure without a message'));
  }
  return { cases, messages };
}

const slug = (file: string) => file.replace(/^test\//, '').replace(/[^\w.-]+/g, '_');

interface RunContext { args: Args; sha: string; bun: string; pg?: PgServer; snapshot?: string; oldBinary?: string; out: string; child?: ReturnType<typeof spawn> }

function childEnv(ctx: RunContext, profile: Profile, seed: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_TEST_RECEIPT_DIR', 'GBRAIN_TEST_RECEIPT_LANE', 'GBRAIN_STRESS_ADMIN_URL', 'GBRAIN_TEST_ALLOW_DATABASE_URL', 'GBRAIN_STRESS_ROOT']) delete env[k];
  if (ctx.snapshot) env.GBRAIN_PGLITE_SNAPSHOT = ctx.snapshot;
  if (ctx.oldBinary) env.GBRAIN_TEST_OLD_BINARY = ctx.oldBinary;
  env.GBRAIN_TEST_SEED = String(seed);
  return { ...env, ...profile.vars };
}

async function runIteration(ctx: RunContext, file: string, profile: Profile, index: number, seed: number, withDatabase: boolean): Promise<IterationResult> {
  const dir = join(ctx.out, 'receipts', `${slug(file)}--i${index}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const env = childEnv(ctx, profile, seed);
  let db = '';
  if (withDatabase) {
    db = await ctx.pg!.create(index);
    env.DATABASE_URL = ctx.pg!.urlFor(db);
    env.GBRAIN_TEST_ALLOW_DATABASE_URL = '1';
  }
  const junit = join(dir, 'stress.junit.xml');
  let cmd: string[];
  if (profile.name === 'e2e') {
    env.GBRAIN_TEST_RECEIPT_DIR = dir;
    env.GBRAIN_TEST_RECEIPT_LANE = 'stress-e2e';
    cmd = ['bash', 'scripts/run-e2e.sh', file];
  } else {
    cmd = ['bun', ...(withDatabase ? ['--no-env-file'] : []), 'test', `--timeout=${profile.timeoutMs}`,
      ...(profile.name === 'serial' ? ['--max-concurrency=1'] : []),
      ...(ctx.args.randomize ? ['--randomize', `--seed=${seed}`] : []),
      '--reporter=junit', `--reporter-outfile=${junit}`, file];
  }
  const started = Date.now();
  const log = join(dir, 'output.log');
  let timedOut = false;
  const exit = await new Promise<number>(res => {
    const child = spawn(cmd[0]!, cmd.slice(1), { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.child = child;
    const chunks: Buffer[] = [];
    child.stdout!.on('data', c => chunks.push(c));
    child.stderr!.on('data', c => chunks.push(c));
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid!); }, ITERATION_CAP_MS);
    child.on('close', code => { clearTimeout(timer); ctx.child = undefined; writeFileSync(log, redact(Buffer.concat(chunks).toString('utf8'))); res(code ?? 1); });
  });
  const durationMs = Date.now() - started;
  const databaseActivity = db ? await ctx.pg!.activity(db).catch(() => 0) : -1;
  if (db) await ctx.pg!.drop(db).catch(() => {});
  if (!withDatabase || profile.name !== 'e2e') {
    const receipt = [`version=1`, `lane=stress`, `kind=primary`, `tag=${slug(file)}-i${index}`, `shard=`, `of=`, `arm=${withDatabase ? profile.arm : 'pglite'}`,
      `sha=${ctx.sha}`, `root=${ROOT}`, `run_id=${process.env.GITHUB_RUN_ID ?? ''}`, `run_attempt=${process.env.GITHUB_RUN_ATTEMPT ?? ''}`,
      `job=${process.env.GITHUB_JOB ?? ''}`, `started=${Math.floor(started / 1000)}`, `exit=${exit}`].join('\n');
    if (profile.name !== 'e2e') {
      writeFileSync(join(dir, `stress--${slug(file)}-i${index}--primary.receipt`), `${receipt}\n`);
      writeFileSync(join(dir, `stress--${slug(file)}-i${index}--primary.files`), `${file}\n`);
    }
  }
  const report = profile.name === 'e2e' ? readdirSync(dir).find(f => f.endsWith('.junit.xml')) : existsSync(junit) ? 'stress.junit.xml' : undefined;
  let cases: TestCase[] = [];
  let messages: string[] = [];
  let reportError = '';
  if (report) {
    try { ({ cases, messages } = readReport(readFileSync(join(dir, report), 'utf8'))); } catch (e) { reportError = (e as Error).message; }
  } else reportError = 'no JUnit report was written';
  const failed = cases.filter(c => c.status === 'fail');
  const failures: Failure[] = failed.map((c, i) => ({ test: c.test, message: redact(messages[i] ?? ''), signature: failureSignature(messages[i] ?? '') }));
  if (exit !== 0 && !failures.length) {
    const tail = readFileSync(log, 'utf8').split('\n').filter(l => l.trim()).slice(-40);
    const first = tail.find(l => /error|Error|FAIL|timed out|panic/.test(l)) ?? tail[tail.length - 1] ?? `exit ${exit}`;
    const why = timedOut ? `iteration exceeded the ${Math.round(ITERATION_CAP_MS / 60000)}-minute iteration cap and was killed` : reportError ? `${first} (${reportError})` : first;
    failures.push({ test: '(file-level)', message: redact(why), signature: failureSignature(why) });
  }
  return {
    index, seed, exit, durationMs, timedOut, receipt: relativeToRoot(dir), databaseActivity,
    executed: cases.filter(c => c.status === 'pass' || c.status === 'fail').length,
    skipped: cases.filter(c => c.status === 'skip' || c.status === 'todo').length,
    failures, missing: [],
  };
}

const relativeToRoot = (p: string) => p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
function killTree(pid: number) { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref(); }

function executedIdentities(dir: string): string[] {
  const full = resolve(ROOT, dir);
  const report = readdirSync(full).find(f => f.endsWith('.junit.xml'));
  if (!report) return [];
  try { return parseJUnit(readFileSync(join(full, report), 'utf8')).filter(c => c.status === 'pass' || c.status === 'fail').map(c => c.test); } catch { return []; }
}

// ── One file ──────────────────────────────────────────────────────────────────

export interface FileResult {
  file: string; profile: Profile['name']; env: Profile['env']; arm: string; status: 'pass' | 'fail' | 'not-stressed';
  reason?: string; seedBase: number; firstIteration: number; iterations: IterationResult[]; reproduce: string;
}

/** Workflows whose dedicated jobs provide prerequisites (agent binaries, native targets) the stress shards lack. */
const OWNING_WORKFLOWS = ['heavy-tests.yml', 'native-locks.yml', 'macos-validation.yml'];

function skipReason(file: string): string | null {
  const text = readFileSync(join(ROOT, file), 'utf8');
  if (/process\.platform/.test(text)) return `every test skipped on ${process.platform}: platform-only tests, run by their owning native lane; not stressed`;
  const keys = [...new Set([...text.matchAll(/process\.env\.([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET))/g)].map(m => m[1]!))];
  if (keys.length) return `every test skipped without ${keys.join(', ')} (secret not available here); not stressed`;
  const owner = OWNING_WORKFLOWS.find(w => { const p = join(ROOT, '.github/workflows', w); return existsSync(p) && readFileSync(p, 'utf8').includes(file); });
  if (owner) return `every test skipped here: its prerequisite (agent binary or native target) comes from its owning job in .github/workflows/${owner}; not stressed`;
  return null;
}

async function stressFile(ctx: RunContext, file: string, profile: Profile, first: number, count: number): Promise<FileResult> {
  const { args } = ctx;
  const seedBase = args.seed ?? defaultSeed(ctx.sha, file);
  const database = profile.env === 'database';
  const result: FileResult = {
    file, profile: profile.name, env: profile.env, arm: profile.arm, status: 'pass', seedBase, firstIteration: first, iterations: [],
    reproduce: reproduceLine({ file, iterations: count, firstIteration: first, seed: seedBase, postgres: database, randomize: args.randomize }),
  };
  let expected: string[] | undefined;
  for (let index = first; index < first + count; index++) {
    const seed = seedBase + index - 1;
    const it = await runIteration(ctx, file, profile, index, seed, database);
    if (!it.failures.length && database && it.databaseActivity === 0) {
      it.failures.push({ test: '(file-level)', message: 'the PostgreSQL arm never connected: its fresh database served no transaction', signature: 'postgres arm executed no tests' });
    }
    if (!it.failures.length) {
      const ids = executedIdentities(it.receipt);
      if (index === first) {
        if (it.executed === 0) {
          const reason = skipReason(file);
          if (reason) { result.status = 'not-stressed'; result.reason = reason; result.iterations.push(it); log(`  - ${file} ${reason}`); return result; }
          it.failures.push({ test: '(file-level)', message: 'zero tests executed', signature: 'zero tests executed' });
        }
        expected = ids;
      } else if (expected) {
        const seen = new Set(ids);
        it.missing = expected.filter(t => !seen.has(t));
        if (it.missing.length) it.failures.push({ test: '(file-level)', message: `unexpected skip: ${it.missing.length} test(s) that ran in iteration ${first} did not run: ${it.missing.slice(0, 3).join('; ')}`, signature: 'unexpected skip' });
      }
    }
    result.iterations.push(it);
    const mark = it.failures.length ? '✗' : '✓';
    log(`  ${mark} ${file} iteration ${index} (seed ${seed}) ${(it.durationMs / 1000).toFixed(1)}s, ${it.executed} executed${it.failures.length ? `: ${it.failures[0]!.test}: ${it.failures[0]!.message.split('\n')[0]}` : ''}`);
    if (it.failures.length) result.status = 'fail';
  }
  return result;
}

const log = (line: string) => console.log(line);

// ── Main ──────────────────────────────────────────────────────────────────────

const USAGE = `usage: bun run test:stress [files…] [--iterations N] [--base <ref>] [--head <ref>] [--postgres]
                         [--seed N] [--first-iteration N] [--randomize] [--work <json>] [--out <dir>] [--dry-run]
Docs: ${STRESS_DOCS}`;

export interface Selection { files: string[]; helpers: HelperExpansion[]; mergeBase?: string; error?: string }

/** The files a run stresses: explicit files, or changed tests plus helper importers versus the merge base. */
export function selectFiles(args: Args, sha: string): Selection {
  if (args.work) return { files: [...new Set(args.work.map(w => w.file))], helpers: [] };
  if (args.files.length) return { files: args.files, helpers: [] };
  const changed = changedFiles(ROOT, args.base, args.head);
  if (changed.error) return { files: [], helpers: [], error: changed.error };
  const tests = changed.helpers.length ? allTestFiles(ROOT) : [];
  const helpers = changed.helpers.map(h => expandHelper(ROOT, h, tests, sha));
  return { files: [...new Set([...changed.tests, ...helpers.flatMap(h => h.stressed)])].sort(), helpers, mergeBase: changed.mergeBase };
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === 'help') { console.log(USAGE); return 0; }
  if (typeof parsed === 'string') { console.error(`test:stress: ${parsed}\n${USAGE}`); return 2; }
  const args = parsed;
  const sha = process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'unknown';
  const bun = Bun.version;
  const setupStarted = Date.now();
  const selection = selectFiles(args, sha);
  if (selection.error) {
    console.error(`test:stress: the changed-file list could not be computed: ${selection.error}\n  Why: the stress set is every test file the diff touches; a guessed list could skip one.\n  Docs: ${STRESS_DOCS}`);
    return 2;
  }
  const livePath = join(ROOT, 'scripts/e2e-live-key-only.txt');
  const liveKeyOnly = new Set(existsSync(livePath) ? readFileSync(livePath, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')) : []);
  const missing = selection.files.filter(f => !existsSync(join(ROOT, f)));
  if (missing.length) { console.error(`test:stress: no such file: ${missing.join(', ')}. Fix: pass repo-relative paths of existing test files. Docs: ${STRESS_DOCS}`); return 2; }
  if (args.postgres && !args.work) {
    for (const f of [...selection.files]) {
      const wrapper = armMode(ROOT, f).wrapper;
      if (wrapper && existsSync(join(ROOT, wrapper)) && !selection.files.includes(wrapper)) { selection.files.push(wrapper); log(`  ${f}: its PostgreSQL arm runs through ${wrapper}; stressing that wrapper too`); }
    }
  }
  const plan = selection.files.map(file => {
    const reason = notStressedReason(file, liveKeyOnly);
    const mode = armMode(ROOT, file);
    return { file, reason, armed: mode.armed || !!mode.wrapper, profile: profileFor(file, { armed: mode.armed, postgres: args.postgres }) };
  });
  const needsDb = plan.filter(p => !p.reason && p.profile.env === 'database');
  for (const p of plan) {
    if (!p.reason && p.profile.name === 'e2e' && !args.postgres) p.reason = 'E2E file needs Postgres; re-run with --postgres; not stressed';
  }
  const unarmedNotice = plan.filter(p => p.armed && !args.postgres && !p.reason);
  log(`test:stress: ${plan.length} file(s) × ${args.work ? 'planned' : args.iterations} iteration(s) at ${sha.slice(0, 12)} on Bun ${bun}${selection.mergeBase ? `, changed versus ${selection.mergeBase.slice(0, 12)}` : ''}`);
  for (const h of selection.helpers) log(`  helper ${h.helper}: ${h.importers} direct importer(s), ${h.mode === 'sampled' ? `stressing its own tests and a sample of ${h.stressed.length}; ${h.listedOnly.length} listed only` : 'stressing all'}`);
  for (const p of plan) log(`  ${p.reason ? 'skip' : p.profile.name.padEnd(12)} ${p.file}${p.reason ? ` (${p.reason})` : ''}`);
  for (const p of unarmedNotice) log(`  note: ${p.file} has a DATABASE_URL-gated PostgreSQL arm; add --postgres to stress it too`);
  if (args.dryRun) return 0;
  if (!plan.length) { log(`test:stress: no changed test files; nothing to stress. Pass files explicitly or --base <ref>. Docs: ${STRESS_DOCS}`); return 0; }

  const out = resolve(ROOT, args.out);
  mkdirSync(out, { recursive: true });
  const ctx: RunContext = { args, sha, bun, out };
  let cancelled = 0;
  const onSignal = (code: number) => async () => {
    if (cancelled) return;
    cancelled = code;
    log(`\ntest:stress: interrupted; stopping the running file and removing owned databases and containers`);
    if (ctx.child?.pid) killTree(ctx.child.pid);
    await ctx.pg?.close().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', onSignal(130));
  process.on('SIGTERM', onSignal(143));

  const results: FileResult[] = [];
  let setupMs = 0;
  const runStarted = Date.now();
  try {
    if (needsDb.length) {
      if (!args.postgres) {
        for (const p of needsDb) p.reason = p.reason ?? 'needs Postgres; re-run with --postgres; not stressed';
      } else {
        ctx.pg = await provisionPostgres();
        log(`  postgres: ${ctx.pg.origin}, a fresh database per iteration (CREATE DATABASE … TEMPLATE)`);
      }
    }
    if (spawnSync('bun', ['run', 'build:pglite-snapshot'], { cwd: ROOT, stdio: 'ignore' }).status === 0) ctx.snapshot = join(ROOT, 'test/fixtures/pglite-snapshot.tar');
    if (plan.some(p => !p.reason && p.profile.prereq === 'old-binary')) {
      const bin = join(out, 'gbrain-before-shared-skills');
      const built = spawnSync('bash', ['scripts/build-shared-skills-baseline.sh', bin], { cwd: ROOT, encoding: 'utf8' });
      if (built.status !== 0) throw new Error(`building the pre-feature executable failed (scripts/build-shared-skills-baseline.sh): ${built.stderr.trim().split('\n').pop()}`);
      ctx.oldBinary = bin;
    }
    setupMs = Date.now() - setupStarted;
    log(`  setup ${(setupMs / 1000).toFixed(1)}s`);
    for (const p of plan) {
      if (p.reason) { results.push({ file: p.file, profile: p.profile.name, env: p.profile.env, arm: p.profile.arm, status: 'not-stressed', reason: p.reason, seedBase: 0, firstIteration: 1, iterations: [], reproduce: '' }); continue; }
      const items = args.work ? args.work.filter(w => w.file === p.file) : [{ file: p.file, first: args.firstIteration, count: args.iterations }];
      for (const item of items) results.push(await stressFile(ctx, p.file, p.profile, item.first, item.count));
    }
    const runMs = Date.now() - runStarted;
    const manifest = writeManifest(ctx, results, selection, setupMs, runMs);
    return summarize(results, manifest, setupMs, runMs);
  } catch (e) {
    console.error(`test:stress: ${(e as Error).message || String(e)}\n  Docs: ${STRESS_DOCS}`);
    if (results.length) writeManifest(ctx, results, selection, setupMs, Date.now() - runStarted);
    return 2;
  } finally {
    await ctx.pg?.close().catch(() => {});
  }
}

function artifactUrl(): string {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env;
  return process.env.GBRAIN_STRESS_ARTIFACT_URL || (server && repo && run ? `${server}/${repo}/actions/runs/${run}` : '');
}

/** The context line printed under every reproduce command. */
export function contextLine(ctx: { sha: string; bun: string }, r: FileResult, it: IterationResult, artifact: string): string {
  return `sha ${ctx.sha.slice(0, 12)}, Bun ${ctx.bun}, backend ${r.arm}, profile ${r.profile} (${r.env}), iteration ${it.index}, seed ${it.seed}${artifact ? `, artifact ${artifact}` : ''}`;
}

function writeManifest(ctx: RunContext, results: FileResult[], selection: Selection, setupMs: number, runMs: number): string {
  const artifact = artifactUrl();
  const failures = results.flatMap(r => r.iterations.flatMap(it => it.failures.map(f => ({
    file: r.file, iteration: it.index, seed: it.seed, test: f.test, backend: r.arm, signature: f.signature, message: f.message,
    reproduce: reproduceLine({ file: r.file, iterations: Math.max(1, r.iterations.length), firstIteration: it.index, seed: r.seedBase, postgres: r.env === 'database', randomize: ctx.args.randomize }),
    context: contextLine(ctx, r, it, artifact),
  }))));
  const manifest = {
    version: 1, kind: 'gbrain-stress-manifest', sha: ctx.sha, bun: ctx.bun, randomize: ctx.args.randomize,
    run_id: process.env.GITHUB_RUN_ID ?? '', run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? '', artifact,
    setup_ms: setupMs, run_ms: runMs, helpers: selection.helpers,
    files: results.map(r => ({ ...r, iterations: r.iterations.map(({ receipt, ...it }) => ({ ...it, receipt })) })),
    not_stressed: results.filter(r => r.status === 'not-stressed').map(r => ({ file: r.file, reason: r.reason })),
    failures,
  };
  const path = join(ctx.out, 'stress-manifest.json');
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function summarize(results: FileResult[], manifestPath: string, setupMs: number, runMs: number): number {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { failures: Array<{ file: string; iteration: number; test: string; message: string; reproduce: string; context: string }> };
  const failedFiles = [...new Set(results.filter(r => r.status === 'fail').map(r => r.file))];
  log(`\ntest:stress: ${results.filter(r => r.status === 'pass').length} passed, ${failedFiles.length} failed, ${results.filter(r => r.status === 'not-stressed').length} not stressed (setup ${(setupMs / 1000).toFixed(1)}s, run ${(runMs / 1000).toFixed(1)}s). Manifest: ${relativeToRoot(manifestPath)}`);
  if (!failedFiles.length) return 0;
  for (const file of failedFiles) {
    const fs = manifest.failures.filter(f => f.file === file);
    const iterations = [...new Set(fs.map(f => f.iteration))];
    const first = fs[0]!;
    log(`\nFAIL [stress_failure]: ${file} failed in ${iterations.length} iteration(s) (first: iteration ${first.iteration}, ${first.test}: ${first.message.split('\n')[0]})`);
    log(`  Why: the same checkout passed and failed across iterations, so the file is nondeterministic (or broken).`);
    log(`  Fix: root-cause the race in the product or the test; never widen a timeout or weaken an assertion. Replay:`);
    log(`    ${first.reproduce}`);
    log(`    # ${first.context}`);
    log(`  Docs: ${STRESS_DOCS}`);
  }
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
