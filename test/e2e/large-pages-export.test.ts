/**
 * Wave B PR 2 (spec 7.4): Markdown export of segmented pages.
 *
 * Protects:
 * - Round trip at 2 and 20 MiB, both engines: a page stored inline (switch off)
 *   and the same page stored segmented (switch on) export the same bytes, the
 *   segmented one streamed (exportStreamWork: the pieces add up to the file and
 *   none is over one segment, so a whole-body join fails at 2 MiB); that
 *   file F is canonical (sha256(F) == sha256(serializePageToMarkdown) of the
 *   inline page) and export(import(F)) == F for both storage classes. With a
 *   withdrawn fact both classes export the same struck file.
 * - Streamed ingest (a file over PAGE_MAX_BYTES) reproduces the importer's trim:
 *   leading and trailing body whitespace is dropped, so export(import(F')) has
 *   F's body (above 24 MiB the import stamps content-sanity keys into the
 *   frontmatter, so only the body round-trips byte for byte).
 * - Abort semantics: a segmented page over the payload limit refuses the whole
 *   export (its estimate is `body_bytes`, not NULL); a streamed page extends the
 *   snapshot deadline by its bytes.
 * - Backup: a PGLite backup restores a segmented page that exports the same bytes.
 * - 128 MiB (GBRAIN_TEST_LARGE_EXPORT=1, PGLite): the export of a 128 MiB page
 *   has F's body and its peak memory (VmHWM) stays under 80 MiB above exporting a
 *   2 MiB page. Run it under a cgroup limit as well (the 20 MiB arms import a
 *   fence-heavy page on the string path, which peaks far above 1G on its own):
 *     GBRAIN_TEST_LARGE_EXPORT=1 sudo -E systemd-run --scope -p MemoryMax=1G -p MemorySwapMax=0 \
 *       "$(command -v bun)" test --timeout=1800000 -t '128 MiB' test/e2e/large-pages-export.test.ts
 * Fails when: export reads a segmented body through the throwing getters
 * (page_body_segmented), joins its segments into one string or Buffer, publishes
 * it as one Buffer, keeps the 32 MiB per-page limit, or the stream and the inline
 * serializer disagree on the frontmatter head, timeline separator or overlay.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { runExport } from '../../src/commands/export.ts';
import { serializeMarkdown, serializePageToMarkdown } from '../../src/core/markdown.ts';
import { EXPORT_SNAPSHOT_MS, exportStreamWork } from '../../src/core/export-stage.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { readPageBodyPolicy, SEGMENT_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { createPgliteBackup, restorePgliteBackup } from '../../src/core/backup/snapshot.ts';
import { bigPage } from '../helpers/segment-bodies.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';

const REPO = resolve(import.meta.dir, '../..');
const MiB = 1024 * 1024;
const SLUG = 'notes/large-export';
const TIMELINE = '- **2024-01-02** | src — first entry\n  detail line\n- **2024-02-03** | src — second entry';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
/**
 * The file after its frontmatter block. Import stamps `embed_skip` / `content_flag` (with an `assessed_at` time) into
 * the frontmatter of a page over content_sanity.bytes_block (24 MiB), so above it only the body round-trips exactly.
 */
const bodyOf = (file: Buffer) => file.subarray(file.indexOf('\n---\n\n', 4) + 6);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'large-pages-export-')));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function seeded(seed: number): () => number {
  let state = seed;
  return () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
}

/** A page file with frontmatter, facts, takes, keys, code and a timeline; not yet in canonical form. */
function pageFile(bytes: number, seed: number): string {
  return `---\ntype: note\ntitle: Large export\n---\n\n${bigPage(seeded(seed), bytes)}\n\n<!-- timeline -->\n\n${TIMELINE}\n`;
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, error } = console;
  const exit = process.exit;
  const messages: string[] = [];
  console.log = console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  process.exit = ((code: number) => { throw new Error(`EXIT:${code} ${messages.join('\n')}`); }) as never;
  try { return await fn(); } finally { console.log = log; console.error = error; process.exit = exit; }
}

let exports = 0;
async function exportPage(engine: BrainEngine, args: string[] = []): Promise<Buffer> {
  const out = join(dir, `out-${++exports}`);
  Object.assign(exportStreamWork, { files: 0, pieces: 0, bytes: 0, largestPiece: 0 });
  await quietly(() => runExport(engine, ['--dir', out, ...args]));
  expect(readFileSync(join(out, '.gbrain-export-status'), 'utf8')).toEndWith('COMPLETE\n');
  return readFileSync(join(out, `${SLUG}.md`));
}

/** The export streamed the segmented page as one file: its pieces add up to the file and none is over one segment. */
function expectStreamed(file: Buffer): void {
  expect(exportStreamWork.files).toBe(1);
  expect(exportStreamWork.bytes).toBe(file.length);
  expect(exportStreamWork.largestPiece).toBeLessThanOrEqual(SEGMENT_MAX_BYTES);
}

