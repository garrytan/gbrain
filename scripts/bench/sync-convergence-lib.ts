/**
 * Helpers for scripts/bench/sync-convergence.ts (#6712 PR 4a): the large-repo
 * fixture (git fast-import, cached by file count and content version), the
 * direct-SQL seeding of a converged managed source (pages plus import
 * provenance), the Docker Postgres and transaction-mode PgBouncer, the RSS
 * sampler and the nearest-rank statistics. Synthetic content only; every
 * listener binds loopback.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem, release } from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveSlugForPath } from '../../src/core/sync.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { recordSyncImportProvenances, syncImportParserFor, type SyncImportProvenance } from '../../src/core/persistence/sync-holds.ts';
import { gitBlobOid, sha256 } from '../../src/core/persistence/digest.ts';
import { PHYSICAL_ROOT_MARKER } from '../../src/core/persistence/root-metadata.ts';
import { loadActivePackForEngine } from '../../src/core/schema-pack/engine-resolution.ts';
import { VERSION } from '../../src/version.ts';
import { PGBOUNCER_IMAGE } from './managed-sync-catchup-lib.ts';

/** Bump when fixture paths or bytes change, so cached fixtures are regenerated. */
export const FIXTURE_CONTENT_VERSION = 1;
/** Every every-th file (i % every === every - 1) is a large Markdown file of bytes plus up to bytes/16 more. */
export interface LargeBlobs { every: number; bytes: number }
export interface FixtureShape { files: number; large?: LargeBlobs }
export const PRESETS: Record<string, FixtureShape> = { '61k': { files: 61_000 }, '600k': { files: 600_000 },
  '6858': { files: 308_000, large: { every: 100, bytes: 2_150_000 } } };
const COMMITTER = 'Bench Fixture <bench@example.invalid>';
const BASE_TIME = 1_700_000_000;

// ─── fixture content ─────────────────────────────────────────────────

const WORDS = ['synthetic', 'note', 'body', 'field', 'value', 'record', 'entry', 'example', 'sample', 'paragraph', 'section', 'detail',
  'item', 'topic', 'thread', 'outline', 'summary', 'draft', 'margin', 'index', 'column', 'ledger', 'signal', 'vector'];
const FILLER = (() => {
  let k = 12345, out = '';
  for (let w = 0; out.length < 8192; w++) {
    k = (Math.imul(k, 1103515245) + 12345) >>> 0;
    out += WORDS[k % WORDS.length] + ((w + 1) % 12 === 0 ? '\n' : ' ');
  }
  return out;
})();
const FILLER_BYTES = Buffer.from(FILLER);

/** The git path of file i: two levels of 100-way directory fan-out. */
export function fixturePath(i: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `d${pad(i % 100)}/e${pad(Math.floor(i / 100) % 100)}/note-${i}.md`;
}

/** The bytes of file i (ASCII, 1-2 KB, or a large file under large), optionally with a drift marker appended. */
export function fixtureContent(i: number, drift?: number, large?: LargeBlobs): Buffer {
  const length = 1024 + ((i * 7919) % 1024);
  const offset = (i * 131) % 4096;
  const tail = drift === undefined ? '' : `\nDrift edit ${drift}.\n`;
  if (large && i % large.every === large.every - 1) {
    const body = Buffer.alloc(large.bytes + ((i * 7919) % (large.bytes >> 4)));
    for (let at = 0, k = i; at < body.length; at += 4096) {
      k = (Math.imul(k, 1103515245) + 12345) >>> 0;
      FILLER_BYTES.copy(body, at, k % 4096, (k % 4096) + Math.min(4096, body.length - at));
    }
    return Buffer.concat([Buffer.from(`---\ntitle: Note ${i}\n---\nSynthetic body ${i}.\n\n`), body, Buffer.from(`\n${tail}`)]);
  }
  return Buffer.from(`---\ntitle: Note ${i}\n---\nSynthetic body ${i}.\n\n${FILLER.slice(offset, offset + length)}\n${tail}`);
}

// ─── git ─────────────────────────────────────────────────────────────

