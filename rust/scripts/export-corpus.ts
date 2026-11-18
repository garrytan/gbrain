#!/usr/bin/env bun
/**
 * Export an existing gbrain brain to the `gbrain-bench-corpus/1` directory format, so the bake-off
 * (rust/bench/baseline for PGLite/Postgres, rust/bench for the Rust stores) can run on a real brain's shape.
 *
 *   bun rust/scripts/export-corpus.ts --out ~/private/my-brain-corpus                 # the brain from your gbrain config
 *   bun rust/scripts/export-corpus.ts --out <dir> --database-url postgresql://...     # a Postgres brain
 *   bun rust/scripts/export-corpus.ts --out <dir> --pglite-dir <path-to-pglite-dir>   # a PGLite brain (closes nothing: stop other gbrain processes first)
 *
 * PRIVACY: the export holds the full text of your pages and chunks. It is private data. Never commit it, share it,
 * attach it to an issue or upload it. Only aggregate numbers from a benchmark run may be published. Files are written
 * 0600 (directory 0700), and the script refuses an output directory inside a git working tree.
 *
 * The brain is only read. Nothing calls an embedding or chat provider: the vectors are the ones already stored.
 * Queries are sampled from stored chunk vectors, so (unlike the dbpedia corpus) they are IN the corpus: their
 * nearest neighbor is themselves. The manifest says so (`queries_in_corpus: true`).
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createEngine } from '../../src/core/engine-factory.ts';
import { loadConfig, toEngineConfig } from '../../src/core/config.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { isSegmentedPage } from '../../src/core/page-body/page-shape.ts';

const USAGE = `usage: bun rust/scripts/export-corpus.ts --out <dir> [--database-url <url> | --pglite-dir <dir>] [--queries 1000] [--seed 1] [--allow-in-repo] [--overwrite]`;

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const args = new Map<string, string | true>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
  const name = a.slice(2);
  if (['allow-in-repo', 'overwrite', 'help'].includes(name)) args.set(name, true);
  else if (['out', 'database-url', 'pglite-dir', 'queries', 'seed'].includes(name)) {
    const v = argv[++i];
    if (v === undefined) fail(`--${name} needs a value`);
    args.set(name, v);
  } else fail(`unknown flag --${name}`);
}
if (args.has('help')) { console.log(USAGE); process.exit(0); }

const outArg = args.get('out') as string | undefined;
if (!outArg) fail('--out is required');
const out = resolve(outArg);
const queryCount = Number(args.get('queries') ?? 1000);
if (!Number.isInteger(queryCount) || queryCount < 0) fail('--queries must be a non-negative integer');
let seed = Number(args.get('seed') ?? 1) >>> 0;
const rand = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The one answer that counts as outside a repository: git's own, in the C locale, exit 128. */
const OUTSIDE_ANY_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git';

/**
 * Where `dir` sits relative to git. Only exit 128 with stderr exactly OUTSIDE_ANY_REPOSITORY counts as outside:
 * a missing git, unsafe ownership, a message in another language or any other probe failure is 'unknown', which
 * the caller refuses like 'inside'. The probe runs with LC_ALL=C and LANG=C so that message is the same on every
 * machine, and inherited GIT_* settings are dropped so a stray GIT_DIR cannot point the probe somewhere else.
 */
