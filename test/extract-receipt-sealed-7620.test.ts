/**
 * #7620: extract receipts are sealed in the transaction that writes them, and
 * stay database-only derived bookkeeping.
 *
 * Protects: `writeReceipt` (src/core/extract/receipt-writer.ts) installs the
 * receipt's chunks and seals it at the safe-chunk fence inside the same
 * transaction as the page write, so a remote/MCP search or query on the
 * extracted source no longer reports `safe_index_pending` and doctor's
 * safe_index_pending count stays 0; a failure after the page write rolls back
 * page and chunks together. The receipt writer only writes a never-filed
 * `extract_receipt` page under the derive-phase `extracts/` folder (the
 * `derive_folder` declared class of docs/designs/GIT_CANONICAL_MEMORY.md):
 * it refuses to overwrite a content page or a page with a file in Git. On a
 * repo-less source the receipt is part of the `database_only_source` class; on
 * a repo source it is `derive_folder`, never database_ahead or adopted by a
 * conversion, and a Git-wins re-derive of the page an extraction read leaves
 * the receipt as it was (a receipt names a run and a source, never a page; the
 * source's removal cascades to it).
 * Fails when: the receipt is committed unsealed, the probe is satisfied by
 * exempting pages instead of sealing them (the unsealed content-page control
 * still has to warn), a failed seal leaves a receipt, the writer overwrites
 * content, or a conversion adopts or discards a receipt.
 * PGLite always; Postgres when DATABASE_URL is set
 * (test/e2e/extract-receipt-sealed-7620-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { receiptSlug, writeReceipt, type ExtractReceiptInput } from '../src/core/extract/receipt-writer.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { safeIndexPendingCheck } from '../src/commands/doctor/checks/safe-index.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import { declaredDatabaseOnly } from '../src/core/persistence/git-gap.ts';
import { censusGitGap } from '../src/commands/sources-git-gap.ts';
import { removeSource } from '../src/core/sources-ops.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { applyGitConversion, planGitConversion } from '../src/core/persistence/git-conversion.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const RECEIPT: Omit<ExtractReceiptInput, 'source_id' | 'run_id'> = {
  kind: 'facts.conversation', round: 'full', extracted_at: '2026-05-27T14:30:00.000Z', total_rows: 3, cost_usd: 0,
  summary: 'Extracted 3 facts from 1/1 eligible pages.',
};
const receipt = (sourceId: string, runId: string): ExtractReceiptInput => ({ ...RECEIPT, source_id: sourceId, run_id: runId });
const note = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${body}\n`;

/** The engine, with every directly issued statement matching `pattern` throwing, in nested transactions too. */
function failingAt(engine: BrainEngine, pattern: RegExp): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (pattern.test(sql)) throw new Error('injected failure after the receipt page write');
        return target.executeRaw(sql, params);
      };
      if (prop === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) =>
        target.transaction(tx => fn(failingAt(tx, pattern)), opts as never);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const backend of testBackends()) describe(`[${backend}] #7620 extract receipts are sealed database-only bookkeeping`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  let lastMeta: Record<string, any> | null = null;
  const remoteCtx = (sourceId: string): OperationContext => ({
    engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: true, sourceId,
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') lastMeta = value as Record<string, any>; },
  }) as OperationContext;
  const op = (name: string) => operations.find(o => o.name === name)!;
  /** The degraded stages of a remote search and a remote query on the source. */
  const remoteStages = async (sourceId: string) => {
    const stages: string[][] = [];
    for (const [name, params] of [['search', { query: 'walrus' }], ['query', { query: 'walrus', expand: false }]] as const) {
      lastMeta = null;
      await op(name).handler(remoteCtx(sourceId), params);
      expect(lastMeta).not.toBeNull();
      stages.push(((lastMeta!.degraded ?? []) as Array<{ stage: string }>).map(d => d.stage));
    }
    return stages;
  };
  const addSource = (id: string) => engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [id]);
  const sealedContent = (sourceId: string) => importFromContent(engine, 'notes/walrus', note('Walrus', 'The walrus pricing note.'), { sourceId, noEmbed: true });
  const pageRow = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; chunker_version: number; sealed: boolean; body: string; type: string }>(
    `SELECT id, chunker_version, text_projection_revision = knowledge_revision AS sealed, compiled_truth AS body, type FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]))[0];
  const chunkCount = async (sourceId: string, slug: string) => Number((await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2', [sourceId, slug]))[0]!.n);

  beforeAll(async () => {
    if (backend === 'postgres') { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    await engine.setConfig('search.mcp_keyword_only', 'true');
  }, 120_000);
  afterAll(async () => { if (closePostgres) await closePostgres(); else await engine.disconnect(); });

  test('repo-less: after an extraction writes its receipt, remote search and query on the source report no safe_index_pending and doctor counts 0', async () => {
    await addSource('source-a');
    await sealedContent('source-a');
    const before = await remoteStages('source-a');
    for (const stages of before) expect(stages).not.toContain('safe_index_pending');
    const { slug } = await writeReceipt(engine, receipt('source-a', 'run-a-0001'));

    const after = await remoteStages('source-a');
    for (const stages of after) expect(stages).not.toContain('safe_index_pending');
    expect(after).toEqual(before);
    const doctor = await safeIndexPendingCheck(engine, ['source-a']);
    expect(doctor).toMatchObject({ status: 'ok', details: { pages_pending: 0, kept_pages: 0 } });
    const row = (await pageRow('source-a', slug))!;
    expect(row.type).toBe('extract_receipt');
    expect(row.chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
    expect(row.sealed).toBe(true);
    expect(await chunkCount('source-a', slug)).toBeGreaterThan(0);

    // A source with no checkout: the receipt is in the database_only_source class, nothing is database_ahead.
    const census = await censusGitGap(engine, 'source-a', { sample: 0 });
    expect(census.states).toMatchObject({ database_ahead: 0, undeclared_database_only: 0 });
    expect(census.declared.database_only_source).toBe(2);

    // Re-running the same run and round overwrites the receipt and it stays sealed.
    await writeReceipt(engine, { ...receipt('source-a', 'run-a-0001'), total_rows: 4 });
    expect(await pageRow('source-a', slug)).toMatchObject({ sealed: true });
    expect((await pageRow('source-a', slug))!.chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);
    expect((await safeIndexPendingCheck(engine, ['source-a'])).details).toMatchObject({ pages_pending: 0 });
  });

  test('negative control: an unsealed content page still raises safe_index_pending and counts in doctor, receipt or not', async () => {
    await addSource('source-b');
    await sealedContent('source-b');
    await writeReceipt(engine, receipt('source-b', 'run-b-0001'));
    await engine.putPage('notes/unsealed', { type: 'note', title: 'Unsealed', compiled_truth: 'A walrus page written without its chunks.', timeline: '' }, { sourceId: 'source-b' });
    expect((await pageRow('source-b', 'notes/unsealed'))!.chunker_version).toBeLessThan(SAFE_FENCE_CHUNKER_VERSION);
    for (const stages of await remoteStages('source-b')) expect(stages).toContain('safe_index_pending');
    expect(await safeIndexPendingCheck(engine, ['source-b'])).toMatchObject({ status: 'warn', details: { pages_pending: 1 } });
  });

  test('a failure after the receipt page write rolls back the page and its chunks together', async () => {
    await addSource('source-c');
    const input = receipt('source-c', 'run-c-0001');
    await expect(writeReceipt(failingAt(engine, /SET chunker_version=/), input)).rejects.toThrow('injected failure');
    expect(await pageRow('source-c', receiptSlug(input))).toBeUndefined();
    expect(await chunkCount('source-c', receiptSlug(input))).toBe(0);
  });

  test('the receipt writer writes only a never-filed receipt: it refuses to overwrite a content page or a page with a file', async () => {
    await addSource('source-d');
    const filed = receipt('source-d', 'd1-run');
    const filedSlug = receiptSlug(filed);
    await engine.putPage(filedSlug, { type: 'extract_receipt', title: 'Committed', compiled_truth: 'A receipt file someone committed to Git.', timeline: '',
      source_path: `${filedSlug}.md` }, { sourceId: 'source-d' });
    await expect(writeReceipt(engine, filed)).rejects.toThrow(/receipt/);
    expect((await pageRow('source-d', filedSlug))!.body).toBe('A receipt file someone committed to Git.');

    const content = receipt('source-d', 'd2-run');
    const contentSlug = receiptSlug(content);
    await engine.putPage(contentSlug, { type: 'note', title: 'Hand-written', compiled_truth: 'A note a person wrote under extracts/.', timeline: '' }, { sourceId: 'source-d' });
    await expect(writeReceipt(engine, content)).rejects.toThrow(/receipt/);
    expect((await pageRow('source-d', contentSlug))!).toMatchObject({ type: 'note', body: 'A note a person wrote under extracts/.' });

    // What it does write is declared database-only on a repo source: the derive-phase folder class.
    const { page } = await writeReceipt(engine, receipt('source-d', 'd3-run'));
    const repoPolicy = { mirror: false, dbOnly: () => false, ignored: new Set<string>() };
    expect(declaredDatabaseOnly({ ...page, database_only_reason: null }, `${page.slug}.md`, repoPolicy)).toBe('derive_folder');
  });

  test('removing the source removes its receipts: a receipt never outlives what it describes', async () => {
    await addSource('source-e');
    const { slug } = await writeReceipt(engine, receipt('source-e', 'run-e-0001'));
    expect(await pageRow('source-e', slug)).toBeDefined();
    await removeSource(engine, { id: 'source-e', yes: true, confirmDestructive: true } as never);
    expect(await pageRow('source-e', slug)).toBeUndefined();
    expect(await chunkCount('source-e', slug)).toBe(0);
  });
});

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

for (const backend of testBackends()) describe(`[${backend}] #7620 a repo source: receipts are derive_folder bookkeeping through conversion and Git-wins re-derives`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  let receiptPath = '';

  test('a conversion neither adopts nor discards the receipt, and a Git-wins re-derive of the page it read leaves it sealed and unchanged', () => managedBrain(async ({ engine, root }) => {
    const slug = receiptPath;
    const receiptRow = async () => (await engine.executeRaw<{ revision: string; sealed: boolean; chunker_version: number; source_path: string | null }>(
      `SELECT knowledge_revision::text AS revision, text_projection_revision = knowledge_revision AS sealed, chunker_version, source_path
       FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL`, [slug]))[0];
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const written = (await receiptRow())!;
    expect(written).toMatchObject({ sealed: true, source_path: null });
    expect(written.chunker_version).toBeGreaterThanOrEqual(SAFE_FENCE_CHUNKER_VERSION);

    // Git moves the page the extraction read; Git wins and the page is re-derived from the committed blob.
    writeFileSync(join(root, 'notes/alice-example.md'), note('Alice example', 'The committed edit of the conversation.'));
    git(root, 'commit', '-qam', 'edit the conversation');
    const census = await censusGitGap(engine, 'default', { sample: 20 });
    expect(census.states).toMatchObject({ database_ahead: 0, undeclared_database_only: 0 });
    expect(census.declared.derive_folder).toBe(1);
    const { preview } = await planGitConversion(engine, 'default');
    expect(preview).toMatchObject({ adopt: { count: 0 }, discard: { count: 0 }, declared: { by: { derive_folder: 1 } }, git_wins: { count: 1 } });
    expect(preview.adopt.sample).not.toContain(`${slug}.md`);

    const result = await applyGitConversion(engine, 'default', preview.preview_hash, { noEmbed: true, noExtract: true });
    expect(result).toMatchObject({ status: 'converted', after: { remaining: 0, strict: true } });
    expect((await engine.executeRaw<{ body: string }>("SELECT compiled_truth AS body FROM pages WHERE source_id='default' AND slug='notes/alice-example'"))[0]!.body)
      .toContain('The committed edit of the conversation.');
    expect(await receiptRow()).toEqual(written);
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
    expect(git(root, 'ls-files', 'extracts')).toBe('');
    // A receipt names its run and source, never a page: no edge ties it to the re-derived page.
    expect((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM links l JOIN pages p ON p.id IN (l.from_page_id, l.to_page_id)
      WHERE p.source_id='default' AND p.slug=$1`, [slug]))[0]!.n).toBe(0);
    expect((await safeIndexPendingCheck(engine, ['default'])).details).toMatchObject({ pages_pending: 0 });

    // A later strict pass that re-derives the page again still leaves the receipt as it was.
    writeFileSync(join(root, 'notes/alice-example.md'), note('Alice example', 'A second committed edit.'));
    git(root, 'commit', '-qam', 'edit again');
    await performManagedSync(engine, OPTS);
    expect(await receiptRow()).toEqual(written);
    expect((await censusGitGap(engine, 'default', { sample: 0 })).declared.derive_folder).toBe(1);
  }, { databaseUrl, setup: async ({ engine, root }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
    writeFileSync(join(root, 'notes/alice-example.md'), note('Alice example', 'The committed conversation.'));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
    // The extraction ran while the brain was unmanaged (receipts are written on unmanaged brains only).
    receiptPath = (await writeReceipt(engine, receipt('default', 'run-default-1'))).slug;
    // Sealed by its own write, before any sync or repair could re-seal it.
    expect((await engine.executeRaw<{ sealed: boolean }>(`SELECT chunker_version >= ${SAFE_FENCE_CHUNKER_VERSION} AND text_projection_revision = knowledge_revision AS sealed
      FROM pages WHERE source_id='default' AND slug=$1`, [receiptPath]))[0]!.sealed).toBe(true);
  } }), 240_000);
});