export function git(repo: string, args: string[], input?: string): string {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function gitVersion(): string { return spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.trim(); }

/** Streams a fast-import program to git fast-import, honouring pipe backpressure. */
async function fastImport(repo: string, produce: (write: (chunk: string | Buffer) => Promise<void>) => Promise<void>): Promise<void> {
  const child = spawn('git', ['-C', repo, 'fast-import', '--quiet', '--done'], { stdio: ['pipe', 'inherit', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise<number>(resolve => child.on('close', code => resolve(code ?? 1)));
  const pending: Buffer[] = [];
  let size = 0;
  const flush = async () => {
    if (!size) return;
    const chunk = Buffer.concat(pending); pending.length = 0; size = 0;
    if (!child.stdin.write(chunk)) await new Promise<void>(resolve => child.stdin.once('drain', () => resolve()));
  };
  const write = async (chunk: string | Buffer) => {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    pending.push(b); size += b.length;
    if (size >= 1 << 20) await flush();
  };
  await produce(write);
  await write('done\n');
  await flush();
  child.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`git fast-import failed (${code}): ${stderr}`);
}

function inlineFile(path: string, bytes: Buffer): Buffer[] {
  return [Buffer.from(`M 100644 inline ${path}\ndata ${bytes.length}\n`), bytes, Buffer.from('\n')];
}

export interface Fixture { dir: string; repo: string; files: number; large?: LargeBlobs; base: string; cached: boolean; generate_ms: number; timings_ms: Record<string, number> }

/**
 * The cached fixture repository for files files, generated on first use: one
 * fast-import commit of every file on main, then read-tree -u --reset to
 * materialize the worktree and an index refresh so the index is stat-clean.
 * A READY stamp marks a complete generation; anything else is regenerated.
 */
export async function ensureFixture(cacheDir: string, files: number, log: (line: string) => void, large?: LargeBlobs): Promise<Fixture> {
  const dir = join(cacheDir, `${files}${large ? `-L${large.every}x${large.bytes}` : ''}-v${FIXTURE_CONTENT_VERSION}`);
  const repo = join(dir, 'repo');
  const ready = join(dir, 'READY');
  if (existsSync(ready)) {
    const stamp = JSON.parse(readFileSync(ready, 'utf8')) as { base: string; files: number; timings_ms?: Record<string, number> };
    if (stamp.files === files) return { dir, repo, files, large, base: stamp.base, cached: true, generate_ms: 0, timings_ms: stamp.timings_ms ?? {} };
  }
  const started = performance.now();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'gc.auto', '0']);
  log(`fixture: generating ${files} files with git fast-import in ${repo}`);
  await fastImport(repo, async write => {
    await write(`commit refs/heads/main\ncommitter ${COMMITTER} ${BASE_TIME} +0000\ndata 18\nsynthetic fixture\n`);
    for (let i = 0; i < files; i++) for (const part of inlineFile(fixturePath(i), fixtureContent(i, undefined, large))) await write(part);
    await write('\n');
  });
  const imported = performance.now();
  git(repo, ['read-tree', '-u', '--reset', 'HEAD']);
  const materialized = performance.now();
  await Bun.sleep(1100);
  git(repo, ['update-index', '-q', '--refresh']);
  const refreshed = performance.now();
  const base = git(repo, ['rev-parse', 'HEAD']);
  for (const i of [...new Set([0, files - 1, ...(large && files >= large.every ? [large.every - 1] : [])])]) {
    const expected = gitBlobOid(fixtureContent(i, undefined, large), base.length === 64 ? 'sha256' : 'sha1');
    const actual = git(repo, ['rev-parse', `HEAD:${fixturePath(i)}`]);
    if (actual !== expected) throw new Error(`fixture blob mismatch for ${fixturePath(i)}: git ${actual}, generator ${expected}`);
  }
  const generate_ms = performance.now() - started;
  const timings_ms = { fast_import: Math.round(imported - started), read_tree: Math.round(materialized - imported),
    index_refresh: Math.round(refreshed - materialized), total: Math.round(generate_ms) };
  log(`fixture: ${JSON.stringify(timings_ms)} ms`);
  writeFileSync(ready, JSON.stringify({ base, files, content_version: FIXTURE_CONTENT_VERSION, timings_ms }) + '\n');
  return { dir, repo, files, large, base, cached: false, generate_ms, timings_ms };
}

/** Moves main and the worktree back to the fixture's base commit (a previous run's drift commit is discarded). */
export function resetFixture(fixture: Fixture): void {
  if (git(fixture.repo, ['rev-parse', 'HEAD']) === fixture.base && !git(fixture.repo, ['status', '--porcelain', '--untracked-files=no'])) return;
  git(fixture.repo, ['update-ref', 'refs/heads/main', fixture.base]);
  git(fixture.repo, ['read-tree', '-u', '--reset', fixture.base]);
}

/** Commits an edit to k evenly spaced files on top of HEAD (fast-import) and checks it out; returns the new HEAD and the edited paths. */
export async function applyDrift(fixture: Fixture, k: number): Promise<{ head: string; paths: string[] }> {
  const from = git(fixture.repo, ['rev-parse', 'HEAD']);
  const indices = [...new Set(Array.from({ length: k }, (_, j) => Math.floor((j * fixture.files) / k)))];
  const message = `drift ${indices.length}\n`;
  await fastImport(fixture.repo, async write => {
    await write(`commit refs/heads/main\ncommitter ${COMMITTER} ${BASE_TIME + 60} +0000\ndata ${message.length}\n${message}from ${from}\n`);
    for (const [j, i] of indices.entries()) for (const part of inlineFile(fixturePath(i), fixtureContent(i, j, fixture.large))) await write(part);
    await write('\n');
  });
  git(fixture.repo, ['read-tree', '-u', '--reset', 'refs/heads/main']);
  return { head: git(fixture.repo, ['rev-parse', 'HEAD']), paths: indices.map(fixturePath) };
}

/**
 * Removes this bench's own physical-root claim files from a cached fixture
 * (the sibling reservation and the in-root marker), which name the brain of a
 * previous run, so a fresh brain can claim the checkout again.
 */
export function clearPhysicalRootClaims(fixture: Fixture): void {
  for (const name of readdirSync(dirname(fixture.repo))) if (name.startsWith('.gbrain-owner-') && name.endsWith('.json')) rmSync(join(dirname(fixture.repo), name), { force: true });
  rmSync(join(fixture.repo, PHYSICAL_ROOT_MARKER), { force: true });
}

// ─── seeding ─────────────────────────────────────────────────────────

export interface SeedResult { source_id: string; incarnation: string; pages: number; timings_ms: Record<string, number> }

/**
 * Seeds a converged managed source by direct SQL, the way a finished managed
 * import leaves it: the source row (last_commit = the fixture base), the
 * worktree claim, one page per file (path-derived slug, settled text
 * projection) and one import provenance record per page whose blob and disk
 * OIDs are the file's blob and whose parser names the active schema pack, as
 * the managed import records it. Writes run with persistence_brain disabled (as
 * test fixtures do, so the managed-writer trigger admits them) and re-enable it
 * at the end. ANALYZE runs after batches 1, 2, 4, 8, ... and at the end: the
 * per-row bump_page_generation_fn trigger runs SELECT MAX(generation) FROM
 * pages, and a plan cached while the table was empty is a sequential scan, so
 * without fresh statistics seeding is quadratic (PGLite has no autovacuum).
 */
export async function seedSource(engine: BrainEngine, input: { sourceId: string; fixture: Fixture; batch: number; log: (line: string) => void }): Promise<SeedResult> {
  const { sourceId, fixture, batch, log } = input;
  const timings_ms: Record<string, number> = {};
  const time = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try { return await run(); } finally { timings_ms[key] = Math.round(performance.now() - t); }
  };
  const format = fixture.base.length === 64 ? 'sha256' : 'sha1';
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await time('source_row', () => engine.executeRaw("INSERT INTO sources(id,name,local_path,config,last_commit,last_sync_at) VALUES($1,$1,$2,'{}',$3,now())",
      [sourceId, fixture.repo, fixture.base]));
    clearPhysicalRootClaims(fixture);
    await time('worktree_claim', () => claimWorktree(engine, sourceId, fixture.repo));
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
    const pack = await loadActivePackForEngine(engine, { remote: false, sourceId }).catch(() => null);
    const parser = syncImportParserFor(fixturePath(0), pack?.identity ?? null);
    let pagesMs = 0, provenanceMs = 0, analyzeMs = 0, nextAnalyze = 1;
    for (let start = 0, batchNo = 1; start < fixture.files; start += batch, batchNo++) {
      const end = Math.min(fixture.files, start + batch);
      const rows: Array<{ slug: string; title: string; body: string; path: string; revision: string }> = [];
      const disk = new Map<string, { sha: string; oid: string; revision: string }>();
      for (let i = start; i < end; i++) {
        const path = fixturePath(i), bytes = fixtureContent(i, undefined, fixture.large), revision = randomUUID();
        rows.push({ slug: resolveSlugForPath(path), title: `Note ${i}`, body: `Synthetic body ${i}.`, path, revision });
        disk.set(path, { sha: sha256(bytes), oid: gitBlobOid(bytes, format), revision });
      }
      let t = performance.now();
      const inserted = await engine.executeRaw<{ id: number; source_path: string }>(`INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth,source_path,knowledge_revision,text_projection_revision)
        SELECT $1, x.slug, 'note', 'markdown', x.title, x.body, x.path, x.revision::uuid, x.revision::uuid
        FROM jsonb_to_recordset($2::text::jsonb) AS x(slug text, title text, body text, path text, revision text)
        RETURNING id, source_path`, [sourceId, JSON.stringify(rows)]);
      pagesMs += performance.now() - t;
      if (inserted.length !== rows.length) throw new Error(`seeded ${inserted.length} of ${rows.length} pages in the batch at ${start}`);
      const records: Array<Omit<SyncImportProvenance, 'recorded_at' | 'validated'>> = inserted.map(row => {
        const d = disk.get(row.source_path)!;
        return { source_id: sourceId, incarnation, page_id: Number(row.id), origin: row.source_path, raw_sha256: d.sha, blob_oid: d.oid, working: false,
          gbrain_version: VERSION, disk_sha256: d.sha, disk_blob_oid: d.oid, revision: d.revision, parser };
      });
      t = performance.now();
      await recordSyncImportProvenances(engine, records);
      provenanceMs += performance.now() - t;
      if (batchNo === nextAnalyze) {
        t = performance.now();
        await engine.executeRaw('ANALYZE pages');
        await engine.executeRaw('ANALYZE op_checkpoints');
        analyzeMs += performance.now() - t;
        nextAnalyze *= 2;
      }
      if (end === fixture.files || batchNo % 20 === 0) log(`seed: ${end}/${fixture.files} pages`);
    }
    timings_ms.pages = Math.round(pagesMs);
    timings_ms.provenance = Math.round(provenanceMs);
    timings_ms.analyze_during = Math.round(analyzeMs);
    await time('analyze', () => engine.executeRaw('ANALYZE'));
    return { source_id: sourceId, incarnation, pages: fixture.files, timings_ms };
  } finally {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }
}

