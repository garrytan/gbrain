/**
 * Purging a page removes its slug and name from the volunteer log and the saved mention gazetteer.
 *
 * 1. Protects: delete_page purge:true and the expired-tombstone purge (bulk, and per tombstone where the belief
 *    ledger records the source) delete the source's
 *    context_volunteer_events rows for the slug (slug plus a rationale that quotes the matched name) and its
 *    mention_gazetteer_entries rows (the page's normalized title and aliases keyed to the slug), in the purge
 *    transaction; the delete_page result counts both, and its receipt reports the gazetteer as deleted (the
 *    volunteer log stays a probed store in the receipt, as on master). A fact purge sweeps neither table: when the
 *    claim is also a live page's name, its receipt reports the gazetteer entry as out-of-scope prose, like the title.
 * 2. Fails when: a purged slug or the name it was matched by stays readable in either table, the scrub reaches
 *    another source's rows or another page's rows, or a fact purge is reported incomplete over a live page's name.
 * 3. Existing coverage: page-purge pins the page-keyed stores and the retrieval logs; nothing pinned these two.
 * 4. Real seams: PGLite, insertVolunteerEvents, runMentionPass, enableBeliefLedger, the delete_page op and
 *    purgeDeletedPagesCoordinated; repo-less brain, local blob storage, no provider calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { insertVolunteerEvents } from '../src/core/context/volunteer-events.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-volunteer-'));
const SLUG = 'people/alice-example';
const OTHER = 'people/bob-sample';
const NAMES: Record<string, string> = { [SLUG]: 'Alice Example', [OTHER]: 'Bob Sample' };

function context(): OperationContext {
  return { engine, config: { engine: 'pglite', embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' };
}

async function seed() {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`);
  for (const sourceId of ['default', 'source-b']) for (const slug of [SLUG, OTHER]) {
    await importFromContent(engine, slug, `---\ntitle: ${NAMES[slug]}\ntype: person\n---\n# ${NAMES[slug]}\n\nBody text.\n`, { noEmbed: true, sourceId });
  }
  await insertVolunteerEvents(engine, ['default', 'source-b'].flatMap(source_id => [SLUG, OTHER].map(slug => ({
    source_id, slug, confidence: 0.9, match_arm: 'alias', rationale: `alias match "${NAMES[slug].toLowerCase()}"`, channel: 'reflex' as const, session_id: 's1', turn: 1 }))));
  const pass = await runMentionPass(engine);
  expect(pass.state).toBe('complete');
}

/** Sources that still hold a row naming the purged page, per table and per way of naming it. */
async function residue() {
  const q = async (sql: string) => (await engine.executeRaw<{ source_id: string }>(sql, [SLUG, NAMES[SLUG].toLowerCase()])).map(r => r.source_id);
  return {
    volunteer_slug: await q(`SELECT DISTINCT source_id FROM context_volunteer_events WHERE slug = $1 AND $2 <> '' ORDER BY 1`),
    volunteer_name: await q(`SELECT DISTINCT source_id FROM context_volunteer_events WHERE strpos(rationale, $2) > 0 AND $1 <> '' ORDER BY 1`),
    gazetteer_slug: await q(`SELECT DISTINCT source_id FROM mention_gazetteer_entries WHERE target_slug = $1 AND $2 <> '' ORDER BY 1`),
    gazetteer_name: await q(`SELECT DISTINCT source_id FROM mention_gazetteer_entries WHERE name_norm = $2 AND $1 <> '' ORDER BY 1`),
  };
}

const EVERYWHERE = { volunteer_slug: ['default', 'source-b'], volunteer_name: ['default', 'source-b'], gazetteer_slug: ['default', 'source-b'], gazetteer_name: ['default', 'source-b'] };
const ONLY_SOURCE_B = { volunteer_slug: ['source-b'], volunteer_name: ['source-b'], gazetteer_slug: ['source-b'], gazetteer_name: ['source-b'] };

async function otherPageUntouched() {
  expect(await engine.executeRaw(`SELECT 1 FROM context_volunteer_events WHERE source_id='default' AND slug=$1`, [OTHER])).toHaveLength(1);
  expect(await engine.executeRaw(`SELECT 1 FROM mention_gazetteer_entries WHERE source_id='default' AND target_slug=$1`, [OTHER])).not.toHaveLength(0);
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); }, 60_000);
beforeEach(async () => { await disposePersistenceConsumer(engine); await resetPgliteState(engine); _resetWriteThroughCacheForTest(); await seed(); }, 60_000);

