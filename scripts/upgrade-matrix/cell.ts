/**
 * Upgrade matrix (GBRA-224 W2): one cell. Install a published old release the
 * way the README tells a user to, build a small brain on it, run serve (and a
 * jobs supervisor on Postgres), upgrade through the old release's own updater
 * while the GitHub fixture shows only the candidate, then check the candidate
 * on that brain. docs/ci-upgrade-matrix.md lists every step and what it
 * guards.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { startGithubFixture, type FixtureHandle } from './github-fixture.ts';
import { StdioMcp } from './mcp-probe.ts';
import { diffCatalog, diffContent, type Difference, type Snapshot } from './snapshot.ts';
import { DOCTOR_ARGV, doctorVerdict, judgeCell, type Check, type Failure, type KnownException } from './verdict.ts';
import type { Candidate } from './versions.ts';
import { startMockProviders, type MockServer } from '../bench/retrieval-scale/mock-providers.ts';
import postgres from '#postgres';

export type Engine = 'pglite' | 'postgres';
export type Keys = 'keyless' | 'keyed';
export type BrainShape = 'repo-less' | 'repo';
export type Fault = 'corrupt-after-upgrade';

export interface CellSpec {
  from: { tag: string; version: string; sha: string; roles: string[] };
  candidate: Candidate;
  engine: Engine;
  keys: Keys;
  brain: BrainShape;
  harnessRoot: string;
  harnessSha: string;
  workDir: string;
  cacheDir: string;
  /** Superuser URL of the Postgres server for Postgres cells; each cell creates its own database. */
  postgresUrl?: string;
  fault?: Fault | null;
  exceptions: KnownException[];
}

export interface Step { name: string; ok: boolean; ms: number; exit?: number | null; detail?: string; log?: string }

export const cellId = (s: { from: { tag: string }; engine: string; keys: string; brain: string }) => [s.from.tag, s.engine, s.keys, s.brain].join('__');

const SEED_WORD = 'zephyrquartz';
const NEW_WORD = 'obsidianlantern';
const SEED_PAGES: Array<{ slug: string; body: string }> = [
  { slug: 'concepts/upgrade-matrix-alpha', body: '# Upgrade matrix alpha\n\nThe alpha page mentions ' + SEED_WORD + ' and links to [[concepts/upgrade-matrix-beta]].\n' },
  { slug: 'concepts/upgrade-matrix-beta', body: '# Upgrade matrix beta\n\nThe beta page is about lighthouse maintenance schedules and tidal charts.\n' },
  { slug: 'people/alice-example', body: '# Alice Example\n\nAlice Example works at acme-example on storage engines.\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | Prefers written design reviews | preference | 0.9 | world | medium | 2026-01-05 | | upgrade-matrix seed | |\n| 2 | Leads the storage team at acme-example | fact | 1.0 | world | high | 2025-11-01 | | upgrade-matrix seed | |\n<!--- gbrain:facts:end -->\n' },
];
const DELETED_SLUG = 'notes/upgrade-matrix-deleted';

function stubBin(dir: string, log: string): void {
  mkdirSync(dir, { recursive: true });
  const write = (name: string, body: string) => { writeFileSync(join(dir, name), '#!/bin/sh\necho "' + name + ' $*" >> "' + log + '"\n' + body + '\n', { mode: 0o755 }); };
  write('crontab', 'case "$1" in -l) echo "no crontab for matrix" >&2; exit 1;; esac\ncat > /dev/null\nexit 0');
  write('systemctl', 'echo "Failed to connect to bus: No medium found" >&2\nexit 1');
  write('launchctl', 'exit 1');
  write('loginctl', 'exit 1');
}

