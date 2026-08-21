import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
     VALUES ('default', 'reports/google-ad-performance', 'note',
             'Google Ad Performance Weekly Report', 'fixture')`,
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('findByTitleFuzzy indexed threshold', () => {
  test('uses the trigram index without losing matches below the default 0.3 threshold', async () => {
    const [score] = await engine.executeRaw<{ sim: number }>(
      `SELECT similarity('Google Ad Performance Weekly Report', 'Google Ads') AS sim`,
    );
    expect(score.sim).toBeGreaterThan(0.2);
    expect(score.sim).toBeLessThan(0.3);

    const match = await engine.findByTitleFuzzy('Google Ads', 'reports', 0.2);
    expect(match?.slug).toBe('reports/google-ad-performance');
    expect(match?.similarity).toBeGreaterThanOrEqual(0.2);
  });

  test('Postgres and PGLite implementations retain the indexed prefilter', () => {
    for (const path of [
      new URL('../src/core/postgres-engine.ts', import.meta.url),
      new URL('../src/core/pglite-engine.ts', import.meta.url),
    ]) {
      const source = readFileSync(path, 'utf8');
      const start = source.indexOf('async findByTitleFuzzy(');
      const end = source.indexOf('\n  async traverseGraph(', start);
      const method = source.slice(start, end);
      expect(method).toContain('minSimilarity >= 0.3');
      expect(method).toContain('title %');
      expect(method).toContain('similarity(title');
    }
  });
});
