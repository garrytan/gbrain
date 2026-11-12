/**
 * #9068: purging a page removes its slug and its name from the volunteer log and the mention gazetteer.
 *
 * 1. Protects: delete_page purge:true, the expired-tombstone purge, the belief ledger's per-tombstone expiry and a
 *    restore that replays a page purge delete the source's context_volunteer_events rows for the slug (each rationale
 *    quotes the matched name) and its mention_gazetteer_entries rows (name_norm -> slug), in the purge transaction,
 *    and the page receipt checks both stores. A fact purge sweeps neither, so a row there that holds the claim is
 *    reported as a residual, never as an incomplete sweep.
 * 2. Fails when: either store keeps the purged slug or name, or the scrub reaches another source's or another
 *    page's rows.
 * 3. Existing coverage: purge-retrieval-feedback-8821 pins the retrieval stores; nothing pinned these two.
 * 4. Real seams: PGLite, and Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt); the belief-ledger and restore cases are PGLite only; the volunteer log's own writer, the delete_page and
 *    purge_fact ops, purgeDeletedPagesCoordinated, a PGLite backup and restore; repo-less brain, no provider calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { insertVolunteerEvents } from '../src/core/context/volunteer-events.ts';
import { DELETION_INVENTORY_BY_TABLE } from '../src/core/deletion-inventory.ts';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { beliefBrain, beliefPage, openFileBeliefBrain, withFileBeliefBrain } from './helpers/belief-ledger.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-names-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const OTHER = 'companies/acme-example';
const OTHER_NAME = 'Acme Example';

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

/** One page's two name rows: a volunteer pointer whose rationale quotes the name, and a gazetteer entry for it. */
async function nameRows(engine: BrainEngine, sourceId: string, slug: string, name: string) {
  await insertVolunteerEvents(engine, [{ source_id: sourceId, slug, confidence: 0.9, match_arm: 'alias', rationale: `alias match "${name}"`, channel: 'op' }]);
  await engine.executeRaw('INSERT INTO mention_gazetteer_entries (source_id, name_norm, target_slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [sourceId, name.toLowerCase(), slug]);
}

/** The page in two sources and another page in default, each with its name rows. */
async function seed(engine: BrainEngine, slug: string, name: string) {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`);
  for (const sourceId of ['default', 'source-b']) {
    await importFromContent(engine, slug, `---\ntitle: ${name}\ntype: person\n---\n# ${name}\n\nBody text.\n`, { noEmbed: true, sourceId });
    await nameRows(engine, sourceId, slug, name);
  }
  if (!(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', ['default', OTHER])).length) {
    await importFromContent(engine, OTHER, `---\ntitle: ${OTHER_NAME}\ntype: company\n---\n# ${OTHER_NAME}\n\nBody text.\n`, { noEmbed: true, sourceId: 'default' });
    await nameRows(engine, 'default', OTHER, OTHER_NAME);
  }
}

/** The sources whose rows still name the page, by slug or by name, per store. */
async function residue(engine: BrainEngine, slug: string, name: string) {
  const sources = async (sql: string) => (await engine.executeRaw<{ source_id: string }>(sql, [slug, name.toLowerCase()])).map(r => r.source_id);
  return {
    context_volunteer_events: await sources('SELECT source_id FROM context_volunteer_events WHERE slug = $1 OR strpos(lower(rationale), $2) > 0 ORDER BY 1'),
    mention_gazetteer_entries: await sources('SELECT source_id FROM mention_gazetteer_entries WHERE target_slug = $1 OR name_norm = $2 ORDER BY 1'),
  };
}
const ONLY_SOURCE_B = { context_volunteer_events: ['source-b'], mention_gazetteer_entries: ['source-b'] };
const SEEDED = { context_volunteer_events: ['default', 'source-b'], mention_gazetteer_entries: ['default', 'source-b'] };

async function otherUntouched(engine: BrainEngine) {
  expect(await engine.executeRaw(`SELECT 1 FROM context_volunteer_events WHERE source_id = 'default' AND slug = $1`, [OTHER])).toHaveLength(1);
  expect(await engine.executeRaw(`SELECT 1 FROM mention_gazetteer_entries WHERE source_id = 'default' AND target_slug = $1`, [OTHER])).toHaveLength(1);
}

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await registerLocalWriter(engine, 'cli');
}), 120_000);
afterAll(async () => {
  for (const engine of engines) await disposePersistenceConsumer(engine);
  await engines.find(e => e.kind === 'pglite')?.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true });
}, 60_000);

