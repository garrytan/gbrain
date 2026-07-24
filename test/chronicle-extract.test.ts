/**
 * v0.42.x — Life Chronicle (#2390) auto-emit extractor (Phase A.3).
 * PGLite in-memory. Covers eligibility, the extractor's parse barrier +
 * idempotent writes (event pages + timeline projection), and the backstop's
 * auto_chronicle gating + enqueue. The LLM judge is stubbed so the deterministic
 * write path is tested without a gateway.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import { runChronicleExtract, parseJudgeJson, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { runChronicleBackstop } from '../src/core/chronicle/backstop.ts';
import { runSources } from '../src/commands/sources.ts';
import { isProtectedJobName } from '../src/core/minions/protected-names.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

let engine: PGLiteEngine;
const LONG_BODY = 'A'.repeat(120);

async function countEvents(): Promise<number> {
  const r = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type = 'event'`);
  return Number(r[0].n);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('isChronicleEligible', () => {
  const body = LONG_BODY;
  test('meeting is eligible', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body }).ok).toBe(true);
  });
  test('meetings/ slug rescues a note-typed page', () => {
    expect(isChronicleEligible({ type: 'note', slug: 'meetings/x', body }).ok).toBe(true);
  });
  test('diary is excluded (privacy)', () => {
    expect(isChronicleEligible({ type: 'diary', slug: 'life/diary/x', body })).toEqual({ ok: false, reason: 'diary_excluded' });
  });
  test('event is excluded (anti-loop)', () => {
    expect(isChronicleEligible({ type: 'event', slug: 'life/events/x', body })).toEqual({ ok: false, reason: 'event_self' });
  });
  test('dream-generated is excluded', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body, dreamGenerated: true })).toEqual({ ok: false, reason: 'dream_generated' });
  });
  test('too-short body is excluded', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body: 'hi' })).toEqual({ ok: false, reason: 'too_short' });
  });
  test('unrelated type is excluded', () => {
    expect(isChronicleEligible({ type: 'concept', slug: 'wiki/concepts/x', body })).toEqual({ ok: false, reason: 'kind:concept' });
  });
});

describe('runChronicleExtract', () => {
  const oneEvent: ChronicleJudge = async () => ({
    events: [{ when: '2026-06-18T15:30:00Z', who: ['people/sarah-chen'], what: 'Sarah committed to Q3', kind: 'commitment' }],
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw(`DELETE FROM pages WHERE type = 'event' OR slug = 'meetings/2026-06-18-sync'`);
    await engine.putPage('meetings/2026-06-18-sync', {
      type: 'meeting', title: 'Weekly sync',
      compiled_truth: LONG_BODY,
      frontmatter: { attendees: ['people/sarah-chen'] },
      effective_date: new Date('2026-06-18T15:00:00Z'),
    });
  });

  test('writes an event page + timeline projection', async () => {
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    expect(r.status).toBe('extracted');
    expect(r.events_written).toBe(1);
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(day.length).toBe(1);
    expect(day[0].summary).toBe('Sarah committed to Q3');
    expect(day[0].page_slug).toBe('meetings/2026-06-18-sync'); // projection keyed to depth
    expect(day[0].event_slug?.startsWith('life/events/2026-06-18-')).toBe(true);
    expect(day[0].kind).toBe('commitment');
  });

  test('is idempotent: running twice yields one event + one projection', async () => {
    await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(day.length).toBe(1);
  });

  test('parse barrier: a malformed proposal writes NOTHING', async () => {
    const before = await countEvents();
    const bad: ChronicleJudge = async () => ({ events: [{ when: '2026-06-18', who: [], kind: 'x' } as never] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: bad });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('malformed_proposal');
    expect(await countEvents()).toBe(before); // no partial write
  });

  test('parse barrier: a non-date `when` writes NOTHING (codex fix #2)', async () => {
    const before = await countEvents();
    const badDate: ChronicleJudge = async () => ({ events: [{ when: 'not-a-date', who: [], what: 'x', kind: 'meeting' }] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: badDate });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('malformed_proposal');
    expect(await countEvents()).toBe(before);
  });

  test('no events → no_events status', async () => {
    const none: ChronicleJudge = async () => ({ events: [] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: none });
    expect(r.status).toBe('no_events');
  });

  // #2606: a truncated or unparseable judge response must NOT be recorded as
  // a legitimate no_events — it gets a distinct skipped reason.
  test('truncated judge output → skipped/judge_truncated, not no_events (#2606)', async () => {
    const truncated: ChronicleJudge = async () => ({ events: [], failure: 'truncated' });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: truncated });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('judge_truncated');
    expect(await countEvents()).toBe(0);
  });

  test('unparseable judge output → skipped/judge_parse_failed (#2606)', async () => {
    const parseFailed: ChronicleJudge = async () => ({ events: [], failure: 'parse_failed' });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: parseFailed });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('judge_parse_failed');
  });
});

describe('runChronicleExtract — mirrored-source guard (#2786)', () => {
  const oneEvent: ChronicleJudge = async () => ({
    events: [{ when: '2026-07-01T10:00:00Z', who: ['people/a'], what: 'Something happened', kind: 'meeting' }],
  });

  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM timeline_entries`);
    await engine.executeRaw(`DELETE FROM pages WHERE type = 'event' OR slug = 'meetings/mirror-test'`);
    await engine.executeRaw(
      `DELETE FROM sources WHERE id IN ('legacy-mirror', 'legacy-mirror-2', 'legacy-mirror-3', 'legacy-mirror-4', 'legacy-mirror-5a', 'legacy-mirror-5b', 'legacy-mirror-6', 'legacy-mirror-7', 'legacy-mirror-8', 'legacy-mirror-9')`,
    );
  });

  // Exact repro from the issue: source A ('default', canonical) and source B
  // ('legacy-mirror', DB-only — no local_path) both hold the identical page
  // at the same slug. Backfill scoped to B must refuse to derive, not fork.
  test('skips when the scoped non-default, non-file-backed source holds a byte-identical mirror of another source\'s page', async () => {
    await runSources(engine, ['add', 'legacy-mirror', '--no-federated']);
    await engine.putPage('meetings/mirror-test', { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY }); // default
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY }, // identical content → identical content_hash
      { sourceId: 'legacy-mirror' },
    );

    const before = await countEvents();
    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror', judge: oneEvent,
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('mirrored_source_slug');
    expect(await countEvents()).toBe(before); // no db-only fork written
  });

  // The reporter's own remediation (re-derive at the canonical source, then
  // remove the legacy one) must keep working after this fix.
  test('still derives normally when scoped to the canonical source ("default"), even though a legacy mirror exists elsewhere', async () => {
    await runSources(engine, ['add', 'legacy-mirror', '--no-federated']);
    await engine.putPage('meetings/mirror-test', { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY });
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY },
      { sourceId: 'legacy-mirror' },
    );

    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'default', judge: oneEvent,
    });
    expect(r.status).toBe('extracted');
    expect(r.events_written).toBe(1);
  });

  // Same-slug-DIFFERENT-content across sources is the supported multi-tenant
  // shape (multi-source-drift.test.ts's OV4 case) — must NOT be flagged as a
  // mirror just because the slug string collides.
  test('does NOT skip when the same slug holds different content across sources', async () => {
    await runSources(engine, ['add', 'legacy-mirror-2', '--no-federated']);
    await engine.putPage('meetings/mirror-test', { type: 'meeting', title: 'Unrelated at default', compiled_truth: LONG_BODY });
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Different content', compiled_truth: `${LONG_BODY} extra` },
      { sourceId: 'legacy-mirror-2' },
    );

    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-2', judge: oneEvent,
    });
    expect(r.status).toBe('extracted');
    expect(r.events_written).toBe(1);
  });

  // A non-default source with its OWN local_path is a real, separately
  // rooted working tree, not a throwaway DB-only mirror — it derives normally
  // even when a byte-identical copy also lives elsewhere.
  test('does NOT skip when the scoped source is file-backed (has its own local_path)', async () => {
    await runSources(engine, ['add', 'legacy-mirror-3', '--no-federated']);
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = $2`, ['/tmp/gbrain-2786-fixture', 'legacy-mirror-3']);
    await engine.putPage('meetings/mirror-test', { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY });
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY },
      { sourceId: 'legacy-mirror-3' },
    );

    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-3', judge: oneEvent,
    });
    expect(r.status).toBe('extracted');
  });

  // codex review P2: content_hash alone doesn't cover effective_date. Two
  // pages with byte-identical title/type/body/frontmatter but a DIFFERENT
  // inferred meeting date must NOT be treated as the same mirror — the
  // DB-only source's correctly-dated event would otherwise be lost.
  test('does NOT skip when content is byte-identical but effective_date differs (codex P2)', async () => {
    await runSources(engine, ['add', 'legacy-mirror-4', '--no-federated']);
    // effective_date_source must be a REAL source ('date' here), not left
    // NULL/unset — a NULL source means "no real date info" (treated like
    // 'fallback' per codex round 7 P1) and would wrongly bypass the date
    // check this test exists to exercise. The normal import pipeline always
    // pairs effective_date with a non-NULL effective_date_source; this
    // fixture mirrors that real invariant.
    await engine.putPage('meetings/mirror-test', {
      type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY,
      effective_date: new Date('2026-07-01T10:00:00Z'),
      effective_date_source: 'date',
    });
    await engine.putPage(
      'meetings/mirror-test',
      {
        type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY, // identical content_hash inputs
        effective_date: new Date('2026-07-02T10:00:00Z'), // different date
        effective_date_source: 'date',
      },
      { sourceId: 'legacy-mirror-4' },
    );

    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-4', judge: oneEvent,
    });
    expect(r.status).toBe('extracted');
    expect(r.events_written).toBe(1);
  });

  // codex review round 4 (P1): `page.effective_date` from `engine.getPage()`
  // is ALWAYS undefined (both engines' getPage() projection omits the
  // column) — a prior version of this fix silently compared against that
  // always-null value instead of the real DB column, so this exact case
  // (byte-identical content AND a genuinely matching non-NULL date) is the
  // one that would have falsely proceeded to extract instead of skipping,
  // even though it's a real, same-date mirror. Locks in the fetch-the-real-
  // column fix.
  test('DOES skip when content is byte-identical AND effective_date genuinely matches (non-NULL, codex round 4 P1)', async () => {
    await runSources(engine, ['add', 'legacy-mirror-6', '--no-federated']);
    const sameDate = new Date('2026-07-03T10:00:00Z');
    // effective_date_source: 'date' on both sides so this exercises the
    // REAL-date-equality branch distinctly from the NULL/fallback branch
    // (covered separately by the round 6/7 fallback and NULL-provenance
    // tests below).
    await engine.putPage('meetings/mirror-test', {
      type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY,
      effective_date: sameDate, effective_date_source: 'date',
    });
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY, effective_date: sameDate, effective_date_source: 'date' },
      { sourceId: 'legacy-mirror-6' },
    );

    const before = await countEvents();
    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-6', judge: oneEvent,
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('mirrored_source_slug');
    expect(await countEvents()).toBe(before);
  });

  // codex review round 6 (P1): two byte-identical copies with NO real date
  // (both stamped effective_date_source='fallback' from their own distinct
  // import times) must still be recognized as the same mirror. A naive
  // exact-date comparison would see two DIFFERENT fallback timestamps and
  // wrongly let extraction proceed — reintroducing the original #2786
  // data-loss bug this whole guard exists to prevent.
  test('DOES skip when content is byte-identical and BOTH sides have fallback (no real) dates, even with different fallback timestamps (codex round 6 P1)', async () => {
    await runSources(engine, ['add', 'legacy-mirror-7', '--no-federated']);
    await engine.putPage('meetings/mirror-test', {
      type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY,
      effective_date: new Date('2026-06-01T00:00:00Z'), // e.g. default's own import time
      effective_date_source: 'fallback',
    });
    await engine.putPage(
      'meetings/mirror-test',
      {
        type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY,
        effective_date: new Date('2026-07-04T00:00:00Z'), // different — the mirror's own later import time
        effective_date_source: 'fallback',
      },
      { sourceId: 'legacy-mirror-7' },
    );

    const before = await countEvents();
    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-7', judge: oneEvent,
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('mirrored_source_slug');
    expect(await countEvents()).toBe(before);
  });

  // codex review round 7 (P1): a legacy row that predates the v0.29.1
  // effective_date/effective_date_source backfill has NULL for BOTH columns
  // (never explicitly 'fallback' — the column simply never got populated).
  // The scoped legacy copy has NULL date info; its durable mirror has a
  // real, populated date. Must still be caught as a mirror — NULL
  // provenance carries no more real-date meaning than 'fallback' does.
  test('DOES skip when the scoped (legacy) copy has NULL date/date_source and the durable copy has a real date (codex round 7 P1)', async () => {
    await runSources(engine, ['add', 'legacy-mirror-9', '--no-federated']);
    await engine.putPage('meetings/mirror-test', {
      type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY,
      effective_date: new Date('2026-07-05T00:00:00Z'),
      effective_date_source: 'date',
    });
    // No effective_date / effective_date_source at all — simulates a
    // pre-v0.29.1 row where the columns were never backfilled.
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY },
      { sourceId: 'legacy-mirror-9' },
    );

    const before = await countEvents();
    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-9', judge: oneEvent,
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('mirrored_source_slug');
    expect(await countEvents()).toBe(before);
  });

  // codex review round 6 (P2): a source that WAS file-backed but has since
  // been archived is no longer a durable home — its scheduled purge would
  // delete events derived here right along with it. Must not be treated as
  // safe just because `local_path` is still set on the row.
  test('DOES skip (not treat as safe) when the scoped source is file-backed but ARCHIVED (codex round 6 P2)', async () => {
    await runSources(engine, ['add', 'legacy-mirror-8', '--no-federated']);
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1, archived = true WHERE id = $2`,
      ['/tmp/gbrain-2786-archived-fixture', 'legacy-mirror-8'],
    );
    await engine.putPage('meetings/mirror-test', { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY });
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY },
      { sourceId: 'legacy-mirror-8' },
    );

    const before = await countEvents();
    const r = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-8', judge: oneEvent,
    });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('mirrored_source_slug');
    expect(await countEvents()).toBe(before);
  });

  // codex review P2: two non-default, non-file-backed sources holding the
  // same identical page must not mutually block each other — neither is a
  // durable, canonical home to defer to, so both must derive normally.
  test('does NOT mutually block when BOTH sources holding the mirror are non-canonical DB-only', async () => {
    await runSources(engine, ['add', 'legacy-mirror-5a', '--no-federated']);
    await runSources(engine, ['add', 'legacy-mirror-5b', '--no-federated']);
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY },
      { sourceId: 'legacy-mirror-5a' },
    );
    await engine.putPage(
      'meetings/mirror-test',
      { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY },
      { sourceId: 'legacy-mirror-5b' },
    );

    const rA = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-5a', judge: oneEvent,
    });
    expect(rA.status).toBe('extracted');

    await engine.executeRaw(`DELETE FROM timeline_entries`);
    await engine.executeRaw(`DELETE FROM pages WHERE type = 'event'`);

    const rB = await runChronicleExtract(engine, {
      slug: 'meetings/mirror-test', sourceId: 'legacy-mirror-5b', judge: oneEvent,
    });
    expect(rB.status).toBe('extracted');
  });

  // Complementary provenance stamp (partial Option 1): even on a normal,
  // un-skipped derivation, the event records which source its depth page was
  // read from, so a later fork stays auditable.
  test('stamps frontmatter.event.depth_source with the derivation-scoped source', async () => {
    await engine.putPage('meetings/mirror-test', { type: 'meeting', title: 'Sync', compiled_truth: LONG_BODY });
    await runChronicleExtract(engine, { slug: 'meetings/mirror-test', sourceId: 'default', judge: oneEvent });
    const rows = await engine.executeRaw<{ frontmatter: Record<string, unknown> }>(
      `SELECT frontmatter FROM pages WHERE type = 'event' ORDER BY id DESC LIMIT 1`,
    );
    const ev = rows[0].frontmatter.event as Record<string, unknown>;
    expect(ev.depth_source).toBe('default');
  });
});

describe('chronicle_extract job protection (#2786 codex rounds 5-7)', () => {
  // The mirror guard's result is persisted in the job row, and
  // get_job/list_jobs don't source-scope reads — so an unprotected submit
  // path would let a source-restricted remote caller learn about a hidden
  // source by submitting this job directly, bypassing the trusted
  // backstop/backfill callers entirely. (The result itself carries neither
  // source IDs nor a count — see the `reason` docstring in
  // extract-events.ts — since protecting submission alone doesn't scope
  // what a later, legitimate read can see, and even a positive count would
  // confirm a mirror exists somewhere.)
  test('chronicle_extract is registered in PROTECTED_JOB_NAMES', () => {
    expect(isProtectedJobName('chronicle_extract')).toBe(true);
  });

  test('MinionQueue.add rejects chronicle_extract without allowProtectedSubmit', async () => {
    const queue = new MinionQueue(engine);
    await expect(
      queue.add('chronicle_extract', { slug: 'x', sourceId: 'default' }),
    ).rejects.toThrow(/protected job name/);
  });

  test('MinionQueue.add allows chronicle_extract WITH allowProtectedSubmit (trusted callers)', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add(
      'chronicle_extract',
      { slug: 'meetings/protect-test', sourceId: 'default' },
      undefined,
      { allowProtectedSubmit: true },
    );
    expect(job.name).toBe('chronicle_extract');
  });
});

describe('parseJudgeJson failure signalling (#2606)', () => {
  test('a legitimate empty array parses to []', () => {
    expect(parseJudgeJson('[]')).toEqual([]);
    expect(parseJudgeJson('```json\n[]\n```')).toEqual([]);
  });

  test('a valid array round-trips', () => {
    const arr = parseJudgeJson('[{"when":"2026-06-18","who":[],"what":"x","kind":"meeting"}]');
    expect(Array.isArray(arr)).toBe(true);
    expect(arr!.length).toBe(1);
  });

  test('empty / no-array / truncated / non-array responses return null', () => {
    expect(parseJudgeJson('')).toBeNull();
    expect(parseJudgeJson('I found no events worth extracting.')).toBeNull();
    // Truncated mid-array (the maxTokens-cap shape from the issue).
    expect(parseJudgeJson('[{"when":"2026-06-18","who":["a"],"what":"long ev')).toBeNull();
    expect(parseJudgeJson('{"events": 1}')).toBeNull();
  });
});

describe('runChronicleBackstop gating', () => {
  beforeEach(async () => {
    await engine.unsetConfig('auto_chronicle');
    await engine.putPage('meetings/bs', { type: 'meeting', title: 'bs', compiled_truth: LONG_BODY });
  });

  test('skips when auto_chronicle is off (default)', async () => {
    const r = await runChronicleBackstop({ slug: 'meetings/bs', type: 'meeting', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r).toEqual({ enqueued: false, skipped: 'auto_chronicle_off' });
  });

  test('skips a diary page before consulting the flag', async () => {
    const r = await runChronicleBackstop({ slug: 'life/diary/x', type: 'diary', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r).toEqual({ enqueued: false, skipped: 'diary_excluded' });
  });

  test('enqueues a chronicle_extract job when enabled + eligible', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    const r = await runChronicleBackstop({ slug: 'meetings/bs', type: 'meeting', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r.enqueued).toBe(true);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'chronicle_extract'`);
    expect(Number(jobs[0].n)).toBeGreaterThanOrEqual(1);
  });
});
