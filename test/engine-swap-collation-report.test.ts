/**
 * The swap report's `collation_order_differs` line (docs/designs/RUST_ENGINE.md D25 A1, the maintainer's ruling of
 * 2026-11-22 at 8:50 PM PST): the Rust engine lists text keys in byte order, as PGLite does. On a Postgres source whose
 * collation is not byte order (libc en_US, or any ICU locale), the plan names every list whose answer changes after the
 * swap, in three classes per site: the same rows in another order (`reordered`), different rows in a capped list
 * (`capped`), and no change (`unchanged`, counted), plus the sites not traced to the end, and the fixed line "repair
 * previews made before the swap must be run again". It is report-only: it never refuses and is not bound by the plan hash.
 *
 * Authoring gate (docs/TESTING.md): (1) protects what a Postgres user is told before the swap about lists that change.
 * (2) Fails when a non-byte-order source (libc en_US, ICU with a C.UTF-8 LC_COLLATE) gets no report, when a C or POSIX
 * source or a PGLite brain gets one, when an unknown collation reads as byte order, when a site loses its class, when the
 * repair-preview line is missing, or when the report changes the verdict or the plan hash. (3) Nothing else reports
 * collation order. (4) No seam: the real evaluator and plan over a PGLite engine with a stubbed shadow status.
 */
import { describe, expect, test } from 'bun:test';
import { collationReport, COLLATION_SITES, REPAIR_PREVIEW_LINE } from '../src/core/engine-swap/collation-report.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { planEngineSwap } from '../src/core/engine-swap/plan.ts';
import { readinessReadyFor } from './helpers/swap-ready-status.ts';

const probe = (collation: string | null, provider: string | null, locale: string | null = null) => ({ state: 'pass' as const, collation, locale_provider: provider, locale });

describe('the collation_order_differs report', () => {
  test('a libc en_US or an ICU Postgres source gets the report, with every class and the repair-preview line', () => {
    for (const p of [probe('en_US.UTF-8', 'c'), probe('C.UTF-8', 'i', 'en-US'), probe('en_US.utf8', 'libc')]) {
      const r = collationReport('postgres', p);
      expect({ p, applies: r.applies, reason: r.reason }).toEqual({ p, applies: true, reason: 'collation_order_differs' });
      expect(r.sites.reordered.length).toBeGreaterThan(0);
      expect(r.sites.capped.length).toBeGreaterThan(0);
      expect(r.sites.unchanged).toBeGreaterThan(0);
      expect(r.lines).toContain(REPAIR_PREVIEW_LINE);
      expect(REPAIR_PREVIEW_LINE).toBe('repair previews made before the swap must be run again');
    }
  });

  test('a C or POSIX Postgres source and a PGLite brain sort in byte order already: no report', () => {
    for (const p of [probe('C', 'c'), probe('POSIX', 'c'), probe('C', 'b', 'C'), probe('C.UTF-8', 'b', 'C.UTF-8')]) {
      expect({ p, applies: collationReport('postgres', p).applies }).toEqual({ p, applies: false });
    }
    expect(collationReport('pglite', null).applies).toBe(false);
  });

  test('an unknown collation never reads as byte order: the report says so and names every site', () => {
    const r = collationReport('postgres', null);
    expect(r.applies).toBeNull();
    expect(r.why).toContain('not known');
    expect(r.sites.reordered.length).toBe(COLLATION_SITES.filter(s => s.class === 'reordered').length);
    expect(r.lines).toContain(REPAIR_PREVIEW_LINE);
  });

  test('every site names its command, its sort and one class; the unchanged sites are counted, not listed', () => {
    for (const s of COLLATION_SITES) {
      expect(s.command.length).toBeGreaterThan(3);
      expect(s.site).toMatch(/^src\/core\/.+\.ts:\d+/);
      expect(['reordered', 'capped', 'untraced']).toContain(s.class);
    }
    const r = collationReport('postgres', probe('en_US.UTF-8', 'c'));
    expect(r.sites.reordered.map(s => s.command)).toContain('gbrain repair purged-page-facts (preview)');
    expect(r.sites.capped.map(s => s.command)).toContain('gbrain doctor entity-duplicates');
  });
});

describe('the swap plan carries the report, report-only', () => {
  test('an ICU source: the plan names the report and the classes, and the verdict and hash do not move', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      const now = new Date('2026-12-01T00:00:00Z');
      const icu = readinessReadyFor();
      icu.fingerprints!.probe = { ...icu.fingerprints!.probe, collation: 'C.UTF-8', locale_provider: 'i', locale: 'en-US' } as never;
      const c = readinessReadyFor();
      const asPostgres = Object.assign(Object.create(engine), { kind: 'postgres' }) as typeof engine;
      const withIcu = await planEngineSwap(asPostgres, { readShadowStatus: async () => icu, now });
      const withC = await planEngineSwap(asPostgres, { readShadowStatus: async () => c, now });
      expect(withIcu.collation.applies).toBe(true);
      expect(withIcu.collation.reason).toBe('collation_order_differs');
      expect(withC.collation.applies).toBe(false);
      expect(withIcu.verdict).toBe(withC.verdict);
      expect(withIcu.plan_hash).toBe(withC.plan_hash);
    } finally { await engine.disconnect(); }
  }, 120_000);
});
