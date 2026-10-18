/**
 * #6398 (fix wave 13 P1.17, Tier A): a fact fence write on an unmanaged brain
 * treated "no file" as "no page", stub-created the file and the #4872 mirror
 * copied the stub over the DB body and timeline.
 * Protects: a DB-only page (no file; a recorded source_path whose file was
 * deleted; a tombstoned row) takes the stub-guard DB-only route (reason
 * `db_only_page`): body, timeline, tags and frontmatter stay byte-identical, no
 * file is created, the fact lands DB-only with its entity_slug. An absent page
 * still gets a stub; the read is source-scoped (another source's row doesn't
 * count); an unreadable row returns fenceWriteFailed and writes nothing.
 * Seams: an engine proxy whose includeDeleted page read throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { writeFactsToFence, type FenceInputFact } from '../src/core/facts/fence-write.ts';
import { readRecentStubGuardEvents } from '../src/core/facts/stub-guard-audit.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let brainDir: string;
let auditDir: string;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ('other','other') ON CONFLICT DO NOTHING`);
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'fence-db-only-'));
  auditDir = mkdtempSync(join(tmpdir(), 'fence-db-only-audit-'));
  _resetWriteThroughCacheForTest();
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id IN ('default','other')`, [brainDir]);
});

const fact = (overrides: Partial<FenceInputFact> = {}): FenceInputFact => ({ fact: 'Joined Acme-example in 2020', kind: 'fact', notability: 'high',
  source: 'test', visibility: 'world', confidence: 1, validFrom: new Date(Date.UTC(2020, 0, 1)), embedding: null, sessionId: null, ...overrides });

async function dbOnlyPage(slug: string, sourceId = 'default') {
  await engine.putPage(slug, { type: 'person', title: 'Example Person', compiled_truth: 'A long, hand-written body about the person.\n\nSecond paragraph.',
    timeline: '- **2020-01-01** | Joined Acme-example', frontmatter: { role: 'engineer' }, tags: ['team'] }, { sourceId });
  await engine.addTimelineEntry(slug, { date: '2021-05-01', summary: 'Promoted' }, { sourceId });
}
async function shape(slug: string, sourceId = 'default') {
  const p = await engine.getPage(slug, { sourceId, includeDeleted: true });
  return { compiled_truth: p?.compiled_truth, timeline: p?.timeline, frontmatter: p?.frontmatter, deleted: !!p?.deleted_at,
    tags: await engine.getTags(slug, { sourceId }), entries: (await engine.getTimeline(slug, { sourceId })).map(e => e.summary) };
}
const factRows = async () => engine.executeRaw<{ entity_slug: string | null; source_markdown_slug: string | null }>('SELECT entity_slug, source_markdown_slug FROM facts');
const reasons = () => readRecentStubGuardEvents({ sinceMs: 60_000 }).map(e => `${e.slug}:${e.reason}`);

describe('#6398 fence write on a DB-only page', () => {
  test('exact_page through writeSingleFact: page byte-identical, no file, fact DB-only with entity_slug', () => withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
    await dbOnlyPage('people/example-person');
    const before = await shape('people/example-person');
    const r = await writeSingleFact(engine, 'default', { fact: 'Joined Acme-example in 2020', provenance: 'test', entity: 'people/example-person', visibility: 'world' });
    expect(r.status).toBe('inserted');
    expect(await shape('people/example-person')).toEqual(before);
    expect(existsSync(join(brainDir, 'people/example-person.md'))).toBe(false);
    expect(await factRows()).toEqual([{ entity_slug: 'people/example-person', source_markdown_slug: null }]);
    expect(reasons()).toEqual(['people/example-person:db_only_page']);
  }));

  test('alias_exact provenance takes the same route', () => withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
    await dbOnlyPage('people/example-person');
    const before = await shape('people/example-person');
    const r = await writeFactsToFence(engine, { sourceId: 'default', localPath: brainDir, slug: 'people/example-person', resolutionSource: 'alias_exact' }, [fact()]);
    expect(r).toMatchObject({ inserted: 0, stubGuardBlocked: true });
    expect(await shape('people/example-person')).toEqual(before);
    expect(existsSync(join(brainDir, 'people/example-person.md'))).toBe(false);
  }));

  test('a recorded source_path whose file was deleted: DB-only, body untouched', () => withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
    await dbOnlyPage('people/example-person');
    await engine.executeRaw(`UPDATE pages SET source_path = 'People/Example Person.md' WHERE slug = 'people/example-person'`);
    const before = await shape('people/example-person');
    const r = await writeFactsToFence(engine, { sourceId: 'default', localPath: brainDir, slug: 'people/example-person', resolutionSource: 'exact_page' }, [fact()]);
    expect(r).toMatchObject({ inserted: 0, stubGuardBlocked: true });
    expect(await shape('people/example-person')).toEqual(before);
    expect(existsSync(join(brainDir, 'People/Example Person.md'))).toBe(false);
  }));

  test('a tombstoned row: DB-only, no stub resurrects the page', () => withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
    await dbOnlyPage('people/example-person');
    await engine.softDeletePage('people/example-person', { sourceId: 'default' });
    const r = await writeFactsToFence(engine, { sourceId: 'default', localPath: brainDir, slug: 'people/example-person', resolutionSource: 'exact_page' }, [fact()]);
    expect(r).toMatchObject({ inserted: 0, stubGuardBlocked: true });
    expect((await shape('people/example-person')).deleted).toBe(true);
    expect(existsSync(join(brainDir, 'people/example-person.md'))).toBe(false);
  }));

  test('an absent page still gets a stub; another source\'s row with the same slug does not count', () => withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
    await dbOnlyPage('people/example-person', 'other');
    const before = await shape('people/example-person', 'other');
    const r = await writeFactsToFence(engine, { sourceId: 'default', localPath: brainDir, slug: 'people/example-person', resolutionSource: 'exact_page' }, [fact()]);
    expect(r.inserted).toBe(1);
    expect(readFileSync(join(brainDir, 'people/example-person.md'), 'utf8')).toContain('Joined Acme-example in 2020');
    expect(await shape('people/example-person', 'other')).toEqual(before);
    expect(reasons()).toEqual([]);
  }));

  test('an unreadable row: fenceWriteFailed, nothing written', () => withEnv({ GBRAIN_AUDIT_DIR: auditDir }, async () => {
    const failing = new Proxy(engine, { get(t, k, rcv) {
      if (k === 'getPage') return (slug: string, opts?: { includeDeleted?: boolean }) => opts?.includeDeleted ? Promise.reject(new Error('connection reset')) : t.getPage(slug, opts as never);
      const v = Reflect.get(t, k, rcv); return typeof v === 'function' ? v.bind(t) : v;
    } }) as unknown as BrainEngine;
    const r = await writeFactsToFence(failing, { sourceId: 'default', localPath: brainDir, slug: 'people/example-person', resolutionSource: 'exact_page' }, [fact()]);
    expect(r).toMatchObject({ inserted: 0, fenceWriteFailed: true });
    expect(existsSync(join(brainDir, 'people/example-person.md'))).toBe(false);
    expect(await factRows()).toEqual([]);
  }));
});
