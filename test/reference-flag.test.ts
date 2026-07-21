import { describe, expect, test } from 'bun:test';
import { referenceExclusionSql, REFERENCE_FRONTMATTER_KEY } from '../src/core/reference-flag.ts';
import { applyReferenceFrontmatter } from '../src/commands/reference.ts';

describe('referenceExclusionSql', () => {
  test('bare pages (no alias)', () => {
    expect(referenceExclusionSql()).toBe(`(frontmatter->>'reference') IS DISTINCT FROM 'true'`);
  });
  test('aliased', () => {
    expect(referenceExclusionSql('p')).toBe(`(p.frontmatter->>'reference') IS DISTINCT FROM 'true'`);
  });
  test('key constant', () => {
    expect(REFERENCE_FRONTMATTER_KEY).toBe('reference');
  });
});

describe('applyReferenceFrontmatter', () => {
  const page = `---\ntitle: Andy Grove\ntype: person\ntags: []\n---\n\n# Andy Grove\n\nBody.`;

  test('adds reference: true to an existing frontmatter block', () => {
    const out = applyReferenceFrontmatter(page, true);
    expect(out).toContain('reference: true');
    expect(out).toContain('type: person');   // other keys preserved
    expect(out).toContain('# Andy Grove');    // body preserved
  });

  test('is idempotent — does not duplicate the key', () => {
    const once = applyReferenceFrontmatter(page, true);
    const twice = applyReferenceFrontmatter(once, true);
    expect(twice).toBe(once);
    expect(twice.match(/reference: true/g)).toHaveLength(1);
  });

  test('replaces a stale reference: false with true', () => {
    const off = `---\ntype: person\nreference: false\n---\n\nBody.`;
    const out = applyReferenceFrontmatter(off, true);
    expect(out).toContain('reference: true');
    expect(out).not.toContain('reference: false');
  });

  test('--unset removes the key', () => {
    const on = applyReferenceFrontmatter(page, true);
    const off = applyReferenceFrontmatter(on, false);
    expect(off).not.toContain('reference:');
    expect(off).toContain('type: person');
  });

  test('--unset on a page without the key is a no-op', () => {
    expect(applyReferenceFrontmatter(page, false)).toBe(page);
  });

  test('setting on a frontmatter-less page prepends a block', () => {
    const raw = '# Just a heading\n\nNo frontmatter here.';
    const out = applyReferenceFrontmatter(raw, true);
    expect(out.startsWith('---\nreference: true\n---\n')).toBe(true);
    expect(out).toContain('# Just a heading');
  });

  test('preserves body containing YAML-special chars', () => {
    const tricky = `---\ntype: person\n---\n\nText with $& and $1 literals.`;
    const out = applyReferenceFrontmatter(tricky, true);
    expect(out).toContain('Text with $& and $1 literals.');
    expect(out).toContain('reference: true');
  });
});

// ── e2e: getHealth exemption + (source_id, slug)-scoped JSONB write ─────────

import { afterAll, beforeAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runReference } from '../src/commands/reference.ts';

describe('reference flag e2e (PGLite)', () => {
  let engine: PGLiteEngine;
  let brainDir: string;
  const savedEnv = process.env.GBRAIN_SOURCE;

  beforeAll(async () => {
    delete process.env.GBRAIN_SOURCE;
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();

    brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-ref-'));
    fs.mkdirSync(path.join(brainDir, 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(brainDir, 'people/andy-grove.md'),
      '---\ntitle: Andy Grove\ntype: person\n---\n\n# Andy Grove\n',
      'utf8',
    );

    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, created_at)
       VALUES ('src-a', 'a', $1, '{}'::jsonb, now()), ('src-b', 'b', NULL, '{}'::jsonb, now())`,
      [brainDir],
    );
    // Same slug in BOTH sources — the write must only touch src-a.
    await engine.putPage('people/andy-grove', {
      type: 'person', title: 'Andy Grove', compiled_truth: 'canon figure',
    }, { sourceId: 'src-a' });
    await engine.putPage('people/andy-grove', {
      type: 'person', title: 'Andy Grove', compiled_truth: 'other-source twin',
    }, { sourceId: 'src-b' });
    // A normal contact WITH a timeline entry, so coverage has a live numerator.
    const contact = await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'real contact',
    }, { sourceId: 'src-a' });
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, summary) VALUES ($1, '2026-01-01', 'met')`,
      [contact.id],
    );
  });

  afterAll(async () => {
    if (savedEnv !== undefined) process.env.GBRAIN_SOURCE = savedEnv;
    await engine.disconnect();
    fs.rmSync(brainDir, { recursive: true, force: true });
  });

  test('runReference scopes the JSONB write to the resolved (source_id, slug)', async () => {
    await runReference(engine, ['people/andy-grove', '--brain', brainDir]);

    const rows = await engine.executeRaw<{ source_id: string; ref: string | null }>(
      `SELECT source_id, frontmatter->>'reference' AS ref FROM pages WHERE slug = 'people/andy-grove' ORDER BY source_id`,
    );
    expect(rows).toEqual([
      { source_id: 'src-a', ref: 'true' },
      { source_id: 'src-b', ref: null },   // twin in the other source untouched
    ]);
    // Durable half: frontmatter on disk got the flag too.
    expect(fs.readFileSync(path.join(brainDir, 'people/andy-grove.md'), 'utf8'))
      .toContain('reference: true');
  });

  test('getHealth exempts reference pages from timeline/link coverage', async () => {
    const health = await engine.getHealth();
    // 3 person pages; the 2 reference-less twins would drag coverage to 1/3.
    // With the src-a twin marked reference, denominator = 2 (alice + src-b twin).
    expect(health.timeline_coverage).toBeCloseTo(0.5);
  });

  test('unset restores the page to a normal counted entity', async () => {
    await runReference(engine, ['people/andy-grove', '--unset', '--brain', brainDir]);
    const rows = await engine.executeRaw<{ ref: string | null }>(
      `SELECT frontmatter->>'reference' AS ref FROM pages WHERE slug = 'people/andy-grove' AND source_id = 'src-a'`,
    );
    expect(rows[0].ref).toBeNull();
    const health = await engine.getHealth();
    expect(health.timeline_coverage).toBeCloseTo(1 / 3);
  });
});
