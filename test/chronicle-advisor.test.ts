/**
 * v0.42.x — Life Chronicle (#2390) advisor collector (Phase A.7).
 *
 * #7282: `chronicle_coverage_gap` counts a meeting/conversation/calendar page as recent by the
 * page's own date (an authored effective_date), like the automatic path (chronicle/eligibility.ts),
 * and by updated_at only when the page has no authored date. Protects: a bulk import or re-render
 * of old chat history (fresh updated_at, old date) is not reported as recent meetings.
 * Fails when: the filter goes back to updated_at alone, or trusts an unauthored 'fallback' date.
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
  await engine.executeRaw(`DELETE FROM pages WHERE type IN ('meeting', 'conversation', 'calendar-event')`);
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

  test('#7282: an old conversation re-imported today is not a recent meeting; a recent meeting is', async () => {
    // updated_at is now() for both (putPage stamps it), as after a bulk import of chat history.
    await engine.putPage('conversations/imported-2020', {
      type: 'conversation', title: 'imported', compiled_truth: 'x'.repeat(120),
      frontmatter: { date: '2020-01-15' }, effective_date: new Date('2020-01-15T00:00:00Z'), effective_date_source: 'date',
    });
    await engine.putPage('meetings/recent-dated', {
      type: 'meeting', title: 'recent', compiled_truth: 'x'.repeat(120),
      frontmatter: { date: new Date().toISOString().slice(0, 10) }, effective_date: new Date(), effective_date_source: 'date',
    });
    const gap = (await collectChronicle.collect(ctx())).find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap).toBeTruthy();
    expect(gap!.title).toStartWith('1 recent meeting(s)');
  });

  test('#7282: a brain whose only unswept pages are old imports has no coverage gap', async () => {
    await engine.putPage('conversations/imported-2020', {
      type: 'conversation', title: 'imported', compiled_truth: 'x'.repeat(120),
      frontmatter: { date: '2020-01-15' }, effective_date: new Date('2020-01-15T00:00:00Z'), effective_date_source: 'date',
    });
    expect((await collectChronicle.collect(ctx())).find((f) => f.id === 'chronicle_coverage_gap')).toBeUndefined();
  });

  test('#7282: an unauthored fallback date does not date the page, so updated_at still counts it', async () => {
    // 'fallback' is the undated-import anchor (the automatic path ignores it too).
    await engine.putPage('conversations/undated', {
      type: 'conversation', title: 'undated', compiled_truth: 'x'.repeat(120),
      effective_date: new Date('2020-01-15T00:00:00Z'), effective_date_source: 'fallback',
    });
    const gap = (await collectChronicle.collect(ctx())).find((f) => f.id === 'chronicle_coverage_gap');
    expect(gap).toBeTruthy();
    expect(gap!.title).toStartWith('1 recent meeting(s)');
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
