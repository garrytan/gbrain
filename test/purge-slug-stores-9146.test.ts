/**
 * #9146: every hard delete of a page clears the six stores keyed to it by source and slug.
 *
 * 1. Protects: delete_page purge:true, the expired-tombstone purge, the belief ledger's per-tombstone expiry, the
 *    batch delete connectors use and a restore that replays a page purge all delete the source's take_proposals,
 *    open_loops, core_edit_notices, page_aliases, slug_aliases and slug_rename_history rows for the slug, in the
 *    delete's transaction.
 * 2. Fails when: a hard-delete path other than delete_page purge:true keeps any of the six (a proposed take's claim
 *    text, an open loop's summary, the notice's base text, the page's aliases), or the scrub reaches another
 *    source's or another page's rows.
 * 3. Existing coverage: page-purge pins the six for delete_page purge:true only; purge-name-stores-9068 and
 *    purge-retrieval-feedback-8821 pin other stores on these paths. Nothing pinned these six on an expiry.
 * 4. Real seams: PGLite; the delete_page op, purgeDeletedPagesCoordinated, engine.deletePages, a PGLite backup and
 *    restore; repo-less brain, no provider calls.
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
import { scrubPurgedSlugStores } from '../src/core/persistence/purge-slug-stores.ts';
import { createPgliteBackup, restorePgliteBackup } from '../src/core/backup/snapshot.ts';
import { beliefBrain, beliefPage, openFileBeliefBrain, withFileBeliefBrain } from './helpers/belief-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-slug-stores-'));
let engine: PGLiteEngine;
const OTHER = 'companies/acme-example';
const TABLES = ['take_proposals', 'open_loops', 'core_edit_notices', 'page_aliases', 'slug_aliases', 'slug_rename_history'] as const;
const all = <T>(value: T) => Object.fromEntries(TABLES.map(t => [t, value])) as Record<(typeof TABLES)[number], T>;

const ctx = (): OperationContext => ({ engine, sourceId: 'default', remote: false, dryRun: false,
  config: { engine: 'pglite', embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: join(home, 'storage') } },
  logger: { info() {}, warn() {}, error() {} } } as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

/** One row per store for the page: each carries text or a name that only this page explains. */
async function slugRows(e: BrainEngine, sourceId: string, slug: string) {
  const run = (sql: string) => e.executeRaw(sql, [sourceId, slug]);
  await run(`INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, model_id)
    VALUES ($1, $2, 'h', 'p', 'r', 'Prefers the placeholder terms', 'take', 'self', 0.5, 'm')`);
  await run(`INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, page_slug, detector)
    VALUES ($1, 'loop:' || $2, 'decision_pending', 'Owes a reply about the placeholder deal', $2, 'manual')`);
  await run(`INSERT INTO core_edit_notices (source_id, slug, base_text, actor) VALUES ($1, $2, 'Base text of the page', 'tester')`);
  await run(`INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ($1, 'alias of ' || $2, $2)`);
  await run(`INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2 || '-former', $2)`);
  await run(`INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, $2 || '-old', $2)`);
}

/** The page in two sources and another page in default, each with its six rows. */
async function seed(slug: string) {
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING`);
  for (const sourceId of ['default', 'source-b']) {
    await importFromContent(engine, slug, `---\ntitle: ${slug}\ntype: person\n---\n# ${slug}\n\nBody text.\n`, { noEmbed: true, sourceId });
    await slugRows(engine, sourceId, slug);
  }
  if (!(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', ['default', OTHER])).length) {
    await importFromContent(engine, OTHER, `---\ntitle: Acme Example\ntype: company\n---\n# Acme Example\n\nBody text.\n`, { noEmbed: true, sourceId: 'default' });
    await slugRows(engine, 'default', OTHER);
  }
}

/** The sources whose rows are still keyed to the page, per store. */
async function residue(e: BrainEngine, slug: string) {
  const sources = async (sql: string) => (await e.executeRaw<{ source_id: string }>(sql, [slug])).map(r => r.source_id);
  return {
    take_proposals: await sources('SELECT source_id FROM take_proposals WHERE page_slug = $1 ORDER BY 1'),
    open_loops: await sources('SELECT source_id FROM open_loops WHERE page_slug = $1 ORDER BY 1'),
    core_edit_notices: await sources('SELECT source_id FROM core_edit_notices WHERE slug = $1 ORDER BY 1'),
    page_aliases: await sources('SELECT source_id FROM page_aliases WHERE slug = $1 ORDER BY 1'),
    slug_aliases: await sources('SELECT source_id FROM slug_aliases WHERE canonical_slug = $1 ORDER BY 1'),
    slug_rename_history: await sources('SELECT source_id FROM slug_rename_history WHERE new_slug = $1 ORDER BY 1'),
  };
}
const SEEDED = all(['default', 'source-b']);
const ONLY_SOURCE_B = all(['source-b']);
const NONE = all([] as string[]);

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await registerLocalWriter(engine, 'cli');
}), 120_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect(); rmSync(home, { recursive: true, force: true });
}, 60_000);

