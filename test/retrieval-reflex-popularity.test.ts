import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractCandidatesFromWindow } from '../src/core/context/entity-salience.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { parseWindow, volunteerContext } from '../src/core/context/volunteer.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM page_aliases');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ('companies/acme-example', 'default', 'company', 'Acme Example', 'A software platform.', '')`,
  );
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     SELECT 'notes/referrer-' || n, 'default', 'note', 'Referrer ' || n, 'A reference.', ''
       FROM generate_series(1, 300) AS n`,
  );
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
     SELECT referrer.id, hub.id, 'references', 'markdown'
       FROM pages referrer CROSS JOIN pages hub
      WHERE referrer.slug LIKE 'notes/referrer-%'
        AND hub.slug = 'companies/acme-example' AND hub.source_id = 'default'`,
  );
});

describe('retrieval reflex popularity guard', () => {
  test('omits a popular exact-title hit introduced only by the assistant', async () => {
    const turns = parseWindow('assistant: Acme Example came up in the discussion.\nuser: Thanks.');
    const candidates = extractCandidatesFromWindow(turns);

    expect(await resolveEntitiesToPointers(engine, 'default', candidates)).toBeNull();
    expect(await volunteerContext(engine, turns, { sourceIds: ['default'] })).toEqual([]);
  });

  test('keeps a popular page explicitly named by the user', async () => {
    const turns = parseWindow('user: Please check Acme Example.');
    const pointers = await resolveEntitiesToPointers(
      engine,
      'default',
      extractCandidatesFromWindow(turns),
    );

    expect(pointers?.pointers.map((pointer) => pointer.slug)).toContain('companies/acme-example');
  });

  test('keeps an alias hit for a popular page introduced by the assistant', async () => {
    await engine.setPageAliases('companies/acme-example', 'default', [normalizeAlias('APX')]);
    const turns = parseWindow('assistant: APX came up in the discussion.\nuser: Thanks.');
    const pointers = await resolveEntitiesToPointers(
      engine,
      'default',
      extractCandidatesFromWindow(turns),
    );

    expect(pointers?.pointers[0]?.slug).toBe('companies/acme-example');
    expect(pointers?.pointers[0]?.arm).toBe('alias');
  });
});
