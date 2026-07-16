/**
 * [test] 2026-07-16
 * Context: Validate Postgres health reporting where entity health coverage is exposed through explicit aliases without breaking legacy behavior.
 * Invariant: Health is still zero/null when no entities exist, and coverage aliases remain equal to legacy link/timeline coverage when entities are present.
 * Rejected alternative: Added no widened PGLite/unit path because that would not execute the real Postgres SQL path where this regression is observable.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';

const skip = !hasDatabase();
const describeIf = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping Postgres get_health entity alias tests (DATABASE_URL not set)');
}

describeIf('Postgres get_health entity coverage aliases', () => {
  beforeEach(async () => {
    await setupDB();
  });

  afterEach(async () => {
    await teardownDB();
  });

  test('no entities keeps legacy zeroes and alias fields null', async () => {
    const engine = getEngine();
    await engine.putPage('concepts/health-fixture', {
      type: 'concept',
      title: 'Health fixture',
      compiled_truth: 'No entity pages are present.',
    });

    const health = await engine.getHealth();

    expect(health.entity_page_count).toBe(0);
    expect(health.link_coverage).toBe(0);
    expect(health.timeline_coverage).toBe(0);
    expect(health.entity_link_coverage).toBeNull();
    expect(health.entity_timeline_coverage).toBeNull();
    expect(health.most_connected).toEqual([]);
    expect(health.most_connected_entities).toEqual([]);
  });

  test('entity-present health aliases match legacy values', async () => {
    const engine = getEngine();
    await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice',
      compiled_truth: 'Alice is a person.',
    });
    await engine.putPage('people/bob', {
      type: 'person',
      title: 'Bob',
      compiled_truth: 'Bob is a person.',
    });
    await engine.putPage('companies/acme', {
      type: 'company',
      title: 'Acme',
      compiled_truth: 'Acme is a company.',
    });

    await engine.addLink('people/alice', 'companies/acme', '', 'works_at');
    await engine.putPage('notes/brief', {
      type: 'note',
      title: 'Brief',
      compiled_truth: 'A plain note for a non-entity target.',
    });
    await engine.addLink('companies/acme', 'notes/brief', '', 'mentions');

    const health = await engine.getHealth();

    expect(health.entity_page_count).toBe(3);
    expect(health.link_coverage).toBeCloseTo(1 / 3, 2);
    expect(health.timeline_coverage).toBe(0);
    expect(health.entity_link_coverage).toBeCloseTo(1 / 3, 2);
    expect(health.entity_timeline_coverage).toBe(0);
    expect(health.entity_link_coverage).toBe(health.link_coverage);
    expect(health.entity_timeline_coverage).toBe(health.timeline_coverage);
    expect(health.most_connected_entities).toEqual(health.most_connected);
    expect(health.most_connected_entities[0]?.slug).toBe('companies/acme');
    expect(health.most_connected_entities[0]?.link_count).toBe(2);
  });
});
