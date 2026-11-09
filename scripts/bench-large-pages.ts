/**
 * Large-page bench (Wave C spec §9.2, PR 1G; record-only): every run writes one versioned JSON receipt
 * (scripts/bench-large-pages-receipt.ts, checked with validateReceipt before it is written). Pages come from the streamed
 * generator (test/helpers/conversation-stream.ts: flat memory, a needle at every decile, the seed in the receipt).
 *
 * Door stages (`--stages door`): a temporary managed brain whose source is strict (`sources.config.canonical = "git"`)
 * with a local bare remote, so every write goes through the door (put_page, append_page and edit_page publish under the
 * worktree's native writer lock and commit to Git before their database row). Embeddings off, no provider calls.
 * - `door_put`: a `--put` page (default 2MiB) put, with `detail.queued_small_write_ms`: the latency of a small put
 *   issued once the large put holds the writer lock (its `prepared` publication boundary), so it queues behind it;
 * - `door_create`: a `--door-page` page (default 20MiB) put; `door_probes`: 10 decile keyword probes against it;
 * - `door_append`: a 10 KB append to that page; `door_splice`: an edit_page replacing its 50% needle.
 * Each publishing stage records `lock_hold_ms`, the native writer-lock hold of its publication (the hold on the
 * worktree's lock path, native-lock.ts `nativeLockSeams`, that spans the publication's `prepared` and
 * `after_commit` boundaries), and `git`: loose and packed object bytes of the checkout (`git count-objects -v`).
 *
 * Database stages (`--stages database`, Wave B, record-only until PRs 1H and 1I land): one `--size` page (default: the
 * engine's `pages.max_bytes` ceiling, 256 MiB on Postgres and 128 MiB on PGLite, less 64 KiB so the append stays under
 * it; above PAGE_MAX_BYTES) through the
 * streamed segmented import, with small puts issued one per event-loop turn meanwhile (`detail.concurrent_small_put`),
 * a 10 KB append re-import, the peak RSS of a fresh child importing the page and a 1 MiB reference
 * (`database_child_rss`), and `flipBodyGeneration` retiring `--flip-rows` live chunk rows (default
 * 5000,10000,20000,40000) without and with embeddings, in one transaction under the publication timeouts (lock_timeout
 * 1 s, statement_timeout 5 s). These stages import the generated file directly, as in Wave B; no new writer is added.
 *
 * Every stage records wall time, row counts and the process's peak RSS over the stage (VmHWM after `clear_refs`).
 * Run it under a memory cap so a regression fails instead of swapping:
 *   sudo systemd-run --scope -p MemoryMax=6G bun scripts/bench-large-pages.ts --out receipt.json
 *   sudo systemd-run --scope -p MemoryMax=6G env DATABASE_URL=postgresql://... bun scripts/bench-large-pages.ts --engine postgres --out receipt.json
 * Flags: --size, --put, --door-page <N>{B,KiB,MiB,GiB,KB,MB,GB} (a bare number is bytes: 1e9), --engine pglite|postgres
 * (default pglite; postgres reads DATABASE_URL, a disposable database), --stages door,database (default both), --seed <n>
 * (default 1), --flip-rows <N,...>, --out <file> (default: stdout).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent, importFromFile } from '../src/core/import-file.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { importStreamedMarkdownFile } from '../src/core/page-body/streamed-import.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { nativeLockSeams } from '../src/core/persistence/native-lock.ts';
import { conversationTurns, writeConversationFile, type ConversationFile } from '../test/helpers/conversation-stream.ts';
import { durableGitRepo, git } from '../test/helpers/git-publication.ts';
import { managedBrain } from '../test/helpers/managed-brain.ts';
import { flipInput, publishSegmentedPage, segmentText, stageGeneration } from '../test/helpers/page-body-fixtures.ts';
import { strictSource } from '../test/helpers/strict-door-audit.ts';
import { RECEIPT_SCHEMA, RECEIPT_VERSION, validateReceipt, type GitSizes, type Receipt, type ReceiptPage, type ReceiptStage } from './bench-large-pages-receipt.ts';

const SLUG = 'bench/large-page';

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : fallback;
}

function parseSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?(?:e\d+)?)\s*(B|KiB|MiB|GiB|KB|MB|GB)?$/.exec(raw.trim());
  if (!match) throw new Error(`size ${raw}: expected a number of bytes or one with B, KiB, MiB, GiB, KB, MB or GB`);
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, KB: 1e3, MB: 1e6, GB: 1e9 }[(match[2] ?? 'B') as 'B'];
  return Math.round(Number(match[1]) * unit);
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * This process's own peak RSS. Linux keeps getrusage's maxRSS across execve, so a child spawned by a parent that has
 * ingested a large page reports at least the parent's peak; VmHWM belongs to the new address space.
 */
