/**
 * Wanted pages on PGLite: unresolved authored links are recorded, heal into
 * edges when their target appears, stay private, and never loop the stale
 * sweep. Postgres arm: test/e2e/wanted-links-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { collectWantedLinks } from '../src/core/wanted-links.ts';
import type { LinkCandidate } from '../src/core/link-extraction.ts';
import { bareNameReferenceSettles, disabledClearsRows, forwardReferenceHeals, onlyUnresolvedAuthoredReferences,
  privateOriginsStayPrivate, restoredTargetHeals } from './helpers/wanted-links-scenarios.ts';

test('a link written before its target exists becomes an edge after the target is created', () => forwardReferenceHeals(), 120_000);
test('resolved references, prose paths and code spans are never wanted', () => onlyUnresolvedAuthoredReferences(), 120_000);
test('a bare-name reference matched only by basename settles after one re-extraction', () => bareNameReferenceSettles(), 120_000);
test('remote callers never see targets or counts from private origins', () => privateOriginsStayPrivate(), 120_000);
test('restoring a deleted target heals links written while it was deleted', () => restoredTargetHeals(), 120_000);
test('wanted_pages.enabled=false clears an origin\'s rows on its next extraction', () => disabledClearsRows(), 120_000);

describe('collectWantedLinks', () => {
  const candidate = (targetSlug: string, key: string, extra: Partial<LinkCandidate> = {}): LinkCandidate => ({
    targetSlug, linkType: 'mentions', context: `ctx ${targetSlug}`, linkSource: 'markdown',
    authoredRef: { key, kind: 'slug', target: targetSlug }, ...extra });
  const run = (candidates: LinkCandidate[], outcome: Record<string, string>, crossSourceAllowed = false) =>
    collectWantedLinks({ candidates, originSourceId: 'src-a', crossSourceAllowed,
      resolve: c => outcome[c.targetSlug] === 'ok' ? { ok: true } : { ok: false, reason: outcome[c.targetSlug] ?? 'missing_target' } });

  test('a reference is wanted only when every alternative fails', () => {
    const bare = { key: 'ref:1', kind: 'name' as const, target: 'acme' };
    expect(run([candidate('acme', 'ref:1', { authoredRef: bare }), candidate('companies/acme', 'ref:1', { authoredRef: bare })],
      { acme: 'missing_target', 'companies/acme': 'ok' })).toEqual([]);
    expect(run([candidate('acme', 'ref:1', { authoredRef: bare })], {})).toEqual([{ producer: 'body', ref_kind: 'name',
      target_source_id: 'src-a', target_ref: 'acme', link_type: 'mentions', context: 'ctx acme' }]);
  });

  test('an unqualified target that exists only in another source is wanted in the origin source', () => {
    expect(run([candidate('people/x', 'ref:1')], { 'people/x': 'cross_source' })).toMatchObject([{ target_source_id: 'src-a', target_ref: 'people/x' }]);
  });

  test('a qualified reference into a forbidden source is never wanted; an allowed one keeps its source', () => {
    const qualified = candidate('people/x', 'ref:1', { targetSourceId: 'src-b',
      authoredRef: { key: 'ref:1', kind: 'slug', target: 'people/x', targetSourceId: 'src-b' } });
    expect(run([qualified], {})).toEqual([]);
    expect(run([qualified], {}, true)).toMatchObject([{ target_source_id: 'src-b', target_ref: 'people/x' }]);
  });

  test('candidates without an authored reference (prose paths) and non-missing failures are ignored', () => {
    expect(run([{ targetSlug: 'and/or', linkType: 'mentions', context: '', linkSource: 'markdown' }], {})).toEqual([]);
    expect(run([candidate('people/x', 'ref:1')], { 'people/x': 'missing_from' })).toEqual([]);
  });

  test('unresolved frontmatter names become name refs; qualified slugs keep their source', () => {
    expect(collectWantedLinks({ candidates: [], originSourceId: 'src-a', crossSourceAllowed: false, resolve: () => ({ ok: true }),
      frontmatterUnresolved: [{ field: 'company', name: 'Acme Example' }, { field: 'key_people', name: '[[people/bob-example]]' },
        { field: 'investors', name: 'src-b:companies/fund-a' }, { field: 'company', name: 'Typed', reason: 'target_type_mismatch' }] }))
      .toEqual([
        { producer: 'frontmatter', ref_kind: 'name', target_source_id: 'src-a', target_ref: 'acme-example', link_type: '', context: 'company: Acme Example' },
        { producer: 'frontmatter', ref_kind: 'slug', target_source_id: 'src-a', target_ref: 'people/bob-example', link_type: '', context: 'key_people: [[people/bob-example]]' },
      ]);
  });
});

describe('unmanaged brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test('the unmanaged stale sweep records and heals wanted links too', async () => {
    const sweep = () => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
    await engine.putPage('notes/lunch', { type: 'note', title: 'Lunch', compiled_truth: 'Lunch with [[people/carol-example]].', timeline: '' });
    await sweep();
    expect(await engine.executeRaw('SELECT target_ref FROM wanted_links')).toEqual([{ target_ref: 'people/carol-example' }]);
    await engine.putPage('people/carol-example', { type: 'person', title: 'Carol', compiled_truth: 'Carol.', timeline: '' });
    await sweep();
    expect(await engine.executeRaw(`SELECT f.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
      WHERE t.slug='people/carol-example'`)).toEqual([{ slug: 'notes/lunch' }]);
    expect(await engine.executeRaw('SELECT target_ref FROM wanted_links')).toEqual([]);
  }, 120_000);
});
