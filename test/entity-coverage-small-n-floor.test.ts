/**
 * Entity coverage checks below the small-N floor (#5379).
 *
 * BrainHealth grades link/timeline coverage only once a brain has
 * MIN_ENTITY_PAGES_FOR_COVERAGE entity pages; below that it reports null.
 * doctor's graph_coverage and onboard's entity_link_coverage /
 * timeline_coverage must agree: a brain with 1-4 entity pages gets an `ok`
 * "not applicable" result with no remediation, never a 0% WARN that
 * `gbrain extract all` cannot clear.
 *
 * Protects: the status, message and remediation list each check returns at
 * the floor boundary. Fails if any of the three checks grades a ratio below
 * the floor, or counts pages its own population excludes (test fixtures for
 * doctor, quarantined pages for onboard) toward the floor. The at-floor and
 * zero-page cases are controls that pass with or without the fix.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { checkEntityLinkCoverage, checkTimelineCoverage } from '../src/core/onboard/checks.ts';
import { buildQuarantineMarker } from '../src/core/quarantine.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

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

const BELOW_FLOOR = [1, MIN_ENTITY_PAGES_FOR_COVERAGE - 1];

async function insertPeople(slugPrefix: string, count: number): Promise<void> {
  await sqlQueryForEngine(engine)`
    INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, content_hash, created_at, updated_at)
    SELECT ${slugPrefix}::text || g, 'default', 'person', 'Person ' || g, '', '{}', ${slugPrefix}::text || 'h' || g, now(), now()
    FROM generate_series(1, ${count}::int) AS g
  `;
}

async function graphCoverage() {
  const checks = await buildChecks(engine, [], null);
  const graph = checks.find((c) => c.name === 'graph_coverage');
  expect(graph, 'graph_coverage check must be present').toBeDefined();
  return graph!;
}

describe('doctor graph_coverage below the entity floor', () => {
  for (const n of BELOW_FLOOR) {
    test(`${n} unlinked entity page(s) → ok, not applicable`, async () => {
      await insertPeople('people/floor-example-', n);
      const graph = await graphCoverage();
      expect(graph.status).toBe('ok');
      expect(graph.message).toContain(`Only ${n} eligible entity ${n === 1 ? 'page' : 'pages'} (< ${MIN_ENTITY_PAGES_FOR_COVERAGE})`);
      expect(graph.message).not.toMatch(/\d+%/);
    });
  }

  test('test-fixture entity pages do not lift a brain over the floor', async () => {
    await insertPeople('people/floor-example-', MIN_ENTITY_PAGES_FOR_COVERAGE - 1);
    await insertPeople('tools/gbrain/test/fixture-', 3);
    const graph = await graphCoverage();
    expect(graph.status).toBe('ok');
    expect(graph.message).toContain(`Only ${MIN_ENTITY_PAGES_FOR_COVERAGE - 1} eligible entity pages`);
  });

  test('control: at the floor, unlinked entities warn with the target', async () => {
    await insertPeople('people/floor-example-', MIN_ENTITY_PAGES_FOR_COVERAGE);
    const graph = await graphCoverage();
    expect(graph.status).toBe('warn');
    expect(graph.message).toContain('connected coverage (in/out) 0% (target 70%)');
    expect(graph.message).toContain(`(${MIN_ENTITY_PAGES_FOR_COVERAGE} entity pages)`);
  });
});

const ONBOARD_CHECKS = [
  ['entity_link_coverage', checkEntityLinkCoverage],
  ['timeline_coverage', checkTimelineCoverage],
] as const;

async function putPeople(count: number, frontmatter: Record<string, unknown> = {}, tag = 'visible'): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await engine.putPage(`people/${tag}-example-${i}`, {
      type: 'person',
      title: `${tag} ${i}`,
      compiled_truth: 'A synthetic entity.',
      timeline: '',
      frontmatter,
    });
  }
}

describe('onboard coverage checks below the entity floor', () => {
  for (const [name, check] of ONBOARD_CHECKS) {
    // Pin an empty home so the warn path's pack lookup never reads the operator's config.
    const run = () => withEnv({ GBRAIN_HOME: emptyHome() }, () => check(engine));

    for (const n of BELOW_FLOOR) {
      test(`${name}: ${n} entity page(s) → ok, not applicable, no remediation`, async () => {
        await putPeople(n);
        const result = await run();
        expect(result.check).toEqual({
          name,
          status: 'ok',
          message: `Only ${n} entity ${n === 1 ? 'page' : 'pages'} (< ${MIN_ENTITY_PAGES_FOR_COVERAGE}) — coverage ratio not meaningful at this scale`,
        });
        expect(result.remediations).toEqual([]);
      });
    }

    test(`${name}: quarantined pages do not count toward the floor`, async () => {
      await putPeople(MIN_ENTITY_PAGES_FOR_COVERAGE - 1);
      await putPeople(2, { quarantine: buildQuarantineMarker('junk_pattern', 'synthetic fixture') }, 'quarantined');
      const result = await run();
      expect(result.check.status).toBe('ok');
      expect(result.check.message).toStartWith(`Only ${MIN_ENTITY_PAGES_FOR_COVERAGE - 1} entity pages`);
    });

    test(`${name}: control — at the floor, zero coverage warns`, async () => {
      await putPeople(MIN_ENTITY_PAGES_FOR_COVERAGE);
      const result = await run();
      expect(result.check.status).toBe('warn');
      expect(result.check.message).toMatch(/^Coverage 0% ± 0\.0% \(target \d+%\)/);
    });

    test(`${name}: control — no entity pages keeps the vacuous message`, async () => {
      const result = await run();
      expect(result.check).toEqual({ name, status: 'ok', message: 'No entity pages — coverage check vacuous' });
      expect(result.remediations).toEqual([]);
    });
  }
});
