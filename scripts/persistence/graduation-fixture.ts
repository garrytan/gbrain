/**
 * Graduation fixtures: on-disk PGLite brains with real persistence history,
 * ready for `foresights migrate --to postgres`.
 *
 * Kinds:
 * - `history`: a thin wrapper over `buildHistoryFixture` (`history-fixture.ts`,
 *   1..10,000 pages). After the build every content chunk gets a
 *   deterministic vector, so the round trip carries embeddings while the
 *   brain stays keyless.
 * - `legacy`: the independent hand-built fixture in
 *   `test/fixtures/graduation/legacy-brain.ts` with its expected.json.
 *
 * A fixture directory holds `brain.pglite` (the data dir), `home` (its
 * GBRAIN_HOME with config.json, host identity, writer credentials and managed
 * root registry), `root` (the Git checkouts) and `fixture.json` (build
 * outputs, the report). Builds run in a child process with provider keys
 * removed. Each build is cached as a tarball keyed by the fixture source files'
 * sha256, the schema version and the build options (seed included); a cache
 * hit extracts the tarball and re-homes it: absolute paths in the database,
 * the managed-root registry and the owner stamps are rewritten for the new
 * directory, and the stamps take the new directories' device, inode and birth
 * time. The 10k history build takes about 18 minutes, so CI builds it once per
 * run and every 10k test restores it.
 *
 *   bun scripts/persistence/graduation-fixture.ts --kind history --pages 1000 --seed 1 --out <dir> [--json]
 *   bun scripts/persistence/graduation-fixture.ts --kind legacy --out <dir>
 *
 * Options: --sources N (default 4), --worktrees N (default 2), --cache-dir DIR
 * (default $GBRAIN_GRADUATION_FIXTURE_CACHE or ~/.cache/gbrain-graduation-fixtures),
 * --no-cache. Synthetic data only; bearer tokens in fixture.json are valid
 * only inside the scratch brain.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export type GraduationFixtureKind = 'history' | 'legacy';
export interface GraduationFixtureOptions {
  kind: GraduationFixtureKind;
  /** history only (1..10,000). */
  pages?: number;
  seed?: number;
  sources?: number;
  worktrees?: number;
  /** Destination directory; must not exist or be empty. */
  dir: string;
  cacheDir?: string | null;
  /** Child build timeout; the 10k history build needs about 20 minutes. */
  timeoutMs?: number;
}
export interface GraduationFixtureReport {
  kind: GraduationFixtureKind;
  pages: number;
  /** On-disk bytes of the PGLite data dir, and the sum of pg_total_relation_size over public tables. */
  bytes: { data_dir: number; relations: number };
  chunks: number;
  versions: number;
  requests: number;
  effects: number;
  embeddings: { chunks: number; facts: number; takes: number };
  facts: number;
  withdrawals: number;
  build_ms: number;
}
export interface GraduationFixture {
  kind: GraduationFixtureKind;
  key: string;
  dir: string;
  dataDir: string;
  home: string;
  root: string;
  cached: boolean;
  report: GraduationFixtureReport;
  /** Build outputs: history fixture ids and synthetic tokens, or the legacy fixture's ids. */
  outputs: Record<string, unknown>;
}

const REPO = resolve(import.meta.dir, '..', '..');
/** Files whose bytes decide what a build produces, per kind (the cache key covers exactly these). */
const KEY_FILES: Record<GraduationFixtureKind, readonly string[]> = {
  history: ['scripts/persistence/graduation-fixture.ts', 'scripts/persistence/history-fixture.ts', 'scripts/persistence/ops.ts'],
  legacy: ['scripts/persistence/graduation-fixture.ts', 'scripts/persistence/ops.ts', 'test/fixtures/graduation/legacy-brain.ts', 'test/fixtures/graduation/expected.json'],
};
const PROVIDER_KEYS = /^(OPENAI|ANTHROPIC|VOYAGE|GEMINI|GOOGLE|TYPESAFE|JEV_TYPESAFE|OPENROUTER|GROQ|MISTRAL|COHERE|DEEPSEEK|XAI)_/;

function normalized(opts: GraduationFixtureOptions) {
  return opts.kind === 'legacy' ? { kind: 'legacy' as const }
    : { kind: 'history' as const, pages: opts.pages ?? 1000, seed: opts.seed ?? 1, sources: opts.sources ?? 4, worktrees: opts.worktrees ?? 2 };
}

