import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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
});

describe('honest brain-score eligibility', () => {
  test('timeless notes do not dilute timeline coverage', async () => {
    await engine.putPage('notes/timeless', {
      type: 'note', title: 'Timeless', compiled_truth: 'reference material', frontmatter: {},
    });
    const health = await engine.getHealth();
    expect(health.timeline_eligible_pages).toBe(0);
    expect(health.timeline_covered_pages).toBe(0);
    expect(health.timeline_coverage_score).toBe(15);
  });

  test('entity and project pages require real events unless explicitly opted out', async () => {
    await engine.putPage('companies/acme-example', {
      type: 'company', title: 'Acme Example', compiled_truth: 'company', frontmatter: {},
    });
    await engine.putPage('projects/example', {
      type: 'project', title: 'Example', compiled_truth: 'project', frontmatter: { timeline_required: false },
    });
    let health = await engine.getHealth();
    expect(health.timeline_eligible_pages).toBe(1);
    expect(health.timeline_covered_pages).toBe(0);
    expect(health.timeline_coverage_score).toBe(0);
    await engine.addTimelineEntry('companies/acme-example', {
      date: '2026-01-02', source: 'frontmatter:launched_at', summary: 'Product launched',
    });
    health = await engine.getHealth();
    expect(health.timeline_covered_pages).toBe(1);
    expect(health.timeline_coverage_score).toBe(15);
  });

  test('soft-deleted pages and links do not affect score denominators', async () => {
    await engine.putPage('live', { type: 'note', title: 'Live', compiled_truth: 'live', frontmatter: {} });
    await engine.putPage('deleted', { type: 'note', title: 'Deleted', compiled_truth: 'gone', frontmatter: {} });
    await engine.deletePage('deleted');
    const health = await engine.getHealth();
    expect(health.page_count).toBe(1);
  });
});
