/**
 * #4108 — fallback-resolved entity refs must not materialize canonical stub
 * pages.
 *
 * End-to-end zero-LLM matrix through writeSingleFact (the pipeline's
 * post-extraction stages: resolve → dedup → fence-first write) against a real
 * PGLiteEngine with sources.local_path set, so the fence path is reachable:
 *
 *   1. nonexistent PREFIXED entity  → fallback_slugify → DB-only, no stub page
 *   2. nonexistent BARE entity      → fallback_slugify → DB-only, no root stub
 *   3. existing page, exact slug    → exact_page       → fence written
 *   4. existing page, fuzzy title   → fuzzy_match      → fence written
 *   5. existing page, curated alias → alias_exact      → fence written
 *
 * Cases 1-2 pin the issue's expected behavior: the fact is RETAINED
 * (entity_slug intact, legacy DB insert) but never mints a canonical page for
 * a slug the resolver invented. Cases 3-5 pin that every provenance that
 * verified a live page still fences.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Live pages for the resolvable arms of the matrix (no on-disk files —
  // the fence write stub-creates them, exercising DB→file drift repair).
  await engine.putPage('companies/acme-example', {
    type: 'company',
    title: 'Acme Example',
    compiled_truth: '# Acme Example',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('people/felicia-example', {
    type: 'person',
    title: 'Felicia Example',
    compiled_truth: '# Felicia Example',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.putPage('people/star-example', {
    type: 'person',
    title: 'Star Example',
    compiled_truth: '# Star Example',
    frontmatter: {},
  }, { sourceId: 'default' });
  await engine.setPageAliases('people/star-example', 'default', ['starshine']);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Fresh tree per test so file-existence assertions are hermetic.
  brainDir = mkdtempSync(join(tmpdir(), 'facts-fallback-stub-guard-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

afterAll(() => {
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

async function factRow(id: number): Promise<{ entity_slug: string | null; source_markdown_slug: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await (engine as any).db.query(
    'SELECT entity_slug, source_markdown_slug FROM facts WHERE id = $1',
    [id],
  );
  return rows.rows[0];
}

describe('writeSingleFact × resolution provenance (#4108 matrix)', () => {
  test('1. nonexistent prefixed entity: fact retained DB-only, no canonical stub page', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Ships invisible widgets',
      provenance: 'test:matrix',
      entity: 'companies/zeta-widgets-nonexistent',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('companies/zeta-widgets-nonexistent');

    // The pre-#4108 bug: this exact write minted
    // companies/zeta-widgets-nonexistent.md as a canonical stub page that a
    // later sync imported, turning the invented slug into an exact_page hit.
    expect(existsSync(join(brainDir, 'companies/zeta-widgets-nonexistent.md'))).toBe(false);

    const row = await factRow(r.id);
    expect(row.entity_slug).toBe('companies/zeta-widgets-nonexistent');
    // DB-only insert — no fence file backs the row.
    expect(row.source_markdown_slug).toBeNull();
  });

  test('2. nonexistent bare entity: fact retained DB-only, no root stub', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Mentioned once in passing',
      provenance: 'test:matrix',
      entity: 'zetaperson',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('zetaperson');
    expect(existsSync(join(brainDir, 'zetaperson.md'))).toBe(false);

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBeNull();
  });

  test('3. exact existing page: fence written', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Raised a seed round in 2017',
      provenance: 'test:matrix',
      entity: 'companies/acme-example',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('companies/acme-example');

    const filePath = join(brainDir, 'companies/acme-example.md');
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('## Facts');
    expect(body).toContain('Raised a seed round in 2017');

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBe('companies/acme-example');
  });

  test('4. fuzzy-resolvable display name: fence written onto the existing page', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Joined the platform team',
      provenance: 'test:matrix',
      entity: 'Felicia Example',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('people/felicia-example');

    const filePath = join(brainDir, 'people/felicia-example.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Joined the platform team');

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBe('people/felicia-example');
  });

  test('5. curated alias: alias_exact provenance fences (not blocked by the fallback guard)', async () => {
    const r = await writeSingleFact(engine, 'default', {
      fact: 'Prefers the starshine handle',
      provenance: 'test:matrix',
      entity: 'starshine',
    });

    expect(r.status).toBe('inserted');
    expect(r.entity_slug).toBe('people/star-example');

    const filePath = join(brainDir, 'people/star-example.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Prefers the starshine handle');

    const row = await factRow(r.id);
    expect(row.source_markdown_slug).toBe('people/star-example');
  });
});
