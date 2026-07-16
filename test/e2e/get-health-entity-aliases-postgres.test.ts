/**
 * v0.42 E2E (real Postgres): verify legacy entity health metrics versus
 * explicit entity aliases.
 *
 * Run: DATABASE_URL=... bun test test/e2e/get-health-entity-aliases-postgres.test.ts
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

    const health = await engine.getHealth();

    expect(health.entity_page_count).toBe(3);
    expect(health.link_coverage).toBeCloseTo(1 / 3, 2);
    expect(health.timeline_coverage).toBe(0);
    expect(health.entity_link_coverage).toBeCloseTo(1 / 3, 2);
    expect(health.entity_timeline_coverage).toBe(0);
    expect(health.entity_link_coverage).toBe(health.link_coverage);
    expect(health.entity_timeline_coverage).toBe(health.timeline_coverage);
  });
});
