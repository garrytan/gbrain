/**
 * Regression guards for the DB-source library path on `runExtractCore`.
 *
 * Before this change, `runExtractCore` always walked the filesystem — even
 * though the CLI's `runExtract` wrapper supported `--source db`. That gap
 * meant the autopilot extract phase silently returned 0 links on brains
 * whose pages live only in Postgres (the checkout has no matching .md
 * files for transcript/code/concept slugs that were ingested via
 * `gbrain import`).
 *
 * This file pins the new `source: 'db'` option on `runExtractCore`:
 *  1. `source: 'db'` extracts wikilinks from compiled_truth in the DB,
 *     not the filesystem.
 *  2. `source: 'db'` ignores `opts.dir` (so the autopilot can pass any
 *     valid path — or none — and the DB walk still works).
 *  3. `source: 'fs'` and the default both keep the old FS-walk behavior.
 *  4. Invalid `source` values throw with a clear message.
 *
 * All tests use PGLite/in-memory — no DB connection required.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runExtractCore } from '../src/commands/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let tempDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // tempDir intentionally empty — DB path must not touch it.
  tempDir = mkdtempSync(join(tmpdir(), 'gbrain-extract-db-test-'));
});

async function seedPage(slug: string, body: string): Promise<void> {
  const [type, name] = slug.split('/');
  await engine.putPage(slug, {
    type: type as 'person' | 'company',
    title: name,
    compiled_truth: body,
    timeline: '',
    frontmatter: {},
    content_hash: 'h-' + slug,
  });
}

describe('runExtractCore — source: db library path', () => {
  test('1. source: db extracts wikilinks from compiled_truth (no FS files)', async () => {
    await seedPage('people/alice', 'Met [[people/bob]] last week.');
    await seedPage('people/bob', 'Friend of [[people/alice]].');

    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'links',
      dir: tempDir,         // empty dir — DB path must not require .md files
      source: 'db',
    });

    expect(result.links_created).toBeGreaterThanOrEqual(2);
    expect(result.pages_processed).toBe(2);
  });

  test('2. default source is fs (back-compat: omit source ⇒ FS walk over empty dir ⇒ 0)', async () => {
    await seedPage('people/alice', 'Met [[people/bob]] last week.');
    await seedPage('people/bob', 'Friend of [[people/alice]].');

    // No `source` passed; empty FS dir; pages exist only in DB.
    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'links',
      dir: tempDir,
    });

    expect(result.links_created).toBe(0);
    expect(result.pages_processed).toBe(0);
  });

  test('3. explicit source: fs matches the default behavior', async () => {
    await seedPage('people/alice', 'Met [[people/bob]] last week.');

    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'links',
      dir: tempDir,
      source: 'fs',
    });

    expect(result.links_created).toBe(0);
    expect(result.pages_processed).toBe(0);
  });

  test('4. invalid source value throws', async () => {
    await expect(
      runExtractCore(engine as unknown as BrainEngine, {
        mode: 'links',
        dir: tempDir,
        // @ts-expect-error — testing runtime validation of an invalid literal
        source: 'http',
      }),
    ).rejects.toThrow(/Invalid extract source/);
  });

  test('5. source: db ignores opts.dir entirely (non-existent path still works)', async () => {
    await seedPage('people/alice', '[[people/bob]]');
    await seedPage('people/bob', '# bob');

    const result = await runExtractCore(engine as unknown as BrainEngine, {
      mode: 'links',
      dir: '/does/not/exist/anywhere',  // would throw under source: 'fs'
      source: 'db',
    });

    expect(result.links_created).toBeGreaterThanOrEqual(1);
  });
});

// Cleanup empty temp dirs created for the FS-path safety guards.
afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
});
