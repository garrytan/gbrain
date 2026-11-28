/**
 * #9886 (#7247 follow-up): a claim whose only ISO date sits in a wiki link, a Markdown link destination or right before
 * a quoted title names a dated document it refers to, not the date of the fact. claimDate (the repair preview) holds it
 * as referenced_date, and the doctor's SQL count (findBulkFactDays dated_claims) applies the same rule.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimDate, findBulkFactDays } from '../src/core/facts/bulk-days.ts';

const DAY = '2026-05-01';
const REFERENCES = [
  'See [[records/2024-03-14]] for the previous session',
  'Acme Example followed up on [[meetings/2024-03-14|the kickoff]]',
  'See [previous session](records/2024-03-14)',
  'Acme Example delivered what 2024-03-14 “Planning notes” promised',
  '这次活动兑现了 2024-03-14「示例记录」所述的安排',
];
const OWN_DATES = [
  'Acme Example closed a seed round on 2025-03-14',
  'Acme Example closed a seed round on 2025-03-14, see [[companies/acme-example]]',
  'On 2025-03-14 Acme Example signed with [Alice Example](people/alice-example)',
];

describe('#9886 claimDate holds dates that belong to a referenced document', () => {
  test('a date inside a reference is held as referenced_date', () => {
    for (const claim of REFERENCES) expect({ claim, found: claimDate(claim, DAY) }).toEqual({ claim, found: { skip: 'referenced_date' } });
  });
  test('a claim that states its own date next to an undated link still takes it', () => {
    expect(OWN_DATES.map(claim => claimDate(claim, DAY))).toEqual([{ date: '2025-03-14' }, { date: '2025-03-14' }, { date: '2025-03-14' }]);
  });
});

describe('#9886 doctor count agrees with claimDate (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('dated_claims counts own dates and skips referenced ones', async () => {
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
      SELECT 'default', 'companies/filler-' || (g % 24), 'Filler example ' || g || ' is a loaded claim', 'fact', 'world', 'bulk-import', $1::timestamptz
        FROM generate_series(1, 240) AS g`, [`${DAY}T00:00:00Z`]);
    for (const fact of [...REFERENCES, ...OWN_DATES]) {
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
        VALUES ('default', 'companies/acme-example', $1, 'fact', 'world', 'bulk-import', $2::timestamptz)`, [fact, `${DAY}T00:00:00Z`]);
    }
    const [day] = await findBulkFactDays(engine, ['default']);
    expect(day).toMatchObject({ day: DAY, facts: 248, dated_claims: OWN_DATES.length });
  }, 120_000);
});
