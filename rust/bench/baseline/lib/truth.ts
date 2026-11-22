/**
 * Exact top-10 ground truth for the corpus queries, shared with the Rust harness through
 * `<corpus>/truth_top10.json`. The file is one JSON object:
 *
 *   { "format": "gbrain-bench-truth/1",
 *     "fingerprint": { "k": 10, "dims": D,
 *                      "vectors": { "bytes": N, "sha256": "<hex>" },
 *                      "queries": { "bytes": N, "sha256": "<hex>" } },
 *     "top10": [[row, ...], ...] }
 *
 * `top10` has one entry per query, each the 10 nearest chunk row indices (rows of vectors.f32), best first.
 * `fingerprint` names the exact corpus files the truth was computed from. A cached file is reused only when
 * the fingerprint of the current `vectors.f32` and `queries.f32` matches; a missing or different fingerprint
 * (including the older bare-array file) means the truth is recomputed here (brute-force dot products on
 * worker threads) and the file is rewritten in the same format. The Rust harness reads and writes the same file.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cpus } from 'node:os';
import type { Corpus } from './corpus.ts';

export interface TruthResult { top10: number[][]; source: 'file' | 'computed'; computeSeconds?: number; persisted: boolean }

export const TRUTH_FORMAT = 'gbrain-bench-truth/1';
export const TRUTH_K = 10;

export interface FileIdentity { bytes: number; sha256: string }
export interface TruthFingerprint { k: number; dims: number; vectors: FileIdentity; queries: FileIdentity }

function fileIdentity(path: string): FileIdentity {
  const hash = createHash('sha256');
  const buf = Buffer.allocUnsafe(8 << 20);
  const fd = openSync(path, 'r');
  let bytes = 0;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally { closeSync(fd); }
  return { bytes, sha256: hash.digest('hex') };
}

/** The identity of the corpus files the truth depends on: the byte size and sha256 of both vector files. */
export function truthFingerprint(dir: string, dims: number): TruthFingerprint {
  return { k: TRUTH_K, dims, vectors: fileIdentity(join(dir, 'vectors.f32')), queries: fileIdentity(join(dir, 'queries.f32')) };
}

const sameIdentity = (a: unknown, b: FileIdentity): boolean => {
  const x = a as Partial<FileIdentity> | null | undefined;
  return !!x && x.bytes === b.bytes && x.sha256 === b.sha256;
};

function sameFingerprint(a: unknown, b: TruthFingerprint): boolean {
  const x = a as Partial<TruthFingerprint> | null | undefined;
  return !!x && x.k === b.k && x.dims === b.dims && sameIdentity(x.vectors, b.vectors) && sameIdentity(x.queries, b.queries);
}

function validTruth(value: unknown, queries: number, rows: number): value is number[][] {
  return Array.isArray(value) && value.length >= queries
    && value.slice(0, queries).every(e => Array.isArray(e) && e.length === TRUTH_K && e.every(r => Number.isInteger(r) && r >= 0 && r < rows));
}

export async function loadOrComputeTruth(corpus: Corpus, neededQueries: number, fullCorpus: boolean): Promise<TruthResult> {
  const path = join(corpus.dir, 'truth_top10.json');
  const fingerprint = fullCorpus ? truthFingerprint(corpus.dir, corpus.dims) : undefined;
  if (fingerprint && existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { format?: unknown; fingerprint?: unknown; top10?: unknown };
      if (parsed.format === TRUTH_FORMAT && sameFingerprint(parsed.fingerprint, fingerprint) && validTruth(parsed.top10, neededQueries, corpus.chunks.length)) {
        return { top10: parsed.top10, source: 'file', persisted: true };
      }
    } catch { /* unreadable, half-written or an older bare-array file: recompute */ }
  }
  const started = performance.now();
  const rows = corpus.chunks.length;
  const total = fullCorpus ? corpus.queryCount : neededQueries;
  const vectors = new SharedArrayBuffer(rows * corpus.dims * 4);
  new Float32Array(vectors).set(corpus.vectors.subarray(0, rows * corpus.dims));
  const queries = new SharedArrayBuffer(total * corpus.dims * 4);
  new Float32Array(queries).set(corpus.queries.subarray(0, total * corpus.dims));
  const workers = Math.max(1, Math.min(cpus().length, total));
  const top10: number[][] = new Array(total);
  const step = Math.ceil(total / workers);
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise<void>((resolve, reject) => {
    const q0 = w * step, q1 = Math.min(total, q0 + step);
    if (q0 >= q1) return resolve();
    const worker = new Worker(new URL('./truth-worker.ts', import.meta.url).href);
    worker.onmessage = (event: MessageEvent<{ q0: number; result: number[][] }>) => {
      event.data.result.forEach((r, k) => { top10[event.data.q0 + k] = r; });
      worker.terminate();
      resolve();
    };
    worker.onerror = e => { worker.terminate(); reject(new Error(`truth worker failed: ${e.message}`)); };
    worker.postMessage({ vectors, queries, dims: corpus.dims, rows, q0, q1 });
  })));
  const computeSeconds = (performance.now() - started) / 1000;
  let persisted = false;
  if (fingerprint) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ format: TRUTH_FORMAT, fingerprint, top10 }));
    renameSync(tmp, path); // atomic: the Rust harness never sees a half-written file
    persisted = true;
  }
  return { top10, source: 'computed', computeSeconds, persisted };
}