describe('a page purge removes the slug and its name from the volunteer log and the mention gazetteer', () => {
  test('the seed names the page in both tables for both sources', async () => {
    expect(await residue()).toEqual(EVERYWHERE);
  }, 60_000);

  test('delete_page purge:true scrubs the source\'s rows', async () => {
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    const result = await withEnv({ GBRAIN_HOME: home }, () => operations.find(o => o.name === 'delete_page')!.handler(context(),
      { slug: SLUG, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision })) as Record<string, any>;
    expect(result.status).toBe('purged');
    expect(result.purge.removed).toMatchObject({ context_volunteer_events: 1, mention_gazetteer_entries: 1 });
    const byStore = new Map((result.receipt.stores as Array<{ store: string }>).map(s => [s.store, s]));
    expect(byStore.get('mention_gazetteer_entries')).toMatchObject({ status: 'deleted', removed: 1 });
    expect(await residue()).toEqual(ONLY_SOURCE_B);
    await otherPageUntouched();
  }, 60_000);

  test('the expired-tombstone purge scrubs the same rows', async () => {
    await engine.softDeletePage(SLUG, { sourceId: 'default' });
    const purged = await purgeDeletedPagesCoordinated(engine, 0);
    expect(purged.slugs).toContain(SLUG);
    expect(await residue()).toEqual(ONLY_SOURCE_B);
    await otherPageUntouched();
  }, 60_000);

  test('the expiry of a tombstone the belief ledger records scrubs the same rows', async () => {
    await enableBeliefLedger(engine, 'default');
    await engine.softDeletePage(SLUG, { sourceId: 'default' });
    const purged = await purgeDeletedPagesCoordinated(engine, 0);
    expect(purged.slugs).toContain(SLUG);
    expect(await engine.executeRaw(`SELECT 1 FROM belief_events WHERE source_id = 'default' AND event_type = 'page.expired'`)).toHaveLength(1);
    expect(await residue()).toEqual(ONLY_SOURCE_B);
    await otherPageUntouched();
  }, 60_000);

  test('a fact purge reports a live page name that carries the claim as out of scope, not as an incomplete sweep', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const claim = 'Carol Placeholder leads platform';
    const named = `SELECT 1 FROM mention_gazetteer_entries WHERE source_id = 'default' AND strpos(name_norm, lower($1)) > 0`;
    const fence = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
    await registerLocalWriter(engine, 'cli');
    await importFromContent(engine, 'people/carol-placeholder', `---\ntitle: ${claim}\ntype: person\n---\n# Carol\n\nBody text.\n`, { noEmbed: true, sourceId: 'default' });
    await importFromContent(engine, 'people/dan-sample', `---\ntitle: Dan Sample\ntype: person\n---\n# Dan Sample\n\n## Facts\n\n${fence}\n`, { noEmbed: true, sourceId: 'default' });
    await runExtractFacts(engine, { slugs: ['people/dan-sample'] });
    expect((await runMentionPass(engine)).state).toBe('complete');
    expect(await engine.executeRaw(named, [claim])).toHaveLength(1);
    const [fact] = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_id = 'default' AND fact = $1`, [claim]);
    const purge = (params: Record<string, unknown>) => operations.find(o => o.name === 'purge_fact')!.handler(context(), params) as Promise<Record<string, any>>;
    const dry = await purge({ id: Number(fact!.id), dry_run: true });
    const done = await purge({ id: Number(fact!.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
    const stores = done.stores as Array<{ store: string; status: string }>;
    expect(stores.find(s => s.store === 'facts')).toMatchObject({ status: 'deleted', removed: 1 });
    expect(stores.find(s => s.store === 'mention_gazetteer_entries')).toMatchObject({ status: 'out_of_scope', reason: 'source_prose', remaining: 1 });
    expect(stores.filter(s => s.status === 'incomplete')).toEqual([]);
    expect(done.completion).not.toBe('incomplete');
    expect(await engine.executeRaw(named, [claim])).toHaveLength(1);
  }), 60_000);
});
