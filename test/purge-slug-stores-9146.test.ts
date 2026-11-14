/**
 * #9146: every hard delete of a page removes the six stores keyed to it by source and slug.
 *
 * 1. Protects: delete_page purge:true, the expired-tombstone purge, the belief ledger's per-tombstone expiry, the batch
 *    deletePages, a restore that replays a page purge and a managed connector delete that expires delete the source's
 *    take_proposals, open_loops (page_slug), core_edit_notices, page_aliases (slug), slug_aliases (canonical_slug) and
 *    slug_rename_history (new_slug) rows for the slug, in the delete's transaction. An immediate hard delete also drops
 *    the slug's write_gate_holds and their receipts; a tombstone expiry drops only holds created up to the soft
 *    delete, so a write held after it stays for review. Removing a source drops its core_edit_notices and
 *    write_gate_holds (the other stores cascade from sources).
 * 2. Fails when: any of those stores keeps the purged page's rows, a tombstone expiry drops a hold that arrived after
 *    the soft delete, a source removal leaves its notices or holds, or a scrub reaches another source's or another
 *    page's rows.
 * 3. Existing coverage: purge-name-stores-9068 and purge-scrub-followups-9068 pin the name and retrieval stores on the
 *    same paths; only the direct purge removed these six.
 * 4. Real seams: PGLite, and Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt); the belief-ledger,
 *    restore and managed connector cases are PGLite only; the delete_page op, purgeDeletedPagesCoordinated,
 *    deletePages, a PGLite backup and restore, the managed connector session, removeSource; repo-less brain, no
 *    provider calls.
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
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { withConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { parseGoogleSourceConfig } from '../src/core/google/google-source.ts';
import { removeSource } from '../src/core/sources-ops.ts';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { beliefBrain, beliefPage, openFileBeliefBrain, withFileBeliefBrain } from './helpers/belief-ledger.ts';
import { createConnectorFixture, googleConfig, options, settleConnectorWrites } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-slug-stores-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const OTHER = 'companies/acme-example';
const STORES = ['take_proposals', 'open_loops', 'core_edit_notices', 'page_aliases', 'slug_aliases', 'slug_rename_history'] as const;
const KEY: Record<string, string> = { take_proposals: 'page_slug', open_loops: 'page_slug', core_edit_notices: 'slug', page_aliases: 'slug', slug_aliases: 'canonical_slug', slug_rename_history: 'new_slug' };

const ctx = (engine: BrainEngine): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: engine.kind, embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

/**
 * A write-gate hold for the slug created and last seen `ago` before now, labelled `when`, with its receipt. A hold
 * that arrives after a soft delete is stamped a second later: PGLite's now() has millisecond resolution, so two
 * back-to-back statements usually share a timestamp, and a hold stamped at the soft delete's instant counts as
 * arriving at or before it.
 */
async function hold(engine: BrainEngine, sourceId: string, slug: string, when: string, ago = '0 seconds') {
  const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload, created_at, last_seen_at)
    VALUES ('fact', $1, $2, $3, 1, 'quarantine', $4::text::jsonb, now() - $5::interval, now() - $5::interval) RETURNING id::text AS id`,
  [sourceId, slug, randomUUID(), JSON.stringify({ when }), ago]);
  await engine.executeRaw(`INSERT INTO write_gate_receipts (target_table, target_id, source_id, content_hash, tier, detector_version, verdict, request_id)
    VALUES ('write_gate_holds', $1, $2, $3, 'quarantine', 1, 'quarantine', $4)`, [row.id, sourceId, randomUUID(), `${slug}|${when}`]);
}

/** One row per slug-keyed store for the page in `sourceId`, and a hold created `holdAgo` before now. */
async function slugRows(engine: BrainEngine, sourceId: string, slug: string, holdAgo = '0 seconds') {
  const marker = randomUUID();
  await engine.executeRaw(`INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, model_id)
    VALUES ($1, $2, $3, 'v1', 'run-1', 'Proposed claim about the page', 'take', 'self', 0.5, 'model-a')`, [sourceId, slug, marker]);
  await engine.executeRaw(`INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, page_slug, detector)
    VALUES ($1, $2, 'commitment_owed_by_me', 'Loop found on the page', $3, 'manual')`, [sourceId, marker, slug]);
  await engine.executeRaw(`INSERT INTO core_edit_notices (source_id, slug, base_text, actor) VALUES ($1, $2, 'Copy of the page text', 'agent')`, [sourceId, slug]);
  await engine.executeRaw(`INSERT INTO page_aliases (source_id, alias_norm, slug, origin, alias_text) VALUES ($1, $2, $3, 'declared', 'Alias text')`, [sourceId, `alias ${marker}`, slug]);
  await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', [sourceId, `old/${marker}`, slug]);
  await engine.executeRaw('INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, $2, $3)', [sourceId, `renamed/${marker}`, slug]);
  await hold(engine, sourceId, slug, 'before', holdAgo);
}

/** The page in default and source-b and OTHER in default, each with one row per store and a hold from an hour ago. */
async function seed(engine: BrainEngine, slug: string) {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`);
  for (const sourceId of ['default', 'source-b']) {
    await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: person\n---\n# ${slug}\n\nBody text.\n`, { noEmbed: true, sourceId });
    await slugRows(engine, sourceId, slug, '1 hour');
  }
  if (!(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', ['default', OTHER])).length) {
    await importFromContent(engine, OTHER, `---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nBody text.\n`, { noEmbed: true, sourceId: 'default' });
    await slugRows(engine, 'default', OTHER, '1 hour');
  }
}

