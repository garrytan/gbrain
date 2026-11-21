/**
 * `gbrain schema detect --fields` reads its page samples through a typed engine member, never `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: runFieldUsage reads the page type counts and the per-type samples through `readFieldUsageSamples`. It
 *    runs no raw statement, so an engine that refuses raw SQL (the Rust engine) still answers the report.
 *  - Regression: a caller that goes back to `executeRaw` fails here, because the engine below refuses every raw
 *    statement that reads the pages table with the Rust engine's refusal.
 *  - Why existing coverage misses it: test/schema-field-usage.test.ts runs the report on a plain PGLite engine, where
 *    the raw statements succeed.
 *  - Memory: runFieldUsage reads the type counts with no samples, then one type's sample per call, as master did, so
 *    it never holds every type's page bodies at once. A caller that reads every type's sample in one call fails here.
 *  - Seam: a real PGLite brain behind a Proxy that refuses raw SQL on the pages table only and records each
 *    readFieldUsageSamples answer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { runFieldUsage } from '../src/core/schema-pack/field-usage.ts';

let pglite: PGLiteEngine;
let rawPageStatements = 0;
const answers: Array<{ query: Record<string, unknown>; types: number; rows: number }> = [];

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
}, 60_000);

afterAll(async () => { await pglite.disconnect(); });

/** PGLite, except that executeRaw refuses every statement reading the pages table, as the Rust engine refuses raw SQL. */
function noRawPages(): BrainEngine {
  return new Proxy(pglite, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (/\bFROM\s+pages\b/i.test(sql)) {
            rawPageStatements++;
            throw capabilityMissing('raw_sql', 'executeRaw');
          }
          return target.executeRaw(sql, params);
        };
      }
      if (prop === 'readFieldUsageSamples') {
        return async (query: Parameters<BrainEngine['readFieldUsageSamples']>[0]) => {
          const out = await target.readFieldUsageSamples(query);
          answers.push({ query: { ...query }, types: out.length, rows: out.reduce((n, t) => n + t.rows.length, 0) });
          return out;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

describe('schema detect --fields runs on a typed member', () => {
  test('runFieldUsage answers the report with no raw pages statement', async () => {
    for (let i = 1; i <= 4; i++) {
      await pglite.putPage(`people/p${i}`, { type: 'person', title: `P${i}`, timeline: '',
        frontmatter: { company: 'Acme', ...(i === 1 ? { role: 'cto' } : {}) },
        compiled_truth: `Person ${i}.\n\n- works_at [[companies/acme-example]]\n${i <= 2 ? '- [preference] Tea\n' : ''}` });
    }
    await pglite.putPage('companies/acme-example', { type: 'company', title: 'Acme', compiled_truth: 'Acme.', timeline: '', frontmatter: {} });
    const report = await runFieldUsage(noRawPages(), { sourceId: 'default' });
    expect(rawPageStatements).toBe(0);
    expect(report.map((t) => `${t.type}:${t.pages}:${t.sampled}`)).toEqual(['person:4:4', 'company:1:1']);
    // One counts-only read, then one read per type that holds only that type's sample.
    expect(answers.map((a) => `${a.query.type ?? '*'}:${a.query.countsOnly === true ? 'counts' : 'sample'}:${a.types}:${a.rows}`))
      .toEqual(['*:counts:2:0', 'person:sample:1:4', 'company:sample:1:1']);
    const [person] = report;
    expect(person).toMatchObject({ required: ['company', 'works_at ->'], optional: ['role', '[preference]'] });
  });
});