function peakRssBytes(): number {
  const hwm = existsSync('/proc/self/status') ? /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8')) : null;
  return (hwm ? Number(hwm[1]) : process.resourceUsage().maxRSS) * 1024;
}

/** Runs one stage: resets the peak RSS (`clear_refs` 5), then reports its wall time and the peak over it. */
async function measure<T>(run: () => Promise<T>): Promise<{ value: T; ms: number; rss_peak_bytes: number }> {
  if (existsSync('/proc/self/clear_refs')) writeFileSync('/proc/self/clear_refs', '5');
  const t0 = performance.now();
  const value = await run();
  return { value, ms: round(performance.now() - t0), rss_peak_bytes: peakRssBytes() };
}

/** About `bytes` of conversation turns (the 10 KB appends and the flip cells' chunk texts). */
function turnsText(bytes: number, seed: number): string {
  const turn = conversationTurns(seed);
  let text = '';
  while (text.length < bytes) text += turn();
  return text.trimEnd();
}

const receiptPage = (slug: string, file: ConversationFile): ReceiptPage => ({ slug, bytes: file.bytes, seed: file.seed, sha256: file.sha256, needles: file.needles });

async function openEngine(kind: string, dir: string): Promise<BrainEngine> {
  if (kind === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('--engine postgres needs DATABASE_URL (a disposable database: the bench deletes its page).');
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const engine = new PostgresEngine();
    await engine.connect({ database_url: url });
    await engine.initSchema();
    return engine;
  }
  const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: join(dir, 'brain.pglite') });
  await engine.initSchema();
  return engine;
}

async function count(engine: BrainEngine, sql: string, params: unknown[]): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string }>(sql, params);
  return Number(row?.n ?? 0);
}

async function pageRows(engine: BrainEngine, slug: string) {
  const [page] = await engine.executeRaw<{ id: number; body_generation: number | string }>('SELECT id, body_generation FROM pages WHERE slug=$1 AND deleted_at IS NULL', [slug]);
  if (!page) throw new Error(`the bench page ${slug} was not written`);
  const id = Number(page.id);
  const generation = Number(page.body_generation);
  const live = 'page_id=$1 AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2)';
  return {
    pages: await count(engine, 'SELECT count(*) AS n FROM pages WHERE deleted_at IS NULL', []),
    texts: await count(engine, `SELECT count(DISTINCT sha256) AS n FROM page_body_manifest WHERE ${live}`, [id, generation]),
    manifest: await count(engine, `SELECT count(*) AS n FROM page_body_manifest WHERE ${live}`, [id, generation]),
    manifest_at_generation: await count(engine, 'SELECT count(*) AS n FROM page_body_manifest WHERE page_id=$1 AND gen_from=$2', [id, generation]),
    chunks: await count(engine, 'SELECT count(*) AS n FROM content_chunks WHERE page_id=$1', [id]),
    chunks_at_generation: await count(engine, 'SELECT count(*) AS n FROM content_chunks WHERE page_id=$1 AND body_generation=$2', [id, generation]),
  };
}

function gitSizes(root: string): GitSizes {
  const fields = Object.fromEntries(git(root, 'count-objects', '-v').trim().split('\n').map(line => line.split(': ')).map(([key, value]) => [key, Number(value)]));
  return { loose_objects: fields.count!, loose_bytes: fields.size! * 1024, packs: fields.packs!, packed_bytes: fields['size-pack']! * 1024 };
}