// ─── Docker Postgres and PgBouncer ───────────────────────────────────

function docker(args: string[], allowFail = false): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}

async function waitForSql(url: string, what: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      const probe = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 2, prepare: false });
      try { await probe`SELECT 1`; } finally { await probe.end(); }
      return;
    } catch (error) { if (i > 90) throw new Error(`${what} did not accept connections: ${(error as Error).message}`); }
    await Bun.sleep(1000);
  }
}

export const PG_CONTAINER = 'gbrain-bench-conv-pg';
export const PGBOUNCER_CONTAINER = 'gbrain-bench-conv-pgbouncer';
const PGBOUNCER_POOL = { POOL_MODE: 'transaction', DEFAULT_POOL_SIZE: '50', MAX_CLIENT_CONN: '2000',
  IGNORE_STARTUP_PARAMETERS: 'extra_float_digits,options,statement_timeout,idle_in_transaction_session_timeout' };

/** Starts (or reuses) a loopback pgvector Postgres 16 container; returns its admin URL and whether this call started it. */
export async function ensurePostgres(port: number): Promise<{ adminUrl: string; started: boolean }> {
  let started = false;
  if (!docker(['ps', '-q', '-f', `name=^${PG_CONTAINER}$`])) {
    docker(['rm', '-f', PG_CONTAINER], true);
    docker(['run', '-d', '--name', PG_CONTAINER, '-p', `127.0.0.1:${port}:5432`, '-e', 'POSTGRES_PASSWORD=postgres', '--shm-size=1g',
      'pgvector/pgvector:pg16', '-c', 'max_connections=400']);
    started = true;
  }
  const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  await waitForSql(adminUrl, 'Postgres');
  return { adminUrl, started };
}

