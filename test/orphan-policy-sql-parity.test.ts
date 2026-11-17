/**
 * F4a: one orphan policy, two renderers. `orphanExclusionSql` (the predicate
 * get_health's aggregate statement uses) must agree with
 * `shouldExcludeFromOrphanReporting` (what `foresights orphans` and the per-slug
 * callers use) on every generated slug and page type, with and without
 * per-brain overrides; otherwise doctor reports two contradictory orphan
 * numbers. Covers the regex edges where JS and Postgres differ (Unicode
 * digits, line terminators), LIKE metacharacters in slugs and overrides, and
 * NULL types. The Postgres twin is `test/e2e/engine-sql-health-parity.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { orphanExclusionSql } from '../src/core/orphan-policy.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';
import { expectOrphanPolicyParity } from './helpers/orphan-policy-parity.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('orphan policy TS/SQL parity (PGLite)', () => {
  test('SQL and TS renderers agree on the generated corpus', async () => {
    expect(await expectOrphanPolicyParity(engine)).toBeGreaterThan(2000);
  });

  test('overrides bind as parameters and the alias is the only spliced text', () => {
    const { text, params } = renderFragment(orphanExclusionSql('pg', { excludePrefixes: ["evil'); DROP TABLE pages; --"], excludeSlugs: ['x'] }));
    expect(text).not.toContain('DROP TABLE');
    expect(params).toContain("evil'); DROP TABLE pages; --");
    expect(text).toContain('pg.slug');
    expect(() => orphanExclusionSql('p; DROP TABLE pages')).toThrow(/plain identifier/);
  });
});
