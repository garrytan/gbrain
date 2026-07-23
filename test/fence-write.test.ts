/**
 * v0.32.2 — fence-write module tests.
 *
 * Exercises the markdown-first write path: page lock + stub-create +
 * atomic .tmp + parse-validate + engine.insertFacts batch + the
 * legacy fallback for missing local_path. Real PGLite + a real
 * filesystem under a per-test tempdir.
 *
 * The page-lock contention test (multi-process integration via
 * Bun.spawn) lives in test/e2e/facts-lock-contention.test.ts (commit
 * 10's invariant E2E capstone, since spawning child processes is an
 * E2E concern). These unit/integration cases cover the in-process
 * happy + recovery paths.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence, lookupSourceLocalPath } from '../src/core/facts/fence-write.ts';
import type { FenceInputFact } from '../src/core/facts/fence-write.ts';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Fresh tempdir per test so the fence-write FS state is hermetic.
  brainDir = mkdtempSync(join(tmpdir(), 'fence-write-test-'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query('DELETE FROM facts');
  // Default source pointed at the fresh brainDir.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (engine as any).db.query(
    `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
    [brainDir],
  );
});

const baseInput = (overrides: Partial<FenceInputFact> = {}): FenceInputFact => ({
  fact: 'Founded Acme in 2017',
  kind: 'fact',
  notability: 'high',
  source: 'mcp:put_page',
  visibility: 'world',
  confidence: 1.0,
  validFrom: new Date(Date.UTC(2017, 0, 1)),
  embedding: null,
  sessionId: null,
  ...overrides,
});

describe('writeFactsToFence — happy path', () => {
  test('stub-creates entity page when none exists, writes fence, stamps DB', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/alice' },
      [baseInput()],
    );

    expect(result.inserted).toBe(1);
    expect(result.ids).toHaveLength(1);
    expect(result.legacyFallback).toBeUndefined();
    expect(result.fenceWriteFailed).toBeUndefined();

    // Page was stub-created with min frontmatter.
    const filePath = join(brainDir, 'people/alice.md');
    expect(existsSync(filePath)).toBe(true);
    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('type: person');
    expect(body).toContain('slug: people/alice');
    expect(body).toContain('## Facts');
    expect(body).toContain('Founded Acme in 2017');

    // DB row has v51 columns populated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbRows = await (engine as any).db.query(
      'SELECT row_num, source_markdown_slug, fact FROM facts WHERE id = $1',
      [result.ids[0]],
    );
    expect(dbRows.rows[0]).toMatchObject({
      row_num: 1,
      source_markdown_slug: 'people/alice',
      fact: 'Founded Acme in 2017',
    });
  });

  test('appends to existing entity page without overwriting body', async () => {
    // Pre-create the entity page with custom content.
    const filePath = join(brainDir, 'people/bob.md');
    mkdirSync(join(brainDir, 'people'), { recursive: true });
    writeFileSync(
      filePath,
      '---\ntype: person\ntitle: Bob\nslug: people/bob\n---\n\n# Bob\n\nMet at YC W22.\n',
      'utf-8',
    );

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/bob' },
      [baseInput({ fact: 'Founded Widgets Inc.' })],
    );

    expect(result.inserted).toBe(1);

    const body = readFileSync(filePath, 'utf-8');
    expect(body).toContain('Met at YC W22.'); // preserved
    expect(body).toContain('# Bob');            // preserved
    expect(body).toContain('## Facts');         // added
    expect(body).toContain('Founded Widgets Inc.');
  });

  test('multi-fact batch appends consecutive row_nums', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/carol' },
      [
        baseInput({ fact: 'Claim 1' }),
        baseInput({ fact: 'Claim 2' }),
        baseInput({ fact: 'Claim 3' }),
      ],
    );

    expect(result.inserted).toBe(3);
    expect(result.ids).toHaveLength(3);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT row_num, fact FROM facts WHERE source_markdown_slug = 'people/carol' ORDER BY row_num`,
    );
    expect(rows.rows.map((r: { row_num: number; fact: string }) => r.row_num)).toEqual([1, 2, 3]);
    expect(rows.rows.map((r: { fact: string }) => r.fact)).toEqual(['Claim 1', 'Claim 2', 'Claim 3']);
  });

  test('appending to a page that already has a facts fence continues row_num sequence', async () => {
    // First write seeds the fence with rows 1 and 2.
    await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/dan' },
      [baseInput({ fact: 'First' }), baseInput({ fact: 'Second' })],
    );

    // Second write should pick up at row_num=3.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/dan' },
      [baseInput({ fact: 'Third' })],
    );

    expect(result.inserted).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT row_num, fact FROM facts WHERE source_markdown_slug = 'people/dan' ORDER BY row_num`,
    );
    expect(rows.rows[2]).toMatchObject({ row_num: 3, fact: 'Third' });
  });

  test('stub-creates nested directories (companies/x → mkdir companies)', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'companies/acme' },
      [baseInput({ fact: 'Founded 2017' })],
    );

    expect(result.inserted).toBe(1);
    expect(existsSync(join(brainDir, 'companies/acme.md'))).toBe(true);
    const body = readFileSync(join(brainDir, 'companies/acme.md'), 'utf-8');
    expect(body).toContain('type: company');  // type inferred from slug prefix
  });
});

describe('writeFactsToFence — legacy fallback', () => {
  test('null localPath returns legacyFallback:true with no inserts', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: null, slug: 'people/whoever' },
      [baseInput()],
    );

    expect(result).toEqual({ inserted: 0, ids: [], legacyFallback: true });

    // No DB inserts happened either.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query('SELECT COUNT(*) AS n FROM facts');
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test('empty facts array returns inserted:0 without touching FS', async () => {
    const slug = 'people/should-not-exist';
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug },
      [],
    );
    expect(result).toEqual({ inserted: 0, ids: [] });
    // The page file should NOT have been stub-created since there was
    // nothing to write.
    expect(existsSync(join(brainDir, `${slug}.md`))).toBe(false);
  });
});

describe('writeFactsToFence — atomic recovery', () => {
  test('after a successful write, no .tmp file is left behind', async () => {
    await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/erin' },
      [baseInput()],
    );

    const tmpPath = join(brainDir, 'people/erin.md.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe('writeFactsToFence — stub guard (v0.34.5)', () => {
  test('refuses to stub-create an unprefixed entity page (bare slug)', async () => {
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'alice' },
      [baseInput()],
    );

    // Result shape: no facts inserted, guard flag set, no ids.
    expect(result.inserted).toBe(0);
    expect(result.ids).toHaveLength(0);
    expect(result.stubGuardBlocked).toBe(true);

    // No phantom file at brain root.
    expect(existsSync(join(brainDir, 'alice.md'))).toBe(false);
    // No phantom .tmp either.
    expect(existsSync(join(brainDir, 'alice.md.tmp'))).toBe(false);
  });

  test('prefixed slugs (people/, companies/, etc.) bypass the guard', async () => {
    // Sanity: re-prove the happy path right next to the guard test so a
    // future refactor that breaks the guard's slug.includes('/') check
    // can't silently pass by only running the guard case.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'people/zelda' },
      [baseInput({ fact: 'Founded Hyrule Labs in 2024' })],
    );

    expect(result.inserted).toBe(1);
    expect(result.stubGuardBlocked).toBeUndefined();
    expect(existsSync(join(brainDir, 'people/zelda.md'))).toBe(true);
  });

  test('empty facts array is a no-op (does NOT trigger the guard)', async () => {
    // Empty input short-circuits BEFORE the guard runs — confirming the
    // guard only fires when there's actual work the caller wants to do.
    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: 'alice' },
      [],
    );

    expect(result.inserted).toBe(0);
    expect(result.stubGuardBlocked).toBeUndefined();
    expect(result.legacyFallback).toBeUndefined();
    expect(existsSync(join(brainDir, 'alice.md'))).toBe(false);
  });
});

describe('writeFactsToFence — basename ≠ slug (#3069)', () => {
  test('resolves the real file via the page row instead of stub-creating a duplicate', async () => {
    // Vault file whose basename differs from its slug — the way sync imports
    // `10-people/Joey Example.md` as slug `10-people/joey-example`.
    mkdirSync(join(brainDir, '10-people'), { recursive: true });
    const realPath = join(brainDir, '10-people/Joey Example.md');
    writeFileSync(
      realPath,
      '---\ntype: person\ntitle: Joey Example\nslug: 10-people/joey-example\n---\n\n# Joey Example\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | Existing claim | fact | 1.0 | world | medium | 2024-01-01 |  | import |  |\n<!--- gbrain:facts:end -->\n',
      'utf-8',
    );
    await engine.putPage('10-people/joey-example', {
      type: 'person',
      title: 'Joey Example',
      compiled_truth: '# Joey Example',
      timeline: '',
      frontmatter: {},
      content_hash: 'x',
      source_path: '10-people/Joey Example.md',
      import_filename: 'Joey Example',
    });

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: '10-people/joey-example' },
      [baseInput({ fact: 'New claim after rename' })],
    );

    expect(result.inserted).toBe(1);
    expect(result.stubGuardBlocked).toBeUndefined();
    // No duplicate stub next to the real page.
    expect(existsSync(join(brainDir, '10-people/joey-example.md'))).toBe(false);
    // The fact landed on the REAL file, continuing the fence's row_num
    // sequence (a stub would have restarted at 1 → idx_facts_fence_key
    // collision against the real page's DB rows).
    const body = readFileSync(realPath, 'utf-8');
    expect(body).toContain('New claim after rename');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await (engine as any).db.query(
      `SELECT row_num FROM facts WHERE source_markdown_slug = '10-people/joey-example'`,
    );
    expect(rows.rows[0].row_num).toBe(2);
  });

  test('page row exists but backing file is gone → stubGuardBlocked, no stub created', async () => {
    await engine.putPage('10-people/ghost-page', {
      type: 'person',
      title: 'Ghost',
      compiled_truth: '',
      timeline: '',
      frontmatter: {},
      content_hash: 'y',
      source_path: '10-people/Ghost Page.md', // never written to disk
      import_filename: 'Ghost Page',
    });

    const result = await writeFactsToFence(
      engine,
      { sourceId: 'default', localPath: brainDir, slug: '10-people/ghost-page' },
      [baseInput()],
    );

    expect(result.inserted).toBe(0);
    expect(result.stubGuardBlocked).toBe(true);
    expect(existsSync(join(brainDir, '10-people/ghost-page.md'))).toBe(false);
  });
});

describe('lookupSourceLocalPath', () => {
  test('returns the configured local_path for an existing source', async () => {
    const got = await lookupSourceLocalPath(engine, 'default');
    expect(got).toBe(brainDir);
  });

  test('returns null for unknown source_id', async () => {
    const got = await lookupSourceLocalPath(engine, 'nonexistent');
    expect(got).toBeNull();
  });

  test('returns null when local_path is NULL on the source row', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (engine as any).db.query(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    const got = await lookupSourceLocalPath(engine, 'default');
    expect(got).toBeNull();
  });
});

// Cleanup any leftover tempdirs after the whole suite.
afterAll(() => {
  // No-op: each test cleaned up via the beforeEach; this is a safety net.
  try {
    if (brainDir) rmSync(brainDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
