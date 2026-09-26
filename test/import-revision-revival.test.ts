import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile, importFromContent, importImageFile } from '../src/core/import-file.ts';
import type { PreparedContentImport } from '../src/core/persistence/prepared-import.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
const sourceId = 'revival-example';
let scratch: string;
let closePostgres: (() => Promise<void>) | undefined;
const markdown = (body: string, id?: string) => `---\ntype: note\ntitle: Revival example\n${id ? `id: ${id}\n` : ''}---\n\n${body}`;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'gbrain-import-revival-'));
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  await engines[0]?.disconnect(); await closePostgres?.();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test('reimport revives the captured tombstone with unchanged or changed content and a fresh projection', async () => {
  for (const engine of engines) for (const changed of [false, true]) {
    const slug = `notes/revive-${changed}`;
    const beforeBody = 'Original canonical body for a recoverable imported page.';
    const afterBody = changed ? 'Changed canonical body after the source file returns.' : beforeBody;
    await importFromContent(engine, slug, markdown(beforeBody), { sourceId, noEmbed: true });
    const original = (await engine.getPage(slug, { sourceId }))!;
    await engine.softDeletePage(slug, { sourceId });
    const tombstone = (await engine.getPage(slug, { sourceId, includeDeleted: true }))!;
    expect(await engine.getPage(slug, { sourceId })).toBeNull();

    expect(await importFromContent(engine, slug, markdown(afterBody), { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
    const revived = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(revived.page.id).toBe(original.id);
    expect(revived.revision).not.toBe(tombstone.knowledge_revision);
    expect(revived.page.text_projection_revision).toBe(revived.revision);
    expect(revived.page.compiled_truth).toBe(afterBody);
    expect((await engine.getChunks(slug, { sourceId })).map(chunk => chunk.chunk_text).join('\n')).toContain(afterBody);
  }
});

test('prepared revival cannot overwrite an intervening restoration of the same page', async () => {
  for (const engine of engines) {
    const slug = 'notes/competing-revival';
    await importFromContent(engine, slug, markdown('Original body.'), { sourceId, noEmbed: true });
    await engine.softDeletePage(slug, { sourceId });
    let prepared: PreparedContentImport | undefined;
    await importFromContent(engine, slug, markdown('Stale prepared restoration.'), {
      sourceId, noEmbed: true, prepare: async ready => { prepared = ready; return ready.result; },
    });
    await importFromContent(engine, slug, markdown('Winning restored body.'), { sourceId, noEmbed: true });
    const winner = await engine.readPageSnapshot(slug, { sourceId });
    await expect(engine.transaction(prepared!.apply)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await engine.readPageSnapshot(slug, { sourceId })).toEqual(winner);
  }
});

test('projection rebuilding preserves external-ID dedup unless force-rechunk was explicitly requested', async () => {
  for (const engine of engines) {
    const originalSlug = 'notes/external-original', destinationSlug = 'notes/unsealed-destination';
    const bytes = markdown('Canonical external record.', 'external-revival-example');
    await importFromContent(engine, originalSlug, bytes, { sourceId, noEmbed: true });
    await engine.putPage(destinationSlug, { type: 'note', title: 'Unrelated destination', compiled_truth: 'Preserve this body.' }, { sourceId });
    const original = await engine.readPageSnapshot(originalSlug, { sourceId });
    const destination = (await engine.readPageSnapshot(destinationSlug, { sourceId }))!;
    expect(destination.page.text_projection_revision).not.toBe(destination.revision);
    expect(await importFromContent(engine, destinationSlug, bytes, { sourceId, noEmbed: true })).toMatchObject({ status: 'skipped', slug: originalSlug });
    expect(await engine.readPageSnapshot(originalSlug, { sourceId })).toEqual(original);
    expect(await engine.readPageSnapshot(destinationSlug, { sourceId })).toEqual(destination);

    expect(await importFromContent(engine, destinationSlug, bytes, { sourceId, noEmbed: true, forceRechunk: true })).toMatchObject({ status: 'imported', slug: destinationSlug });
    expect((await engine.getPage(destinationSlug, { sourceId }))!.compiled_truth).toBe('Canonical external record.');
  }
});

test('unchanged code and image imports revive their original identities after soft deletion', async () => {
  const codePath = join(scratch, 'example.ts'), imagePath = join(scratch, 'example.png');
  writeFileSync(codePath, 'export function exampleValue() { return 42; }\n');
  writeFileSync(imagePath, Buffer.from('synthetic-image-bytes-for-keyless-revival'));
  for (const engine of engines) for (const kind of ['code', 'image'] as const) {
    const run = () => kind === 'code'
      ? importCodeFile(engine, codePath, 'code/example.ts', { sourceId, noEmbed: true })
      : importImageFile(engine, imagePath, 'images/example.png', { sourceId, noEmbed: true });
    const initial = await run(); expect(initial.status).toBe('imported');
    const page = (await engine.getPage(initial.slug, { sourceId }))!;
    await engine.softDeletePage(initial.slug, { sourceId });
    expect(await run()).toMatchObject({ status: 'imported', slug: initial.slug });
    const revived = (await engine.readPageSnapshot(initial.slug, { sourceId }))!;
    expect(revived.page.id).toBe(page.id);
    expect(revived.page.text_projection_revision).toBe(revived.revision);
    expect((await engine.getChunks(initial.slug, { sourceId })).length).toBeGreaterThan(0);
  }
});
