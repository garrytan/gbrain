/**
 * A sync rename must preserve atom lineage, visibility and completed extraction.
 * Existing rename tests cover facts/links, not atoms or managed checkpoints.
 * Leaving source_slug behind or binding completion to a slug breaks this test.
 * Uses the real rename transaction and repair planners; no new production seam.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { staleAtomsRepair } from '../src/core/repair/stale-atoms.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { MANAGED_ATOM_DISCOVERY_SQL } from '../src/core/persistence/atom-maintenance.ts';
import { privatePagesFilterFragment } from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('sync renames retain atom provenance and completed extraction across repeated moves', async () => {
  const sourceId = 'rename-lineage';
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1),($2,$2)', [sourceId, 'other-lineage']);
  const origin = await engine.putPage('notes/topic', {
    type: 'note', title: 'Topic', compiled_truth: 'The original evidence.', frontmatter: { visibility: 'world' },
  }, { sourceId });
  for (const source of [sourceId, 'other-lineage']) {
    await engine.putPage('atoms/claim', { type: 'atom', title: 'Claim', compiled_truth: 'The original claim.',
      frontmatter: { source_slug: 'notes/topic', source_hash: origin.content_hash!.slice(0, 16),
        source_quote: 'The original evidence.', visibility: 'world', managed_extraction: true },
    }, { sourceId: source });
  }
  await engine.putPage('notes/reference', { type: 'note', title: 'Reference', compiled_truth: 'Unrelated metadata.',
    frontmatter: { source_slug: 'notes/topic' } }, { sourceId });
  const before = await engine.getPage('atoms/claim', { sourceId });
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [sourceId]);
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-atoms','rename-completed',$1::text::jsonb)`,
    [JSON.stringify([{ sourceId, incarnation, kind: 'page', locator: 'notes/topic', pageId: origin.id, contentHash: origin.content_hash }])]);
  const scope = { brain_id: 'test', source_ids: [sourceId] };
  const backlog = () => engine.executeRaw(`SELECT p.slug FROM pages p WHERE p.source_id=$1 AND p.id=$2 ${MANAGED_ATOM_DISCOVERY_SQL}`, [sourceId, origin.id]);
  expect(await backlog()).toEqual([]);

  // A failed surrounding publication must roll back the origin and its atoms.
  await expect(engine.transaction(async tx => {
    await tx.updateSlug('notes/topic', 'notes/aborted', { sourceId });
    throw new Error('abort publication');
  })).rejects.toThrow('abort publication');
  expect((await engine.getPage('atoms/claim', { sourceId }))?.frontmatter.source_slug).toBe('notes/topic');
  expect((await engine.getPage('notes/topic', { sourceId }))?.id).toBe(origin.id);

  for (const [oldSlug, newSlug] of [['notes/topic', 'generated/topic'], ['generated/topic', 'archive/topic']]) {
    expect(await renamePageOntoSlug(engine, { sourceId, oldSlug, newSlug, to: `${newSlug}.md` })).toBe('renamed');
    const after = await engine.getPage('atoms/claim', { sourceId });
    expect(after?.frontmatter).toEqual({ ...before!.frontmatter, source_slug: newSlug });
    expect(after?.id).toBe(before!.id);
    expect(after?.compiled_truth).toBe(before!.compiled_truth);
    expect((await engine.getPage(newSlug, { sourceId }))?.id).toBe(origin.id);
    expect((await staleAtomsRepair.plan(engine, scope, null)).items).toEqual([]);
    expect((await visibilityRepair.plan(engine, scope, null, { apply: false, driftClass: 'lineage' })).items).toEqual([]);
    expect(await backlog()).toEqual([]);
    expect(await engine.executeRaw(`SELECT p.slug FROM pages p WHERE p.source_id=$1 AND p.type='atom' AND ${privatePagesFilterFragment('p')}`, [sourceId]))
      .toEqual([{ slug: 'atoms/claim' }]);
  }
  expect((await engine.getPage('atoms/claim', { sourceId: 'other-lineage' }))?.frontmatter.source_slug).toBe('notes/topic');
  expect((await engine.getPage('notes/reference', { sourceId }))?.frontmatter.source_slug).toBe('notes/topic');

  // Identical content on a different page is not completed by this checkpoint.
  const twin = await engine.putPage('notes/twin', { type: 'note', title: 'Topic', compiled_truth: 'The original evidence.',
    frontmatter: { visibility: 'world' } }, { sourceId });
  expect(twin.content_hash).toBe(origin.content_hash);
  expect(await engine.executeRaw(`SELECT p.slug FROM pages p WHERE p.source_id=$1 AND p.id=$2 ${MANAGED_ATOM_DISCOVERY_SQL}`, [sourceId, twin.id]))
    .toEqual([{ slug: 'notes/twin' }]);

  // A genuine deletion must still hide the atom and propose retirement.
  await engine.softDeletePage('archive/topic', { sourceId });
  expect((await staleAtomsRepair.plan(engine, scope, null)).listing?.map(item => item.class)).toEqual(['origin_gone']);
  expect((await visibilityRepair.plan(engine, scope, null, { apply: false, driftClass: 'lineage' })).items.map(item => item.slug)).toEqual(['atoms/claim']);
});
