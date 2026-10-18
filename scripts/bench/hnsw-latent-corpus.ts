/**
 * Synthetic-latent corpus for scripts/bench/hnsw-iterative-scan.ts
 * (`--corpus latent`): brain-shaped pages and chunks with real-width unit
 * vectors and no network or model calls. Opt-in bench code, never run in CI.
 *
 * Geometry. Every chunk vector is
 *   a0·μ + a1·C[super] + a2·G[topic] + B[topic]·(u_page + u_chunk) + n
 * normalized to unit length: μ is a shared mean direction (embeddings are
 * anisotropic), C and G are random unit super-topic and topic directions,
 * B[topic] is a random rank-`rank` basis in which a topic's pages and chunks
 * vary (local variation is low-rank, as in text embeddings), and n is
 * isotropic noise across all dimensions. A query picks a random chunk and
 * moves it inside its topic subspace and with fresh noise (a query is close
 * to, not equal to, its source chunk). Topics grow as 4·sqrt(pages), so a
 * bigger brain is both broader and denser. Pages hold 1 to 60 chunks
 * (exponential, mean about 7.5) and fall into three sources (10% / 40% /
 * 50%) and a visibility draw independent of their topic.
 *
 * Determinism. Every page draws from its own seeded stream, so any page can
 * be regenerated alone (the main thread rebuilds query source chunks that
 * way) and the corpus at a given --chunks and --seed is identical across
 * runs, machines and worker counts.
 *
 * Load + truth. `loadLatentCorpus` splits the pages over Bun workers. Each
 * worker regenerates its pages, streams its chunks into `content_chunks`
 * with binary COPY (exact float4 values, no text parse) and, in the same
 * pass, scores every chunk against every query in float64 to keep the exact
 * per-page max-pooled top 100 for each filter group, plus each query's 20
 * nearest chunks for the local intrinsic dimension estimate.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import postgres from '#postgres';

export interface LatentParams {
  chunks: number;
  dims: number;
  seed: number;
  rank: number;
  /** Variance shares before normalization. */
  mean: number; superTopic: number; topic: number; page: number; chunk: number; noise: number;
  queryShift: number; queryNoise: number;
  /** Page shares of bench-a and bench-b (bench-c holds the rest): the `source10` filter is bench-a, `source50` is bench-a plus bench-b. */
  sourceShares: [number, number];
}

export const LATENT_DEFAULTS: Omit<LatentParams, 'chunks' | 'dims' | 'seed'> = {
  rank: 16, mean: 0.25, superTopic: 0.2, topic: 0.25, page: 0.35, chunk: 0.25, noise: 0.15, queryShift: 0.25, queryNoise: 0.3,
  sourceShares: [0.1, 0.4],
};

export const SUPER_TOPICS = 64;
export const MAX_CHUNKS_PER_PAGE = 60;
export const TRUTH_K = 100;
export const LID_K = 20;
/** Filter groups the truth is kept for; each is a page predicate. */
export const GROUPS = ['none', 'source10', 'source50', 'vis50', 'vis10'] as const;
export type Group = (typeof GROUPS)[number];

export interface PagePlan { count: number; chunkStart: Int32Array; chunkCount: Int32Array; topic: Int32Array; source: Uint8Array; vis: Float32Array }

export function hash32(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) { h = Math.imul(h ^ (p >>> 0), 0x01000193); h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; }
  return h >>> 0;
}

/** mulberry32 with a cached Box-Muller pair. */
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gauss(): number {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return v; }
    let u = 0;
    while (u === 0) u = this.next();
    const r = Math.sqrt(-2 * Math.log(u)), a = 2 * Math.PI * this.next();
    this.spare = r * Math.sin(a);
    return r * Math.cos(a);
  }
}

export function topicCount(chunks: number): number {
  return Math.max(SUPER_TOPICS, Math.round(4 * Math.sqrt(chunks / 7.5)));
}

