/**
 * v0.42.x — Life Chronicle (#2390) advisor collector (Phase A.7).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collectChronicle } from '../src/core/advisor/collect-chronicle.ts';
import type { AdvisorContext } from '../src/core/advisor/types.ts';

let engine: PGLiteEngine;
const ctx = (): AdvisorContext => ({ engine, remote: false } as unknown as AdvisorContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await engine.executeRaw('DELETE FROM timeline_entries');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw(`DELETE FROM pages WHERE type = 'meeting'`);
});

describe('collectChronicle', () => {
  test('flags recent meetings with no timeline coverage', async () => {
    await engine.putPage('meetings/recent', { type: 'meeting', title: 'recent', compiled_truth: 'x'.repeat(120) });
    const findings = await collectChronicle.collect(ctx());
    const gap = findings.find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap).toBeTruthy();
    expect(gap!.severity).toBe('info');
    expect(gap!.fix.command_argv).toEqual(['gbrain', 'chronicle-backfill']);
  });

  test('flags unresolved ontology conflicts', async () => {
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'advisor', source: 'm/a', validFrom: '2026-05-01' });
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'founder', source: 'm/b', validFrom: '2026-01-01' });
    const findings = await collectChronicle.collect(ctx());
    const conflict = findings.find((f) => f.id === 'ontology_conflicts');
    expect(conflict).toBeTruthy();
    expect(conflict!.severity).toBe('warn');
  });

  test('no findings on a clean brain', async () => {
    const findings = await collectChronicle.collect(ctx());
    expect(findings).toHaveLength(0);
  });
});