/** Recreates a transaction-mode PgBouncer (host network, loopback) in front of upstreamPort; returns its settings. */
export async function startPgbouncer(adminUrl: string, upstreamPort: number, listenPort: number): Promise<Record<string, string>> {
  const admin = new URL(adminUrl);
  docker(['rm', '-f', PGBOUNCER_CONTAINER], true);
  const env = { DB_HOST: '127.0.0.1', DB_PORT: String(upstreamPort), DB_USER: decodeURIComponent(admin.username), DB_PASSWORD: decodeURIComponent(admin.password),
    AUTH_TYPE: 'scram-sha-256', LISTEN_ADDR: '127.0.0.1', LISTEN_PORT: String(listenPort), ...PGBOUNCER_POOL };
  docker(['run', '-d', '--name', PGBOUNCER_CONTAINER, '--network', 'host', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), PGBOUNCER_IMAGE]);
  const viaPooler = new URL(adminUrl); viaPooler.port = String(listenPort);
  await waitForSql(viaPooler.toString(), 'PgBouncer');
  return { image: PGBOUNCER_IMAGE, listen: `127.0.0.1:${listenPort}`, ...Object.fromEntries(Object.entries(PGBOUNCER_POOL).map(([k, v]) => [k.toLowerCase(), v])) };
}

