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
    // #5876: every pointer is a scoped, previewed backfill (paid work needs the user's agreement).
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    expect(gap!.fix.command_argv).toEqual(['gbrain', 'chronicle-backfill', '--since', since, '--limit', '50', '--dry-run']);
  });

  // Value: protects=the coverage gap counts only pages whose own date is recent (the automatic extraction's history cutoff) and its title names what it counts; fails_when=a bulk import of years-old conversations (fresh updated_at) is reported as tens of thousands of "recent meetings" with a paid backfill as the fix; why_new=#7282; seam=none; no_claim=the backfill's own selection
  test('#7282: an old-dated page with a fresh updated_at is not a recent gap; the title names the types', async () => {
    try {
      const body = 'x'.repeat(120);
      await engine.putPage('conversations/old-thread', { type: 'conversation', title: 'old thread', compiled_truth: body, frontmatter: { date: '2019-03-01' } } as never);
      await engine.putPage('meetings/this-week', { type: 'meeting', title: 'this week', compiled_truth: body, frontmatter: { date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) } } as never);
      const gap = (await collectChronicle.collect(ctx())).find((f) => f.id === 'chronicle_coverage_gap');
      expect(gap?.title).toBe("1 recent meeting, conversation or calendar page(s) aren't in the timeline yet (1 meeting)");
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE type = 'conversation'`);
    }
  });

  test('flags unresolved ontology conflicts', async () => {
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'advisor', source: 'm/a', validFrom: '2026-05-01' });
    await engine.mergeOntologyFact({ entitySlug: 'people/x', dimension: 'role', value: 'founder', source: 'm/b', validFrom: '2026-01-01' });
    const findings = await collectChronicle.collect(ctx());
    const conflict = findings.find((f) => f.id === 'ontology_conflicts');
    expect(conflict).toBeTruthy();
    expect(conflict!.severity).toBe('warn');
  });

  test('no findings on a clean brain whose operator answered the auto_chronicle default', async () => {
    // #5876: until `config set auto_chronicle` answers it, the default-on notice is the only finding.
    await engine.unsetConfig('chronicle.default_on_acknowledged');
    expect((await collectChronicle.collect(ctx())).map((f) => f.id)).toEqual(['auto_chronicle_default_on']);
    await engine.setConfig('chronicle.default_on_acknowledged', '2026-10-04T00:00:00Z');
    try {
      expect(await collectChronicle.collect(ctx())).toHaveLength(0);
    } finally {
      await engine.unsetConfig('chronicle.default_on_acknowledged');
    }
  });
});