function gitWorkTreeStatus(dir: string): { status: 'inside' | 'outside' | 'unknown'; detail: string } {
  let probe = dir;
  while (!existsSync(probe)) probe = resolve(probe, '..');
  const env: Record<string, string> = { LC_ALL: 'C', LANG: 'C' };
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_') && key !== 'LC_ALL' && key !== 'LANG') env[key] = value;
  }
  const run = spawnSync('git', ['-C', probe, 'rev-parse', '--is-inside-work-tree'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (run.status === 0) return { status: 'inside', detail: '' };
  if (run.status === 128 && (run.stderr ?? '').replace(/\r?\n$/, '') === OUTSIDE_ANY_REPOSITORY) return { status: 'outside', detail: '' };
  const detail = run.error ? run.error.message : (run.stderr ?? '').trim() || `git exited ${run.status}`;
  return { status: 'unknown', detail };
}

if (!args.has('allow-in-repo')) {
  const where = gitWorkTreeStatus(out);
  if (where.status === 'inside') {
    fail(`refusing to write private brain text inside a git working tree (${out}); pick a directory outside any repo, or pass --allow-in-repo`);
  }
  if (where.status === 'unknown') {
    fail(`refusing to write private brain text: could not tell whether ${out} is inside a git working tree (${where.detail}); fix git, pick a directory outside any repo, or pass --allow-in-repo`);
  }
}
if (existsSync(out) && readdirSync(out).length > 0 && !args.has('overwrite')) fail(`${out} is not empty; pass --overwrite to replace the corpus files in it`);

let config: EngineConfig;
if (args.has('database-url')) config = { engine: 'postgres', database_url: args.get('database-url') as string, pool_max: 2 };
else if (args.has('pglite-dir')) config = { engine: 'pglite', database_path: resolve(args.get('pglite-dir') as string) };
else {
  const loaded = loadConfig();
  if (!loaded) fail('no gbrain config found; pass --database-url or --pglite-dir');
  config = toEngineConfig(loaded);
}

console.error([
  '',
  '  WARNING: this export contains the full text of your private brain.',
  '  Keep it outside any repository, never share or upload it, and publish only aggregate benchmark numbers.',
  '',
].join('\n'));

mkdirSync(out, { recursive: true, mode: 0o700 });
chmodSync(out, 0o700);
const open = (name: string) => openSync(join(out, name), 'w', 0o600);
const writeLine = (fd: number, value: unknown) => writeSync(fd, JSON.stringify(value) + '\n');

const engine = await createEngine(config);
await engine.connect(config);
try {
  const sources = (await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')).map(r => r.id);
  const pagesFd = open('pages.jsonl');
  const chunksFd = open('chunks.jsonl');
  const vectorsFd = open('vectors.f32');
  const queryReservoir: { vector: Float32Array; text: string }[] = [];

  let pageIndex = 0, chunkRow = 0, skippedChunks = 0, skippedPages = 0, skippedSegmented = 0, dims = 0, seen = 0, maxNormDeviation = 0;
  const usedSources: string[] = [];

  for (const sourceId of sources) {
    let after: string | undefined;
    let any = false;
    for (;;) {
      const batch = await engine.listPages({ sourceId, sort: 'slug', limit: 200, ...(after ? { slugAfter: after } : {}) });
      if (batch.length === 0) break;
      for (const page of batch) {
        after = page.slug;
        // A segmented page's body getters throw page_body_segmented: skip and count it before anything is written for
        // it, instead of aborting the export after its files were opened.
        if (isSegmentedPage(page)) {
          skippedSegmented++;
          continue;
        }
        let chunks;
        try {
          chunks = await engine.getChunks(page.slug, { sourceId, includeEmbedding: true });
        } catch {
          skippedPages++;
          continue;
        }
        const body = page.timeline && page.timeline.trim() ? `${page.compiled_truth}\n\n${page.timeline}` : page.compiled_truth;
        any = true;
        const embedded = chunks.filter(c => c.embedding && c.embedding.length > 0);
        skippedChunks += chunks.length - embedded.length;
        const chunkStart = chunkRow;
        for (const c of embedded) {
          const v = c.embedding!;
          if (dims === 0) dims = v.length;
          if (v.length !== dims) throw new Error(`chunk ${page.slug}#${c.chunk_index} has ${v.length} dimensions, expected ${dims}`);
          let sq = 0;
          for (let d = 0; d < v.length; d++) sq += v[d]! * v[d]!;
          maxNormDeviation = Math.max(maxNormDeviation, Math.abs(Math.sqrt(sq) - 1));
          writeLine(chunksFd, { page: pageIndex, idx: c.chunk_index, text: c.chunk_text });
          writeSync(vectorsFd, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
          chunkRow++;
          // reservoir sample of stored vectors for the query set
          seen++;
          if (queryReservoir.length < queryCount) queryReservoir.push({ vector: Float32Array.from(v), text: c.chunk_text.slice(0, 60) });
          else {
            const j = Math.floor(rand() * seen);
            if (j < queryCount) queryReservoir[j] = { vector: Float32Array.from(v), text: c.chunk_text.slice(0, 60) };
          }
        }
        writeLine(pagesFd, {
          i: pageIndex, source_id: sourceId, slug: page.slug, type: page.type, title: page.title,
          frontmatter: page.frontmatter ?? {}, body, chunk_start: chunkStart, chunk_count: embedded.length,
        });
        pageIndex++;
      }
      if (batch.length < 200) break;
    }
    if (any) usedSources.push(sourceId);
  }
  closeSync(pagesFd); closeSync(chunksFd); closeSync(vectorsFd);

  const queriesFd = open('queries.f32');
  const queriesJsonl = open('queries.jsonl');
  queryReservoir.forEach((q, i) => {
    writeSync(queriesFd, new Uint8Array(q.vector.buffer, q.vector.byteOffset, q.vector.byteLength));
    writeLine(queriesJsonl, { q: i, text: q.text });
  });
  closeSync(queriesFd); closeSync(queriesJsonl);

  const manifest = {
    format: 'gbrain-bench-corpus/1', dims, pages: pageIndex, chunks: chunkRow, queries: queryReservoir.length,
    sources: usedSources, origin: `export of a ${engine.kind} gbrain brain (private; never commit or share)`,
    queries_in_corpus: true, skipped_chunks_without_embedding: skippedChunks, skipped_pages_unreadable: skippedPages,
    skipped_pages_segmented: skippedSegmented,
    max_abs_norm_deviation: Number(maxNormDeviation.toFixed(6)),
  };
  const manifestPath = join(out, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  console.error(`exported ${pageIndex} pages, ${chunkRow} chunks (${dims} dims), ${queryReservoir.length} queries to ${out}`);
  if (skippedChunks || skippedPages || skippedSegmented) {
    console.error(`skipped ${skippedChunks} chunks without an embedding, ${skippedPages} unreadable pages and ${skippedSegmented} segmented pages`);
  }
} finally {
  await engine.disconnect();
}