const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) => operations.find(op => op.name === name)!.handler(ctx, params) as Promise<Record<string, any>>;

/**
 * One write through its operation, waited on until its receipt commits (a write past the 30 s wait answers pending) and
 * then until its page's text projection is sealed at its new revision (`text_projection_revision = knowledge_revision`:
 * searchable, keyword-only with embeddings off). Returns the milliseconds until the commit.
 */
async function write(ctx: OperationContext, name: string, params: Record<string, unknown>, requestId: string): Promise<number> {
  const t0 = performance.now();
  const result = await call(ctx, name, { ...params, request_id: requestId, wait_ms: 30_000 })
    .catch((error: { code?: string }) => { if (error?.code === 'write_pending') return null; throw error; });
  let state = result?.state ?? result?.receipt?.state;
  while (state !== 'committed') {
    if (state === 'conflict' || state === 'failed' || state === 'cancelled') throw new Error(`${name} ${requestId} ended ${state}`);
    await Bun.sleep(100);
    state = (await call(ctx, 'get_write_request', { request_id: requestId })).state;
  }
  const committed = performance.now() - t0;
  const sealed = () => ctx.engine.executeRaw<{ sealed: boolean }>(`SELECT (text_projection_revision = knowledge_revision) IS TRUE AS sealed
    FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL`, [params.slug]);
  while (!(await sealed())[0]?.sealed) await Bun.sleep(100);
  return round(committed);
}

async function doorStages(kind: string, dir: string, sizes: { put: number; page: number }, seed: number, pages: ReceiptPage[]): Promise<ReceiptStage[]> {
  const stages: ReceiptStage[] = [];
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
  await managedBrain(async ({ engine, ctx, root }) => {
    const remote = join(root, '..', 'remote.git');
    git(root, 'init', '-q', '--bare', remote);
    git(root, 'remote', 'add', 'origin', remote);
    git(root, 'push', '-q', '-u', 'origin', 'HEAD');
    await strictSource(engine);
    const [binding] = await engine.executeRaw<{ coordination_path: string }>('SELECT coordination_path FROM persistence_host_bindings');
    const holds: Array<{ start: number; end: number }> = [];
    const marks = new Map<string, { prepared?: number; committed?: number }>();
    let onPrepared: ((requestId: string) => void) | undefined;
    nativeLockSeams.held = (path, ms) => { if (path === binding!.coordination_path) holds.push({ start: performance.now() - ms, end: performance.now() }); };
    installFaultHook(async (point, detail) => {
      const mark = detail.requestId ? marks.get(detail.requestId) : undefined;
      if (!mark) return;
      if (point === 'publication:prepared') { mark.prepared = performance.now(); onPrepared?.(detail.requestId!); }
      if (point === 'publication:after_commit') mark.committed = performance.now();
    });
    const publish = async (name: string, params: Record<string, unknown>) => {
      const requestId = randomUUID();
      marks.set(requestId, {});
      return { requestId, committedMs: await write(ctx, name, params, requestId) };
    };
    const lockHold = (requestId: string) => {
      const mark = marks.get(requestId)!;
      const hold = holds.find(h => mark.prepared !== undefined && mark.committed !== undefined && h.start <= mark.prepared && h.end >= mark.committed);
      if (!hold) throw new Error(`no native writer-lock hold spans publication ${requestId} (${holds.length} holds seen)`);
      return round(hold.end - hold.start);
    };
    const stage = async (name: ReceiptStage['name'], slug: string, run: () => Promise<{ requestId: string; committedMs: number; detail?: Record<string, unknown> }>) => {
      const { value, ms, rss_peak_bytes } = await measure(run);
      stages.push({ name, ms, rss_peak_bytes, rows: await pageRows(engine, slug), git: gitSizes(root), lock_hold_ms: lockHold(value.requestId),
        detail: { committed_ms: value.committedMs, ...value.detail } });
    };
    try {
      const putFile = writeConversationFile(join(dir, 'door-put.md'), sizes.put, seed);
      const pageFile = writeConversationFile(join(dir, 'door-page.md'), sizes.page, seed + 1);
      pages.push(receiptPage('bench/door-put', putFile), receiptPage('bench/door-page', pageFile));
      await stage('door_put', 'bench/door-put', async () => {
        let small: Promise<number> | undefined;
        onPrepared = () => {
          if (small) return;
          small = write(ctx, 'put_page', { slug: 'bench/door-small', content: `---\ntitle: Small\ntype: note\n---\n\nA short note queued behind a large put.\n` }, randomUUID());
        };
        const put = await publish('put_page', { slug: 'bench/door-put', content: readFileSync(putFile.path, 'utf8') });
        onPrepared = undefined;
        if (!small) throw new Error('the large put never reached its prepared boundary, so no small write was queued behind it');
        return { ...put, detail: { queued_small_write_ms: round(await small) } };
      });
      await stage('door_create', 'bench/door-page', () => publish('put_page', { slug: 'bench/door-page', content: readFileSync(pageFile.path, 'utf8') }));
      const probes = await measure(async () => {
        const found: number[] = [];
        for (const needle of pageFile.needles) {
          const hits = await call(ctx, 'search', { query: needle.word, match: 'keyword', limit: 5 }) as unknown as Array<{ slug: string }> | { results: Array<{ slug: string }> };
          if ((Array.isArray(hits) ? hits : hits.results).some(hit => hit.slug === 'bench/door-page')) found.push(needle.decile);
        }
        return found;
      });
      stages.push({ name: 'door_probes', ms: probes.ms, rss_peak_bytes: probes.rss_peak_bytes, rows: { found: probes.value.length, total: pageFile.needles.length }, detail: { found_deciles: probes.value } });
      await stage('door_append', 'bench/door-page', () => publish('append_page', { slug: 'bench/door-page', text: turnsText(10 * 1024, seed + 2) }));
      const middle = pageFile.needles[5]!.word;
      const revision = (await engine.readPageSnapshot('bench/door-page', { sourceId: 'default' }))!.revision;
      await stage('door_splice', 'bench/door-page', () => publish('edit_page', { slug: 'bench/door-page', expected_revision: revision, edits: [{ old_text: middle, new_text: `${middle} spliced` }] }));
    } finally {
      nativeLockSeams.held = undefined;
      installFaultHook(undefined);
    }
  }, { databaseUrl: kind === 'postgres' ? process.env.DATABASE_URL : undefined, setup });
  return stages;
}

