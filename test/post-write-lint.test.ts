/**
 * Post-write validator lint tests (PR 2.5 minimal integration).
 *
 * Feature-flag gated; default OFF means zero behavior change to put_page.
 * When ON, runs the 4 BrainWriter validators and logs findings without
 * rejecting the write. Strict-mode flip is out of scope; deferred per
 * CEO plan.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runPostWriteLint, isLintOnPutPageEnabled } from '../src/core/output/post-write.ts';

let engine: BrainEngine;
let dbDir: string;

beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'postwrite-'));
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dbDir });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

async function reset(): Promise<void> {
  await engine.executeRaw('TRUNCATE pages, links, content_chunks, timeline_entries, tags, raw_data, page_versions, ingest_log RESTART IDENTITY CASCADE');
  await engine.executeRaw(`DELETE FROM config WHERE key = 'writer.lint_on_put_page'`);
}

describe('isLintOnPutPageEnabled', () => {
  beforeEach(async () => { await reset(); });

  test('defaults false when config unset', async () => {
    expect(await isLintOnPutPageEnabled(engine)).toBe(false);
  });

  test('true when config = true', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    expect(await isLintOnPutPageEnabled(engine)).toBe(true);
  });

  test('true when config = 1', async () => {
    await engine.setConfig('writer.lint_on_put_page', '1');
    expect(await isLintOnPutPageEnabled(engine)).toBe(true);
  });

  test('false for any other value', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'maybe');
    expect(await isLintOnPutPageEnabled(engine)).toBe(false);
  });

  test('false when config = false', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'false');
    expect(await isLintOnPutPageEnabled(engine)).toBe(false);
  });
});

describe('runPostWriteLint', () => {
  beforeEach(async () => { await reset(); });

  test('flag disabled → returns ran=false, no findings', async () => {
    await engine.putPage('people/x', {
      type: 'person', title: 'X', compiled_truth: 'X has a bare factual paragraph without a citation.',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/x');
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('flag_disabled');
    expect(r.findings).toEqual([]);
  });

  test('page not found → returns ran=false', async () => {
    const r = await runPostWriteLint(engine, 'people/ghost', { force: true });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('page_not_found');
  });

  test('validate:false frontmatter → skipped (grandfather)', async () => {
    await engine.putPage('people/old', {
      type: 'person', title: 'Old', compiled_truth: 'Lots of factual paragraphs without citations.',
      frontmatter: { validate: false },
    });
    const r = await runPostWriteLint(engine, 'people/old', { force: true });
    expect(r.ran).toBe(false);
    expect(r.skippedReason).toBe('validate_false_frontmatter');
  });

  test('forces run even when flag is off', async () => {
    await engine.putPage('people/y', {
      type: 'person', title: 'Y', compiled_truth: 'Y raised money [Source: X, 2026-04-18](https://x.com/y).',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/y', { force: true, noLog: true });
    expect(r.ran).toBe(true);
  });

  test('flag on + bad page → findings include citation error', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    await engine.putPage('people/bad', {
      type: 'person', title: 'Bad', compiled_truth: 'Bad raised $5M in Series A from Sequoia without citation.',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/bad', { noLog: true });
    expect(r.ran).toBe(true);
    expect(r.findings.length).toBeGreaterThan(0);
    const citationError = r.findings.find(f => f.validator === 'citation' && f.severity === 'error');
    expect(citationError).toBeDefined();
  });

  test('flag on + clean page → zero findings', async () => {
    await engine.setConfig('writer.lint_on_put_page', 'true');
    await engine.putPage('people/clean', {
      type: 'person', title: 'Clean',
      compiled_truth: '## See Also\n- [Source: X/clean, 2026-04-18](https://x.com/clean/status/1)',
      frontmatter: {},
    });
    const r = await runPostWriteLint(engine, 'people/clean', { noLog: true });
    expect(r.ran).toBe(true);
    expect(r.findings).toEqual([]);
  });
});