describe('#9146 a hard delete of a page clears the stores keyed to it by slug', () => {
  test('delete_page purge:true clears the source\'s rows and counts them', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/alice-example';
    await seed(slug);
    expect(await residue(engine, slug)).toEqual(SEEDED);
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    const result = await op('delete_page').handler(ctx(), { slug, purge: true, request_id: randomUUID(), expected_revision: snapshot!.revision }) as Record<string, any>;
    expect(result.status).toBe('purged');
    expect(await residue(engine, slug)).toEqual(ONLY_SOURCE_B);
    expect(await residue(engine, OTHER)).toEqual(all(['default']));
    const stores = new Map((result.receipt.stores as Array<{ store: string; status: string; removed?: number }>).map(s => [s.store, s]));
    for (const store of ['take_proposals', 'open_loops', 'core_edit_notices', 'page_aliases', 'slug_aliases']) expect(stores.get(store)).toMatchObject({ status: 'deleted', removed: 1 });
  }), 120_000);

  test('the expired-tombstone purge clears the same rows', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/bob-sample';
    await seed(slug);
    await engine.softDeletePage(slug, { sourceId: 'default' });
    expect(await residue(engine, slug)).toEqual(SEEDED);
    const purged = await purgeDeletedPagesCoordinated(engine, 0);
    expect(purged.slugs).toContain(slug);
    expect(await residue(engine, slug)).toEqual(ONLY_SOURCE_B);
    expect(await residue(engine, OTHER)).toEqual(all(['default']));
  }), 120_000);

  test('the batch delete clears the same rows', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/carol-example';
    await seed(slug);
    expect(await residue(engine, slug)).toEqual(SEEDED);
    expect(await engine.deletePages([slug], { sourceId: 'default' })).toEqual([slug]);
    expect(await residue(engine, slug)).toEqual(ONLY_SOURCE_B);
    expect(await residue(engine, OTHER)).toEqual(all(['default']));
  }), 120_000);

  test('a store the schema does not have yet is skipped only when asked', () => withEnv({ GBRAIN_HOME: home }, async () => {
    const slug = 'people/dana-sample';
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-c', 'source-c') ON CONFLICT DO NOTHING`);
    await slugRows(engine, 'source-c', slug);
    await engine.executeRaw('ALTER TABLE take_proposals RENAME TO take_proposals_away');
    try {
      await expect(scrubPurgedSlugStores(engine, 'source-c', [slug])).rejects.toThrow();
      const removed = await scrubPurgedSlugStores(engine, 'source-c', [slug], { ifPresent: true });
      expect(removed).toEqual({ open_loops: 1, core_edit_notices: 1, page_aliases: 1, slug_aliases: 1, slug_rename_history: 1 });
    } finally {
      await engine.executeRaw('ALTER TABLE take_proposals_away RENAME TO take_proposals');
    }
  }), 120_000);
});

test('#9146 a recorded tombstone the belief ledger expires clears the same rows', () => beliefBrain(async b => {
  const slug = 'people/alice-example';
  await b.put(slug, beliefPage({ title: 'Alice Example', prose: 'Body of the page.' }));
  await b.put(OTHER, beliefPage({ title: 'Acme Example', prose: 'Body of the other page.' }));
  await slugRows(b.engine, b.sourceId, slug);
  await slugRows(b.engine, b.sourceId, OTHER);
  await b.engine.executeRaw(`UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE source_id = $1 AND slug = $2`, [b.sourceId, slug]);
  expect(await residue(b.engine, slug)).toEqual(all([b.sourceId]));
  const purged = await purgeDeletedPagesCoordinated(b.engine, 72);
  expect(purged.slugs).toContain(slug);
  expect(await residue(b.engine, slug)).toEqual(NONE);
  expect(await residue(b.engine, OTHER)).toEqual(all([b.sourceId]));
}), 120_000);

test('#9146 a restore that replays a page purge clears the same rows from the restored brain', () => withFileBeliefBrain('restore-slug-stores', async fb => {
  const src = 'restore-slug-stores', slug = 'people/alice-example';
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
    expect(await residue(brain.engine, slug)).toEqual(NONE);
    expect(await residue(brain.engine, OTHER)).toEqual(all([src]));
  } finally { await close(); }
}), 300_000);