/** Per-page attributes, drawn first from the page's own stream (pageStream replays them). */
function pageHeader(seed: number, p: number, topics: number, shares: [number, number] = LATENT_DEFAULTS.sourceShares) {
  const rng = new Rng(hash32(seed, p, 0x9a6e));
  const chunkCount = Math.min(MAX_CHUNKS_PER_PAGE, 1 + Math.floor(-Math.log(1 - rng.next()) * 6.5));
  const topic = Math.floor(rng.next() * topics);
  const s = rng.next();
  const source = s < shares[0] ? 0 : s < shares[0] + shares[1] ? 1 : 2;
  const vis = rng.next();
  return { rng, chunkCount, topic, source, vis };
}

export function planPages(chunks: number, seed: number, shares: [number, number] = LATENT_DEFAULTS.sourceShares): PagePlan {
  const topics = topicCount(chunks);
  const starts: number[] = [], counts: number[] = [], topicOf: number[] = [], sources: number[] = [], vis: number[] = [];
  let total = 0;
  for (let p = 0; total < chunks; p++) {
    const h = pageHeader(seed, p, topics, shares);
    const n = Math.min(h.chunkCount, chunks - total);
    starts.push(total); counts.push(n); topicOf.push(h.topic); sources.push(h.source); vis.push(h.vis);
    total += n;
  }
  return { count: starts.length, chunkStart: Int32Array.from(starts), chunkCount: Int32Array.from(counts), topic: Int32Array.from(topicOf), source: Uint8Array.from(sources), vis: Float32Array.from(vis) };
}

export function inGroup(group: Group, source: number, vis: number): boolean {
  switch (group) {
    case 'none': return true;
    case 'source10': return source === 0;
    case 'source50': return source <= 1;
    case 'vis50': return vis < 0.5;
    case 'vis10': return vis < 0.1;
  }
}

/** Shared basis: μ, SUPER_TOPICS super directions, `topics` topic directions, then `topics × rank` subspace vectors. */
export function buildBasis(params: LatentParams): SharedArrayBuffer {
  const { dims, rank, seed } = params;
  const topics = topicCount(params.chunks);
  const rows = 1 + SUPER_TOPICS + topics + topics * rank;
  const buf = new SharedArrayBuffer(rows * dims * 4);
  const out = new Float32Array(buf);
  for (let r = 0; r < rows; r++) {
    const rng = new Rng(hash32(seed, r, 0xba515));
    const row = out.subarray(r * dims, (r + 1) * dims);
    let norm = 0;
    for (let d = 0; d < dims; d++) { const g = rng.gauss(); row[d] = g; norm += g * g; }
    const isSubspace = r >= 1 + SUPER_TOPICS + topics;
    const scale = isSubspace ? 1 / Math.sqrt(dims) : 1 / Math.sqrt(norm);
    for (let d = 0; d < dims; d++) row[d]! *= scale;
  }
  return buf;
}

export class Generator {
  readonly topics: number;
  private readonly basis: Float32Array;
  private readonly acc: Float64Array;
  private readonly coef: Float64Array;
  constructor(readonly params: LatentParams, basisBuf: SharedArrayBuffer) {
    this.topics = topicCount(params.chunks);
    this.basis = new Float32Array(basisBuf);
    this.acc = new Float64Array(params.dims);
    this.coef = new Float64Array(params.rank);
  }
  private row(r: number): Float32Array { const D = this.params.dims; return this.basis.subarray(r * D, (r + 1) * D); }

