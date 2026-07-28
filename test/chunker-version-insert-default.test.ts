/**
 * #2807 — putPage INSERT default for chunker_version.
 *
 * postgres-engine / pglite-engine used `COALESCE(<chunkerVersion>, 1)` in the
 * pages INSERT. Callers that don't supply chunker_version (no MCP/subagent
 * caller does — it's internal metadata) landed new pages at version 1, so
 * doctor's contextual_retrieval_coverage check flagged dream-written pages as
 * "older chunker_version" forever, even though they were chunked/embedded with
 * the current chunker.
 *
 * Fix: default the INSERT to MARKDOWN_CHUNKER_VERSION. The ON CONFLICT UPDATE
 * still COALESCE-preserves an explicitly supplied version.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../src/core/chunkers/recursive.ts';

describe('#2807 — putPage chunker_version INSERT default', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  async function readChunkerVersion(slug: string): Promise<number> {
    const { rows } = await (engine as any).db.query(
      `SELECT chunker_version FROM pages WHERE slug = $1`,
      [slug],
    );
    return Number((rows[0] as { chunker_version: number }).chunker_version);
  }

  test('page written without chunker_version defaults to MARKDOWN_CHUNKER_VERSION, not 1', async () => {
    await engine.putPage('dream/no-chunker-version', {
      type: 'concept',
      title: 'Dream synthesized page',
      compiled_truth: 'Written directly through putPage, like a dream subagent.',
      timeline: '',
    });
    expect(await readChunkerVersion('dream/no-chunker-version')).toBe(MARKDOWN_CHUNKER_VERSION);
    expect(MARKDOWN_CHUNKER_VERSION).toBeGreaterThan(1);
  });

  test('explicit chunker_version is honored on INSERT', async () => {
    await engine.putPage('dream/explicit-chunker-version', {
      type: 'concept',
      title: 'Explicit version',
      compiled_truth: 'Caller supplied a version.',
      timeline: '',
      chunker_version: 2,
    });
    expect(await readChunkerVersion('dream/explicit-chunker-version')).toBe(2);
  });

  test('re-put without chunker_version does not lower an already-current version', async () => {
    await engine.putPage('dream/preserve-version', {
      type: 'concept',
      title: 'Preserve me',
      compiled_truth: 'first write',
      timeline: '',
      chunker_version: MARKDOWN_CHUNKER_VERSION,
    });
    // Second write omits chunker_version; the UPDATE branch must not drop it
    // below the current chunker version.
    await engine.putPage('dream/preserve-version', {
      type: 'concept',
      title: 'Preserve me',
      compiled_truth: 'second write',
      timeline: '',
    });
    expect(await readChunkerVersion('dream/preserve-version')).toBe(MARKDOWN_CHUNKER_VERSION);
  });
});