describe('#9068 a page purge removes the slug and name from the volunteer log and the mention gazetteer', () => {
  test('both stores are swept page-name stores in the deletion inventory', () => {
    for (const table of ['context_volunteer_events', 'mention_gazetteer_entries']) expect(DELETION_INVENTORY_BY_TABLE.get(table)?.class).toBe('swept');
  });

  test('delete_page purge:true scrubs the source\'s rows and the receipt checks both stores', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/alice-example', name = 'Alice Example';
      await seed(engine, slug, name);
      expect(await residue(engine, slug, name)).toEqual(SEEDED);
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      const result = await op('delete_page').handler(ctx(engine), { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
      expect(result.status).toBe('purged');
      expect({ engine: engine.kind, residue: await residue(engine, slug, name) }).toEqual({ engine: engine.kind, residue: ONLY_SOURCE_B });
      await otherUntouched(engine);
      const stores = new Map((result.receipt.stores as Array<{ store: string; status: string; removed?: number }>).map(s => [s.store, s]));
      for (const store of ['context_volunteer_events', 'mention_gazetteer_entries']) expect(stores.get(store)).toMatchObject({ status: 'deleted', removed: 1 });
    }
  }), 120_000);

  test('the expired-tombstone purge scrubs the same rows', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/bob-sample', name = 'Bob Sample';
      await seed(engine, slug, name);
      await engine.softDeletePage(slug, { sourceId: 'default' });
      expect(await residue(engine, slug, name)).toEqual(SEEDED);
      const purged = await purgeDeletedPagesCoordinated(engine, 0);
      expect(purged.slugs).toContain(slug);
      expect({ engine: engine.kind, residue: await residue(engine, slug, name) }).toEqual({ engine: engine.kind, residue: ONLY_SOURCE_B });
      await otherUntouched(engine);
    }
  }), 120_000);

  test('a fact purge reports a name row that holds the claim instead of calling the sweep incomplete', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const claim = 'Door code is 4417';
    for (const engine of engines) {
      const slug = 'people/carol-example';
      await importFromContent(engine, slug, `---\ntitle: Carol Example\ntype: person\n---\n# Carol Example\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`, { noEmbed: true, sourceId: 'default' });
      await runExtractFacts(engine, { slugs: [slug] });
      const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact = $1 AND entity_slug = $2', [claim, slug]);
      await importFromContent(engine, 'notes/door-code-example', `---\ntitle: Door code example\ntype: note\n---\n# Door code example\n\nBody text.\n`, { noEmbed: true, sourceId: 'default' });
      await nameRows(engine, 'default', 'notes/door-code-example', claim);
      const purge = (params: Record<string, unknown>) => op('purge_fact').handler(ctx(engine), params) as Promise<Record<string, any>>;
      const dry = await purge({ id: Number(fact.id), dry_run: true });
      const result = await purge({ id: Number(fact.id), confirm: dry.confirm_token, expected_revision: dry.expected_revision, request_id: randomUUID() });
      const stores = new Map((result.stores as Array<{ store: string; status: string; reason?: string }>).map(s => [s.store, s]));
      for (const store of ['context_volunteer_events', 'mention_gazetteer_entries']) {
        expect({ engine: engine.kind, store, report: stores.get(store) }).toMatchObject({ engine: engine.kind, store, report: { status: 'out_of_scope', reason: 'probed_reported', remaining: 1 } });
      }
      expect(await engine.executeRaw('SELECT 1 FROM mention_gazetteer_entries WHERE target_slug = $1', ['notes/door-code-example'])).toHaveLength(1);
    }
  }), 120_000);
});

const pgliteTest = testBackends().includes('pglite') ? test : test.skip;

pgliteTest('#9068 a recorded tombstone the belief ledger expires scrubs the same rows', () => beliefBrain(async b => {
  const slug = 'people/alice-example', name = 'Alice Example';
  await b.put(slug, beliefPage({ title: name, prose: 'Body of the page.' }));
  await b.put(OTHER, beliefPage({ title: OTHER_NAME, prose: 'Body of the other page.' }));
  await nameRows(b.engine, b.sourceId, slug, name);
  await nameRows(b.engine, b.sourceId, OTHER, OTHER_NAME);
  await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]);
  const purged = await purgeDeletedPagesCoordinated(b.engine, 72);
  expect(purged.slugs).toContain(slug);
  expect(await residue(b.engine, slug, name)).toEqual({ context_volunteer_events: [], mention_gazetteer_entries: [] });
  expect(await b.engine.executeRaw('SELECT 1 FROM mention_gazetteer_entries WHERE source_id = $1 AND target_slug = $2', [b.sourceId, OTHER])).toHaveLength(1);
}), 120_000);

pgliteTest('#9068 a restore that replays a page purge scrubs the same rows from the restored brain', () => withFileBeliefBrain('restore-9068', async fb => {
  const src = 'restore-9068', slug = 'people/alice-example', name = 'Alice Example';
  await fb.open(async b => {
    await b.put(slug, beliefPage({ title: name, prose: 'Body of the page.' }));
    await b.put(OTHER, beliefPage({ title: OTHER_NAME, prose: 'Body of the other page.' }));
    await nameRows(b.engine, src, slug, name);
    await nameRows(b.engine, src, OTHER, OTHER_NAME);
  });
  const archive = join(fb.home, 'archive.gbrain-backup');
  await createPgliteBackup({ root: fb.home, output: archive });
  await fb.open(async b => {
    const snapshot = await b.engine.readPageSnapshot(slug, { sourceId: src });
    await op('delete_page').handler(b.ctx, { slug, purge: true, expected_revision: snapshot!.revision, request_id: randomUUID() });
  });
  const into = join(fb.home, 'restored');
  const result = await restorePgliteBackup({ archive, into });
  expect(result.purge_replay.replays.map(x => x.scope)).toEqual(['page']);
  const { brain, close } = await openFileBeliefBrain(join(into, '.gbrain', 'brain.pglite'), src, join(into, 'content'));
  try {
    expect(await residue(brain.engine, slug, name)).toEqual({ context_volunteer_events: [], mention_gazetteer_entries: [] });
    expect(await brain.engine.executeRaw('SELECT 1 FROM mention_gazetteer_entries WHERE source_id = $1 AND target_slug = $2', [src, OTHER])).toHaveLength(1);
  } finally { await close(); }
}), 300_000);