  /** Writes one unit vector into `out` from subspace coefficients `coef` and noise variance `noiseVar`. */
  private compose(topic: number, coef: Float64Array, noiseVar: number, rng: Rng, out: Float32Array): void {
    const { dims: D, rank, mean, superTopic, topic: topicVar } = this.params;
    const acc = this.acc;
    const mu = this.row(0), sup = this.row(1 + (topic % SUPER_TOPICS)), top = this.row(1 + SUPER_TOPICS + topic);
    const a0 = Math.sqrt(mean), a1 = Math.sqrt(superTopic), a2 = Math.sqrt(topicVar), sn = Math.sqrt(noiseVar / D);
    for (let d = 0; d < D; d++) acc[d] = a0 * mu[d]! + a1 * sup[d]! + a2 * top[d]! + sn * rng.gauss();
    const base = 1 + SUPER_TOPICS + this.topics + topic * rank;
    for (let j = 0; j < rank; j++) {
      const c = coef[j]!;
      const b = this.row(base + j);
      for (let d = 0; d < D; d++) acc[d]! += c * b[d]!;
    }
    let norm = 0;
    for (let d = 0; d < D; d++) norm += acc[d]! * acc[d]!;
    const inv = 1 / Math.sqrt(norm);
    for (let d = 0; d < D; d++) out[d] = acc[d]! * inv;
  }

  /** Replays page `p`, calling `each(chunkIndex, vector, uPage + uChunk)` for its first `count` chunks. */
  page(p: number, count: number, each: (c: number, vec: Float32Array, coef: Float64Array) => void): void {
    const { rank, page: pageVar, chunk: chunkVar, noise, seed } = this.params;
    const h = pageHeader(seed, p, this.topics);
    const sp = Math.sqrt(pageVar / rank), sc = Math.sqrt(chunkVar / rank);
    const uPage = new Float64Array(rank);
    for (let j = 0; j < rank; j++) uPage[j] = sp * h.rng.gauss();
    const vec = new Float32Array(this.params.dims);
    for (let c = 0; c < count; c++) {
      for (let j = 0; j < rank; j++) this.coef[j] = uPage[j]! + sc * h.rng.gauss();
      this.compose(h.topic, this.coef, noise, h.rng, vec);
      each(c, vec, this.coef);
    }
  }

  query(topic: number, sourceCoef: Float64Array, rng: Rng, out: Float32Array): void {
    const { rank, queryShift, queryNoise } = this.params;
    const sq = Math.sqrt(queryShift / rank);
    const coef = new Float64Array(rank);
    for (let j = 0; j < rank; j++) coef[j] = sourceCoef[j]! + sq * rng.gauss();
    this.compose(topic, coef, queryNoise, rng, out);
  }
}

export interface LatentQueries { vectors: Float32Array[]; sourcePage: number[]; sourceChunk: number[] }

export function buildQueries(params: LatentParams, plan: PagePlan, basis: SharedArrayBuffer, n: number): LatentQueries {
  const gen = new Generator(params, basis);
  const rng = new Rng(hash32(params.seed, 0x51e7));
  const out: LatentQueries = { vectors: [], sourcePage: [], sourceChunk: [] };
  for (let i = 0; i < n; i++) {
    const chunk = Math.floor(rng.next() * params.chunks);
    let lo = 0, hi = plan.count - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (plan.chunkStart[mid]! <= chunk) lo = mid; else hi = mid - 1; }
    const c = chunk - plan.chunkStart[lo]!;
    let coef: Float64Array | undefined;
    gen.page(lo, c + 1, (ci, _vec, k) => { if (ci === c) coef = Float64Array.from(k); });
    const q = new Float32Array(params.dims);
    gen.query(plan.topic[lo]!, coef!, rng, q);
    out.vectors.push(q); out.sourcePage.push(lo); out.sourceChunk.push(c);
  }
  return out;
}

const VOCAB = (() => {
  const syl = ['ka', 'lo', 'mi', 'ten', 'ar', 'vis', 'no', 're', 'shu', 'pa', 'der', 'qui', 'lan', 'mo', 'zet', 'ri', 'bo', 'ex', 'ul', 'fen'];
  const words: string[] = [];
  const rng = new Rng(0x70c4b);
  for (let i = 0; i < 6000; i++) {
    let w = '';
    const n = 1 + Math.floor(rng.next() * 3);
    for (let j = 0; j < n; j++) w += syl[Math.floor(rng.next() * syl.length)];
    words.push(w);
  }
  return words;
})();

