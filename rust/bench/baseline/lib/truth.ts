/**
 * Exact top-10 ground truth for the corpus queries, shared with the Rust harness through
 * `<corpus>/truth_top10.json`: an array with one entry per query, each entry the 10 nearest chunk
 * row indices (rows of vectors.f32), best first. If the Rust harness already wrote the file it is reused;
 * otherwise it is computed here (brute-force dot products on worker threads) and written in the same format.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cpus } from 'node:os';
import type { Corpus } from './corpus.ts';

export interface TruthResult { top10: number[][]; source: 'file' | 'computed'; computeSeconds?: number; persisted: boolean }

function validTruth(value: unknown, queries: number, rows: number): value is number[][] {
  return Array.isArray(value) && value.length >= queries
    && value.slice(0, queries).every(e => Array.isArray(e) && e.length === 10 && e.every(r => Number.isInteger(r) && r >= 0 && r < rows));
}

export async function loadOrComputeTruth(corpus: Corpus, neededQueries: number, fullCorpus: boolean): Promise<TruthResult> {
  const path = join(corpus.dir, 'truth_top10.json');
  if (fullCorpus && existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (validTruth(parsed, neededQueries, corpus.chunks.length)) return { top10: parsed, source: 'file', persisted: true };
    } catch { /* unreadable or half-written: recompute */ }
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
  if (fullCorpus) {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(top10));
    renameSync(tmp, path); // atomic: the Rust harness never sees a half-written file
    persisted = true;
  }
  return { top10, source: 'computed', computeSeconds, persisted };
}