export function removeContainer(name: string): void { docker(['rm', '-f', name], true); }

/** Median of 20 SELECT 1 round trips on one unprepared connection. */
export async function measureRtt(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => {}, prepare: false });
  try {
    await sql`SELECT 1`;
    const xs: number[] = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); await sql.unsafe('SELECT 1').simple(); xs.push(performance.now() - t); }
    return summarize(xs).p50!;
  } finally { await sql.end(); }
}

// ─── statistics and process memory ───────────────────────────────────

export interface Summary { n: number; p50: number | null; p95: number | null; max: number | null; mean: number | null }
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Nearest-rank percentile: the smallest sample with at least p% of samples at or below it (with 7 samples, p95 is the max). */
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
}

export function summarize(xs: readonly number[]): Summary {
  if (!xs.length) return { n: 0, p50: null, p95: null, max: null, mean: null };
  return { n: xs.length, p50: round1(percentile(xs, 50)!), p95: round1(percentile(xs, 95)!), max: round1(Math.max(...xs)),
    mean: round1(xs.reduce((a, b) => a + b, 0) / xs.length) };
}

/** Per-key summaries over rounds' timings_ms (a key missing from a round is not counted for that round). */
export function breakdown(rounds: ReadonlyArray<Record<string, number>>): Record<string, Summary> {
  const keys = [...new Set(rounds.flatMap(r => Object.keys(r)))].sort();
  return Object.fromEntries(keys.map(key => [key, summarize(rounds.flatMap(r => typeof r[key] === 'number' ? [r[key]!] : []))]));
}

/** Samples process.memoryUsage().rss every everyMs: phasePeak() is the maximum since the last mark(), stop() the overall maximum. */
/**
 * RSS every `everyMs` (overall and per phase peaks), and the event loop's lag: how late each tick fired past `everyMs`,
 * the longest stretch a pass kept timers from running (#6712 PR 4b, ruling 4).
 */
export function startRssSampler(everyMs: number): { phasePeak: () => number; phaseLag: () => number; mark: () => void; stop: () => { peak: number; samples: number; maxLagMs: number } } {
  let peak = process.memoryUsage().rss, phase = peak, samples = 1, last = performance.now(), maxLag = 0, phaseLag = 0;
  const timer = setInterval(() => {
    const now = performance.now(), lag = Math.max(0, now - last - everyMs);
    last = now;
    if (lag > maxLag) maxLag = lag;
    if (lag > phaseLag) phaseLag = lag;
    const rss = process.memoryUsage().rss; samples++; if (rss > peak) peak = rss; if (rss > phase) phase = rss;
  }, everyMs);
  return {
    phasePeak: () => Math.max(phase, process.memoryUsage().rss),
    phaseLag: () => Math.round(phaseLag),
    mark: () => { phase = process.memoryUsage().rss; phaseLag = 0; },
    stop: () => { clearInterval(timer); return { peak: Math.max(peak, process.memoryUsage().rss), samples, maxLagMs: Math.round(maxLag) }; },
  };
}

/** VmHWM (peak resident set) from /proc/self/status, in bytes; null off Linux. */
export function readVmHwm(): number | null {
  try { const m = /^VmHWM:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/self/status', 'utf8')); return m ? Number(m[1]) * 1024 : null; } catch { return null; }
}

export const mib = (bytes: number | null) => bytes === null ? null : round1(bytes / (1 << 20));

export function hostInfo(): Record<string, unknown> {
  const list = cpus();
  return { cpu_count: list.length, cpu_model: list[0]?.model ?? null, mem_total_mib: mib(totalmem()), platform: process.platform, kernel: release(), bun: Bun.version };
}