/** About 600 to 2,400 characters (mean about 1,500): roughly a 430-token chunk. Half the words come from the topic's slice of the vocabulary. */
export function chunkText(seed: number, p: number, c: number, topic: number): string {
  const rng = new Rng(hash32(seed, p, c, 0x7e47));
  const target = 600 + Math.floor(rng.next() * 1800);
  const parts: string[] = [];
  let len = 0;
  while (len < target) {
    const w = rng.next() < 0.5 ? VOCAB[(topic * 37 + Math.floor(rng.next() * 60)) % VOCAB.length]! : VOCAB[Math.floor(rng.next() * VOCAB.length)]!;
    parts.push(w); len += w.length + 1;
    if (rng.next() < 0.07) { parts[parts.length - 1] += '.'; }
  }
  return parts.join(' ');
}

export const pageSlug = (p: number) => `bench/latent/p${p}`;
export const hashPage = (seed: number, p: number) => hash32(seed, p, 0x51b);
export const SOURCE_IDS = ['bench-a', 'bench-b', 'bench-c'] as const;

// ---------------------------------------------------------------------------
// Binary COPY of content_chunks
// ---------------------------------------------------------------------------

const COPY_HEADER = Buffer.concat([Buffer.from('PGCOPY\n\xff\r\n\0', 'latin1'), Buffer.alloc(8)]);

class CopyBuffer {
  private buf: Buffer;
  private pos = 0;
  constructor(size: number) { this.buf = Buffer.allocUnsafe(size); }
  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.pos + n));
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }
  int16(v: number) { this.ensure(2); this.buf.writeInt16BE(v, this.pos); this.pos += 2; }
  int32(v: number) { this.ensure(4); this.buf.writeInt32BE(v, this.pos); this.pos += 4; }
  text(s: string) { const b = Buffer.from(s, 'utf8'); this.int32(b.length); this.ensure(b.length); b.copy(this.buf, this.pos); this.pos += b.length; }
  vector(v: Float32Array) {
    this.int32(4 + 4 * v.length); this.int16(v.length); this.int16(0);
    this.ensure(4 * v.length);
    for (let d = 0; d < v.length; d++) { this.buf.writeFloatBE(v[d]!, this.pos); this.pos += 4; }
  }
  raw(b: Buffer) { this.ensure(b.length); b.copy(this.buf, this.pos); this.pos += b.length; }
  get size() { return this.pos; }
  take(): Buffer { const out = Buffer.from(this.buf.subarray(0, this.pos)); this.pos = 0; return out; }
}

// ---------------------------------------------------------------------------
// Worker: load a page range and score it against every query
// ---------------------------------------------------------------------------

/** A prepared real-text corpus (hnsw-real-corpus-prep.py): chunks.txt, its line offsets, and unit vectors.f32 in chunk order. */
export interface FileCorpus { dir: string; offsets: SharedArrayBuffer }

interface WorkerInput {
  params: LatentParams; basis: SharedArrayBuffer | null; queries: SharedArrayBuffer; nQueries: number;
  plan: { chunkStart: Int32Array; chunkCount: Int32Array; topic: Int32Array; source: Uint8Array; vis: Float32Array };
  pageFrom: number; pageTo: number; url: string; model: string; file?: FileCorpus;
}

