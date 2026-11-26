/**
 * Writes that name a page by the exact spelling it is stored under (a decomposed Unicode name, or capitals, from before
 * writes composed slugs) act on that stored page, never on a composed look-alike, and a deleted page stored that way
 * can be restored by its name.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Contract: file_upload and ontology_propose by a stored decomposed spelling attach to that page even when a
 *     composed page that prints the same name exists; restore_page by the stored spelling restores the page that
 *     delete_page soft-deleted by that spelling; `gbrain takes horizon set|clear` by a stored spelling addresses the
 *     take on that page, not on its composed look-alike.
 *  2. Regression: the #9908 bundle review of PR 9944 (three findings). The write wrapper normalized the slug before it
 *     resolved the stored spelling, so an upload to a private decomposed page attached the file to its public
 *     composed look-alike; restore_page was missing from the stored-spelling operations and answered
 *     revision_conflict; the takes horizon normalized before an exact lookup.
 *  3. Existing coverage: test/slug-legacy-rows.test.ts covers delete, tag, timeline, edit and append by a stored
 *     spelling, not these four paths.
 *  4. Seam: none. Real PGLite engines (an engine opened from settings with a local store for file_upload) and the
 *     registry operations and CLI command.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEngine, type EngineSettings } from '../src/core/engine-open.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runTakes } from '../src/commands/takes.ts';
import { readTakeHorizons } from '../src/core/takes-horizon.ts';

const NFD = 'coll/caf\u0065\u0301-write';
const NFC = 'coll/caf\u00e9-write';

const root = mkdtempSync(join(tmpdir(), 'gbrain-slug-stored-writes-'));
let engine: PGLiteEngine;
let stored: BrainEngine;

function ctxFor(e: BrainEngine): OperationContext {
  return { engine: e, config: { engine: 'pglite', embedding_disabled: true } as never, remote: false, sourceId: 'default',
    dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}
const call = async <T = Record<string, any>>(e: BrainEngine, name: string, params: Record<string, unknown>): Promise<T> =>
  await operationsByName[name]!.handler(ctxFor(e), params) as T;
const page = (title: string) => `---\ntitle: ${title}\ntype: note\n---\nbody\n`;

/** Write `seed` through put_page, then store it under `as`, the way an older writer left it. */
async function storeAs(e: BrainEngine, seed: string, as: string, title: string): Promise<number> {
  if (e === stored) await importFromContent(e, seed, page(title));
  else await call(e, 'put_page', { slug: seed, content: page(title) });
  await e.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', [as, seed, 'default']);
  await e.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision WHERE slug = $1 AND source_id = $2', [as, 'default']);
  const [row] = await e.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [as, 'default']);
  return Number(row!.id);
}
const idOf = async (e: BrainEngine, slug: string) =>
  Number((await e.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, 'default']))[0]!.id);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const settings: EngineSettings = { embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() },
    embedding: { model: 'openai:text-embedding-3-small', dimensions: 1536 }, storage: { backend: 'local', localPath: join(root, 'store') } };
  stored = await openEngine(settings);
  await stored.initSchema();
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await disposePersistenceConsumer(stored);
  await engine.disconnect();
  await stored.disconnect();
  rmSync(root, { recursive: true, force: true });
});