async function importAs(engine: BrainEngine, storage: 'on' | 'off', file: string): Promise<string> {
  await engine.executeRaw('DELETE FROM pages');
  await engine.setConfig('pages.segmented_storage', storage);
  const bodyPolicy = await readPageBodyPolicy(engine);
  const result = await quietly(() => importFromFile(engine, file, `${SLUG}.md`, { noEmbed: true, bodyPolicy }));
  expect(result.error ?? null).toBeNull();
  expect(result.status).toBe("imported");
  const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [SLUG]);
  return row!.body_storage;
}

for (const backend of testBackends()) describe(`large-page export: ${backend}`, () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = backend === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
    await engine.connect(backend === 'postgres' ? { database_url: requirePostgresTestDatabase() } : {});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'");
    await engine.executeRaw('DELETE FROM pages');
    await engine.setConfig('pages.segmented_storage', 'off');
    await engine.disconnect();
  });

  test.each([2, 20])('%i MiB: inline and segmented export the same canonical file, and export(import(F)) == F', async size => {
    const raw = join(dir, `${backend}-${size}-raw.md`);
    writeFileSync(raw, pageFile(size * MiB, size));
    expect(await importAs(engine, 'off', raw)).toBe('inline');
    const canonical = await exportPage(engine);
    const page = (await engine.getPage(SLUG))!;
    expect(sha(canonical)).toBe(sha(serializePageToMarkdown(page, await engine.getTags(SLUG))));
    const file = join(dir, `${backend}-${size}-canonical.md`);
    writeFileSync(file, canonical);

    expect(await importAs(engine, 'on', file)).toBe('segmented');
    const segmented = await exportPage(engine);
    expectStreamed(segmented);
    expect(sha(segmented)).toBe(sha(canonical));
    expect(await importAs(engine, 'off', file)).toBe('inline');
    expect(sha(await exportPage(engine))).toBe(sha(canonical));

    await engine.executeRaw("INSERT INTO fact_withdrawals (source_id, visibility, fact_hash) VALUES ('default', 'world', gbrain_fact_fingerprint('likes tea'))");
    try {
      const struck = await exportPage(engine);
      expect(struck.equals(canonical)).toBe(false);
      expect(await importAs(engine, 'on', file)).toBe('segmented');
      const segmentedStruck = await exportPage(engine);
      expectStreamed(segmentedStruck);
      expect(sha(segmentedStruck)).toBe(sha(struck));
    } finally { await engine.executeRaw("DELETE FROM fact_withdrawals WHERE source_id='default'"); }
  }, 600_000);

  test('a segmented page over the payload limit refuses the whole export; a streamed page extends the snapshot deadline', async () => {
    const file = join(dir, `${backend}-limit.md`);
    writeFileSync(file, pageFile(2 * MiB, 3));
    expect(await importAs(engine, 'on', file)).toBe('segmented');
    const [{ body_bytes: stored }] = await engine.executeRaw<{ body_bytes: number }>('SELECT body_bytes FROM pages WHERE slug=$1', [SLUG]);
    await engine.executeRaw('UPDATE pages SET body_bytes=$2 WHERE slug=$1', [SLUG, 300 * MiB]);
    try {
      await expect(exportPage(engine)).rejects.toThrow('Export page payload limit exceeded');
    } finally { await engine.executeRaw('UPDATE pages SET body_bytes=$2 WHERE slug=$1', [SLUG, stored]); }

    const query = engine.executeRaw, now = Date.now;
    engine.executeRaw = async function (sql, params, options) {
      if (sql.includes('AS export_tags')) {
        const late = now() + EXPORT_SNAPSHOT_MS + 1000;
        Date.now = () => late;
      }
      return query.call(this, sql, params, options) as never;
    };
    try {
      const extended = await exportPage(engine);
      expectStreamed(extended);
      expect(extended.length).toBeGreaterThan(2 * MiB);
    } finally { engine.executeRaw = query; Date.now = now; }
  }, 300_000);

  test.skipIf(backend !== 'pglite')('streamed ingest drops leading and trailing body whitespace like parseMarkdown, so export(import(F + whitespace)) has the body of F', async () => {
    const head = serializeMarkdown({}, '', '', { type: 'note', title: 'Large export', tags: [] }).slice(0, -1);
    const body = conversationBody(PAGE_MAX_BYTES + MiB, { seed: 5 });
    const canonical = `${head}${body}\n\n<!-- timeline -->\n\n${TIMELINE}\n`;
    const padded = join(dir, 'padded.md');
    writeFileSync(padded, `${head}\n  \n\t\n${body} \t\n\n  \n\n<!-- timeline -->\n\n${TIMELINE}\n\n \n`);
    expect(await importAs(engine, 'on', padded)).toBe('segmented');
    const exported = await exportPage(engine);
    expectStreamed(exported);
    expect(sha(bodyOf(exported))).toBe(sha(bodyOf(Buffer.from(canonical))));
  }, 600_000);
});

