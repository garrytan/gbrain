/**
 * Coverage checks must derive numerator and denominator from the same visible
 * entity sample. An estimated Bernoulli denominator can be smaller than the
 * actual sample, producing impossible values above 100% and a NaN confidence
 * interval. Quarantined pages are hidden from the brain and must be excluded
 * from both sides of every coverage ratio.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  checkEntityLinkCoverage,
  checkTimelineCoverage,
} from '../src/core/onboard/checks.ts';
import { buildQuarantineMarker } from '../src/core/quarantine.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// Enough visible entities to clear the small-N floor, so the checks compute a
// ratio instead of reporting "not applicable". Counting the quarantined page
// as well would make it 1 of 6, i.e. 17%.
async function seedVisibleAndQuarantinedEntities(): Promise<void> {
  for (let n = 1; n <= MIN_ENTITY_PAGES_FOR_COVERAGE; n++) {
    await engine.putPage(`people/visible-example-${n}`, {
      type: 'person',
      title: `Visible Example ${n}`,
      compiled_truth: 'A visible synthetic entity.',
      timeline: '',
    });
  }
  await engine.putPage('people/quarantined-example', {
    type: 'person',
    title: 'Quarantined Example',
    compiled_truth: 'A quarantined synthetic entity.',
    timeline: '',
    frontmatter: {
      quarantine: buildQuarantineMarker('junk_pattern', 'synthetic fixture'),
    },
  });
  await engine.putPage('notes/source-example', {
    type: 'note',
    title: 'Source Example',
    compiled_truth: 'A synthetic source page.',
    timeline: '',
  });
}

describe('onboard entity coverage invariants', () => {
  test('uses the actual Bernoulli sample size and never emits >100% or NaN', async () => {
    const samples: Array<{ feature: string; samplePercent: number | undefined }> = [];
    const postgres = {
      kind: 'postgres',
      getConfig: async () => null,
      executeRaw: async () => [],
      countEntityPages: async (_filter: unknown, opts: { excludeQuarantined?: boolean }) => {
        expect(opts).toEqual({ excludeQuarantined: true });
        return 100_000;
      },
      // The old implementation read count=7,050 but divided by the estimated
      // 5,000 rows, yielding "Coverage 141% ± NaN%". The actual sampled
      // denominator is 10,000, so the truthful result is 71%.
      entityFeatureCoverage: async (_filter: unknown, feature: string, opts?: { samplePercent?: number }) => {
        samples.push({ feature, samplePercent: opts?.samplePercent });
        return { matched: 7_050, sampleSize: 10_000 };
      },
    } as unknown as BrainEngine;

    const result = await checkEntityLinkCoverage(postgres);

    expect(result.check.message).toMatch(/^Coverage 71% ± \d+\.\d%/);
    expect(result.check.message).not.toMatch(/NaN|Infinity/);
    expect(result.check.message).not.toMatch(/Coverage 1\d\d%/);
    // 5,000 / 100,000 rows = 5%: a Bernoulli sample above the 50k-entity line.
    expect(samples).toEqual([{ feature: 'links', samplePercent: 5 }]);
  });

  test('defensively clamps malformed sampled counts to the 0-100% invariant', async () => {
    const postgres = {
      kind: 'postgres',
      getConfig: async () => null,
      executeRaw: async () => [],
      countEntityPages: async () => 100_000,
      entityFeatureCoverage: async () => ({ matched: 12_000, sampleSize: 10_000 }),
    } as unknown as BrainEngine;

    const result = await checkEntityLinkCoverage(postgres);

    expect(result.check.message).toMatch(/^Coverage 100% ± 0\.0%/);
    expect(result.check.message).not.toMatch(/NaN|Infinity/);
  });

  test('entity-link coverage excludes quarantined entities from numerator and denominator', async () => {
    await seedVisibleAndQuarantinedEntities();
    await engine.addLink(
      'notes/source-example',
      'people/quarantined-example',
      '',
      'mentions',
      'manual',
    );

    const result = await checkEntityLinkCoverage(engine);

    expect(result.check.message).toMatch(/^Coverage 0% ± 0\.0%/);
    expect(result.check.message).not.toContain('17%');
  });

  test('timeline coverage applies the same visible-sample invariant', async () => {
    await seedVisibleAndQuarantinedEntities();
    await engine.addTimelineEntry('people/quarantined-example', {
      date: '2026-01-01',
      source: 'synthetic fixture',
      summary: 'Synthetic event',
    });

    const result = await checkTimelineCoverage(engine);

    expect(result.check.message).toMatch(/^Coverage 0% ± 0\.0%/);
    expect(result.check.message).not.toContain('17%');
  });
});
