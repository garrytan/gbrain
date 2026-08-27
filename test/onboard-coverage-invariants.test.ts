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

async function seedVisibleAndQuarantinedEntities(): Promise<void> {
  await engine.putPage('people/visible-example', {
    type: 'person',
    title: 'Visible Example',
    compiled_truth: 'A visible synthetic entity.',
    timeline: '',
  });
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
    const queries: string[] = [];
    let call = 0;
    const postgres = {
      kind: 'postgres',
      async executeRaw(sql: string) {
        queries.push(sql);
        call++;
        if (call === 1) return [{ count: 100_000 }];
        // The old implementation reads count=7,050 but divides by the
        // estimated 5,000 rows, yielding "Coverage 141% ± NaN%". The actual
        // sampled denominator is 10,000, so the truthful result is 71%.
        return [{ count: 7_050, matched: 7_050, sample_size: 10_000 }];
      },
    } as unknown as BrainEngine;

    const result = await checkEntityLinkCoverage(postgres);

    expect(result.check.message).toMatch(/^Coverage 71% ± \d+\.\d%/);
    expect(result.check.message).not.toMatch(/NaN|Infinity/);
    expect(result.check.message).not.toMatch(/Coverage 1\d\d%/);
    expect(queries).toHaveLength(2);
  });

  test('defensively clamps malformed sampled counts to the 0-100% invariant', async () => {
    let call = 0;
    const postgres = {
      kind: 'postgres',
      async executeRaw() {
        call++;
        if (call === 1) return [{ count: 100_000 }];
        return [{ matched: 12_000, sample_size: 10_000 }];
      },
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
    expect(result.check.message).not.toContain('50%');
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
    expect(result.check.message).not.toContain('50%');
  });
});