/** Replays page `p` of a file corpus: its chunk texts and vectors, read in one block each. */
function filePage(file: { offsets: Float64Array; text: number; vectors: number }, dims: number, start: number, count: number, each: (c: number, vec: Float32Array, text: string) => void): void {
  const from = file.offsets[start]!, to = file.offsets[start + count]!;
  const bytes = Buffer.allocUnsafe(to - from);
  readSync(file.text, bytes, 0, bytes.length, from);
  const texts = bytes.toString('utf8').split('\n');
  const vbuf = Buffer.allocUnsafe(count * dims * 4);
  readSync(file.vectors, vbuf, 0, vbuf.length, start * dims * 4);
  const all = new Float32Array(vbuf.buffer, vbuf.byteOffset, count * dims);
  for (let c = 0; c < count; c++) each(c, all.subarray(c * dims, (c + 1) * dims), texts[c]!);
}

/** Per query and group: up to TRUTH_K [pageIndex, similarity] pairs, best first; chunk-level top LID_K distances per query. */
export interface ShardTruth { pages: Array<Array<Array<[number, number]>>>; chunkSims: number[][] }

class TopK {
  ids: number[] = []; sims: number[] = [];
  constructor(private readonly k: number) {}
  get floor(): number { return this.sims.length < this.k ? -Infinity : this.sims[this.sims.length - 1]!; }
  push(id: number, sim: number) {
    if (sim <= this.floor) return;
    let i = this.sims.length;
    while (i > 0 && this.sims[i - 1]! < sim) i--;
    this.ids.splice(i, 0, id); this.sims.splice(i, 0, sim);
    if (this.sims.length > this.k) { this.ids.pop(); this.sims.pop(); }
  }
}

async function runWorker(input: WorkerInput): Promise<ShardTruth> {
  const { params, nQueries, plan, pageFrom, pageTo } = input;
  const D = params.dims;
  const gen = input.basis ? new Generator(params, input.basis) : null;
  const file = input.file ? { offsets: new Float64Array(input.file.offsets), text: openSync(join(input.file.dir, 'chunks.txt'), 'r'), vectors: openSync(join(input.file.dir, 'vectors.f32'), 'r') } : null;
  const Q = new Float32Array(input.queries);
  const groupTops = Array.from({ length: nQueries }, () => GROUPS.map(() => new TopK(TRUTH_K)));
  const chunkTops = Array.from({ length: nQueries }, () => new TopK(LID_K));
  const best = new Float64Array(nQueries);
  const sql = postgres(input.url, { max: 1, prepare: false, onnotice: () => {} });
  const copy = await sql.unsafe(`COPY content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding) FROM STDIN (FORMAT binary)`).writable();
  const finished = new Promise<void>((res, rej) => { copy.on('finish', res); copy.on('error', rej); });
  const out = new CopyBuffer(16 << 20);
  out.raw(COPY_HEADER);
  const flush = async () => { if (!copy.write(out.take())) await new Promise(r => copy.once('drain', r)); };
  for (let p = pageFrom; p < pageTo; p++) {
    best.fill(-Infinity);
    const topic = plan.topic[p]!;
    const each = (c: number, vec: Float32Array, text: string) => {
      out.int16(7);
      out.int32(4); out.int32(p + 1);
      out.int32(4); out.int32(c);
      out.text(text); out.text('compiled_truth'); out.text(input.model);
      out.text(createHash('md5').update(text).digest('hex'));
      out.vector(vec);
      for (let q = 0; q < nQueries; q++) {
        let dot = 0;
        const off = q * D;
        for (let d = 0; d < D; d++) dot += vec[d]! * Q[off + d]!;
        if (dot > best[q]!) best[q] = dot;
        chunkTops[q]!.push(0, dot);
      }
    };
    if (file) filePage(file, D, plan.chunkStart[p]!, plan.chunkCount[p]!, each);
    else gen!.page(p, plan.chunkCount[p]!, (c, vec) => each(c, vec, chunkText(params.seed, p, c, topic)));
    for (let q = 0; q < nQueries; q++) {
      const tops = groupTops[q]!;
      for (let g = 0; g < GROUPS.length; g++) if (inGroup(GROUPS[g]!, plan.source[p]!, plan.vis[p]!)) tops[g]!.push(p, best[q]!);
    }
    if (out.size > 8 << 20) await flush();
  }
  out.int16(-1);
  await flush();
  copy.end();
  await finished;
  await sql.end();
  if (file) { closeSync(file.text); closeSync(file.vectors); }
  return {
    pages: groupTops.map(tops => tops.map(t => t.ids.map((id, i) => [id, t.sims[i]!] as [number, number]))),
    chunkSims: chunkTops.map(t => t.sims),
  };
}