/** Per store, the sources that still hold a row for the slug; holds and their receipts as `source:when`. */
async function residue(engine: BrainEngine, slug: string) {
  const out: Record<string, string[]> = {};
  for (const table of STORES) out[table] = (await engine.executeRaw<{ s: string }>(`SELECT DISTINCT source_id AS s FROM ${table} WHERE ${KEY[table]} = $1 ORDER BY 1`, [slug])).map(r => r.s);
  out.write_gate_holds = (await engine.executeRaw<{ s: string }>(`SELECT source_id || ':' || (payload->>'when') AS s FROM write_gate_holds WHERE slug = $1 ORDER BY 1`, [slug])).map(r => r.s);
  out.write_gate_receipts = (await engine.executeRaw<{ s: string }>(`SELECT source_id || ':' || split_part(request_id, '|', 2) AS s FROM write_gate_receipts
    WHERE target_table = 'write_gate_holds' AND split_part(request_id, '|', 1) = $1 ORDER BY 1`, [slug])).map(r => r.s);
  return out;
}
const only = (sources: string[], holds: string[]) => ({ ...Object.fromEntries(STORES.map(t => [t, sources])), write_gate_holds: holds, write_gate_receipts: holds });
const SEEDED = only(['default', 'source-b'], ['default:before', 'source-b:before']);
const ONLY_SOURCE_B = only(['source-b'], ['source-b:before']);
const stores = (r: Record<string, string[]>) => Object.fromEntries(STORES.map(t => [t, r[t]]));

async function otherUntouched(engine: BrainEngine) {
  expect(await residue(engine, OTHER)).toEqual(only(['default'], ['default:before']));
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

describe('#9146 every hard delete removes the page\'s slug-keyed stores', () => {
  test('(A) delete_page purge:true scrubs the source\'s rows and its holds', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/alice-example';
      await seed(engine, slug);
      expect(await residue(engine, slug)).toEqual(SEEDED);
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      const result = await op('delete_page').handler(ctx(engine), { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
      expect(result.status).toBe('purged');
      expect({ engine: engine.kind, residue: await residue(engine, slug) }).toEqual({ engine: engine.kind, residue: ONLY_SOURCE_B });
      await otherUntouched(engine);
    }
  }), 120_000);

  test('(B) the expired-tombstone purge scrubs the rows and keeps a hold that arrived after the soft delete', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/bob-example';
      await seed(engine, slug);
      await engine.softDeletePage(slug, { sourceId: 'default' });
      expect(await residue(engine, slug)).toEqual(SEEDED);
      await hold(engine, 'default', slug, 'after', '-1 second');
      const purged = await purgeDeletedPagesCoordinated(engine, 0);
      expect(purged.slugs).toContain(slug);
      expect({ engine: engine.kind, residue: await residue(engine, slug) })
        .toEqual({ engine: engine.kind, residue: only(['source-b'], ['default:after', 'source-b:before']) });
      await otherUntouched(engine);
    }
  }), 120_000);

  test('(B) the expired-tombstone purge keeps a hold the same content re-opened after the soft delete', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/erin-example';
      await seed(engine, slug);
      await engine.softDeletePage(slug, { sourceId: 'default' });
      await engine.executeRaw(`UPDATE write_gate_holds SET status = 'held', last_seen_at = now() + interval '1 second', seen_count = seen_count + 1,
        payload = jsonb_set(payload, '{when}', '"reopened"') WHERE source_id = 'default' AND slug = $1`, [slug]);
      await engine.executeRaw(`UPDATE write_gate_receipts SET request_id = $1 WHERE target_table = 'write_gate_holds'
        AND target_id IN (SELECT id::text FROM write_gate_holds WHERE source_id = 'default' AND slug = $2)`, [`${slug}|reopened`, slug]);
      const purged = await purgeDeletedPagesCoordinated(engine, 0);
      expect(purged.slugs).toContain(slug);
      expect({ engine: engine.kind, residue: await residue(engine, slug) })
        .toEqual({ engine: engine.kind, residue: only(['source-b'], ['default:reopened', 'source-b:before']) });
      await otherUntouched(engine);
    }
  }), 120_000);

  test('(D) the batch deletePages scrubs the rows and the slug\'s holds', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/carol-example';
      await seed(engine, slug);
      expect(await engine.deletePages([slug], { sourceId: 'default' })).toEqual([slug]);
      expect({ engine: engine.kind, residue: await residue(engine, slug) }).toEqual({ engine: engine.kind, residue: ONLY_SOURCE_B });
      await otherUntouched(engine);
    }
  }), 120_000);

  test('removing a source drops its notices and holds along with the stores that cascade', () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/dave-example';
      await seed(engine, slug);
      await removeSource(engine, { id: 'source-b', yes: true });
      expect({ engine: engine.kind, residue: await residue(engine, slug) }).toEqual({ engine: engine.kind, residue: only(['default'], ['default:before']) });
      await otherUntouched(engine);
    }
  }), 120_000);
});