/** sha256 over the fixture source files, the schema version and the build options. */
export async function graduationFixtureKey(opts: GraduationFixtureOptions): Promise<string> {
  const { LATEST_VERSION } = await import('../../src/core/migrate.ts');
  const hash = createHash('sha256');
  for (const file of KEY_FILES[opts.kind]) hash.update(file).update(readFileSync(join(REPO, file)));
  hash.update(JSON.stringify({ schema: LATEST_VERSION, ...normalized(opts) }));
  return hash.digest('hex').slice(0, 32);
}

function defaultCacheDir(): string {
  return process.env.GBRAIN_GRADUATION_FIXTURE_CACHE || join(homedir(), '.cache', 'gbrain-graduation-fixtures');
}

function run(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): string {
  const result = Bun.spawnSync(argv, { cwd: opts.cwd, env: opts.env as Record<string, string>, stdout: 'pipe', stderr: 'pipe', timeout: opts.timeoutMs });
  if (result.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} exited ${result.exitCode}${result.signalCode ? ` (${result.signalCode})` : ''}\n${result.stderr.toString().slice(-4000)}`);
  return result.stdout.toString();
}

/** Prepare a fixture in `opts.dir`, from the cache when its key matches, otherwise by building it in a child process. */
export async function prepareGraduationFixture(opts: GraduationFixtureOptions): Promise<GraduationFixture> {
  const dir = resolve(opts.dir);
  if (existsSync(dir)) assert.equal(readdirSync(dir).length, 0, `graduation fixture: ${dir} must be empty`);
  mkdirSync(dir, { recursive: true });
  const key = await graduationFixtureKey(opts);
  const cacheDir = opts.cacheDir === null ? null : resolve(opts.cacheDir ?? defaultCacheDir());
  const tarball = cacheDir ? join(cacheDir, `${opts.kind}-${key}.tar.gz`) : null;
  if (tarball && existsSync(tarball)) {
    run(['tar', '-xpzf', tarball, '-C', dir]);
    await rehomeFixture(dir);
    return { ...readMeta(dir), cached: true };
  }
  const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([name]) => !PROVIDER_KEYS.test(name)));
  delete env.DATABASE_URL; delete env.GBRAIN_DATABASE_URL;
  env.GBRAIN_HOME = join(dir, 'home');
  env.GBRAIN_NO_SNAPSHOT = '1';
  run([process.execPath, '--no-env-file', import.meta.path, '--build-child', JSON.stringify({ ...normalized(opts), key, dir })],
    { cwd: REPO, env, timeoutMs: opts.timeoutMs ?? 30 * 60_000 });
  if (tarball) {
    mkdirSync(cacheDir!, { recursive: true });
    const staged = `${tarball}.${process.pid}.tmp`;
    run(['tar', '-cpzf', staged, '-C', dir, '.']);
    renameSync(staged, tarball);
  }
  return { ...readMeta(dir), cached: false };
}

function readMeta(dir: string): Omit<GraduationFixture, 'cached'> {
  const meta = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
  return { kind: meta.kind, key: meta.key, dir, dataDir: join(dir, 'brain.pglite'), home: join(dir, 'home'), root: join(dir, 'root'),
    report: meta.report, outputs: meta.outputs };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== '.git' && entry.name !== 'brain.pglite') walk(path, visit); }
    else if (entry.isFile()) visit(path);
  }
}

/**
 * Rewrite a restored fixture for its new directory: database paths, small
 * JSON identity files (and their path-hash file names), then re-stamp every
 * owner stamp and reservation with the new directories' device, inode and
 * birth time. Only the synthetic fixture's own private files are touched.
 */
export async function rehomeFixture(dir: string): Promise<void> {
  const metaPath = join(dir, 'fixture.json');
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const from: string = meta.builtAt;
  const swap = (text: string) => text.split(from).join(dir);
  const files: string[] = [];
  walk(dir, path => { if (path.endsWith('.json') && statSync(path).size <= 65_536) files.push(path); });
  files.push(join(dir, 'brain.pglite', '.gbrain-managed'));
  const oldPaths = new Set<string>();
  for (const file of files) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/"(?:root|local_path)":"([^"]+)"/g)) oldPaths.add(match[1]);
    if (text.includes(from)) writeFileSync(file, swap(text), { mode: statSync(file).mode & 0o777 });
  }
  const renamed = new Map([...oldPaths].map(path => [sha(path), sha(swap(path))]));
  for (const file of files) {
    if (!existsSync(file)) continue;
    const name = basename(file).replace(/[a-f0-9]{64}/, hash => renamed.get(hash) ?? hash);
    if (name !== basename(file)) renameSync(file, join(dirname(file), name));
  }
  walk(dir, path => {
    const name = basename(path);
    if (name !== '.gbrain-owner.json' && !/^\.gbrain-owner-[a-f0-9]{64}\.json$/.test(name)) return;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const info = statSync(value.root, { bigint: true });
    const stamped = name === '.gbrain-owner.json'
      ? { ...value, device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString() }
      : value.initialInode !== null
        ? { ...value, initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString() }
        : value;
    writeFileSync(path, JSON.stringify(stamped), { mode: 0o600 });
  });
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: join(dir, 'brain.pglite') });
  try {
    await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
      await tx.executeRaw('UPDATE sources SET local_path=replace(local_path,$1,$2) WHERE local_path LIKE $3', [from, dir, `${from}%`]);
      await tx.executeRaw(`UPDATE persistence_host_bindings SET local_path=replace(local_path,$1,$2),coordination_path=replace(coordination_path,$1,$2)
        WHERE local_path LIKE $3 OR coordination_path LIKE $3`, [from, dir, `${from}%`]);
    });
    await markSourcesSynced(engine);
  } finally { await engine.disconnect(); }
  meta.builtAt = dir;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Record every checkout-backed source as synced now at its current Git HEAD and
 * chunker version, as a user's routinely synced brain is. Doctor's
 * sync_freshness is wall-clock based, so a cached fixture is refreshed on each
 * restore; otherwise the source doctor (a graduation plan blocker) fails.
 */
async function markSourcesSynced(engine: import('../../src/core/engine.ts').BrainEngine): Promise<void> {
  const { CHUNKER_VERSION } = await import('../../src/core/chunkers/code.ts');
  const sources = await engine.executeRaw<{ id: string; local_path: string }>('SELECT id,local_path FROM sources WHERE local_path IS NOT NULL');
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.write_sources',$1,true)", [JSON.stringify(sources.map(source => source.id))]);
    for (const source of sources) {
      const head = Bun.spawnSync(['git', '-C', source.local_path, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
      await tx.executeRaw('UPDATE sources SET last_sync_at=now(),last_commit=$2,chunker_version=$3 WHERE id=$1',
        [source.id, head.exitCode === 0 ? head.stdout.toString().trim() : null, String(CHUNKER_VERSION)]);
    }
  });
}

function dirBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? dirBytes(child) : statSync(child).size;
  }
  return total;
}

/** Bytes, chunks, versions, requests and embeddings of a closed fixture brain (opens it read-only in practice). */
async function reportFor(engine: import('../../src/core/engine.ts').BrainEngine, kind: GraduationFixtureKind, dataDir: string, buildMs: number): Promise<GraduationFixtureReport> {
  const [row] = await engine.executeRaw<Record<string, number>>(`SELECT
    (SELECT count(*) FROM pages)::int AS pages, (SELECT count(*) FROM content_chunks)::int AS chunks,
    (SELECT count(*) FROM page_versions)::int AS versions, (SELECT count(*) FROM persistence_requests)::int AS requests,
    (SELECT count(*) FROM persistence_effects)::int AS effects, (SELECT count(*) FROM facts)::int AS facts,
    (SELECT count(*) FROM fact_withdrawals)::int AS withdrawals,
    (SELECT count(*) FROM content_chunks WHERE embedding IS NOT NULL)::int AS chunk_embeddings,
    (SELECT count(*) FROM facts WHERE embedding IS NOT NULL)::int AS fact_embeddings,
    (SELECT count(*) FROM takes WHERE embedding IS NOT NULL)::int AS take_embeddings,
    (SELECT sum(pg_total_relation_size(c.oid)) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r')::bigint AS relations`);
  return { kind, pages: Number(row.pages), bytes: { data_dir: dirBytes(dataDir), relations: Number(row.relations) },
    chunks: Number(row.chunks), versions: Number(row.versions), requests: Number(row.requests), effects: Number(row.effects),
    embeddings: { chunks: Number(row.chunk_embeddings), facts: Number(row.fact_embeddings), takes: Number(row.take_embeddings) },
    facts: Number(row.facts), withdrawals: Number(row.withdrawals), build_ms: buildMs };
}

/** Child-process build: GBRAIN_HOME is already `<dir>/home`. */
async function buildChild(spec: { kind: GraduationFixtureKind; key: string; dir: string; pages?: number; seed?: number; sources?: number; worktrees?: number }): Promise<void> {
  assert.equal(process.env.GBRAIN_HOME, join(spec.dir, 'home'), 'graduation fixture: the child must run under the fixture home');
  const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
  const { saveConfig } = await import('../../src/core/config.ts');
  const { disposePersistenceConsumer } = await import('../../src/core/persistence/service.ts');
  const dataDir = join(spec.dir, 'brain.pglite');
  const root = join(spec.dir, 'root');
  mkdirSync(root, { recursive: true });
  saveConfig({ engine: 'pglite', database_path: dataDir, embedding_disabled: true } as Parameters<typeof saveConfig>[0]);
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  const started = performance.now();
  let outputs: Record<string, unknown>;
  try {
    await engine.initSchema();
    if (spec.kind === 'legacy') {
      const { buildLegacyBrain } = await import('../../test/fixtures/graduation/legacy-brain.ts');
      const built = await buildLegacyBrain(engine, { root });
      outputs = { ...built, queued: undefined, queuedAdmissionPath: join(root, 'queued-admission.json') };
    } else {
      const { buildHistoryFixture } = await import('./history-fixture.ts');
      const built = await buildHistoryFixture(engine, { pages: spec.pages!, seed: spec.seed!, sources: spec.sources!, worktrees: spec.worktrees!, root });
      const [dims] = await engine.executeRaw<{ t: string }>(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
        WHERE attrelid='content_chunks'::regclass AND attname='embedding'`);
      const width = Number(/\((\d+)\)/.exec(dims.t)![1]);
      // Deterministic per-chunk vectors (no provider): sin waves seeded by chunk id, at full float precision.
      await engine.executeRaw(`UPDATE content_chunks c SET embedding=v.vec::vector, embedded_at='2026-01-01T00:00:00Z', model='fixture:graduation'
        FROM (SELECT id, ('[' || string_agg((sin((g + 1) * (id + 0.37)) / 3)::real::text, ',' ORDER BY g) || ']') AS vec
              FROM content_chunks, generate_series(0, $1 - 1) g GROUP BY id) v WHERE v.id=c.id`, [width]);
      outputs = { seed: built.seed, sources: built.sources, remotes: built.remotes, accessTokenId: built.accessTokenId,
        oauthClientId: built.oauthClientId, queuedRequestId: built.queuedRequestId, delayedEffectId: built.delayedEffectId,
        counts: built.counts, digest: built.digest, embeddingWidth: width };
    }
  } finally {
    await disposePersistenceConsumer(engine);
  }
  await markSourcesSynced(engine);
  const buildMs = Math.round(performance.now() - started);
  const report = await reportFor(engine, spec.kind, dataDir, buildMs);
  await engine.disconnect();
  report.bytes.data_dir = dirBytes(dataDir);
  writeFileSync(join(spec.dir, 'fixture.json'), JSON.stringify({ kind: spec.kind, key: spec.key, builtAt: spec.dir, options: spec, report, outputs }, null, 2));
}

function parseArgs(argv: string[]): { opts: GraduationFixtureOptions; json: boolean } {
  const value = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const kind = (value('--kind') ?? 'history') as GraduationFixtureKind;
  if (kind !== 'history' && kind !== 'legacy') throw new Error(`--kind must be history or legacy, got ${kind}`);
  const out = value('--out');
  if (!out) throw new Error('--out <dir> is required');
  const num = (flag: string) => value(flag) === undefined ? undefined : Number(value(flag));
  return { json: argv.includes('--json'), opts: { kind, dir: out, pages: num('--pages'), seed: num('--seed'), sources: num('--sources'),
    worktrees: num('--worktrees'), cacheDir: argv.includes('--no-cache') ? null : value('--cache-dir') } };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === '--build-child') {
    await buildChild(JSON.parse(argv[1]));
  } else {
    let parsed: ReturnType<typeof parseArgs>;
    try { parsed = parseArgs(argv); } catch (error) { console.error(String((error as Error).message)); process.exit(2); }
    const fixture = await prepareGraduationFixture(parsed.opts);
    if (parsed.json) console.log(JSON.stringify({ ...fixture, outputs: undefined }, null, 2));
    else {
      const r = fixture.report;
      console.log(`${fixture.kind} fixture at ${fixture.dir} (${fixture.cached ? 'restored from cache' : `built in ${r.build_ms} ms`}, key ${fixture.key})`);
      console.log(`  pages ${r.pages}  chunks ${r.chunks}  versions ${r.versions}  requests ${r.requests}  effects ${r.effects}  facts ${r.facts}  withdrawals ${r.withdrawals}`);
      console.log(`  embeddings: chunks ${r.embeddings.chunks}  facts ${r.embeddings.facts}  takes ${r.embeddings.takes}`);
      console.log(`  bytes: data dir ${r.bytes.data_dir}  relations ${r.bytes.relations}`);
    }
  }
}

