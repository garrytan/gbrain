/**
 * #10586: get_versions on an old slug that only a merge/rename alias names returns the surviving page's history,
 * as get_page resolves that slug. Fails when the get_versions op matches pages.slug alone. A page holding the slug itself wins.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const versions = (slug: string) => operationsByName.get_versions!.handler(
  { engine, config: { engine: 'pglite' } as never, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as OperationContext,
  { slug }) as Promise<Array<{ id: number }>>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/current-note', { type: 'note', title: 'Current', compiled_truth: 'Body one.' });
  await engine.createVersion('notes/current-note');
  await engine.executeRaw(
    "INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ('default', 'notes/old-note', 'notes/current-note')");
});

afterAll(async () => { await engine.disconnect(); });

describe('getVersions through an alias slug', () => {
  test('old slug lists the surviving page history', async () => {
    const direct = await versions('notes/current-note');
    const viaAlias = await versions('notes/old-note');
    expect(direct.length).toBe(1);
    expect(viaAlias.map(v => v.id)).toEqual(direct.map(v => v.id));
  });

  test('a page that holds the slug itself keeps its own history', async () => {
    await engine.putPage('notes/old-note', { type: 'note', title: 'Own', compiled_truth: 'Own body.' });
    expect(await versions('notes/old-note')).toEqual([]);
  });
});
