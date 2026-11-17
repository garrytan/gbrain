/**
 * Filing modes (core/filing/modes.ts, foresights filing): where a NEW page goes.
 *
 * - routeNewPage per mode: generic by type folder, para by project/area/archive,
 *   lyt maps vs notes, zettelkasten by a fixed time id.
 * - the mode is stored per source in sources.config.filing_mode; other config keys survive.
 * - routeForSource uses the schema pack's folder for the type and never suggests a taken slug.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { routeNewPage, titleSlug, zettelId, isFilingMode, FILING_MODES } from '../src/core/filing/modes.ts';
import { getFilingMode, routeForSource, setFilingMode } from '../src/commands/filing.ts';

const NOW = new Date('2026-11-17T09:05:00Z');

describe('routeNewPage', () => {
  test('generic files by the type folder, falling back to the plural of the type', () => {
    expect(routeNewPage('generic', { type: 'person', title: 'Alice Example', typeFolder: 'people/' }).slug).toBe('people/alice-example');
    expect(routeNewPage('generic', { type: 'concept', title: 'Flywheel effect' }).slug).toBe('concepts/flywheel-effect');
  });

  test('para: archived beats project beats area beats resource, with frontmatter to match', () => {
    const base = { type: 'note', title: 'Launch checklist', typeFolder: 'notes' };
    const project = routeNewPage('para', { ...base, project: 'Q1 Launch', area: 'Ops' });
    expect(project.slug).toBe('projects/q1-launch/launch-checklist');
    expect(project.frontmatter).toEqual({ para: 'project', project: 'Q1 Launch' });
    expect(routeNewPage('para', { ...base, area: 'Ops' }).slug).toBe('areas/ops/launch-checklist');
    expect(routeNewPage('para', base).slug).toBe('resources/notes/launch-checklist');
    expect(routeNewPage('para', { ...base, project: 'Q1 Launch', archived: true }).slug).toBe('archives/projects/q1-launch/launch-checklist');
    expect(routeNewPage('para', { ...base, archived: true }).frontmatter).toEqual({ para: 'archive' });
  });

  test('lyt puts maps of content in maps/ and everything else in notes/', () => {
    expect(routeNewPage('lyt', { type: 'MOC', title: 'Pricing' }).slug).toBe('maps/pricing');
    expect(routeNewPage('lyt', { type: 'concept', title: 'Anchoring' })).toMatchObject({ slug: 'notes/anchoring', frontmatter: { methodology_role: 'atomic' } });
  });

  test('zettelkasten names the note by a UTC minute id that sorts by time', () => {
    const z = routeNewPage('zettelkasten', { type: 'note', title: 'Spaced repetition', now: NOW });
    expect(z.slug).toBe('zettel/202611170905-spaced-repetition');
    expect(z.frontmatter.zettel_id).toBe('202611170905');
    expect(zettelId(new Date('2026-01-02T03:04:59Z'))).toBe('202601020304');
  });

  test('titles become safe slugs; an empty title is untitled', () => {
    expect(titleSlug('../../etc/passwd')).not.toContain('/');
    expect(titleSlug('!!!')).toBe('untitled');
    expect(titleSlug('a'.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  test('only the four modes are valid', () => {
    expect(FILING_MODES).toEqual(['generic', 'para', 'lyt', 'zettelkasten']);
    expect(isFilingMode('para')).toBe(true);
    expect(isFilingMode('PARA')).toBe(false);
    expect(isFilingMode(undefined)).toBe(false);
  });
});

describe('per-source mode on a brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('notes', 'notes', '{"keep": 1}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  });
  afterAll(async () => { await engine.disconnect(); });

  test('absent means generic; set stores it per source and keeps other config keys', async () => {
    expect(await getFilingMode(engine, 'notes')).toBe('generic');
    expect(await getFilingMode(engine, 'no-such-source')).toBeNull();
    expect(await setFilingMode(engine, 'notes', 'zettelkasten')).toBe(true);
    expect(await getFilingMode(engine, 'notes')).toBe('zettelkasten');
    expect(await getFilingMode(engine, 'default')).toBe('generic');
    const [row] = await engine.executeRaw<{ keep: string | null; mode: string | null }>(
      `SELECT config->>'keep' AS keep, config->>'filing_mode' AS mode FROM sources WHERE id = 'notes'`);
    expect(row).toEqual({ keep: '1', mode: 'zettelkasten' });
    expect(await setFilingMode(engine, 'no-such-source', 'para')).toBe(false);
  });

  test('generic uses the schema pack folder for the type', async () => {
    const s = await routeForSource(engine, 'default', 'generic', { type: 'person', title: 'Alice Example' });
    expect(s.slug).toBe('people/alice-example');
  });

  test('a taken slug gets -2, then -3; a page in another source does not count', async () => {
    const put = (slug: string, source: string) => engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth) VALUES ($1, $2, 'note', 't', 'b')`, [source, slug]);
    await put('notes/anchoring', 'default');
    await put('notes/anchoring-2', 'default');
    await put('notes/pricing', 'notes');
    expect((await routeForSource(engine, 'default', 'lyt', { type: 'note', title: 'Anchoring' })).slug).toBe('notes/anchoring-3');
    expect((await routeForSource(engine, 'default', 'lyt', { type: 'note', title: 'Pricing' })).slug).toBe('notes/pricing');
  });
});
