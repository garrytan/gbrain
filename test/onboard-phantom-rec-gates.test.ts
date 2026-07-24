// test/onboard-phantom-rec-gates.test.ts
//
// Regression test for phantom onboard recommendations — recs that fire on a
// coverage metric but recommend an action that structurally cannot move it,
// so they persist forever (the `onboard --check` nag that confused a
// maintenance agent: it ran the direct equivalents, they no-op'd, the recs
// stayed). See reports/onboard-auto-loop-2026-06-22 (companion to the loop fix).
//
// Two gates:
//   - extract-ner is only recommended when the active pack actually declares
//     NER inference rules (packSupportsNerInference) — the SAME predicate the
//     handler gates on, so recommender and handler can't drift.
//   - extract-timeline-from-meetings is only recommended when there is at least
//     one dated meeting page to extract FROM.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkEntityLinkCoverage, checkTimelineCoverage } from '../src/core/onboard/checks.ts';
import { packSupportsNerInference } from '../src/core/schema-pack/best-effort.ts';
import type { ResolvedPack } from '../src/core/schema-pack/registry.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  _resetPackLocatorForTests();
});

async function seedEntities(n: number) {
  for (let i = 0; i < n; i++) {
    await engine.putPage(`person-${i}`, {
      title: `Person ${i}`,
      type: 'person' as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: `people/person-${i}.md`,
    });
  }
}

// Minimal pack-shaped object for the pure predicate (only manifest.link_types read).
function fakePack(linkTypes: unknown[]): ResolvedPack {
  return { manifest: { link_types: linkTypes } } as unknown as ResolvedPack;
}

describe('packSupportsNerInference (shared recommender/handler gate)', () => {
  it('false for null/undefined', () => {
    expect(packSupportsNerInference(null)).toBe(false);
    expect(packSupportsNerInference(undefined)).toBe(false);
  });

  it('false when the pack declares no link_types', () => {
    expect(packSupportsNerInference(fakePack([]))).toBe(false);
  });

  it('false when no link_type has an inference.regex (the real gbrain-base case)', () => {
    expect(packSupportsNerInference(fakePack([
      { verb: 'mentions' },
      { verb: 'works_at', inference: { gazetteer: true } }, // inference, but no regex
    ]))).toBe(false);
  });

  it('true when at least one link_type carries an inference.regex', () => {
    expect(packSupportsNerInference(fakePack([
      { verb: 'mentions' },
      { verb: 'cites', inference: { regex: '\\bRFC\\s?\\d+\\b' } },
    ]))).toBe(true);
  });
});

describe('checkEntityLinkCoverage — NER capability gate', () => {
  it('low coverage + pack without NER rules → WARN but NO extract-ner rec, with a reason', async () => {
    // Fresh brain's active pack (gbrain-base) has no inference.regex link_types,
    // so packSupportsNerInference is false → the rec must be withheld.
    await seedEntities(3); // entity pages, zero inbound links → coverage 0%
    const { check, remediations } = await checkEntityLinkCoverage(engine);
    expect(check.status).toBe('warn');
    expect(remediations).toHaveLength(0);
    expect(check.message).toContain('no auto-fix');
    expect(check.message).toContain('NER inference rules');
  });
});

describe('checkTimelineCoverage — datable-meetings gate', () => {
  it('low coverage + zero dated meetings → WARN but NO rec, with a reason', async () => {
    await seedEntities(3); // entity pages with no timeline entries → coverage 0%
    const { check, remediations } = await checkTimelineCoverage(engine);
    expect(check.status).toBe('warn');
    expect(remediations).toHaveLength(0);
    expect(check.message).toContain('no auto-fix');
    expect(check.message).toContain('dated meeting');
  });

  it('low coverage + a dated meeting present → recommends extract-timeline-from-meetings', async () => {
    await seedEntities(3);
    await engine.putPage('m0', {
      title: 'Standup', type: 'meeting' as never,
      compiled_truth: 'body that is long enough to pass any minimum-length guards in the codebase',
      timeline: '', frontmatter: {}, source_path: 'meetings/m0.md',
    });
    await engine.executeRaw(
      `UPDATE pages SET effective_date = '2026-01-01' WHERE slug = $1`,
      ['m0'],
    );
    const { check, remediations } = await checkTimelineCoverage(engine);
    expect(check.status).toBe('warn');
    expect(remediations).toHaveLength(1);
    expect(remediations[0]?.job).toBe('extract-timeline-from-meetings');
  });
});