describe.skipIf(testBackends().includes('postgres') && !testBackends().includes('pglite'))('PGLite backup of a segmented page', () => {
  test('restores the page so it exports the same bytes', async () => {
    const root = join(dir, 'backup-root');
    mkdirSync(join(root, '.gbrain'), { recursive: true });
    const database = join(root, '.gbrain', 'brain.pglite');
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: database }));
    const file = join(dir, 'backup-page.md');
    writeFileSync(file, pageFile(2 * MiB, 11));
    const withBrain = async <T>(path: string, fn: (engine: PGLiteEngine) => Promise<T>): Promise<T> => {
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite', database_path: path });
      try { return await fn(engine); } finally { await engine.disconnect(); }
    };
    const before = await withBrain(database, async engine => {
      await engine.initSchema();
      expect(await importAs(engine, 'on', file)).toBe('segmented');
      const exported = await exportPage(engine);
      expectStreamed(exported);
      return exported;
    });
    const archive = join(dir, 'segmented.gbrain-backup');
    await createPgliteBackup({ root, output: archive });
    const restored = join(dir, 'restored-root');
    await restorePgliteBackup({ archive, into: restored });
    const after = await withBrain(join(restored, '.gbrain', 'brain.pglite'), async engine => {
      const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug=$1', [SLUG]);
      expect(row?.body_storage).toBe('segmented');
      const exported = await exportPage(engine);
      expectStreamed(exported);
      return exported;
    });
    expect(sha(after)).toBe(sha(before));
  }, 600_000);
});

const CHILD = `
import { readFileSync, writeFileSync } from 'node:fs';
import { PGLiteEngine } from ${JSON.stringify(join(REPO, 'src/core/pglite-engine.ts'))};
import { importFromFile } from ${JSON.stringify(join(REPO, 'src/core/import-file.ts'))};
import { readPageBodyPolicy } from ${JSON.stringify(join(REPO, 'src/core/page-body/limits.ts'))};
import { runExport } from ${JSON.stringify(join(REPO, 'src/commands/export.ts'))};
const [mode, brain, file, out] = process.argv.slice(-4);
const engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: brain });
await engine.initSchema();
let result = null;
if (mode === 'import') {
  await engine.setConfig('pages.segmented_storage', 'on');
  result = await importFromFile(engine, file, ${JSON.stringify(`${SLUG}.md`)}, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });
  result = { status: result.status, error: result.error ?? null };
} else {
  console.log = () => {};
  writeFileSync('/proc/self/clear_refs', '5');
  await runExport(engine, ['--dir', out]);
}
const peak = Number(/^VmHWM:\\s+(\\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024;
await engine.disconnect();
process.stdout.write(JSON.stringify({ result, peak }) + '\\n');
`;

/** A canonical page file whose body is at most `bytes`, written in pieces; returns the sha256 of its body (bodyOf). */
function writeCanonical(path: string, bytes: number): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'w');
  const write = (text: string) => { hash.update(text); writeSync(fd, text); };
  try {
    writeSync(fd, serializeMarkdown({}, '', '', { type: 'note', title: 'Large export', tags: [] }).slice(0, -1));
    for (let at = 0, part = 0; ; part++) {
      const piece = (part ? '\n\n' : '') + conversationBody(Math.min(4 * MiB, bytes - at - 16), { seed: part + 1 });
      if (at + Buffer.byteLength(piece) > bytes) break;
      write(piece);
      at += Buffer.byteLength(piece);
    }
    write(`\n\n<!-- timeline -->\n\n${TIMELINE}\n`);
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function child(mode: 'import' | 'export', brain: string, file: string, out: string): { result: { status: string; error: string | null } | null; peak: number } {
  const script = join(dir, 'child.ts');
  writeFileSync(script, CHILD);
  const run = spawnSync(process.execPath, [script, mode, brain, file, out], { cwd: REPO, encoding: 'utf8', timeout: 1_500_000, maxBuffer: 16 * MiB });
  if (run.status !== 0) throw new Error(`${mode} child failed (${run.status} ${run.signal}): ${run.stderr.slice(-4000)}`);
  return JSON.parse(run.stdout.trim().split('\n').pop()!);
}

describe.skipIf(process.env.GBRAIN_TEST_LARGE_EXPORT !== '1' || process.platform !== 'linux')('128 MiB export memory (PGLite)', () => {
  test('exports a 128 MiB page with the body of F and peak memory independent of the page size', () => {
    const measure = (name: string, bytes: number) => {
      const file = join(dir, `${name}.md`);
      const expected = writeCanonical(file, bytes);
      const brain = join(dir, `${name}.pglite`);
      expect(child('import', brain, file, '').result).toEqual({ status: 'imported', error: null });
      rmSync(file);
      const out = join(dir, `${name}-out`);
      const { peak } = child('export', brain, file, out);
      expect(sha(bodyOf(readFileSync(join(out, `${SLUG}.md`))))).toBe(expected);
      rmSync(out, { recursive: true, force: true });
      rmSync(brain, { recursive: true, force: true });
      return peak;
    };
    const small = measure('small', 2 * MiB);
    const large = measure('large', 128 * MiB - 64 * 1024);
    console.log(JSON.stringify({ smallPeakMiB: Math.round(small), largePeakMiB: Math.round(large) }));
    expect(large - small).toBeLessThan(80);
  }, 1_800_000);
});