if (!isMainThread && (workerData as { latentCorpus?: boolean } | null)?.latentCorpus) {
  runWorker(workerData as WorkerInput).then(r => parentPort!.postMessage({ ok: r }), (e: Error) => parentPort!.postMessage({ error: e.stack ?? e.message }));
}

/**
 * Streams the corpus into content_chunks (pages must already exist with
 * id = pageIndex + 1) across `workers` workers and returns the merged truth:
 * `pages[q][g]` = the exact top TRUTH_K page indexes for query q under
 * GROUPS[g], best first, and `lid[q]` the MLE local intrinsic dimension at
 * query q over its LID_K nearest chunks.
 */
export async function loadLatentCorpus(input: {
  params: LatentParams; plan: PagePlan; basis: SharedArrayBuffer | null; queries: Float32Array[]; url: string; model: string; workers: number;
  log: (m: string) => void; file?: FileCorpus;
}): Promise<{ pages: number[][][]; lid: number[]; top1Sim: number[] }> {
  const { params, plan, queries } = input;
  const qbuf = new SharedArrayBuffer(queries.length * params.dims * 4);
  const qflat = new Float32Array(qbuf);
  queries.forEach((q, i) => qflat.set(q, i * params.dims));
  const shards: Array<[number, number]> = [];
  const per = params.chunks / input.workers;
  let from = 0;
  for (let w = 1; w <= input.workers; w++) {
    let to = from;
    while (to < plan.count && (w === input.workers || plan.chunkStart[to]! < per * w)) to++;
    if (to > from) shards.push([from, to]);
    from = to;
  }
  let done = 0;
  const results = await Promise.all(shards.map(([pageFrom, pageTo]) => new Promise<ShardTruth>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        latentCorpus: true, params, basis: input.basis, queries: qbuf, nQueries: queries.length,
        plan: { chunkStart: plan.chunkStart, chunkCount: plan.chunkCount, topic: plan.topic, source: plan.source, vis: plan.vis }, pageFrom, pageTo, url: input.url, model: input.model,
        ...(input.file ? { file: input.file } : {}),
      } satisfies WorkerInput & { latentCorpus: true },
    });
    worker.on('message', (m: { ok?: ShardTruth; error?: string }) => {
      void worker.terminate();
      if (m.error) return reject(new Error(m.error));
      input.log(`loaded shard ${++done}/${shards.length} (pages ${pageFrom}..${pageTo - 1})`);
      resolve(m.ok!);
    });
    worker.on('error', reject);
  })));
  const pages = queries.map((_, q) => GROUPS.map((_, g) => {
    const merged = results.flatMap(r => r.pages[q]![g]!);
    merged.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return merged.slice(0, TRUTH_K).map(([p]) => p);
  }));
  const lid: number[] = [], top1Sim: number[] = [];
  queries.forEach((_, q) => {
    const sims = results.flatMap(r => r.chunkSims[q]!).sort((a, b) => b - a).slice(0, LID_K);
    const dist = sims.map(s => Math.sqrt(Math.max(1e-12, 2 - 2 * s)));
    const dk = dist[dist.length - 1]!;
    const mean = dist.slice(0, -1).reduce((acc, d) => acc + Math.log(d / dk), 0) / (dist.length - 1);
    lid.push(-1 / mean);
    top1Sim.push(sims[0]!);
  });
  return { pages, lid, top1Sim };
}