export async function runCell(spec: CellSpec): Promise<Record<string, unknown>> {
  const id = cellId(spec);
  const dir = join(spec.workDir, id);
  rmSync(dir, { recursive: true, force: true });
  const home = join(dir, 'home'), bunDir = join(dir, 'bun'), logs = join(dir, 'logs'), tmp = join(dir, 'tmp');
  for (const d of [home, bunDir, logs, tmp]) mkdirSync(d, { recursive: true });
  const serviceLog = join(dir, 'service-calls.log');
  stubBin(join(dir, 'stub-bin'), serviceLog);

  const steps: Step[] = [];
  const failures: Failure[] = [];
  const fail = (check: Check, detail: string) => { failures.push({ check, detail: detail.slice(0, 2000) }); };
  const started = Date.now();
  const receipt: Record<string, unknown> = {
    schema: 'gbrain-upgrade-matrix-cell/1', id, harness_sha: spec.harnessSha,
    candidate: spec.candidate, from: spec.from, shape: { engine: spec.engine, keys: spec.keys, brain: spec.brain }, fault: spec.fault ?? null,
  };

  const mock: MockServer | null = spec.keys === 'keyed' ? startMockProviders({ manifest: { seed: 224, chunks: 64, pages: 16, dims: 1024 } }) : null;
  const fx: FixtureHandle = await startGithubFixture({
    source: spec.harnessRoot, mirrorDir: join(dir, 'mirror.git'), archiveDir: join(spec.cacheDir, 'archives'), certDir: join(spec.cacheDir, 'certs'),
    forward: mock ? { 'api.voyageai.com': mock.url } : {},
  });
  writeFileSync(join(dir, 'gitconfig'), '[url "' + fx.mirror + '"]\n\tinsteadOf = https://github.com/garrytan/gbrain\n[user]\n\tname = upgrade-matrix\n\temail = upgrade-matrix@example.invalid\n[init]\n\tdefaultBranch = main\n');

  let databaseUrl: string | undefined;
  const dbName = 'um_' + createHash('sha1').update(id + process.pid + started).digest('hex').slice(0, 16);
  const env: Record<string, string> = {
    PATH: [join(dir, 'stub-bin'), join(bunDir, 'bin'), dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: home, GBRAIN_HOME: home, BUN_INSTALL: bunDir, BUN_INSTALL_CACHE_DIR: join(spec.cacheDir, 'bun-install-cache'), TMPDIR: tmp,
    LANG: 'C.UTF-8', NO_COLOR: '1', TERM: 'dumb', USER: process.env.USER ?? 'runner',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    HTTPS_PROXY: fx.proxyUrl, HTTP_PROXY: fx.proxyUrl, https_proxy: fx.proxyUrl, http_proxy: fx.proxyUrl,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: fx.caFile, GITHUB_API_URL: fx.apiUrl,
    ...(mock ? { VOYAGE_API_KEY: 'pa-upgrade-matrix-mock-not-a-key' } : {}),
  };

  let logSeq = 0;
  const run = async (name: string, cmd: string[], opts: { stdin?: string; timeoutMs?: number; check?: Check; extraEnv?: Record<string, string> } = {}) => {
    const t = Date.now();
    const log = join(logs, String(++logSeq).padStart(2, '0') + '-' + name.replace(/[^a-z0-9-]+/gi, '_') + '.log');
    const proc = Bun.spawn(cmd, { cwd: home, env: { ...env, ...opts.extraEnv }, stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: opts.timeoutMs ?? 300_000, killSignal: 'SIGKILL' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    writeFileSync(log, '$ ' + cmd.join(' ') + '\n[exit ' + code + ' after ' + (Date.now() - t) + ' ms]\n--- stdout\n' + stdout + '\n--- stderr\n' + stderr);
    const step: Step = { name, ok: code === 0, ms: Date.now() - t, exit: code, log: log.slice(dir.length + 1) };
    if (code !== 0) step.detail = (stderr.trim() || stdout.trim()).split('\n').slice(-6).join('\n').slice(0, 800);
    steps.push(step);
    if (code !== 0 && opts.check) fail(opts.check, name + ' exited ' + code + ': ' + (step.detail ?? ''));
    return { code, stdout, stderr };
  };
  const note = (name: string, ok: boolean, detail?: string) => { steps.push({ name, ok, ms: 0, ...(detail ? { detail: detail.slice(0, 800) } : {}) }); };
  const gbrain = (name: string, args: string[], opts: Parameters<typeof run>[2] = {}) => run(name, ['gbrain', ...args], opts);
  const installDir = (root = join(bunDir, 'install', 'global')) => join(root, 'node_modules', 'gbrain');

  const brainChild = (name: string, extra: string[], install = installDir()) => run(name, [
    process.execPath, join(spec.harnessRoot, 'scripts', 'upgrade-matrix', 'snapshot-child.ts'),
    ...(spec.engine === 'pglite' ? ['--pglite', JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).database_path, '--install', install] : ['--url', databaseUrl!]),
    ...extra,
  ], { timeoutMs: 180_000 });
  const snapshot = async (name: string, catalog: boolean): Promise<Snapshot | null> => {
    const r = await brainChild('snapshot-' + name, catalog ? ['--catalog'] : []);
    if (r.code !== 0) return null;
    writeFileSync(join(dir, 'snapshot-' + name + '.json'), r.stdout);
    return JSON.parse(r.stdout) as Snapshot;
  };

  const processes: { serve: StdioMcp | null; supervisor: boolean } = { serve: null, supervisor: false };
  const startServe = async (label: string, cli: string[] = ['gbrain']): Promise<string | null> => {
    const proc = Bun.spawn([...cli, 'serve'], { cwd: home, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const client = new StdioMcp(proc as never);
    processes.serve = client;
    const t = Date.now();
    try {
      const version = await client.initialize();
      steps.push({ name: 'serve-' + label, ok: true, ms: Date.now() - t, detail: 'serverInfo.version ' + version });
      return version;
    } catch (e) {
      steps.push({ name: 'serve-' + label, ok: false, ms: Date.now() - t, detail: String(e) + '\n' + client.stderr.join('').slice(-600) });
      return null;
    }
  };
  const stopServe = async () => { if (processes.serve) { await processes.serve.close(); processes.serve = null; } };
  const stopAll = async () => {
    await stopServe();
    if (processes.supervisor) { await gbrain('supervisor-stop', ['jobs', 'supervisor', 'stop'], { timeoutMs: 60_000 }); processes.supervisor = false; }
  };

  try {
    // ── 1. old release, installed and seeded as a user would ──────────────
    fx.setRefs({ HEAD: spec.from.sha, 'latest-stable': spec.from.sha, stable: spec.from.sha, [spec.from.tag]: spec.from.sha });
    const install = await run('install-old', ['bun', 'install', '-g', 'github:garrytan/gbrain'], { timeoutMs: 600_000, check: 'setup' });
    const oldVersion = install.code === 0 ? (await gbrain('version-old', ['--version'], { check: 'setup' })).stdout.trim() : '';
    if (install.code === 0 && !oldVersion.endsWith(spec.from.version)) fail('setup', 'installed ' + oldVersion + ', expected ' + spec.from.version);
    if (failures.length) throw new SetupError();

    if (spec.engine === 'postgres') {
      if (!spec.postgresUrl) { fail('setup', 'a Postgres cell needs --postgres-url'); throw new SetupError(); }
      const admin = new URL(spec.postgresUrl);
      await adminSql(spec.postgresUrl, 'CREATE DATABASE ' + dbName);
      admin.pathname = '/' + dbName;
      databaseUrl = admin.toString();
    }
    const initArgs = ['init', '--non-interactive',
      ...(spec.engine === 'pglite' ? ['--pglite'] : ['--url', databaseUrl!]),
      ...(spec.keys === 'keyless' ? ['--no-embedding'] : []),
      ...(spec.brain === 'repo' ? ['--git'] : [])];
    await gbrain('init', initArgs, { check: 'setup', timeoutMs: 600_000 });
    if (failures.length) throw new SetupError();

    for (const page of SEED_PAGES) await gbrain('seed-put-' + page.slug.split('/')[1], ['put', page.slug], { stdin: page.body, check: 'setup' });
    await gbrain('seed-remember', ['remember', 'Alice Example reviews storage designs on Tuesdays', '--entity', 'people/alice-example', '--provenance', 'upgrade-matrix seed'], { check: 'setup' });
    const doomed = await gbrain('seed-put-deleted', ['put', DELETED_SLUG], { stdin: '# To be deleted\n\nThis page is soft-deleted before the upgrade.\n', check: 'setup' });
    const revision = parseJson(doomed.stdout)?.revision;
    await gbrain('seed-delete', ['delete', DELETED_SLUG, ...(typeof revision === 'string' ? ['--expected-revision', revision] : [])], { check: 'setup' });
    if (spec.keys === 'keyed') await gbrain('seed-embed', ['embed', '--stale', '--yes'], { check: 'setup' });
    const seedDream = await gbrain('seed-dream', ['dream', '--json'], { timeoutMs: 600_000 });
    receipt.seed_dream = seedDream.code === 0 ? 'ok' : 'failed (exit ' + seedDream.code + '; recorded, not judged: the old release ran it)';
    if (failures.length) throw new SetupError();

    const before = await snapshot('before', false);
    if (!before) { fail('setup', 'could not read the seeded brain'); throw new SetupError(); }
    const oldGlobal = join(dir, 'old-global');
    cpSync(join(bunDir, 'install', 'global'), oldGlobal, { recursive: true, verbatimSymlinks: true });

    const oldServeVersion = await startServe('old');
    if (oldServeVersion !== spec.from.version) { fail('setup', 'the old serve did not answer MCP as ' + spec.from.version + ' (got ' + oldServeVersion + ')'); throw new SetupError(); }
    if (spec.engine === 'postgres') {
      const sup = await gbrain('supervisor-start-old', ['jobs', 'supervisor', 'start', '--detach', '--json'], { timeoutMs: 120_000, check: 'setup' });
      processes.supervisor = sup.code === 0;
      if (failures.length) throw new SetupError();
    }
    const oldServe = processes.serve!;

    // ── 2. the old release's own updater, seeing only the candidate ───────
    const candidateTag = 'v' + spec.candidate.version;
    fx.setRefs({ HEAD: spec.candidate.sha, 'latest-stable': spec.candidate.sha, stable: spec.candidate.sha, [spec.from.tag]: spec.from.sha, [candidateTag]: spec.candidate.sha });
    const switchedAt = fx.requests.length;
    let up = await gbrain('upgrade', ['upgrade'], { timeoutMs: 900_000 });
    if (up.code === 3 && /restart_refused|--stop-mcp/.test(up.stdout + up.stderr)) {
      receipt.upgrade_needed_stop_mcp = true;
      up = await gbrain('upgrade-stop-mcp', ['upgrade', '--stop-mcp'], { timeoutMs: 900_000 });
    }
    if (up.code !== 0) fail('upgrade', 'gbrain upgrade exited ' + up.code + ': ' + (up.stderr || up.stdout).trim().split('\n').slice(-8).join('\n'));

    const served = fx.requests.slice(switchedAt);
    const foreign = served.filter(r => r.sha && r.sha !== spec.candidate.sha && r.status === 200);
    receipt.interposition = { after_switch: served, proxy: dedupe(fx.proxy), denied: dedupe(fx.proxy.filter(p => p.action === 'denied')) };
    if (foreign.length) fail('interposition', 'the updater fetched non-candidate commits: ' + foreign.map(r => r.host + r.path + '@' + r.sha!.slice(0, 7)).join(', '));
    if (!served.some(r => r.sha === spec.candidate.sha && r.status === 200 && /tarball/.test(r.path))) fail('interposition', 'the updater never fetched the candidate tarball from the fixture');

    // ── 3. the installed build is the candidate commit ────────────────────
    const newVersion = (await gbrain('version-new', ['--version'])).stdout.trim();
    const tree = compareInstalledTree(spec.harnessRoot, spec.candidate.sha, installDir());
    const lock = readFileSync(join(bunDir, 'install', 'global', 'bun.lock'), 'utf8');
    const lockSha = /"gbrain@github:garrytan\/gbrain#([0-9a-f]{7,40})"/.exec(lock)?.[1] ?? null;
    receipt.installed = { old_version: oldVersion, new_version: newVersion, lock_sha: lockSha, tree_files: tree.checked, tree_mismatches: tree.mismatches.slice(0, 20), tree_missing: tree.missing.slice(0, 20) };
    if (!newVersion.endsWith(spec.candidate.version)) fail('installed_build', 'gbrain --version says ' + newVersion + ', expected ' + spec.candidate.version);
    if (!lockSha || !spec.candidate.sha.startsWith(lockSha)) fail('installed_build', 'bun.lock pins ' + lockSha + ', expected ' + spec.candidate.sha.slice(0, 7));
    if (tree.mismatches.length || tree.missing.length) fail('installed_build', tree.mismatches.length + ' installed files differ from the candidate tree and ' + tree.missing.length + ' are missing: ' + [...tree.mismatches, ...tree.missing].slice(0, 5).join(', '));

    // ── 4. one build: nothing from before the upgrade still runs ──────────
    if (oldServe.alive) {
      receipt.restart_fix_needed = true;
      const fix = await gbrain('restart-only', ['upgrade', '--restart-only', '--stop-mcp'], { timeoutMs: 900_000 });
      if (fix.code !== 0) fail('one_build', 'gbrain upgrade --restart-only --stop-mcp exited ' + fix.code);
      await Promise.race([oldServe.proc.exited, new Promise(r => setTimeout(r, 20_000))]);
      if (oldServe.alive) fail('one_build', 'the serve started on ' + spec.from.version + ' is still running after the upgrade and restart');
      await oldServe.close();
    }
    processes.serve = null;
    const newServeVersion = await startServe('new');
    if (newServeVersion !== spec.candidate.version) fail('serve', 'the restarted serve reports ' + newServeVersion + ', expected ' + spec.candidate.version);
    else {
      try {
        const hits = await processes.serve!.callTool('search', { query: SEED_WORD });
        if (!hits.includes('upgrade-matrix-alpha')) fail('serve', 'MCP search for the seed word did not return the seeded page');
        note('serve-search', true);
      } catch (e) { fail('serve', String(e)); }
    }
    if (spec.engine === 'postgres') {
      if (processes.supervisor) await waitForWorkerHeartbeat();
      const doc = await gbrain('doctor-processes', ['doctor', '--json'], { timeoutMs: 300_000 });
      const skew = parseJson(doc.stdout)?.checks?.find((c: any) => c.name === 'runtime_build_skew');
      receipt.runtime_build_skew = skew ?? null;
      if (!skew || skew.status !== 'ok') fail('one_build', 'runtime_build_skew is ' + (skew?.status ?? 'missing') + ': ' + String(skew?.message ?? '').slice(0, 300));
    }
    await stopAll();
    const leftovers = gbrainProcessesFor(home);
    if (leftovers.length) fail('one_build', 'gbrain processes still running for this brain after stopping serve and the supervisor: ' + leftovers.join('; '));

    // ── 5. migrations, schema head, doctor ─────────────────────────────────
    await gbrain('apply-migrations', ['apply-migrations', '--yes', '--non-interactive'], { timeoutMs: 900_000, check: 'apply_migrations' });
    const doctor = await gbrain('doctor', DOCTOR_ARGV, { timeoutMs: 300_000 });
    const report = parseJson(doctor.stdout);
    const schema = report?.checks?.find((c: any) => c.name === 'schema_version');
    const m = /Version (\d+) \(latest: (\d+)\)/.exec(String(schema?.message ?? ''));
    receipt.schema_version = schema?.message ?? null;
    if (!m || m[1] !== m[2] || schema.status !== 'ok') fail('schema_head', 'schema_version check: ' + (schema ? schema.status + ' ' + schema.message : 'missing from doctor --json'));
    const dv = doctorVerdict(report);
    receipt.doctor = { source: dv.source, status: report?.status ?? null, health_score: report?.health_score ?? null, failing: dv.failing };
    if (!dv.ok) fail('doctor', dv.failing.length ? dv.failing.join('; ') : 'doctor printed no JSON report (exit ' + doctor.code + ')');

    // ── 6. preservation: canonical content equal before and after ─────────
    if (spec.fault === 'corrupt-after-upgrade') {
      const injected = await brainChild('fault-corrupt', ['--exec', "SET session_replication_role = replica; UPDATE pages SET title = title || ' (corrupted by the upgrade-matrix fault)' WHERE slug = 'concepts/upgrade-matrix-beta'; UPDATE pages SET deleted_at = NULL WHERE slug = '" + DELETED_SLUG + "'"]);
      if (injected.code !== 0) { fail('setup', 'the corruption fault could not be injected'); throw new SetupError(); }
    }
    const after = await snapshot('after', true);
    if (!after) fail('preservation', 'could not read the upgraded brain');
    else {
      const diffs = diffContent(before, after);
      receipt.preservation = { differences: diffs.slice(0, 50), compared: Object.fromEntries(Object.entries(before.content).map(([t, v]) => [t, v.rows.length])) };
      if (diffs.length) fail('preservation', diffs.length + ' canonical differences: ' + diffs.slice(0, 5).map(d => d.kind + ' ' + d.where).join('; '));
    }

    // ── 7. the upgraded brain works ────────────────────────────────────────
    const newSlug = 'concepts/upgrade-matrix-after';
    await gbrain('write', ['put', newSlug], { stdin: '# After the upgrade\n\nWritten by the candidate; it mentions ' + NEW_WORD + '.\n', check: 'write' });
    for (const [word, slug] of [[SEED_WORD, 'upgrade-matrix-alpha'], [NEW_WORD, 'upgrade-matrix-after']] as const) {
      const s = await gbrain('search-' + word, ['search', word], { check: 'keyword_search' });
      if (s.code === 0 && !s.stdout.includes(slug)) fail('keyword_search', 'search ' + word + ' did not return ' + slug);
    }
    if (mock) {
      const calls = mock.stats.embed_inputs;
      await gbrain('embed-new', ['embed', newSlug, '--yes'], { check: 'vector_search' });
      if (mock.stats.embed_inputs <= calls) fail('vector_search', 'embedding the new page made no provider call');
      const queried = mock.stats.embed_calls;
      const q = await gbrain('vector-query', ['query', 'lighthouse maintenance schedules and tidal charts'], { check: 'vector_search' });
      if (mock.stats.embed_calls <= queried) fail('vector_search', 'query did not embed the question (no vector arm)');
      if (q.code === 0 && !q.stdout.includes('upgrade-matrix-beta')) fail('vector_search', 'query did not return the matching seed page');
    }
    await gbrain('dream', ['dream', '--json'], { timeoutMs: 600_000, check: 'dream' });

    // ── 8. mixed versions: the old binary on the upgraded brain ───────────
    const pre = await snapshot('mixed-before', true);
    const oldCli = [process.execPath, join(installDir(oldGlobal), 'src', 'cli.ts')];
    await run('old-version', [...oldCli, '--version']);
    await run('old-search', [...oldCli, 'search', SEED_WORD]);
    await run('old-doctor', [...oldCli, 'doctor', '--json'], { timeoutMs: 300_000 });
    const oldAgain = await startServe('old-again', oldCli);
    receipt.old_serve_on_upgraded_brain = oldAgain ?? 'did not answer MCP (recorded, not judged)';
    if (oldAgain) { try { await processes.serve!.callTool('search', { query: SEED_WORD }); } catch { /* the old build may refuse; only mutation is judged */ } }
    await stopAll();
    const post = pre ? await snapshot('mixed-after', true) : null;
    if (!pre || !post) fail('mixed_version', 'could not snapshot the brain around the old binary');
    else {
      const diffs: Difference[] = [...diffCatalog(pre, post), ...diffContent(pre, post)];
      receipt.mixed_version = { differences: diffs.slice(0, 50) };
      if (diffs.length) fail('mixed_version', diffs.length + ' schema or content changes by ' + spec.from.version + ': ' + diffs.slice(0, 5).map(d => d.kind + ' ' + d.where).join('; '));
    }
  } catch (e) {
    if (!(e instanceof SetupError)) fail('setup', 'harness error: ' + (e instanceof Error ? e.stack ?? e.message : String(e)));
  } finally {
    await stopAll().catch(() => {});
    for (const pid of gbrainPids(home)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fx.stop();
    mock?.stop();
    if (databaseUrl && spec.postgresUrl) await adminSql(spec.postgresUrl, 'DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)').catch(() => {});
  }

  const judged = judgeCell(spec.from.tag, failures, spec.exceptions);
  receipt.verdict = spec.fault && judged.verdict === 'pass' ? 'fail' : judged.verdict;
  receipt.failures = judged.open;
  receipt.known_exceptions = judged.excepted;
  receipt.service_calls = existsSync(serviceLog) ? readFileSync(serviceLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  receipt.steps = steps;
  receipt.elapsed_s = Math.round((Date.now() - started) / 1000);
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;


  async function waitForWorkerHeartbeat(): Promise<void> {
    await new Promise(r => setTimeout(r, 15_000));
  }
}

class SetupError extends Error {}

async function adminSql(url: string, statement: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try { await sql.unsafe(statement); } finally { await sql.end({ timeout: 5 }); }
}

function parseJson(text: string): any {
  try { return JSON.parse(text); } catch {
    const start = text.indexOf('{');
    try { return start >= 0 ? JSON.parse(text.slice(start)) : null; } catch { return null; }
  }
}

function dedupe<T extends { host: string; action: string }>(rows: T[]): T[] {
  return rows.filter((r, i) => rows.findIndex(o => o.host === r.host && o.action === r.action) === i);
}

/** Every blob in the candidate's tree compared with the installed package (git hash-object), skipping paths Bun does not install. */
export function compareInstalledTree(repo: string, sha: string, installed: string): { checked: number; mismatches: string[]; missing: string[] } {
  const listing = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--full-tree', sha], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const mismatches: string[] = [], missing: string[] = [];
  const paths: string[] = [], expected: string[] = [];
  for (const line of listing.split('\n')) {
    const m = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (!m || m[1] === '120000' || m[1] === '160000') continue;
    const path = m[3]!;
    if (path.startsWith('.git/') || /(^|\/)node_modules\//.test(path)) continue;
    if (!existsSync(join(installed, path))) { missing.push(path); continue; }
    paths.push(path); expected.push(m[2]!);
  }
  for (let i = 0; i < paths.length; i += 2000) {
    const chunk = paths.slice(i, i + 2000);
    const got = execFileSync('git', ['hash-object', '--no-filters', '--stdin-paths'], { cwd: installed, input: chunk.join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');
    chunk.forEach((p, j) => { if (got[j] !== expected[i + j]) mismatches.push(p); });
  }
  return { checked: paths.length, mismatches, missing };
}

function gbrainPids(home: string): number[] {
  const out: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const environ = readFileSync('/proc/' + entry + '/environ', 'utf8');
      if (environ.split('\0').includes('GBRAIN_HOME=' + home)) out.push(Number(entry));
    } catch { /* gone or not ours */ }
  }
  return out;
}

function gbrainProcessesFor(home: string): string[] {
  return gbrainPids(home).map(pid => {
    try { return pid + ' ' + readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ').trim().slice(0, 200); } catch { return String(pid); }
  });
}
