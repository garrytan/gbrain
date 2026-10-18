/**
 * #5575 Cat 39 deletion-audit findings: purge leaves no claim text in stored
 * request outcomes (39-2); remembering a purged claim refuses with typed
 * purged_content on the verb path (39-3); refused or no-op writes of purged
 * content keep no copy in their journal entry (39-4); fact and page receipts
 * list every swept inventory store, store by store (39-5, 39-6); an older
 * version of a purged page does not import again (39-7). Real PGLite, no
 * provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { admitWrite, completeWrite } from '../src/core/persistence/journal.ts';
import { requestPrincipalForContext } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { frozenVerbWriteError, runMemoryWrite } from '../src/core/persistence/verb-errors.ts';
import { opError } from '../src/core/ops/contract.ts';
import { DELETION_INVENTORY } from '../src/core/deletion-inventory.ts';
import { withEnv } from './helpers/with-env.ts';

const CLAIM = 'Vault combination is 7731';
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-eval-fixes-'));
let engine: PGLiteEngine;
const op = (name: string) => operations.find(o => o.name === name)!;
const context = (): OperationContext => ({ engine, config: { engine: 'pglite', embedding_disabled: true } as never,
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' });
const call = (name: string, params: Record<string, unknown>) =>
  withEnv({ GBRAIN_HOME: home }, () => op(name).handler(context(), params)) as Promise<Record<string, any>>;
const fenceRow = (n: number, claim: string) => `| ${n} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
const page = (title: string, rows: string[], prose = 'Prose.') => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\n${prose}\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->\n`;
const CONTENT = page('Alice', [fenceRow(1, CLAIM), fenceRow(2, 'Likes jasmine tea')]);

async function seed(slug = 'people/alice-example', content = CONTENT): Promise<number> {
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND source_markdown_slug=$2', [CLAIM, slug]);
  return Number(row.id);
}
async function purgeFact(id: number) {
  const dry = await call('purge_fact', { id, dry_run: true });
  return call('purge_fact', { id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
}
async function purgePage(slug: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
  return call('delete_page', { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision });
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'ok'; } catch (e) { return e instanceof OperationError ? (e.canonical ?? e.code) : String((e as Error).message); }
}
async function journalCarries(text: string): Promise<number> {
  const rows = await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE strpos(lower(COALESCE(intent::text,'')||COALESCE(outcome::text,'')
    ||COALESCE(error_detail::text,'')||COALESCE(error_message,'')),lower($1))>0`, [text]);
  return rows.length;
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine); await resetPgliteState(engine); _resetWriteThroughCacheForTest();
  await withEnv({ GBRAIN_HOME: home }, () => registerLocalWriter(engine, 'cli'));
});

describe('purge eval fixes', () => {
  test('39-2: stored request outcomes carrying the claim are redacted and the receipt says so honestly', async () => {
    const id = await seed();
    const c = context();
    const principal = await withEnv({ GBRAIN_HOME: home }, () => requestPrincipalForContext(c));
    const [source] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation FROM sources WHERE id='default'`);
    const row = await withEnv({ GBRAIN_HOME: home }, async () => admitWrite(engine, { principal, operation: 'add_timeline_entry', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug: 'people/alice-example', requestId: randomUUID(), callerIntent: { date: '2026-01-02' },
      intent: { date: '2026-01-02' }, authority: await submissionAuthority(c, 'add_timeline_entry', 'default', source.incarnation, 'people/alice-example') }));
    await engine.transaction(tx => completeWrite(tx, row, 'committed', { entry: { date: '2026-01-02', summary: `Told us: ${CLAIM}` } }));
    expect(await journalCarries(CLAIM)).toBeGreaterThan(0);
    const done = await purgeFact(id);
    expect(await journalCarries(CLAIM)).toBe(0);
    const [kept] = await engine.executeRaw<{ outcome: { entry: { date: string; summary: string } } }>('SELECT outcome FROM persistence_requests WHERE id=$1::uuid', [row.id]);
    expect(kept.outcome.entry).toEqual({ date: '2026-01-02', summary: '[purged]' });
    expect(done.stores.find((s: { store: string }) => s.store === 'persistence_requests')).toMatchObject({ status: 'deleted' });
  }, 60_000);

  test('39-3: remembering a purged claim refuses with purged_content (verb path, local and remote mapping)', async () => {
    const id = await seed();
    await purgeFact(id);
    expect(await codeOf(call('remember', { fact: CLAIM, entity: 'people/alice-example', provenance: 'test' }))).toBe('purged_content');
    const thrown = await runMemoryWrite(async () => { throw opError('purged_content', 'purged_content: x', 'y'); }).catch(e => e as OperationError);
    expect([thrown.code, thrown.canonical]).toEqual(['invalid_params', 'purged_content']);
    const frozen = frozenVerbWriteError({ request_id: randomUUID(), state: 'failed', retry_after_ms: null }, 'purged_content', 'purged_content: x');
    expect([frozen.code, frozen.canonical, frozen.detail]).toEqual(['invalid_params', 'purged_content', 'purged_content']);
  }, 60_000);

  test('39-4: refused and no-op writes of purged content keep no copy in their journal entry', async () => {
    const id = await seed();
    await purgeFact(id);
    expect(await journalCarries(CLAIM)).toBe(0);
    await codeOf(call('remember', { fact: CLAIM, entity: 'people/alice-example', provenance: 'test' }));
    await codeOf(call('put_page', { slug: 'people/alice-example', content: CONTENT, request_id: randomUUID() }));
    expect(await journalCarries(CLAIM)).toBe(0);
    const [page] = await engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE slug='people/alice-example'`);
    expect(page.compiled_truth).not.toContain(CLAIM);
  }, 60_000);

  test('39-5: the fact receipt lists every swept inventory store, files and persistence_effects included', async () => {
    const done = await purgeFact(await seed());
    const listed = new Set([...done.stores, ...done.residuals].map((s: { store: string }) => s.store));
    const swept = DELETION_INVENTORY.filter(e => e.class === 'swept').map(e => e.table);
    expect(swept.filter(t => !listed.has(t))).toEqual([]);
    expect(listed.has('files') && listed.has('persistence_effects')).toBe(true);
  }, 60_000);

  test('39-6: the page receipt is store by store, verified, and names other pages that keep a claim in prose', async () => {
    await seed();
    await importFromContent(engine, 'meetings/2026-03-12-sync', `---\ntitle: Sync\ntype: meeting\n---\n# Sync\n\nAlice said: ${CLAIM}.\n`, { noEmbed: true, sourceId: 'default' });
    const purged = await purgePage('people/alice-example');
    expect(purged.status).toBe('purged');
    expect(String(purged.residuals)).toContain('git history');
    const result = purged.receipt;
    expect(Object.keys(result).indexOf('residuals')).toBeLessThan(Object.keys(result).indexOf('stores'));
    const byStore = new Map(result.stores.map((s: { store: string }) => [s.store, s]));
    const swept = DELETION_INVENTORY.filter(e => e.class === 'swept').map(e => e.table);
    expect(swept.filter(t => !byStore.has(t))).toEqual([]);
    expect(byStore.get('facts')).toMatchObject({ status: 'deleted' });
    expect(byStore.get('pages')).toMatchObject({ status: 'out_of_scope', reason: 'source_prose', items: ['meetings/2026-03-12-sync'] });
    for (const store of ['canonical_markdown', 'fence_tmp_evidence', 'persistence_effects']) expect(byStore.has(store)).toBe(true);
    expect(result.stores.some((s: { status: string }) => s.status === 'incomplete')).toBe(false);
    expect(result.page_tombstones).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(result)).not.toContain(CLAIM);
  }, 60_000);

  test('39-7: an older version of a purged page is refused as well as its last content', async () => {
    const v1 = page('Bob', [fenceRow(1, 'Bob keeps the spare key under the mat')], 'First draft.');
    await importFromContent(engine, 'people/bob-example', v1, { noEmbed: true, sourceId: 'default' });
    await importFromContent(engine, 'people/bob-example', page('Bob', [fenceRow(1, 'Bob keeps the spare key under the mat')], 'Second draft.'),
      { noEmbed: true, sourceId: 'default' });
    expect(await engine.executeRaw(`SELECT 1 FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug='people/bob-example'`)).not.toHaveLength(0);
    await purgePage('people/bob-example');
    for (const slug of ['people/bob-example', 'archive/bob-v1']) {
      const error = await importFromContent(engine, slug, v1, { noEmbed: true, sourceId: 'default' }).then(() => 'imported', e => String((e as Error).message));
      expect(error).toContain('purged_content');
    }
  }, 60_000);
});
