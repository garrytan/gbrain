/**
 * Refactor wave 1, W0 / EO8 (T-G16): SQL-text goldens for every PostgresEngine
 * method in the 12 W1 domains, captured on master with a recording fake `sql`
 * (no database). A W1 conversion must reproduce each golden byte for byte:
 * same statements, same order, same lanes and transaction events, same text
 * modulo `$N` renumbering (pinned by hash), same bound-value shapes. See
 * `test/helpers/sql-text-normalizer.ts` for the exact contract and
 * `test/fixtures/goldens/README.md` for regeneration.
 *
 * Fixtures:
 *   sql-text/<domain>.json        normalized trace per method + variant
 *   sql-text/_driver.json         tagged vs unsafe, param count, unsafe options
 *                                 (the only part an EO2 conversion may change)
 *   sql-text/_classification.json every prototype member -> domain / out-of-scope
 */

import { describe, expect, test } from 'bun:test';
import { expectGolden, expectNormalizerStable, defineNormalizer } from './helpers/golden.ts';
import { DOMAIN_OF, SQL_CASES, W1_DOMAINS, prototypeMembers, runCase, withPinnedSqlEnvironment } from './helpers/postgres-engine-sql-cases.ts';
import { SQL_DRIVER_NORMALIZER, SQL_TEXT_NORMALIZER, type DomainCapture } from './helpers/sql-text-normalizer.ts';

const CLASSIFICATION_NORMALIZER = defineNormalizer<Record<string, string>>('sql-text-classification-v1', (map) => {
  const counts: Record<string, number> = {};
  for (const d of Object.values(map)) counts[d] = (counts[d] ?? 0) + 1;
  return { members: map, counts };
});

async function captureDomain(domain: string): Promise<DomainCapture> {
  return withPinnedSqlEnvironment(undefined, async () => {
    const cases = [];
    for (const c of SQL_CASES.filter((x) => DOMAIN_OF[x.method] === domain)) {
      const r = await runCase(c);
      cases.push({ method: r.method, variant: r.variant, trace: r.trace, error: r.error });
    }
    return { domain, cases };
  });
}

describe('EO8 classification', () => {
  test('every PostgresEngine prototype member is classified exactly once', () => {
    const members = prototypeMembers();
    expect(members.filter((m) => !(m in DOMAIN_OF))).toEqual([]);
    expect(Object.keys(DOMAIN_OF).filter((m) => !members.includes(m)).sort()).toEqual([]);
    const pinned = Object.fromEntries(members.map((m) => [m, DOMAIN_OF[m]]));
    expectGolden('sql-text/_classification', pinned, CLASSIFICATION_NORMALIZER);
  });

  test('every in-scope method has at least one case and every case targets an in-scope method', () => {
    const inScope = Object.entries(DOMAIN_OF).filter(([, d]) => (W1_DOMAINS as readonly string[]).includes(d)).map(([m]) => m);
    const covered = new Set(SQL_CASES.map((c) => c.method));
    expect(inScope.filter((m) => !covered.has(m))).toEqual([]);
    expect(SQL_CASES.filter((c) => !inScope.includes(c.method)).map((c) => c.method)).toEqual([]);
    const cjk = SQL_CASES.filter((c) => DOMAIN_OF[c.method] === 'cjk-search');
    expect(cjk.filter((c) => !c.variant.startsWith('cjk')).map((c) => `${c.method}#${c.variant}`)).toEqual([]);
    const keys = SQL_CASES.map((c) => `${c.method}#${c.variant}`);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe('EO8 SQL-text goldens (fake sql, flag off)', () => {
  for (const domain of W1_DOMAINS) {
    test(`${domain}: every method completes and its SQL text matches master`, async () => {
      const capture = await expectNormalizerStable(() => captureDomain(domain), SQL_TEXT_NORMALIZER);
      expect(capture.cases.filter((c) => c.error).map((c) => `${c.method}#${c.variant}: ${c.error}`)).toEqual([]);
      expect(capture.cases.length).toBeGreaterThan(0);
      expectGolden(`sql-text/${domain}`, capture, SQL_TEXT_NORMALIZER);
    });
  }

  test('driver facts (tagged vs unsafe, param count, unsafe options) match master', async () => {
    const capture = await expectNormalizerStable(
      async () => { const out: DomainCapture[] = []; for (const d of W1_DOMAINS) out.push(await captureDomain(d)); return out; },
      SQL_DRIVER_NORMALIZER,
    );
    expectGolden('sql-text/_driver', capture, SQL_DRIVER_NORMALIZER);
  });
});
