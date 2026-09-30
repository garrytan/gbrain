/**
 * B-21: failures on the facts write path are not swallowed.
 *
 *   - The entity resolver no longer turns a database error on the exact-slug
 *     or fuzzy lookup into a fallback slug (a silent misattribution); only a
 *     brain without pg_trgm degrades the fuzzy arm.
 *   - The fence writer's fallback to file-only row numbering when the DB
 *     MAX(row_num) lookup fails (the duplicate-key class it guards) is
 *     reported instead of silent.
 *   - A failed page-cache mirror after a fence write is reported.
 *
 * Real PGLite; failures injected by wrapping executeRaw / refreshPageBody.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveEntitySlugWithSource } from '../src/core/entities/resolve.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

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
  brainDir = mkdtempSync(join(tmpdir(), 'facts-failures-'));
  _resetWriteThroughCacheForTest();
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

/** An engine whose executeRaw throws for SQL matching `pattern`. */
function failing(pattern: RegExp, error: Error): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (pattern.test(sql)) throw error;
          return target.executeRaw(sql, params as never);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

const input = {
  fact: 'Founded Acme in 2017', kind: 'fact' as const, notability: 'high' as const, source: 'test',
  visibility: 'world' as const, confidence: 1.0, validFrom: new Date(Date.UTC(2017, 0, 1)), embedding: null, sessionId: null,
};

describe('facts write-path failures (B-21)', () => {
  test('an exact-slug lookup error is not a fallback slug', async () => {
    const broken = failing(/SELECT slug FROM pages WHERE source_id = \$1 AND slug = \$2/, new Error('connection reset'));
    await expect(resolveEntitySlugWithSource(broken, 'default', 'people/alice-example')).rejects.toThrow('connection reset');
  });

  test('a fuzzy lookup error is not a fallback slug, but a missing pg_trgm still degrades', async () => {
    const broken = failing(/similarity\(/, new Error('connection reset'));
    await expect(resolveEntitySlugWithSource(broken, 'default', 'Alice Example')).rejects.toThrow('connection reset');
    const noTrgm = failing(/similarity\(/, Object.assign(new Error('function similarity(text, unknown) does not exist'), { code: '42883' }));
    expect(await resolveEntitySlugWithSource(noTrgm, 'default', 'Alice Example'))
      .toEqual({ slug: 'alice-example', source: 'fallback_slugify' });
  });

  test('a failed DB row-number lookup is reported, not silent', async () => {
    const broken = failing(/MAX\(row_num\)/, new Error('connection reset'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await writeFactsToFence(broken, { sourceId: 'default', localPath: brainDir, slug: 'people/alice-example', resolutionSource: 'exact_page' }, [input]);
      expect(result.inserted).toBe(1);
      expect(warn.mock.calls.some(c => String(c[0]).includes('FACTS_ROW_NUM_HINT_UNAVAILABLE') && String(c[0]).includes('connection reset'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  test('a failed page-cache mirror after a fence write is reported', async () => {
    await importFromContent(engine, 'people/alice-example', '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n', { noEmbed: true });
    const broken = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'refreshPageBody') return async () => { throw new Error('mirror write failed'); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as BrainEngine;
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await writeFactsToFence(broken, { sourceId: 'default', localPath: brainDir, slug: 'people/alice-example', resolutionSource: 'exact_page' }, [input]);
      expect(result.inserted).toBe(1);
      expect(warn.mock.calls.some(c => String(c[0]).includes('FACTS_PAGE_MIRROR_FAILED') && String(c[0]).includes('mirror write failed'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
