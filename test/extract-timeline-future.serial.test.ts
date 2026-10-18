/** Historical fan-out must wait until a retained invite has happened. Reverting
 * the guard writes false Discussed-in rows. Existing tests cover only ended
 * meetings. No production seam is added: DB/maintenance imports are synthetic.
 */
import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

const deny = () => { throw new Error('Unexpected dependency call'); };
let managed = false;
let maintenanceCalls = 0;
mock.module('../src/core/by-mention.ts', () => ({ buildGazetteer: deny, findMentionedEntities: () => [] }));
mock.module('../src/core/link-extraction.ts', () => ({ isCrossSourceLinksEnabled: async () => false }));
mock.module('../src/core/effective-date.ts', () => ({ computeEffectiveDate: () => ({ date: null, source: 'fallback' }) }));
mock.module('../src/core/backfill-effective-date.ts', () => ({ parseFrontmatter: (v: unknown) => v }));
mock.module('../src/core/search/private-visibility.ts', () => ({ isPrivatePage: ({ frontmatter }: any) => frontmatter?.visibility === 'private' }));
mock.module('../src/core/quarantine.ts', () => ({ quarantineFilterFragment: () => 'TRUE' }));
mock.module('../src/core/persistence/attribution.ts', () => ({ maintenanceTransaction: async (e: any, f: any) => f(e) }));
mock.module('../src/core/trust/taint.ts', () => ({ derivedWriteTrust: () => ({}) }));
mock.module('../src/core/trust/derived-gate.ts', () => ({ derivedGateConfig: async () => ({}), derivedGateInput: () => ({}), recordTimelineFlag: async () => {}, timelineRowAllowed: () => true }));
mock.module('../src/core/write-gate.ts', () => ({ assessTimelineForGate: () => ({}) }));
mock.module('../src/core/trust/tier.ts', () => ({ storedTrustTier: (v: unknown) => v }));
mock.module('../src/core/persistence/ownership.ts', () => ({ managedPersistenceEnabled: async () => managed }));
mock.module('../src/core/persistence/prepared-maintenance.ts', () => ({ maintenancePreflight: () => { maintenanceCalls++; return null; }, submitDatabaseMaintenanceIntent: deny }));
mock.module('../src/core/persistence/authority.ts', () => ({ authorizeWrite: deny }));
mock.module('../src/core/persistence/journal.ts', () => ({ getWriteRequest: deny }));
mock.module('../src/core/persistence/model.ts', () => ({ isTerminal: deny }));
mock.module('../src/core/persistence/digest.ts', () => ({ digest: deny }));
mock.module('../src/core/persistence/context.ts', () => ({ withWriteTrust: deny }));
mock.module('../src/core/ops/contract.ts', () => ({ OperationError: class extends Error {}, opError: deny }));
const { extractTimelineFromMeetings } = await import('../src/core/extract-timeline-from-meetings.ts');
afterAll(() => mock.restore());
beforeEach(() => { managed = false; maintenanceCalls = 0; });

// Vastly separated dates avoid a wall-clock boundary, sleeps or global clock mocks.
const past = '2000-01-01T00:00:00Z';
const future = '2999-01-01T00:00:00Z';
async function run(frontmatter: Record<string, unknown>, effectiveDate: string | Date | null = '2000-01-01', dryRun = true) {
  const meeting = { id: 1, slug: 'calendar/synthetic', source_id: 'fixture', title: 'Synthetic meeting',
    trust_tier: 'owner', effective_date: effectiveDate, frontmatter, import_filename: null,
    created_at: past, updated_at: past, compiled_truth: '', timeline: '' };
  const stored: unknown[] = [];
  const engine = {
    executeRaw: async (sql: string) => {
      if (sql.includes('JOIN pages meeting')) return [{ meeting_slug: meeting.slug, meeting_source_id: 'fixture', attendee_slug: 'people/synthetic', attendee_source_id: 'fixture' }];
      if (sql.includes('FROM timeline_entries')) return [];
      if (sql.includes('FROM pages')) return [meeting];
      throw new Error('Unexpected SQL');
    },
    addTimelineEntriesBatch: async (rows: unknown[]) => { stored.push(...rows); return rows.length; },
  } as unknown as BrainEngine;
  const result = await extractTimelineFromMeetings(engine, { dryRun, gazetteer: new Map() });
  // The source meeting is neither edited nor hidden by deriving timeline rows.
  expect(meeting.frontmatter).toBe(frontmatter);
  expect(meeting.slug).toBe('calendar/synthetic');
  expect(result.batch_errors).toBe(0);
  return { result, stored };
}
for (const [label, fm, date, count] of [
  ['future end', { start: past, end: future }, past, 0],
  ['future start', { start: future }, past, 0],
  ['invalid end falls back to start', { start: future, end: 'invalid' }, past, 0],
  ['null end falls back to start', { start: future, end: null }, past, 0],
  ['authored future date', {}, future, 0],
  ['Date authored future date', {}, new Date(future), 0],
  ['ended historical invite', { start: past, end: past }, past, 1],
  ['end wins over inconsistent future start', { start: future, end: past }, past, 1],
  ['ended timezone offset', { start: '2000-01-01T09:00:00+08:00', end: '2000-01-01T10:00:00+08:00' }, past, 1],
  ['invalid metadata retains authored historical date', { start: 'bad', end: false }, past, 1],
  ['null metadata retains authored historical date', { start: null, end: null }, past, 1],
] as const) {
  test(label, async () => {
    const { result } = await run(fm, date);
    expect(result.entries_created).toBe(count);
    expect(result.meetings_scanned).toBe(count);
  });
}
test('future rows never reach unmanaged writes', async () => {
  const { result, stored } = await run({ start: future, end: future }, past, false);
  expect(result.entries_created).toBe(0);
  expect(stored).toEqual([]);
});
test('ended rows still reach unmanaged writes', async () => {
  const { result, stored } = await run({ start: past, end: past }, past, false);
  expect(result.entries_created).toBe(1);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ summary: 'Discussed in Synthetic meeting', slug: 'people/synthetic' });
});
test('future rows never reach managed admission', async () => {
  managed = true;
  const { result, stored } = await run({ start: future, end: future }, past, false);
  expect(result.entries_created).toBe(0);
  expect(result.meetings_scanned).toBe(0);
  expect(stored).toEqual([]);
  expect(maintenanceCalls).toBe(0);
});
test('private meeting stays withheld', async () => {
  const { result } = await run({ visibility: 'private', start: past, end: past });
  expect(result.entries_created).toBe(0);
});

test('same-day boundary defers upcoming and ongoing, admits at exact end', async () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    for (const [start, end, expected] of [
      ['2026-10-18T13:00:00Z', '2026-10-18T14:00:00Z', 0],
      ['2026-10-18T11:00:00Z', '2026-10-18T12:00:00.001Z', 0],
      ['2026-10-18T11:00:00Z', '2026-10-18T12:00:00Z', 1],
      ['2026-10-18T18:00:00+08:00', '2026-10-18T19:00:00+08:00', 1],
    ] as const) {
      const { result } = await run({ start, end }, '2026-10-18');
      expect(result.entries_created).toBe(expected);
    }
  } finally { clock.mockRestore(); }
});
