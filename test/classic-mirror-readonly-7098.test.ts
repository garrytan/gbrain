/** #7098: classic disk sinks must honor a source's read-only mirror, without losing DB-only facts. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { _resetWriteThroughCacheForTest, deletePageThrough, resolvePageWriteTarget, writePageThrough } from '../src/core/write-through.ts';
import { writeTimelineEntryThrough } from '../src/core/timeline-write-through.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { formatSaveOutcome, persistSavedIdea } from '../src/commands/brainstorm.ts';

for (const backend of testBackends()) describe(`classic mirror-readonly storage: ${backend}`, () => {
let engine: BrainEngine;
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let close: (() => Promise<void>) | undefined;
let root: string;
const slug = 'people/alice-example';
const content = '---\ntitle: Alice Example\ntype: person\n---\n\nAlice Example leads a team.\n';
const sourceId = 'mirror-example';
const file = () => join(root, 'Alice Example.md');
async function mode(readOnly: boolean) {
  await engine.executeRaw('UPDATE sources SET config=$1::text::jsonb WHERE id=$2', [JSON.stringify({ mirror_read_only: readOnly }), sourceId]);
}
async function fact(text: string) {
  return writeSingleFact(engine, sourceId, { entity: slug, fact: text, provenance: 'test:mirror', visibility: 'world', remote: false });
}

beforeAll(async () => {
  if (backend === 'postgres') {
    template = await persistencePostgresTemplate(requirePostgresTestDatabase());
    return;
  }
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  if (backend === 'postgres') await template.dispose();
  else await engine.disconnect();
});
beforeEach(async () => {
  if (backend === 'postgres') ({ engine, close } = await template.clone());
  else await resetPgliteState(engine as PGLiteEngine);
  _resetWriteThroughCacheForTest();
  root = mkdtempSync(join(tmpdir(), 'gbrain-classic-mirror-'));
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  writeFileSync(file(), content);
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId, sourcePath: 'Alice Example.md' });
}, 60_000);
afterEach(async () => {
  if (close) { await close(); close = undefined; }
  rmSync(root, { recursive: true, force: true });
}, 60_000);

describe('classic mirror-readonly (#7098)', () => {
  test('a source without local_path cannot bypass readonly through the global repository', async () => {
    await mode(true);
    await engine.executeRaw('UPDATE sources SET local_path=NULL WHERE id=$1', [sourceId]);
    await engine.setConfig('sync.repo_path', root);
    expect(await writePageThrough(engine, slug, { sourceId })).toMatchObject({ written: false, skipped: 'mirror_read_only' });
    expect(readFileSync(file(), 'utf8')).toBe(content);
  }, 60_000);

  test('brainstorm saves database-only and reports the deliberate mirror skip, not an error', async () => {
    await mode(true);
    const idea = 'notes/idea-example';
    const outcome = await persistSavedIdea(engine, { slug: idea, content: '# A database-only idea', sourceId, provenanceVia: 'test:mirror' });
    expect(outcome).toMatchObject({ dbSaved: true, writeThrough: { written: false, skipped: 'mirror_read_only' } });
    expect((await engine.getPage(idea, { sourceId }))?.compiled_truth).toContain('A database-only idea');
    const formatted = formatSaveOutcome(outcome, { profileLabel: 'brainstorm', slug: idea });
    expect(formatted.stdout).toContain('read-only mirror');
    expect(formatted.exitCode).toBe(0);
    expect(readdirSync(root)).toEqual(['Alice Example.md']);
  });

  test('resolves no writable target, including tombstone targets, before checking missing roots', async () => {
    await mode(true);
    expect(await resolvePageWriteTarget(engine, slug, sourceId)).toEqual({ ok: false, skipped: 'mirror_read_only' });
    expect(await resolvePageWriteTarget(engine, slug, sourceId, { includeDeleted: true })).toEqual({ ok: false, skipped: 'mirror_read_only' });
    rmSync(root, { recursive: true });
    expect(await resolvePageWriteTarget(engine, slug, sourceId)).toEqual({ ok: false, skipped: 'mirror_read_only' });
  });

  test('does not rewrite an existing file or create a missing page; writable siblings still progress', async () => {
    await mode(true);
    expect(await writePageThrough(engine, slug, { sourceId })).toMatchObject({ written: false, skipped: 'mirror_read_only' });
    await importFromContent(engine, 'notes/new-example', '# New database page', { sourceId, noEmbed: true });
    expect(await writePageThrough(engine, 'notes/new-example', { sourceId })).toMatchObject({ written: false, skipped: 'mirror_read_only' });
    expect(readFileSync(file(), 'utf8')).toBe(content);
    expect(readdirSync(root)).toEqual(['Alice Example.md']);
    const sibling = join(root, 'sibling');
    mkdirSync(sibling);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [sibling]);
    await importFromContent(engine, 'notes/sibling', '# Sibling', { noEmbed: true });
    expect(await writePageThrough(engine, 'notes/sibling')).toMatchObject({ written: true });
  });

  test('rechecks readonly even when deletion receives a previously writable target', async () => {
    const target = await resolvePageWriteTarget(engine, slug, sourceId);
    expect(target.ok).toBe(true);
    await mode(true);
    expect(await deletePageThrough(engine, slug, { sourceId, target })).toMatchObject({ removed: false, skipped: 'mirror_read_only' });
    expect(readFileSync(file(), 'utf8')).toBe(content);
  });

  test('facts stay recallable database-only and the mirror stays byte-identical', async () => {
    await mode(true);
    const written = await fact('Alice Example manages the platform team.');
    const rows = await engine.executeRaw<{ fact: string; row_num: number | null }>('SELECT fact,row_num FROM facts WHERE id=$1', [written.id]);
    expect(rows).toEqual([{ fact: 'Alice Example manages the platform team.', row_num: null }]);
    expect(readFileSync(file(), 'utf8')).toBe(content);
  }, 60_000);

  test('forget expires a pre-existing fenced fact without striking its mirror file', async () => {
    const written = await fact('Alice Example founded an example studio.');
    const before = readFileSync(file(), 'utf8');
    expect(before).toContain('Alice Example founded an example studio.');
    await mode(true);
    expect(await forgetFactInFence(engine, written.id)).toMatchObject({ ok: true });
    expect(readFileSync(file(), 'utf8')).toBe(before);
    const [row] = await engine.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id=$1', [written.id]);
    expect(row?.expired).toBe(true);
  }, 60_000);

  test('timeline skips the file and mode changes are visible without a cache reset', async () => {
    await mode(true);
    const entry = { date: '2026-10-20', summary: 'Joined the example project' };
    expect(await writeTimelineEntryThrough(engine, slug, sourceId, entry)).toMatchObject({ handled: false, skipped: 'mirror_read_only' });
    expect(readFileSync(file(), 'utf8')).toBe(content);
    await mode(false);
    expect(await writeTimelineEntryThrough(engine, slug, sourceId, entry)).toMatchObject({ handled: true });
    expect(readFileSync(file(), 'utf8')).toContain(entry.summary);
    await mode(true);
    expect(await writePageThrough(engine, slug, { sourceId })).toMatchObject({ written: false, skipped: 'mirror_read_only' });
  });
});
});