/** Chunks per manifest occurrence and bytes per chunk text of the 100 MB bench page (29,041 chunks over 374 occurrences). */
const FLIP_CHUNKS_PER_OCCURRENCE = 78;
const FLIP_CHUNK_BYTES = 3400;

/**
 * One `flip_retire` cell: a segmented page at generation 1 whose occurrences hold `rows` live chunk rows, then the flip to
 * generation 2 that retires all of them, timed inside a transaction with the publication's lock and statement timeouts.
 */
async function flipRetire(engine: BrainEngine, rows: number, embedded: boolean) {
  const slug = `bench/flip-${rows}-${embedded ? 'embedded' : 'plain'}`;
  await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
  const texts = Array.from({ length: Math.ceil(rows / FLIP_CHUNKS_PER_OCCURRENCE) }, (_, i) => segmentText(`## Part ${i}\n\nSegment ${i} of ${slug}.\n`));
  const page = await publishSegmentedPage(engine, slug, texts);
  const samples = Array.from({ length: 64 }, (_, i) => turnsText(FLIP_CHUNK_BYTES, 100 + i));
  const [column] = await engine.executeRaw<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
  const dims = Number(/\((\d+)\)/.exec(column?.type ?? '')?.[1] ?? 1024);
  const embedding = embedded ? `('[' || array_to_string(ARRAY(SELECT round(random()::numeric, 4) FROM generate_series(1, ${dims}) WHERE g >= 0), ',') || ']')::vector` : 'NULL';
  for (let from = 0; from < rows; from += 5000) {
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, occurrence_id, local_ordinal, raw_byte_start, raw_byte_end, body_generation, embedding, embedded_at)
      SELECT $1, g, ($2::text[])[1 + g % 64], 'compiled_truth', ($3::bigint[])[1 + g / ${FLIP_CHUNKS_PER_OCCURRENCE}], g % ${FLIP_CHUNKS_PER_OCCURRENCE}, 0, ${FLIP_CHUNK_BYTES}, 1,
        ${embedding}, ${embedded ? 'now()' : 'NULL'}
      FROM generate_series($4::int, $5::int) AS g`, [page.pageId, samples, page.occurrences, from, Math.min(rows, from + 5000) - 1]);
  }
  const next = [segmentText(`## Part 0\n\nReplacement of ${slug}.\n`)];
  const staged = await stageGeneration(engine, { pageId: page.pageId, slug, genFrom: 2, texts: next });
  const t0 = performance.now();
  try {
    const flip = await engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
      return tx.flipBodyGeneration(flipInput(page.pageId, 1, staged.stagingId, next,
        { closeOccurrences: page.occurrences, retireChunkOccurrences: page.occurrences, retireMaxRows: rows }));
    });
    return { rows, embedded, ms: round(performance.now() - t0), retired: flip.retiredChunks, timed_out: false };
  } catch (error) {
    if ((error as { code?: unknown })?.code !== '57014' && !/statement timeout/i.test(String(error))) throw error;
    return { rows, embedded, ms: round(performance.now() - t0), retired: 0, timed_out: true };
  } finally {
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [slug]);
  }
}

