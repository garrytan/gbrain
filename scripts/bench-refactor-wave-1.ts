#!/usr/bin/env bun
/**
 * Refactor wave 1 performance baseline (plan criterion (f), EO14, T-G15).
 * A bench, not a test: it never runs in a CI test lane.
 *
 *   bun scripts/bench-refactor-wave-1.ts [--backend pglite|postgres|pgbouncer]
 *     [--url <postgres-url>] [--admin-url <direct-postgres-url>] [--json]
 *     [--pages 400] [--paragraphs 6] [--import-concurrency 4] [--warmup 20]
 *     [--iterations 200] [--hybrid-iterations 50] [--count-calls 10]
 *     [--cold-runs 10] [--binary bin/gbrain] [--phases import,ops,count,hybrid-cold,connect,snapshot,version]
 *
 * pglite (default): a temporary file-backed PGLite data dir.
 * postgres: --url (or DATABASE_URL) is a direct server; prepared statements
 *   stay at the postgres.js default.
 * pgbouncer: --url (or GBRAIN_PGBOUNCER_URL) is a transaction-mode pooler and
 *   --admin-url (or GBRAIN_PGBOUNCER_DIRECT_URL / DATABASE_URL) the server
 *   behind it; GBRAIN_PREPARE=false is set explicitly because bench pooler
 *   ports are not the 6543 auto-detect port.
 * Postgres backends CREATE a fresh `gbrain_bench_test_<hex>` database on the
 * admin server and DROP it afterwards; no existing database is touched.
 *
 * Isolation: temporary GBRAIN_HOME, provider keys removed from the process,
 * a deterministic stub embedder and reranker installed through the gateway's
 * transport seams, and a fetch guard that fails (and counts) any network call.
 * SQL round trips are counted outside src: Postgres through a loopback TCP
 * proxy that parses the frontend protocol (Sync + simple Query messages),
 * PGLite by wrapping the instance's execProtocolRawSync (every protocol
 * exchange with the WASM backend passes through it).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Pure helpers (exported for test/bench-refactor-wave-1.test.ts).
// ---------------------------------------------------------------------------

export const DEFAULT_SIZES = {
  pages: 400,
  paragraphs: 6,
  importConcurrency: 4,
  warmup: 20,
  iterations: 200,
  hybridIterations: 50,
  countCalls: 10,
  coldRuns: 10,
  extraImportPages: 10,
} as const;

export interface Summary { n: number; min: number; median: number; p95: number; max: number; mean: number }

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const mean = sorted.reduce((sum, v) => sum + v, 0) / (sorted.length || 1);
  return {
    n: sorted.length,
    min: round(sorted[0] ?? NaN),
    median: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1] ?? NaN),
    mean: round(mean),
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic unit vector derived from the text alone (the stub embedder). */
export function stubVector(text: string, dims: number): number[] {
  const seed = createHash('sha256').update(text).digest().readUInt32BE(0);
  const rand = mulberry32(seed);
  const out = new Array<number>(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) { out[i] = rand() * 2 - 1; norm += out[i] * out[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) out[i] = out[i] / norm;
  return out;
}

const SYLLABLES = ['ka', 'lo', 'mi', 'nu', 'pe', 'ra', 'si', 'to', 'va', 'ze', 'bro', 'dan', 'fel', 'gor', 'hul', 'jin'];

/** Fixed 256-word synthetic vocabulary (no real names). */
export function vocabulary(): string[] {
  const words: string[] = [];
  for (const a of SYLLABLES) for (const b of SYLLABLES) words.push(a + b);
  return words;
}

export interface CorpusPage { slug: string; content: string }

export function corpusPage(index: number, paragraphs: number, prefix = 'bench/topic'): CorpusPage {
  const words = vocabulary();
  const rand = mulberry32(1000 + index);
  const pick = () => words[Math.floor(rand() * words.length)];
  const id = String(index).padStart(4, '0');
  const body: string[] = [];
  for (let p = 0; p < paragraphs; p++) {
    const sentence: string[] = [];
    for (let w = 0; w < 80; w++) sentence.push(pick());
    body.push(sentence.join(' ') + '.');
  }
  const content = `---\ntype: note\ntitle: Topic ${id} ${pick()} ${pick()}\ntags: [bench, group-${index % 8}]\n---\n\n# Topic ${id}\n\n${body.join('\n\n')}\n`;
  return { slug: `${prefix}-${id}`, content };
}

export function buildCorpus(pages: number, paragraphs: number): CorpusPage[] {
  return Array.from({ length: pages }, (_, i) => corpusPage(i, paragraphs));
}

/** Fixed query set: two vocabulary words each, seeded. */
export function benchQueries(count = 20): string[] {
  const words = vocabulary();
  const rand = mulberry32(7);
  return Array.from({ length: count }, () =>
    `${words[Math.floor(rand() * words.length)]} ${words[Math.floor(rand() * words.length)]}`);
}

export interface WireCounts { roundTrips: number; parses: number; messages: number }

/**
 * Incremental parser for the PostgreSQL frontend (client -> server) stream.
 * A round trip ends at each Sync ('S') of the extended protocol and at each
 * simple Query ('Q'). The startup phase (StartupMessage, SSLRequest,
 * GSSENCRequest, CancelRequest) is untyped and skipped.
 */
export class PgFrontendCounter {
  counts: WireCounts = { roundTrips: 0, parses: 0, messages: 0 };
  private pending: Uint8Array = new Uint8Array(0);
  constructor(private startup = true) {}

  feed(chunk: Uint8Array): void {
    const buf = this.pending.length ? concatBytes(this.pending, chunk) : chunk;
    let offset = 0;
    while (true) {
      if (this.startup) {
        if (buf.length - offset < 8) break;
        const len = readInt32(buf, offset);
        if (buf.length - offset < len) break;
        const code = readInt32(buf, offset + 4);
        offset += len;
        if (code !== 80877103 && code !== 80877104) this.startup = false;
        continue;
      }
      if (buf.length - offset < 5) break;
      const type = buf[offset];
      const len = readInt32(buf, offset + 1);
      if (buf.length - offset < len + 1) break;
      offset += len + 1;
      this.counts.messages++;
      if (type === 0x53 /* S */ || type === 0x51 /* Q */) this.counts.roundTrips++;
      if (type === 0x50 /* P */) this.counts.parses++;
    }
    this.pending = offset < buf.length ? buf.slice(offset) : new Uint8Array(0);
  }
}

function readInt32(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

type Backend = 'pglite' | 'postgres' | 'pgbouncer';
type Phase = 'import' | 'ops' | 'count' | 'hybrid-cold' | 'connect' | 'snapshot' | 'version';
const ALL_PHASES: Phase[] = ['import', 'ops', 'count', 'hybrid-cold', 'connect', 'snapshot', 'version'];
const CHILD_MARKER = 'BENCH_CHILD_RESULT ';
const REPO = resolve(import.meta.dir, '..');
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'COHERE_API_KEY', 'TOGETHER_API_KEY',
  'OPENROUTER_API_KEY', 'XAI_API_KEY', 'DASHSCOPE_API_KEY', 'ZHIPU_API_KEY', 'MINIMAX_API_KEY'];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
function intArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const providerCalls = { embed: 0, embed_texts: 0, rerank: 0, fetch: 0 };
type ProviderSnapshot = typeof providerCalls;
const snapshotProviders = (): ProviderSnapshot => ({ ...providerCalls });

interface RoundTripCounter { read(): WireCounts; close(): Promise<void> }

function hermeticEnv(home: string, backend: Backend, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    GBRAIN_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_NO_UPDATE_CHECK: '1',
    GBRAIN_MODEL_DISCOVERY: 'off',
    TZ: 'UTC',
    ...extra,
  };
  if (backend === 'pgbouncer') env.GBRAIN_PREPARE = 'false';
  return env;
}

