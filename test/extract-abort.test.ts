/**
 * #1972 (Codex #7) — cooperative abort on the cycle-reachable extract paths.
 *
 * The cycle calls runExtractCore with `slugs` defined (incremental →
 * extractForSlugs) or undefined (full walk → extractLinksFromDir /
 * extractTimelineFromDir). All three must bail promptly on a pre-aborted
 * signal. Behavioral, dryRun-only (no DB writes, so no FK setup needed).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractCore } from '../src/commands/extract.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'extract-abort-'));
  // a.md links to b; both exist so the wikilink resolves.
  writeFileSync(join(dir, 'a.md'), '# A\n\nsee [[b]] for more.\n');
  writeFileSync(join(dir, 'b.md'), '# B\n\nplain.\n');
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

function aborted(): AbortSignal {
  const a = new AbortController();
  a.abort(new Error('timeout'));
  return a.signal;
}

describe('extract cooperative abort', () => {
  test('incremental path (extractForSlugs) processes 0 pages when pre-aborted', async () => {
    const r = await runExtractCore(engine, {
      mode: 'links', dir, dryRun: true, slugs: ['a', 'b'], signal: aborted(),
    });
    expect(r.pages_processed).toBe(0);
  });

  test('incremental path processes all pages without a signal', async () => {
    const r = await runExtractCore(engine, {
      mode: 'links', dir, dryRun: true, slugs: ['a', 'b'],
    });
    expect(r.pages_processed).toBe(2);
  });

  test('full-walk path (extractLinksFromDir) creates 0 links when pre-aborted', async () => {
    const r = await runExtractCore(engine, {
      mode: 'links', dir, dryRun: true, signal: aborted(),
    });
    expect(r.links_created).toBe(0);
  });

  test('full-walk path resolves the wikilink without a signal', async () => {
    const r = await runExtractCore(engine, { mode: 'links', dir, dryRun: true });
    expect(r.links_created).toBeGreaterThanOrEqual(1);
  });
});