/** Child mode: import `--child` in a fresh process (the parent generated it) and report its peak RSS from the open engine on. */
async function child(file: string, kind: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-large-'));
  const engine = await openEngine(kind, dir);
  try {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1', [SLUG]);
    const bodyPolicy = await readPageBodyPolicy(engine);
    Bun.gc(true);
    if (existsSync('/proc/self/clear_refs')) writeFileSync('/proc/self/clear_refs', '5');
    const result = await importFromFile(engine, file, `${SLUG}.md`, { noEmbed: true, bodyPolicy });
    if (result.status !== 'imported') throw new Error(`the bench page was not imported: ${result.error ?? result.status}`);
    process.stdout.write(JSON.stringify({ peak_rss_bytes: peakRssBytes() }) + '\n');
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function childRss(file: string, kind: string): number {
  const run = spawnSync(process.execPath, [import.meta.path, '--child', file, '--engine', kind], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 20 });
  if (run.status !== 0) throw new Error(`child ingest of ${file} failed:\n${run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').pop()!).peak_rss_bytes;
}

/** The database_append stage adds about 10 KiB; the page leaves this much room under the ceiling for it. */
const APPEND_RESERVE_BYTES = 64 * 1024;

/** `requested`: the `--size`, or null for the engine's ceiling less the append reserve. */
async function databaseStages(kind: string, dir: string, requested: number | null, seed: number, pages: ReceiptPage[]): Promise<ReceiptStage[]> {
  const engine = await openEngine(kind, dir);
  try {
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.executeRaw('DELETE FROM pages WHERE slug=$1 OR slug LIKE $2', [SLUG, 'bench/small-%']);
    const policy = await readPageBodyPolicy(engine);
    const size = requested ?? policy.maxBytes - APPEND_RESERVE_BYTES;
    if (size <= PAGE_MAX_BYTES) throw new Error(`--size ${size} is not above PAGE_MAX_BYTES (${PAGE_MAX_BYTES}); smaller files take the single-string import.`);
    if (size + APPEND_RESERVE_BYTES > policy.maxBytes) throw new Error(`--size ${size} leaves no room under this engine's ceiling ${policy.maxBytes} (pages.max_bytes) for the ${APPEND_RESERVE_BYTES}-byte append stage.`);
    const file = join(dir, 'page.md');
    const generated = writeConversationFile(file, size, seed);
    pages.push(receiptPage(SLUG, generated));
    const ingest = async () => {
      const result = await importStreamedMarkdownFile(engine, file, `${SLUG}.md`, { noEmbed: true }, statSync(file), policy);
      if (result.status !== 'imported') throw new Error(`the bench page was not imported: ${result.error ?? result.status}`);
    };

    const latencies: number[] = [];
    let ingesting = true;
    const small = (async () => {
      for (let i = 0; ingesting; i++) {
        const t0 = performance.now();
        await importFromContent(engine, `bench/small-${i % 50}`, `---\ntitle: Small ${i}\ntype: note\n---\n\nA short note, revision ${i}.\n`, { sourceId: 'default', noEmbed: true });
        latencies.push(performance.now() - t0);
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    const ingested = await measure(ingest);
    ingesting = false;
    await small;
    latencies.sort((a, b) => a - b);
    const pct = (p: number) => latencies.length ? round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!) : null;
    const stages: ReceiptStage[] = [{ name: 'database_ingest', ms: ingested.ms, rss_peak_bytes: ingested.rss_peak_bytes, rows: await pageRows(engine, SLUG),
      detail: { concurrent_small_put: { writes: latencies.length, p50_ms: pct(0.5), p95_ms: pct(0.95), max_ms: pct(1) } } }];

    appendFileSync(file, `\n${turnsText(10 * 1024, seed + 2)}\n`);
    const appended = await measure(ingest);
    stages.push({ name: 'database_append', ms: appended.ms, rss_peak_bytes: appended.rss_peak_bytes, rows: await pageRows(engine, SLUG) });

    const reference = join(dir, 'page-reference.md');
    writeConversationFile(file, size, seed);
    writeConversationFile(reference, 1024 ** 2, seed);
    const rss = await measure(async () => ({ large: childRss(file, kind), reference: childRss(reference, kind) }));
    stages.push({ name: 'database_child_rss', ms: rss.ms, rss_peak_bytes: rss.value.large, rows: {},
      detail: { peak_reference_bytes: rss.value.reference, delta_bytes: rss.value.large - rss.value.reference } });

    const flip = await measure(async () => {
      const cells = [];
      for (const embedded of [false, true]) {
        for (const rows of arg('--flip-rows', '5000,10000,20000,40000').split(',').map(Number)) cells.push(await flipRetire(engine, rows, embedded));
      }
      return cells;
    });
    stages.push({ name: 'database_flip_retire', ms: flip.ms, rss_peak_bytes: flip.rss_peak_bytes, rows: {}, detail: { cells: flip.value } });
    return stages;
  } finally {
    await engine.disconnect();
  }
}

async function main(): Promise<void> {
  const kind = arg('--engine', 'pglite');
  if (process.argv.includes('--child')) return child(arg('--child', ''), kind);
  if (kind !== 'pglite' && kind !== 'postgres') throw new Error(`--engine ${kind}: expected pglite or postgres`);
  const groups = arg('--stages', 'door,database').split(',');
  if (!groups.length || groups.some(group => group !== 'door' && group !== 'database')) throw new Error(`--stages ${groups.join(',')}: expected door, database or both`);
  const seed = Number(arg('--seed', '1'));
  const started = new Date();
  const t0 = performance.now();
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-large-'));
  const pages: ReceiptPage[] = [];
  const stages: ReceiptStage[] = [];
  try {
    if (groups.includes('door')) stages.push(...await doorStages(kind, dir, { put: parseSize(arg('--put', '2MiB')), page: parseSize(arg('--door-page', '20MiB')) }, seed, pages));
    if (groups.includes('database')) stages.push(...await databaseStages(kind, dir, arg('--size', '') ? parseSize(arg('--size', '')) : null, seed, pages));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dir, encoding: 'utf8' });
  const receipt: Receipt = { schema: RECEIPT_SCHEMA, version: RECEIPT_VERSION, engine: kind, commit: head.status === 0 ? head.stdout.trim() : null,
    started_at: started.toISOString(), wall_ms: round(performance.now() - t0), rss_peak_bytes: Math.max(...stages.map(stage => stage.rss_peak_bytes)), pages, stages };
  const problems = validateReceipt(receipt);
  if (problems.length) throw new Error(`the receipt does not conform to ${RECEIPT_SCHEMA} v${RECEIPT_VERSION}:\n  ${problems.join('\n  ')}`);
  const out = arg('--out', '');
  if (out) writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
  else process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
}

await main();