/** Scrub the bench process itself before any src module loads. */
function isolateProcess(home: string, backend: Backend): void {
  for (const key of [...PROVIDER_KEYS, 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_PGLITE_SNAPSHOT', 'GBRAIN_PREPARE']) delete process.env[key];
  Object.assign(process.env, hermeticEnv(home, backend));
}

async function installStubs(): Promise<{ dims: number; model: string }> {
  const gw = await import('../src/core/ai/gateway.ts');
  const { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } = await import('../src/core/ai/defaults.ts');
  gw.configureGateway({
    embedding_model: DEFAULT_EMBEDDING_MODEL,
    embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    env: { VOYAGE_API_KEY: 'bench-stub-not-a-key' },
  });
  const dims = DEFAULT_EMBEDDING_DIMENSIONS;
  gw.__setEmbedTransportForTests((async (input: { values: string[] }) => {
    providerCalls.embed++;
    providerCalls.embed_texts += input.values.length;
    return { embeddings: input.values.map(text => stubVector(text, dims)) };
  }) as never);
  gw.__setRerankTransportForTests(async (_url: string, init: RequestInit) => {
    providerCalls.rerank++;
    const documents = (JSON.parse(String(init.body)) as { documents?: unknown[] }).documents ?? [];
    const results = documents.map((_, index) => ({ index, relevance_score: 1 - index / (documents.length + 1) }));
    return new Response(JSON.stringify({ results }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  globalThis.fetch = (async (input: unknown) => {
    providerCalls.fetch++;
    throw new Error(`bench: network disabled (${String(input)})`);
  }) as unknown as typeof fetch;
  return { dims, model: DEFAULT_EMBEDDING_MODEL };
}

/** Counts every protocol exchange a PGLite instance makes with its WASM backend. */
function pgliteCounter(engine: BrainEngine): RoundTripCounter {
  const raw = (engine as unknown as { _statements: { db: Record<string, unknown> } | null })._statements?.db;
  if (!raw || typeof raw.execProtocolRawSync !== 'function') throw new Error('bench: PGLite instance not reachable for round-trip counting');
  const original = (raw.execProtocolRawSync as (message: Uint8Array, ...rest: unknown[]) => unknown).bind(raw);
  const counts: WireCounts = { roundTrips: 0, parses: 0, messages: 0 };
  raw.execProtocolRawSync = (message: Uint8Array, ...rest: unknown[]) => {
    counts.roundTrips++;
    const parser = new PgFrontendCounter(false);
    parser.feed(message);
    counts.parses += parser.counts.parses;
    counts.messages += parser.counts.messages;
    return original(message, ...rest);
  };
  return { read: () => ({ ...counts }), close: async () => { delete raw.execProtocolRawSync; } };
}

/** Loopback TCP proxy in front of a Postgres/PgBouncer URL; returns the proxied URL. */
async function pgWireProxy(target: string): Promise<RoundTripCounter & { url: string }> {
  const upstream = new URL(target);
  const counters: PgFrontendCounter[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(client => {
    const counter = new PgFrontendCounter();
    counters.push(counter);
    const server = net.connect(Number(upstream.port || 5432), upstream.hostname);
    sockets.add(client); sockets.add(server);
    client.on('data', (chunk: Buffer) => { counter.feed(chunk); server.write(chunk); });
    server.on('data', chunk => client.write(chunk));
    const end = () => { client.destroy(); server.destroy(); sockets.delete(client); sockets.delete(server); };
    client.on('close', end); server.on('close', end);
    client.on('error', end); server.on('error', end);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as net.AddressInfo).port;
  const proxied = new URL(target);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(port);
  return {
    url: proxied.toString(),
    read: () => counters.reduce<WireCounts>((sum, c) => ({
      roundTrips: sum.roundTrips + c.counts.roundTrips,
      parses: sum.parses + c.counts.parses,
      messages: sum.messages + c.counts.messages,
    }), { roundTrips: 0, parses: 0, messages: 0 }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

/**
 * The primary engine uses the CLI's module-singleton pool. The round-trip
 * counting engine is a second, instance-owned pool (the module singleton
 * would silently reuse the primary connection) of the same size and options.
 */
async function openEngine(backend: Backend, target: string, instancePool = false): Promise<BrainEngine> {
  const { createEngine } = await import('../src/core/engine-factory.ts');
  const { resolvePoolSize } = await import('../src/core/db.ts');
  const config = backend === 'pglite'
    ? { engine: 'pglite' as const, database_path: target }
    : { engine: 'postgres' as const, database_url: target, ...(instancePool ? { poolSize: resolvePoolSize() } : {}) };
  const engine = await createEngine(config);
  await engine.connect(config);
  return engine;
}

type Span = <T>(fn: () => Promise<T>) => Promise<T>;
type Op = (i: number, span: Span) => Promise<unknown>;

interface OpResult {
  latency_ms: Summary;
  sql_round_trips?: {
    first_call: number; per_call_min: number; per_call_max: number; per_call: number[]; total: number;
    first_call_parses: number; parses_per_call_min: number; parses_per_call_max: number; parses_total: number;
  };
  provider_calls_per_call?: Record<keyof ProviderSnapshot, number>;
}

async function timeOp(op: Op, i: number, counter?: RoundTripCounter): Promise<{ ms: number; counts?: WireCounts; providers: ProviderSnapshot }> {
  let spanMs: number | undefined;
  let spanCounts: WireCounts | undefined;
  const span: Span = async fn => {
    const c0 = counter?.read();
    const t0 = performance.now();
    try { return await fn(); }
    finally {
      spanMs = performance.now() - t0;
      if (counter && c0) spanCounts = diffCounts(counter.read(), c0);
    }
  };
  const p0 = snapshotProviders();
  const c0 = counter?.read();
  const t0 = performance.now();
  await op(i, span);
  const ms = performance.now() - t0;
  const counts = counter && c0 ? (spanCounts ?? diffCounts(counter.read(), c0)) : undefined;
  const p1 = snapshotProviders();
  const providers = Object.fromEntries(Object.keys(p1).map(k => [k, p1[k as keyof ProviderSnapshot] - p0[k as keyof ProviderSnapshot]])) as ProviderSnapshot;
  return { ms: spanMs ?? ms, counts, providers };
}

function diffCounts(a: WireCounts, b: WireCounts): WireCounts {
  return { roundTrips: a.roundTrips - b.roundTrips, parses: a.parses - b.parses, messages: a.messages - b.messages };
}

async function measureLatency(op: Op, warmup: number, iterations: number): Promise<Summary> {
  for (let i = 0; i < warmup; i++) await op(i, fn => fn());
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) samples.push((await timeOp(op, warmup + i)).ms);
  return summarize(samples);
}

async function measureCounts(op: Op, counter: RoundTripCounter, calls: number): Promise<Required<Omit<OpResult, 'latency_ms'>>> {
  const first = await timeOp(op, 0, counter);
  for (let i = 1; i <= 3; i++) await op(i, fn => fn());
  const rows: Array<{ counts?: WireCounts; providers: ProviderSnapshot }> = [];
  for (let i = 0; i < calls; i++) rows.push(await timeOp(op, 4 + i, counter));
  const trips = rows.map(r => r.counts!.roundTrips);
  const parses = rows.map(r => r.counts!.parses);
  const perCall = Object.fromEntries(Object.keys(providerCalls).map(key => {
    const values = new Set(rows.map(r => r.providers[key as keyof ProviderSnapshot]));
    if (values.size !== 1) throw new Error(`bench: provider calls for ${key} vary per call (${[...values].join(',')})`);
    return [key, [...values][0]];
  })) as Record<keyof ProviderSnapshot, number>;
  return {
    sql_round_trips: {
      first_call: first.counts!.roundTrips, per_call_min: Math.min(...trips), per_call_max: Math.max(...trips),
      per_call: trips, total: trips.reduce((sum, v) => sum + v, 0),
      first_call_parses: first.counts!.parses, parses_per_call_min: Math.min(...parses), parses_per_call_max: Math.max(...parses),
      parses_total: parses.reduce((sum, v) => sum + v, 0),
    },
    provider_calls_per_call: perCall,
  };
}

interface Fixtures { slugs: string[]; queries: string[]; vectors: Float32Array[]; chunkVariants: ChunkInput[][]; model: string }

function buildFixtures(pages: number, dims: number, model: string): Fixtures {
  const queries = benchQueries(20);
  const words = vocabulary();
  const chunkVariants = [0, 1].map(variant => Array.from({ length: 3 }, (_, index): ChunkInput => {
    const text = Array.from({ length: 120 }, (_, w) => words[(variant * 31 + index * 17 + w * 7) % words.length]).join(' ');
    return { chunk_index: index, chunk_text: text, chunk_source: 'compiled_truth', embedding: new Float32Array(stubVector(text, dims)), model, token_count: 120 };
  }));
  return {
    slugs: Array.from({ length: pages }, (_, i) => corpusPage(i, 1).slug),
    queries,
    vectors: queries.map(q => new Float32Array(stubVector(q, dims))),
    chunkVariants,
    model,
  };
}

async function buildOps(engine: BrainEngine, fx: Fixtures, onHybridMeta: (status: string | undefined) => void): Promise<Record<string, Op>> {
  const { MAX_SEARCH_LIMIT } = await import('../src/core/engine.ts');
  const { hybridSearchCached } = await import('../src/core/search/hybrid.ts');
  const putBody = (variant: number) => Array.from({ length: 60 }, (_, w) => vocabulary()[(variant * 13 + w * 5) % 256]).join(' ');
  return {
    getPage: async i => { if (!await engine.getPage(fx.slugs[(i * 37) % fx.slugs.length])) throw new Error('bench: getPage miss'); },
    searchKeyword: async i => engine.searchKeyword(fx.queries[i % fx.queries.length], { limit: 20 }),
    'searchVector(limit=20)': async i => engine.searchVector(fx.vectors[i % fx.vectors.length], { limit: 20 }),
    [`searchVector(limit=MAX_SEARCH_LIMIT=${MAX_SEARCH_LIMIT})`]: async i => engine.searchVector(fx.vectors[i % fx.vectors.length], { limit: MAX_SEARCH_LIMIT }),
    putPage: async i => engine.putPage('bench/put-target', { type: 'note', title: 'Put target', compiled_truth: putBody(i % 2) }),
    _upsertChunksOnce: async (i, span) => engine.transaction(tx => span(() =>
      (tx as unknown as { _upsertChunksOnce(slug: string, chunks: ChunkInput[], opts: object): Promise<void> })
        ._upsertChunksOnce('bench/upsert-target', fx.chunkVariants[i % 2], {}))),
    hybridSearchCached: async i => hybridSearchCached(engine, fx.queries[i % fx.queries.length], {
      limit: 20, onMeta: meta => onHybridMeta(meta.cache?.status),
    }),
  };
}

async function seedTargets(engine: BrainEngine, fx: Fixtures): Promise<void> {
  await engine.putPage('bench/put-target', { type: 'note', title: 'Put target', compiled_truth: 'seed' });
  await engine.putPage('bench/upsert-target', { type: 'note', title: 'Upsert target', compiled_truth: 'seed' });
  await engine.upsertChunks('bench/upsert-target', fx.chunkVariants[1]);
}

async function importCorpus(engine: BrainEngine, pages: number, paragraphs: number, concurrency: number) {
  const { importFromContent } = await import('../src/core/import-file.ts');
  const corpus = buildCorpus(pages, paragraphs);
  const perPage: number[] = [];
  const p0 = snapshotProviders();
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < corpus.length) {
      const page = corpus[next++];
      const s = performance.now();
      const result = await importFromContent(engine, page.slug, page.content);
      perPage.push(performance.now() - s);
      if (result.status !== 'imported') throw new Error(`bench: import of ${page.slug} returned ${result.status} ${result.error ?? ''}`);
    }
  }));
  const seconds = (performance.now() - t0) / 1000;
  const p1 = snapshotProviders();
  return {
    pages, paragraphs_per_page: paragraphs, concurrency,
    seconds: Math.round(seconds * 1000) / 1000,
    pages_per_second: Math.round((pages / seconds) * 100) / 100,
    per_page_ms: summarize(perPage),
    provider_calls: { embed: p1.embed - p0.embed, embed_texts: p1.embed_texts - p0.embed_texts, rerank: p1.rerank - p0.rerank, fetch: p1.fetch - p0.fetch },
  };
}

async function spawnTimed(cmd: string[], env: Record<string, string>): Promise<{ ms: number; stdout: string; stderr: string; exitCode: number }> {
  const t0 = performance.now();
  const child = Bun.spawn(cmd, { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ms: performance.now() - t0, stdout, stderr, exitCode };
}

async function spawnChild(kind: string, args: string[], env: Record<string, string>): Promise<{ wall_ms: number; result: Record<string, unknown> }> {
  const run = await spawnTimed([process.execPath, '--no-env-file', join(REPO, 'scripts/bench-refactor-wave-1.ts'), '--child', kind, ...args], env);
  const line = run.stdout.split('\n').find(l => l.startsWith(CHILD_MARKER));
  if (run.exitCode !== 0 || !line) throw new Error(`bench child ${kind} failed (exit ${run.exitCode}):\n${run.stderr.slice(-2000)}\n${run.stdout.slice(-1000)}`);
  return { wall_ms: run.ms, result: JSON.parse(line.slice(CHILD_MARKER.length)) };
}

/** src_tree identifies the production code under test independent of test/doc commits. */
function gitInfo(): { commit: string; src_tree: string; dirty: boolean } {
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', REPO, ...args]).stdout.toString().trim();
  return { commit: git('rev-parse', 'HEAD'), src_tree: git('rev-parse', 'HEAD:src'), dirty: git('status', '--porcelain', '--untracked-files=no').length > 0 };
}

function redactUrl(url: string | undefined): string | null {
  if (!url) return null;
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
}

// ---------------------------------------------------------------------------
// Child processes (fresh bun process per sample = real cold start)
// ---------------------------------------------------------------------------

async function child(kind: string): Promise<void> {
  const backend = (arg('--backend') ?? 'pglite') as Backend;
  const target = arg('--target')!;
  const t0 = performance.now();
  if (kind === 'connect') {
    // Mirrors the CLI connect path: gateway, engine factory, connect, then
    // the migrate.ts pending-migration probe (loads the migration registry).
    await installStubs();
    const tImport = performance.now();
    const { createEngine } = await import('../src/core/engine-factory.ts');
    const importMs = performance.now() - tImport;
    const tConnect = performance.now();
    const config = backend === 'pglite' ? { engine: 'pglite' as const, database_path: target } : { engine: 'postgres' as const, database_url: target };
    const engine = await createEngine(config);
    await engine.connect(config);
    const connectMs = performance.now() - tConnect;
    const tProbe = performance.now();
    const { tryRunPendingMigrations } = await import('../src/core/migrate.ts');
    const probe = await tryRunPendingMigrations(engine);
    const probeMs = performance.now() - tProbe;
    await engine.disconnect();
    emit({ factory_import_ms: importMs, connect_ms: connectMs, migrate_probe_ms: probeMs, migrate_probe_status: probe.status, in_process_ms: performance.now() - t0 });
    return;
  }
  if (kind === 'pglite-init') {
    await installStubs();
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    const tConnect = performance.now();
    await engine.connect({});
    const connectMs = performance.now() - tConnect;
    const tInit = performance.now();
    await engine.initSchema();
    const initMs = performance.now() - tInit;
    const snapshotLoaded = (engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded;
    await engine.disconnect();
    emit({ connect_ms: connectMs, init_schema_ms: initMs, connect_init_ms: connectMs + initMs, snapshot_loaded: snapshotLoaded, in_process_ms: performance.now() - t0 });
    return;
  }
  if (kind === 'hybrid-cold') {
    const { dims, model } = await installStubs();
    const { semanticResultCacheAvailable } = await import('../src/core/search/query-cache.ts');
    const engine = await openEngine(backend, target);
    const counter = backend === 'pglite' ? pgliteCounter(engine) : undefined;
    const fx = buildFixtures(1, dims, model);
    const statuses: Array<string | undefined> = [];
    const ops = await buildOps(engine, fx, status => statuses.push(status));
    const probe = () => ({
      pglite_statement_cache_entries: backend === 'pglite'
        ? (engine as unknown as { _statements: { statements: Map<string, unknown> } })._statements.statements.size : null,
      vector_iterative_scan_probe_set: (engine as unknown as { vectorIterativeScan?: unknown }).vectorIterativeScan !== undefined,
    });
    const before = probe();
    const first = await timeOp(ops.hybridSearchCached, 0, counter);
    const afterFirst = probe();
    const warm: number[] = [];
    for (let i = 0; i < 5; i++) warm.push((await timeOp(ops.hybridSearchCached, 0, counter)).ms);
    const second = await timeOp(ops.hybridSearchCached, 0, counter);
    await counter?.close();
    await engine.disconnect();
    emit({
      cold_first_call_ms: first.ms, warm_same_query_ms: warm, first_call_round_trips: first.counts?.roundTrips ?? null,
      warm_call_round_trips: second.counts?.roundTrips ?? null, first_call_providers: first.providers, warm_call_providers: second.providers,
      cache_statuses: statuses, semantic_result_cache_available: semanticResultCacheAvailable(),
      probes_before: before, probes_after_first: afterFirst, fetch_attempts: providerCalls.fetch,
    });
    return;
  }
  throw new Error(`bench: unknown child ${kind}`);
}

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`${CHILD_MARKER}${JSON.stringify(result)}\n`);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const backend = (arg('--backend') ?? 'pglite') as Backend;
  if (!['pglite', 'postgres', 'pgbouncer'].includes(backend)) throw new Error(`--backend must be pglite|postgres|pgbouncer`);
  const json = process.argv.includes('--json');
  const sizes = {
    pages: intArg('--pages', DEFAULT_SIZES.pages),
    paragraphs: intArg('--paragraphs', DEFAULT_SIZES.paragraphs),
    importConcurrency: intArg('--import-concurrency', DEFAULT_SIZES.importConcurrency),
    warmup: intArg('--warmup', DEFAULT_SIZES.warmup),
    iterations: intArg('--iterations', DEFAULT_SIZES.iterations),
    hybridIterations: intArg('--hybrid-iterations', DEFAULT_SIZES.hybridIterations),
    countCalls: intArg('--count-calls', DEFAULT_SIZES.countCalls),
    coldRuns: intArg('--cold-runs', DEFAULT_SIZES.coldRuns),
    extraImportPages: DEFAULT_SIZES.extraImportPages,
    searchConcurrency: 1,
  };
  const phases = new Set((arg('--phases') ?? ALL_PHASES.join(',')).split(',') as Phase[]);
  for (const p of phases) if (!ALL_PHASES.includes(p)) throw new Error(`unknown phase ${p}`);
  const binary = arg('--binary');
  const url = arg('--url') ?? (backend === 'pgbouncer' ? process.env.GBRAIN_PGBOUNCER_URL : backend === 'postgres' ? process.env.DATABASE_URL : undefined);
  const adminUrl = arg('--admin-url') ?? (backend === 'pgbouncer' ? (process.env.GBRAIN_PGBOUNCER_DIRECT_URL ?? process.env.DATABASE_URL) : url);
  if (backend !== 'pglite' && (!url || !adminUrl)) throw new Error(`--backend ${backend} needs --url${backend === 'pgbouncer' ? ' and --admin-url' : ''}`);

  const home = mkdtempSync(join(tmpdir(), 'gbrain-bench-wave1-'));
  isolateProcess(home, backend);
  const childEnv = hermeticEnv(home, backend);
  const log = (line: string) => { if (!json) console.error(line); };

  const { dims, model } = await installStubs();
  const { semanticResultCacheAvailable } = await import('../src/core/search/query-cache.ts');
  const { MAX_SEARCH_LIMIT } = await import('../src/core/engine.ts');
  const report: Record<string, unknown> = {
    bench: 'refactor-wave-1',
    meta: {
      ...gitInfo(), backend, bun: Bun.version, platform: `${platform()}-${arch()}`, kernel: release(),
      cpu_model: cpus()[0]?.model ?? 'unknown', cpu_count: cpus().length, total_mem_gb: Math.round(totalmem() / 2 ** 30 * 10) / 10,
      url: redactUrl(url), admin_url: redactUrl(adminUrl), prepare: backend === 'pgbouncer' ? 'false (GBRAIN_PREPARE)' : backend === 'postgres' ? 'postgres.js default (true)' : 'n/a',
      embedding: { model, dims, provider: 'deterministic stub (sha256-seeded unit vectors)' },
      reranker: 'deterministic stub (input order)', max_search_limit: MAX_SEARCH_LIMIT, sizes,
    },
  };

  let target: string;
  let dropDatabase: (() => Promise<void>) | undefined;
  if (backend === 'pglite') {
    target = join(home, 'brain.pglite');
  } else {
    const { default: postgres } = await import('#postgres');
    const database = `gbrain_bench_test_${randomBytes(6).toString('hex')}`;
    const admin = postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const benchUrl = new URL(url!);
    benchUrl.pathname = `/${database}`;
    target = benchUrl.toString();
    dropDatabase = async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); };
  }

  try {
    const fx = buildFixtures(sizes.pages, dims, model);
    const hybridStatuses: Array<string | undefined> = [];
    const engine = await openEngine(backend, target);
    const tInit = performance.now();
    await engine.initSchema();
    log(`[bench] ${backend}: schema ready in ${Math.round(performance.now() - tInit)}ms`);
    const ops = await buildOps(engine, fx, status => hybridStatuses.push(status));
    try {
      if (phases.has('import')) {
        log(`[bench] importing ${sizes.pages} pages (concurrency ${sizes.importConcurrency})`);
        report.import = await importCorpus(engine, sizes.pages, sizes.paragraphs, sizes.importConcurrency);
        const [{ missing }] = await engine.executeRaw<{ missing: number }>(`SELECT count(*)::int AS missing FROM content_chunks WHERE embedding IS NULL`);
        if (missing !== 0) throw new Error(`bench: ${missing} chunks lack embeddings after import`);
      }
      await seedTargets(engine, fx);
      const results: Record<string, OpResult> = {};
      if (phases.has('ops')) {
        for (const [name, op] of Object.entries(ops)) {
          const iterations = name === 'hybridSearchCached' ? sizes.hybridIterations : sizes.iterations;
          log(`[bench] ${name}: ${sizes.warmup} warmup + ${iterations} iterations`);
          results[name] = { latency_ms: await measureLatency(op, sizes.warmup, iterations) };
        }
      }
      if (phases.has('count')) {
        const proxy = backend === 'pglite' ? undefined : await pgWireProxy(target);
        const countEngine = proxy ? await openEngine(backend, proxy.url, true) : engine;
        const counter = proxy ?? pgliteCounter(engine);
        try {
          const countOps = await buildOps(countEngine, fx, status => hybridStatuses.push(status));
          const { importFromContent } = await import('../src/core/import-file.ts');
          countOps.importFromContent = async i => {
            const page = corpusPage(100000 + i, sizes.paragraphs, 'bench/extra');
            const result = await importFromContent(countEngine, page.slug, page.content);
            if (result.status !== 'imported') throw new Error(`bench: extra import returned ${result.status}`);
          };
          for (const [name, op] of Object.entries(countOps)) {
            log(`[bench] counting round trips: ${name}`);
            results[name] = { ...(results[name] ?? {}), ...(await measureCounts(op, counter, sizes.countCalls)) } as OpResult;
          }
        } finally {
          if (proxy) { await countEngine.disconnect(); await proxy.close(); } else await counter.close();
        }
      }
      report.ops = results;
      const [{ rows: cacheRows }] = await engine.executeRaw<{ rows: number }>(`SELECT count(*)::int AS rows FROM query_cache`);
      report.semantic_result_cache = {
        semantic_result_cache_available: semanticResultCacheAvailable(),
        hybrid_calls_observed: hybridStatuses.length,
        cache_statuses: [...new Set(hybridStatuses)],
        query_cache_rows: cacheRows,
      };
      if (semanticResultCacheAvailable() !== false) throw new Error('bench: semantic result cache is no longer hard-disabled');
      if (hybridStatuses.some(s => s !== 'disabled')) throw new Error(`bench: hybrid cache status left 'disabled': ${[...new Set(hybridStatuses)].join(',')}`);
      if (cacheRows !== 0) throw new Error(`bench: query_cache has ${cacheRows} rows`);
    } finally {
      await engine.disconnect();
    }

    const cold: Record<string, unknown> = {};
    const childArgs = ['--backend', backend, '--target', target];
    const coldSeries = async (label: string, kind: string, args: string[], env: Record<string, string>, pick: string[]) => {
      log(`[bench] ${label}: 1 discarded + ${sizes.coldRuns} fresh processes`);
      await spawnChild(kind, args, env);
      const rows: Array<{ wall_ms: number; result: Record<string, unknown> }> = [];
      for (let i = 0; i < sizes.coldRuns; i++) rows.push(await spawnChild(kind, args, env));
      const out: Record<string, unknown> = { process_wall_ms: summarize(rows.map(r => r.wall_ms)) };
      for (const key of pick) out[key] = summarize(rows.map(r => Number(r.result[key])));
      return { out, rows };
    };
    if (phases.has('hybrid-cold') && phases.has('import')) {
      const { out, rows } = await coldSeries('hybridSearchCached cold', 'hybrid-cold', childArgs, childEnv, ['cold_first_call_ms']);
      const warmAll = rows.flatMap(r => r.result.warm_same_query_ms as number[]);
      const statuses = new Set(rows.flatMap(r => r.result.cache_statuses as string[]));
      if (rows.some(r => r.result.semantic_result_cache_available !== false) || [...statuses].some(s => s !== 'disabled')) {
        throw new Error('bench: semantic result cache engaged in a cold child');
      }
      if (rows.some(r => r.result.fetch_attempts !== 0)) throw new Error('bench: cold child attempted network access');
      const sample = rows[0].result;
      cold.hybrid = {
        ...out,
        warm_same_process_ms: summarize(warmAll),
        first_call_round_trips: sample.first_call_round_trips, warm_call_round_trips: sample.warm_call_round_trips,
        first_call_providers: sample.first_call_providers, warm_call_providers: sample.warm_call_providers,
        probes_before: sample.probes_before, probes_after_first: sample.probes_after_first,
        cache_statuses: [...statuses], semantic_result_cache_available: false,
        warmed_caches: warmedCaches(backend),
      };
    }
    if (phases.has('connect') && phases.has('import')) {
      cold.engine_connect = (await coldSeries('engine connect cold start', 'connect', childArgs, childEnv,
        ['factory_import_ms', 'connect_ms', 'migrate_probe_ms', 'in_process_ms'])).out;
    }
    if (phases.has('snapshot') && backend === 'pglite') {
      const snapshot = join(REPO, 'test/fixtures/pglite-snapshot-default.tar');
      log('[bench] ensuring the default-profile PGLite snapshot (bun run build:pglite-snapshot --profile default)');
      const build = await spawnTimed([process.execPath, '--no-env-file', join(REPO, 'scripts/build-pglite-snapshot.ts'), '--profile', 'default'], childEnv);
      if (build.exitCode !== 0 || !existsSync(snapshot)) throw new Error(`bench: snapshot build failed\n${build.stderr}`);
      const on = await coldSeries('PGLite connect+initSchema, snapshot ON', 'pglite-init', [], { ...childEnv, GBRAIN_PGLITE_SNAPSHOT: snapshot },
        ['connect_ms', 'init_schema_ms', 'connect_init_ms']);
      const off = await coldSeries('PGLite connect+initSchema, snapshot OFF', 'pglite-init', [], { ...childEnv, GBRAIN_NO_SNAPSHOT: '1' },
        ['connect_ms', 'init_schema_ms', 'connect_init_ms']);
      if (on.rows.some(r => r.result.snapshot_loaded !== true)) throw new Error('bench: snapshot ON run did not load the snapshot');
      if (off.rows.some(r => r.result.snapshot_loaded !== false)) throw new Error('bench: snapshot OFF run loaded a snapshot');
      cold.pglite_init_snapshot_on = on.out;
      cold.pglite_init_snapshot_off = off.out;
    }
    if (phases.has('version')) {
      const series = async (label: string, cmd: string[]) => {
        log(`[bench] ${label}: 1 discarded + ${sizes.coldRuns} runs`);
        await spawnTimed(cmd, childEnv);
        const samples: number[] = [];
        let version = '';
        for (let i = 0; i < sizes.coldRuns; i++) {
          const run = await spawnTimed(cmd, childEnv);
          if (run.exitCode !== 0) throw new Error(`bench: ${cmd.join(' ')} exited ${run.exitCode}: ${run.stderr}`);
          version = run.stdout.trim();
          samples.push(run.ms);
        }
        return { version, wall_ms: summarize(samples) };
      };
      cold.version_source = await series('bun src/cli.ts --version', [process.execPath, '--no-env-file', join(REPO, 'src/cli.ts'), '--version']);
      if (binary) cold.version_binary = await series(`${binary} --version`, [resolve(binary), '--version']);
    }
    report.cold_start = cold;
    report.provider_calls_total = snapshotProviders();
    if (providerCalls.fetch !== 0) throw new Error(`bench: ${providerCalls.fetch} network attempts`);
  } finally {
    if (dropDatabase) await dropDatabase();
    rmSync(home, { recursive: true, force: true });
  }

  if (json) console.log(JSON.stringify(report, null, 2));
  else printTable(report);
}

function warmedCaches(backend: Backend): Array<{ cache: string; where: string; applies: boolean }> {
  return [
    { cache: 'ES module registry (dynamic imports: search/mode.ts, ai/gateway.ts, query-cache.ts, rerank, ...)', where: 'bun runtime', applies: true },
    { cache: 'PgliteStatementCache (named statements from the 2nd sighting of a SQL text)', where: 'src/core/pglite-statements.ts', applies: backend === 'pglite' },
    { cache: 'postgres.js per-connection prepared statements (prepare=true)', where: 'vendor/postgres', applies: backend === 'postgres' },
    { cache: 'postgres.js connection pool + array type fetch on first connection', where: 'vendor/postgres', applies: backend !== 'pglite' },
    { cache: 'engine vectorIterativeScan capability probe', where: `${backend === 'pglite' ? 'pglite' : 'postgres'}-engine.ts`, applies: true },
    { cache: 'supersede-edge probe (WeakMap per engine, 5 min TTL)', where: 'src/core/search/hybrid.ts hasAnySupersedeEdges', applies: true },
    { cache: 'query embedding cache', where: 'none exists: every call embeds (provider_calls.embed = 1 per call)', applies: false },
    { cache: 'semantic result cache (query_cache)', where: 'hard-disabled: semanticResultCacheAvailable() === false, asserted', applies: false },
  ];
}

function printTable(report: Record<string, unknown>): void {
  const meta = report.meta as Record<string, unknown>;
  const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v ?? '-')).padStart(9);
  console.log(`refactor-wave-1 bench  backend=${meta.backend}  commit=${String(meta.commit).slice(0, 12)}${meta.dirty ? '+dirty' : ''}  bun=${meta.bun}`);
  console.log(`machine: ${meta.cpu_model} x${meta.cpu_count}, ${meta.total_mem_gb} GB, ${meta.platform}`);
  console.log(`sizes: ${JSON.stringify(meta.sizes)}`);
  const imp = report.import as Record<string, unknown> | undefined;
  if (imp) console.log(`import: ${imp.pages} pages in ${imp.seconds}s = ${imp.pages_per_second} pages/s (c=${imp.concurrency}); per-page ms ${JSON.stringify(imp.per_page_ms)}; provider ${JSON.stringify(imp.provider_calls)}`);
  console.log(`${'op'.padEnd(40)}${'median'.padStart(9)}${'p95'.padStart(9)}${'max'.padStart(9)}${'rt/call'.padStart(9)}${'rt 1st'.padStart(9)}${'parse/c'.padStart(9)}  provider/call`);
  for (const [name, r] of Object.entries((report.ops ?? {}) as Record<string, OpResult>)) {
    const rt = r.sql_round_trips;
    const range = (a?: number, b?: number) => (a === undefined ? '-' : a === b ? String(a) : `${a}-${b}`);
    const prov = r.provider_calls_per_call;
    console.log(`${name.padEnd(40)}${fmt(r.latency_ms?.median)}${fmt(r.latency_ms?.p95)}${fmt(r.latency_ms?.max)}${fmt(range(rt?.per_call_min, rt?.per_call_max))}${fmt(rt?.first_call)}${fmt(range(rt?.parses_per_call_min, rt?.parses_per_call_max))}  ${prov ? `embed=${prov.embed} rerank=${prov.rerank} fetch=${prov.fetch}` : '-'}`);
  }
  console.log(`semantic result cache: ${JSON.stringify(report.semantic_result_cache)}`);
  for (const [name, value] of Object.entries((report.cold_start ?? {}) as Record<string, Record<string, unknown>>)) {
    const parts = Object.entries(value).filter(([, v]) => v && typeof v === 'object' && 'median' in (v as object))
      .map(([k, v]) => `${k} median=${(v as Summary).median} p95=${(v as Summary).p95} max=${(v as Summary).max}`);
    console.log(`cold ${name}: ${parts.join('; ')}`);
  }
}

if (import.meta.main) {
  const kind = arg('--child');
  if (kind) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-bench-wave1-child-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    process.env.GBRAIN_HOME = home;
    try { await child(kind); } finally { rmSync(home, { recursive: true, force: true }); }
  } else {
    await main();
  }
}