const pgliteTest = testBackends().includes('pglite') ? test : test.skip;

pgliteTest('#9146 (C) a recorded tombstone the belief ledger expires scrubs the rows and keeps a later hold', () => beliefBrain(async b => {
  const slug = 'people/alice-example', src = b.sourceId;
  await b.put(slug, beliefPage({ title: 'Alice Example', prose: 'Body of the page.' }));
  await b.put(OTHER, beliefPage({ title: 'Acme Example', prose: 'Body of the other page.' }));
  await slugRows(b.engine, src, slug, '200 hours');
  await slugRows(b.engine, src, OTHER, '200 hours');
  await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = $1 AND slug = $2`, [src, slug]);
  await hold(b.engine, src, slug, 'after', '50 hours');
  const purged = await purgeDeletedPagesCoordinated(b.engine, 72);
  expect(purged.slugs).toContain(slug);
  expect(await residue(b.engine, slug)).toEqual(only([], [`${src}:after`]));
  expect(await residue(b.engine, OTHER)).toEqual(only([src], [`${src}:before`]));
}), 120_000);

pgliteTest('#9146 (E) a restore that replays a page purge scrubs the rows and holds from the restored brain', () => withFileBeliefBrain('restore-9146', async fb => {
  const src = 'restore-9146', slug = 'people/alice-example';
  await fb.open(async b => {
    await b.put(slug, beliefPage({ title: 'Alice Example', prose: 'Body of the page.' }));
    await b.put(OTHER, beliefPage({ title: 'Acme Example', prose: 'Body of the other page.' }));
    await slugRows(b.engine, src, slug);
    await slugRows(b.engine, src, OTHER);
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
    expect(await residue(brain.engine, slug)).toEqual(only([], []));
    expect(await residue(brain.engine, OTHER)).toEqual(only([src], [`${src}:before`]));
  } finally { await close(); }
}), 300_000);

describe('#9146 a managed connector delete that expires scrubs the same rows', () => {
  const fixture = createConnectorFixture();
  beforeAll(fixture.setup, 120_000);
  afterAll(fixture.teardown);

  pgliteTest('connector_v2_delete, then the tombstone purge', () => withEnv(fixture.env, async () => {
    for (const engine of fixture.engines.filter(e => e.kind === 'pglite')) {
      const f = await fixture.source(engine, googleConfig);
      const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
      const slug = 'people/alice-example', path = `${slug}.md`;
      await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => {
        await managed!.importMarkdown(path, `---\ntype: person\ntitle: Alice Example\n---\n# Alice Example\n\nBody.\n`);
        await managed!.importMarkdown(`${OTHER}.md`, `---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nBody.\n`);
      });
      await settleConnectorWrites(engine, f.id);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await slugRows(engine, f.id, slug, '1 hour');
      await slugRows(engine, f.id, OTHER);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await withConnectorSync(engine, f.id, 'google', cfg, options, async managed => { expect(await managed!.delete(slug, path)).toBe(true); });
      await settleConnectorWrites(engine, f.id);
      expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NOT NULL', [f.id, slug])).toHaveLength(1);
      const purged = await purgeDeletedPagesCoordinated(engine, 0);
      expect(purged.slugs).toContain(slug);
      expect(stores(await residue(engine, slug))).toEqual(stores(only([], [])));
      expect(stores(await residue(engine, OTHER))).toEqual(stores(only([f.id], [])));
      await disposePersistenceConsumer(engine);
    }
  }), 240_000);
});
