/** Reader for the gbrain-bench-corpus/1 directory format (see /rust/bench/README or the bake-off spec). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CorpusManifest {
  format: string;
  dims: number;
  pages: number;
  chunks: number;
  queries: number;
  sources: string[];
  origin?: string;
  [extra: string]: unknown;
}

export interface CorpusPage {
  i: number;
  source_id: string;
  slug: string;
  type: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  chunk_start: number;
  chunk_count: number;
}

export interface CorpusChunk { page: number; idx: number; text: string }

export interface Corpus {
  dir: string;
  manifest: CorpusManifest;
  dims: number;
  pages: CorpusPage[];
  chunks: CorpusChunk[];
  /** chunks x dims, row-major, unit length. */
  vectors: Float32Array;
  queryCount: number;
  queries: Float32Array;
}

function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, 'utf8');
  const out: T[] = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (end > start) out.push(JSON.parse(text.slice(start, end)) as T);
    start = end + 1;
  }
  return out;
}

async function readF32(path: string, expected: number): Promise<Float32Array> {
  const buf = await Bun.file(path).arrayBuffer();
  const out = new Float32Array(buf);
  if (out.length !== expected) throw new Error(`${path}: expected ${expected} floats, found ${out.length}`);
  return out;
}

/** `pageLimit`: keep only the first N pages and their chunks (smoke runs). */
export async function loadCorpus(dir: string, pageLimit?: number): Promise<Corpus> {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${dir} is not a corpus directory (no manifest.json)`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CorpusManifest;
  if (manifest.format !== 'gbrain-bench-corpus/1') throw new Error(`unsupported corpus format: ${manifest.format}`);
  const dims = manifest.dims;
  let pages = readJsonl<CorpusPage>(join(dir, 'pages.jsonl'));
  let chunks = readJsonl<CorpusChunk>(join(dir, 'chunks.jsonl'));
  let vectors = await readF32(join(dir, 'vectors.f32'), manifest.chunks * dims);
  if (pages.length !== manifest.pages) throw new Error(`pages.jsonl has ${pages.length} pages, manifest says ${manifest.pages}`);
  if (chunks.length !== manifest.chunks) throw new Error(`chunks.jsonl has ${chunks.length} chunks, manifest says ${manifest.chunks}`);
  if (pageLimit !== undefined && pageLimit < pages.length) {
    pages = pages.slice(0, pageLimit);
    const lastChunk = pages[pages.length - 1]!.chunk_start + pages[pages.length - 1]!.chunk_count;
    chunks = chunks.slice(0, lastChunk);
    vectors = vectors.subarray(0, lastChunk * dims);
  }
  const queries = await readF32(join(dir, 'queries.f32'), manifest.queries * dims);
  return { dir, manifest, dims, pages, chunks, vectors, queryCount: manifest.queries, queries };
}

export const chunkVector = (c: Corpus, row: number): Float32Array => c.vectors.subarray(row * c.dims, (row + 1) * c.dims);
export const queryVector = (c: Corpus, q: number): Float32Array => c.queries.subarray(q * c.dims, (q + 1) * c.dims);

/** Comparison key shared by truth mapping and search results: slugs are unique across sources in this corpus format. */
export const chunkKey = (slug: string, chunkIndex: number) => `${slug}#${chunkIndex}`;

/** Row index -> (slug, chunk_index) key. */
export function rowKeys(c: Corpus): string[] {
  const keys = new Array<string>(c.chunks.length);
  for (const p of c.pages) {
    for (let k = 0; k < p.chunk_count; k++) {
      const row = p.chunk_start + k;
      keys[row] = chunkKey(p.slug, c.chunks[row]!.idx);
    }
  }
  return keys;
}
