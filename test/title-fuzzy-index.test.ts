import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { surfaceFileSource } from './helpers/source-surface.ts';
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
    // test-reads-source-ok[structural]: the trigram prefilter is a planner property with no observable result difference; both engines run engine-sql/pages.ts (W1-extended).
    for (const source of [surfaceFileSource('postgres-engine', 'src/core/engine-sql/pages.ts')]) {
      const start = source.indexOf('export async function findByTitleFuzzy(');
      const end = source.indexOf('\nexport async function getPageTimestamps(', start);
      const method = source.slice(start, end);
      expect(method).toContain('minSimilarity >= 0.3');
      expect(method).toContain('title %');
      expect(method).toContain('similarity(title');
    }
  });
});