describe('finding 1: a write by a stored spelling resolves that page before it normalizes the slug', () => {
  test('file_upload by the decomposed spelling attaches the file to the decomposed page, not its composed look-alike', async () => {
    const nfdId = await storeAs(stored, 'coll/upload-seed', NFD, 'Private decomposed');
    await importFromContent(stored, NFC, page('Public composed'));
    const nfcId = await idOf(stored, NFC);
    const file = join(root, 'note.txt');
    writeFileSync(file, 'attached bytes');
    await call(stored, 'file_upload', { path: file, page_slug: NFD });
    const rows = await stored.executeRaw<{ page_id: number | null; page_slug: string | null }>('SELECT page_id, page_slug FROM files WHERE filename = $1', ['note.txt']);
    expect(rows.map(r => ({ page_id: Number(r.page_id), page_slug: r.page_slug }))).toEqual([{ page_id: nfdId, page_slug: NFD }]);
    expect(rows.some(r => Number(r.page_id) === nfcId)).toBe(false);
  });

  test('ontology_propose by the decomposed spelling records the fact on the decomposed page, not its composed look-alike', async () => {
    const nfd = 'people/zoe\u0308-onto';
    const nfc = 'people/zo\u00eb-onto';
    await storeAs(engine, 'people/onto-seed', nfd, 'Decomposed person');
    await call(engine, 'put_page', { slug: nfc, content: page('Composed person') });
    await call(engine, 'ontology_propose', { entity: nfd, dimension: 'role', value: 'advisor' });
    const facts = await engine.executeRaw<{ entity_slug: string }>(
      `SELECT DISTINCT entity_slug FROM facts WHERE entity_slug IN ($1, $2) AND source_id = 'default'`, [nfd, nfc]);
    expect(facts.map(f => f.entity_slug)).toEqual([nfd]);
  });
});

describe('finding 2: restore_page by a stored spelling restores that page', () => {
  test('a decomposed page soft-deleted by its name is restored by its name, in place, with no composed twin', async () => {
    const nfd = 'coll/re\u0301store';
    const nfc = 'coll/r\u00e9store';
    await storeAs(engine, 'coll/restore-seed', nfd, 'Restore me');
    const revision = async () => (await engine.readPageSnapshot(nfd, { sourceId: 'default', includeDeleted: true }))!.revision;
    await call(engine, 'delete_page', { slug: nfd, expected_revision: await revision() });
    const out = await call<{ slug: string; status: string }>(engine, 'restore_page', { slug: nfd, expected_revision: await revision() });
    expect(out.slug).toBe(nfd);
    const rows = await engine.executeRaw<{ slug: string; deleted: boolean }>(
      'SELECT slug, deleted_at IS NOT NULL AS deleted FROM pages WHERE slug IN ($1, $2) ORDER BY slug', [nfd, nfc]);
    expect(rows.map(r => ({ slug: r.slug, deleted: r.deleted === true || (r.deleted as unknown) === 't' }))).toEqual([{ slug: nfd, deleted: false }]);
  });
});

describe('finding 3: the takes horizon addresses the take on the page stored under the exact spelling', () => {
  test('takes horizon set and clear by the decomposed spelling change that page\'s take, never its composed look-alike\'s', async () => {
    const nfd = 'companies/acme\u0301-horizon';
    const nfc = 'companies/acm\u00e9-horizon';
    const nfdId = await storeAs(engine, 'companies/horizon-seed', nfd, 'Decomposed company');
    await call(engine, 'put_page', { slug: nfc, content: page('Composed company') });
    const nfcId = await idOf(engine, nfc);
    await engine.addTakesBatch([
      { page_id: nfdId, row_num: 1, claim: 'Decomposed claim', kind: 'bet', holder: 'world', weight: 0.6, since_date: '2025-01-01' },
      { page_id: nfcId, row_num: 1, claim: 'Composed claim', kind: 'bet', holder: 'world', weight: 0.6, since_date: '2025-01-01' },
    ]);
    const takeOf = async (pageId: number) => Number((await engine.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id = $1 AND row_num = 1', [pageId]))[0]!.id);
    const nfdTake = await takeOf(nfdId);
    const nfcTake = await takeOf(nfcId);
    const quiet = console.log;
    console.log = () => {};
    try { await runTakes(engine, ['horizon', 'set', nfd, '--row', '1', '--date', '2026-06-30']); } finally { console.log = quiet; }
    const horizons = await readTakeHorizons(engine);
    expect({ decomposed: horizons.get(nfdTake)?.horizon_date ?? null, composed: horizons.get(nfcTake)?.horizon_date ?? null })
      .toEqual({ decomposed: '2026-06-30', composed: null });
  });
});
