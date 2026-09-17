import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { PreparedContentImport } from '../src/core/persistence/prepared-import.ts';
import { assertImportBase } from '../src/core/page-state/import-guard.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const engines: BrainEngine[] = [];
const sourceId = 'import-cas-example';
const content = (stamp: string, body = 'A stable canonical paragraph with enough text to become a chunk.') =>
  `---\ntitle: Example\ntype: note\ncaptured_at: ${stamp}\ntags: [existing]\n---\n${body}`;
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
    const pg = new PostgresEngine(); await pg.connect({ database_url: process.env.DATABASE_URL }); await pg.initSchema(); engines.push(pg);
  }
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  }
}, 120_000);
afterAll(async () => { for (const engine of engines) {
  await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]); await engine.disconnect();
} });
async function prepare(engine: BrainEngine, slug: string, bytes: string): Promise<PreparedContentImport> {
  let prepared: PreparedContentImport | undefined;
  await importFromContent(engine, slug, bytes, { sourceId, noEmbed: true, prepare: async ready => { prepared = ready; return ready.result; } });
  return prepared!;
}

test('prepared same-body imports still publish changed canonical metadata', async () => {
  for (const engine of engines) {
    const slug = 'notes/captured-metadata';
    await importFromContent(engine, slug, content('first-capture'), { sourceId, noEmbed: true });
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const ready = await prepare(engine, slug, content('second-capture'));
    expect(ready.noop).toBe(false);
    await engine.transaction(ready.apply);
    const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(after.page.content_hash).toBe(before.page.content_hash);
    expect(after.page.frontmatter.captured_at).toBe('second-capture');
    expect(after.revision).not.toBe(before.revision);
    expect(after.page.text_projection_revision).toBe(after.revision);
  }
});

test('provider preparation cannot overwrite an intervening tag or page replacement', async () => {
  for (const engine of engines) {
    const slug = 'notes/competing-import';
    await importFromContent(engine, slug, content('base'), { sourceId, noEmbed: true });
    const ready = await prepare(engine, slug, content('prepared', 'Prepared stale replacement.'));
    await engine.addTag(slug, 'concurrent', { sourceId });
    const current = (await engine.readPageSnapshot(slug, { sourceId }))!;
    await expect(engine.transaction(ready.apply)).rejects.toMatchObject({ code: 'revision_conflict' });
    const after = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(after).toEqual(current);
    expect(after.tags).toContain('concurrent');
    expect(after.page.compiled_truth).not.toContain('Prepared stale');
  }
});

test('absence guards reject create races and physical recreation of the same slug', async () => {
  for (const engine of engines) {
    const slug = 'notes/create-race';
    const ready = await prepare(engine, slug, content('prepared'));
    await importFromContent(engine, slug, content('winner'), { sourceId, noEmbed: true });
    await expect(engine.transaction(ready.apply)).rejects.toMatchObject({ code: 'page_identity_changed' });
    const original = (await engine.getPage(slug, { sourceId }))!;
    await engine.deletePage(slug, { sourceId });
    await importFromContent(engine, slug, content('recreated'), { sourceId, noEmbed: true });
    await expect(engine.transaction(tx => assertImportBase(tx, slug, sourceId, original))).rejects.toMatchObject({ code: 'page_identity_changed' });
    expect((await engine.getPage(slug, { sourceId }))!.frontmatter.captured_at).toBe('recreated');
  }
});
