/**
 * extract_facts isolates each page's reconcile: one page whose fence rows the
 * database rejects must not abort reconciliation for every later page (the
 * "poison page"). Real PGLite, no provider calls.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;

const fence = (rows: string) => `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

async function putPage(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, { title: slug, type: 'person', compiled_truth: body, frontmatter: {}, timeline: '' });
}

async function fenceRowCount(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug=$1 AND source_id='default'`, [slug]);
  return rows[0].n;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('UPDATE facts SET superseded_by=NULL');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
});

describe('extract_facts poison-page isolation', () => {
  test('an out-of-range fence confidence is a parse warning, not a database error', () => {
    const parsed = parseFactsFence(fence('| 1 | Likes tea | fact | 7 | world | medium | 2026-01-01 |  | chat |  |'));
    expect(parsed.facts).toHaveLength(0);
    expect(parsed.warnings.some(w => w.includes('confidence "7"') && w.includes('0..1'))).toBe(true);
  });

  test('a page whose insert violates a constraint does not stop later pages from reconciling', async () => {
    await putPage('people/aaa-poison-example', fence('| 1 | Likes tea | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |'));
    await putPage('people/zzz-healthy-example', fence('| 1 | Prefers email | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |'));
    // Reject every insert for the poison page only, the way a CHECK or FK
    // violation would, without depending on which malformed input the parser
    // currently tolerates.
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION test_reject_poison() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.source_markdown_slug = 'people/aaa-poison-example' THEN RAISE EXCEPTION 'poison row rejected'; END IF;
        RETURN NEW;
      END $fn$`);
    await engine.executeRaw('CREATE TRIGGER test_reject_poison BEFORE INSERT ON facts FOR EACH ROW EXECUTE FUNCTION test_reject_poison()');
    try {
      const result = await runExtractFacts(engine, { slugs: ['people/aaa-poison-example', 'people/zzz-healthy-example'] });
      expect(await fenceRowCount('people/zzz-healthy-example')).toBe(1);
      expect(await fenceRowCount('people/aaa-poison-example')).toBe(0);
      expect(result.warnings.some(w => w.startsWith('people/aaa-poison-example: FACTS_RECONCILE_FAILED') && w.includes('poison row rejected'))).toBe(true);
      expect(result.pagesFailed).toBe(1);
    } finally {
      await engine.executeRaw('DROP TRIGGER IF EXISTS test_reject_poison ON facts');
    }
  });

  test('a DB-only row superseded by a fence row does not block that page from re-reconciling', async () => {
    const slug = 'people/alice-example';
    await putPage(slug, fence('| 1 | CEO of acme-example | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |'));
    await putPage('people/bob-example', fence('| 1 | Likes tea | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |'));
    await runExtractFacts(engine, { slugs: [slug] });
    const [fenceRow] = await engine.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE source_markdown_slug=$1`, [slug]);
    // A DB-only legacy row that a later remember superseded with the fence row.
    const [legacy] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts(source_id, entity_slug, fact, kind, visibility, source, expired_at, superseded_by)
       VALUES ('default', $1, 'COO of acme-example', 'fact', 'world', 'chat', now(), $2) RETURNING id`, [slug, fenceRow.id]);
    // Attribute drift forces the wipe-and-reinsert path for alice's page.
    await putPage(slug, fence('| 1 | CEO of acme-example | fact | 1.0 | world | high | 2026-01-01 |  | chat |  |'));

    const result = await runExtractFacts(engine, { slugs: [slug, 'people/bob-example'] });

    expect(result.warnings.filter(w => w.includes('FACTS_RECONCILE_FAILED'))).toEqual([]);
    expect(await fenceRowCount('people/bob-example')).toBe(1);
    const alice = await engine.executeRaw<{ notability: string }>(`SELECT notability FROM facts WHERE source_markdown_slug=$1`, [slug]);
    expect(alice.map(r => r.notability)).toEqual(['high']);
    const [kept] = await engine.executeRaw<{ expired: boolean }>(
      `SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id=$1`, [legacy.id]);
    expect(kept.expired).toBe(true);
  });
});
