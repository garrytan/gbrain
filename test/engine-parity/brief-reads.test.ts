/**
 * BrainEngine parity: the proactive brief's calendar, loop and page-edit reads. The brief read google sources,
 * meeting pages, counterparty emails, world loop facts, loop evidence pages, the counterparty page, its newest
 * timeline entry and its revisions as raw SQL. On a Rust brain each read was refused: the catches turned the
 * refusal into no meeting, no loop and no edit, and the SessionStart path stopped. The agent got no brief while
 * every engine still reported success.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the members readBriefMeetingPages, readBriefEmailAliasPages, readBriefWorldFacts, readBriefEditPage,
 *    readBriefTimelineEntry and readBriefPageVersions answer what PGLite answers, and the callers (sessionStartBrief,
 *    turnBrief, meetingCounterparties, assembleBrief) build the same brief.
 *  - Regression: a brief read that runs executeRaw resolves nothing on Rust: no meeting, no calendar trigger, no loop
 *    item and no edit item, or the SessionStart brief stops on the refusal.
 *  - Why existing coverage misses it: test/proactive-brief.test.ts builds a PGLite engine only, and the census has no
 *    google source, meeting page or open loop.
 *  - Seam: none. Pages, aliases, facts, loops, timeline entries and versions are written with typed members; the
 *    google sources take their sync time from a harness fixture. The callers run as production code.
 */
import { describe, expect } from 'bun:test';
import { createSyncedSource, parityArms, sorted, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  __resetBriefStateForTests, assembleBrief, meetingCounterparties, sessionStartBrief, turnBrief, upcomingMeetings,
  type Brief, type BriefClock, type BriefCounterparty,
} from '../../src/core/context/proactive-brief.ts';
import { upsertOpenLoop } from '../../src/core/loops/loops-store.ts';
import { normalizeAlias } from '../../src/core/search/alias-normalize.ts';

const { parityTest } = parityArms(testBackends());

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SRC = 'default';
const clock = (now = Date.now()): BriefClock => ({ now, stopAt: now + 30_000 });
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const page = (type: string, title: string, body = `${title}.`, frontmatter: Record<string, unknown> = {}) => ({
  type: type as 'note', title, compiled_truth: body, timeline: '', frontmatter,
});

/**
 * A fresh google source g1 and a stale one g2, the counterparty pages with their email aliases, and meetings: one
 * in the window, one private, one past, one in the stale source.
 */
async function seedCalendar(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  __resetBriefStateForTests();
  await createSyncedSource(engine, backend, 'g1', { kind: 'google' }, iso(-HOUR));
  await createSyncedSource(engine, backend, 'g2', { kind: 'google' }, iso(-2 * DAY));
  await engine.putPage('people/alice-example', page('person', 'Alice Example', 'Alice Example runs the widget desk.', { email: 'Alice.Work@example.com' }));
  await engine.setPageAliases('people/alice-example', SRC, [normalizeAlias('Alice Example'), normalizeAlias('alice@example.com')]);
  await engine.putPage('people/bram-example', page('person', 'Bram Example'));
  await engine.putPage('people/bram-other', page('person', 'Bram Other'));
  await engine.setPageAliases('people/bram-example', SRC, [normalizeAlias('bram@example.com')]);
  await engine.setPageAliases('people/bram-other', SRC, [normalizeAlias('bram@example.com')]);
  await engine.putPage('people/hidden-example', page('person', 'Hidden Example', 'Hidden.', { visibility: 'private' }));
  await engine.setPageAliases('people/hidden-example', SRC, [normalizeAlias('hidden@example.com')]);
  const meeting = (start: number, attendees: string[], extra: Record<string, unknown> = {}) =>
    page('meeting', 'Sync', 'Sync.', { start: iso(start), attendees, account: 'owner@example.com', ...extra });
  await engine.putPage('meetings/soon', meeting(2 * HOUR, ['alice@example.com', 'owner@example.com', 'bram@example.com', 'hidden@example.com']), { sourceId: 'g1' });
  await engine.putPage('meetings/private', meeting(3 * HOUR, ['carol@example.com'], { visibility: 'private' }), { sourceId: 'g1' });
  await engine.putPage('meetings/past', meeting(-3 * HOUR, ['dana@example.com']), { sourceId: 'g1' });
  await engine.putPage('meetings/stale', meeting(2 * HOUR, ['erin@example.com']), { sourceId: 'g2' });
}

/** An id-free view of a brief: item ids carry sequence numbers, which differ between engines and resets. */
function view(brief: Brief | null) {
  if (!brief) return null;
  const strip = (s: string) => s.replace(/\[(L|F|Ev|Et)\d+\]/g, '[$1]');
  return {
    trigger: brief.trigger,
    counterparties: brief.counterparties.map(c => `${c.source_id}:${c.slug}:${c.display}:${c.confidence}`),
    items: brief.items.map(i => ({ kind: i.kind, id: i.id.replace(/\d+$/, ''), date: i.date, due: i.due ?? false, slug: i.slug, text: i.text })),
    text: strip(brief.text),
  };
}

const alice: BriefCounterparty = { slug: 'people/alice-example', source_id: SRC, display: 'Alice Example', confidence: 1 };

describe('engine parity: proactive brief reads', () => {
  parityTest('upcomingMeetings and meetingCounterparties read fresh google meetings and the one page an email names', {
    methods: ['putPage', 'setPageAliases'],
  }, async (engine, backend) => {
    await seedCalendar(engine, backend);
    const meetings = await upcomingMeetings(engine, clock());
    const counterparties = await meetingCounterparties(engine, SRC, meetings);
    const answer = {
      meetings: meetings.map(m => ({ slug: m.slug, source_id: m.source_id, attendees: sorted(m.attendees) })),
      counterparties: counterparties.map(c => `${c.slug}:${c.display}`),
    };
    expect(answer).toEqual({
      meetings: [{ slug: 'meetings/soon', source_id: 'g1', attendees: ['alice@example.com', 'bram@example.com', 'hidden@example.com'] }],
      counterparties: ['people/alice-example:Alice Example'],
    });
    return answer;
  });

  parityTest('sessionStartBrief briefs the meeting counterparty with its newest world fact', {
    methods: ['putPage', 'setPageAliases', 'insertFact', 'listFactsByEntity'],
  }, async (engine, backend) => {
    await seedCalendar(engine, backend);
    await engine.insertFact({ fact: 'Alice Example signed the renewal.', entity_slug: 'people/alice-example', source: 'test', visibility: 'world', embedding: null } as never, { source_id: SRC });
    const answer = view(await sessionStartBrief(engine, { sourceId: SRC, clock: clock() }));
    expect(answer?.trigger).toBe('session');
    expect(answer?.counterparties).toEqual(['default:people/alice-example:Alice Example:1']);
    expect(answer?.items.map(i => i.id)).toEqual(['F']);
    return answer;
  });

  parityTest('turnBrief takes the calendar trigger when a named counterparty attends, by alias or frontmatter email', {
    methods: ['putPage', 'setPageAliases', 'insertFact'],
  }, async (engine, backend) => {
    await seedCalendar(engine, backend);
    await engine.insertFact({ fact: 'Alice Example moved the launch.', entity_slug: 'people/alice-example', source: 'test', visibility: 'world', embedding: null } as never, { source_id: SRC });
    const named = view(await turnBrief(engine, { sourceId: SRC, prompt: 'What should I know about Alice Example?', clock: clock() }));
    expect(named?.trigger).toBe('calendar');
    // The frontmatter email alone: the alias is gone, the meeting lists the work address.
    await engine.setPageAliases('people/alice-example', SRC, [normalizeAlias('Alice Example')]);
    await engine.putPage('meetings/soon', page('meeting', 'Sync', 'Sync.', { start: iso(2 * HOUR), attendees: ['alice.work@example.com'], account: 'owner@example.com' }), { sourceId: 'g1' });
    const byFrontmatter = view(await turnBrief(engine, { sourceId: SRC, prompt: 'What should I know about Alice Example?', clock: clock() }));
    expect(byFrontmatter?.trigger).toBe('calendar');
    return { named, byFrontmatter };
  });

  parityTest('the loop arm admits a loop through its world fact, or through its evidence page on a widened pull', {
    methods: ['putPage', 'setPageAliases', 'insertFact', 'upsertOpenLoop', 'listOpenLoops'],
  }, async (engine, backend) => {
    await seedCalendar(engine, backend);
    await engine.putPage('emails/thread-a', page('email', 'Term sheet'), { sourceId: 'g1' });
    const world = await engine.insertFact({ fact: 'I owe Alice Example the term sheet.', entity_slug: 'people/alice-example', source: 'test', visibility: 'world', embedding: null } as never, { source_id: 'g1' });
    const hidden = await engine.insertFact({ fact: 'I owe Alice Example a private note.', entity_slug: 'people/alice-example', source: 'test', visibility: 'private', embedding: null } as never, { source_id: 'g1' });
    const loop = (summary: string, factId: number | null) => upsertOpenLoop(engine, {
      sourceId: 'g1', dedupKey: `k:${summary}`, loopType: 'commitment_owed_by_me', counterpartySlug: 'people/alice-example',
      counterpartySourceId: SRC, counterpartyEmail: 'alice@example.com', summary, evidence: [], threadId: null,
      pageSlug: 'emails/thread-a', dueAt: null, detector: 'llm_extract', factId, lastActivityAt: iso(-HOUR),
    } as never);
    await loop('Send Alice the term sheet', Number((world as { id: number }).id));
    await loop('Send Alice the private note', Number((hidden as { id: number }).id));
    const worldOnly = view(await assembleBrief(engine, { trigger: 'pull', counterparties: [alice], local: true, clock: clock() }));
    const widened = view(await assembleBrief(engine, { trigger: 'pull', counterparties: [alice], local: true, includePrivate: true, clock: clock() }));
    expect(worldOnly?.items.filter(i => i.kind === 'loop').map(i => i.text)).toEqual([expect.stringContaining("“I owe Alice Example the term sheet.”")]);
    expect(widened?.items.filter(i => i.kind === 'loop').length).toBe(2);
    return { worldOnly, widened };
  });

  parityTest('the edit arm reads the newest timeline entry, or the lines a revision added', {
    methods: ['putPage', 'setPageAliases', 'createVersion', 'addTimelineEntry'],
  }, async (engine, backend) => {
    await seedCalendar(engine, backend);
    await engine.createVersion('people/alice-example', { sourceId: SRC });
    await engine.putPage('people/alice-example', page('person', 'Alice Example', 'Alice Example runs the widget desk.\nAlice Example joined the board of a-company.'));
    await engine.putPage('people/carol-example', page('person', 'Carol Example'));
    await engine.addTimelineEntry('people/carol-example', { date: new Date().toISOString().slice(0, 10), summary: 'Carol Example opened an office', detail: 'in a new city' }, { sourceId: SRC });
    const carol: BriefCounterparty = { slug: 'people/carol-example', source_id: SRC, display: 'Carol Example', confidence: 1 };
    const hidden: BriefCounterparty = { slug: 'people/hidden-example', source_id: SRC, display: 'Hidden Example', confidence: 1 };
    const remote = view(await assembleBrief(engine, { trigger: 'pull', counterparties: [alice, carol, hidden], local: false, clock: clock() }));
    const widened = view(await assembleBrief(engine, { trigger: 'pull', counterparties: [hidden], local: true, includePrivate: true, clock: clock() }));
    expect(remote?.items.map(i => `${i.id}:${i.slug}`)).toEqual(['Ev:people/alice-example', 'Et:people/carol-example']);
    expect(widened).toBeNull();
    return { remote, widened };
  });

  parityTest('the six brief members answer by privacy, eligibility, byte ceiling and limit', {
    methods: ['putPage', 'setPageAliases', 'insertFact', 'createVersion', 'addTimelineEntry', 'getPage',
      'readBriefMeetingPages', 'readBriefEmailAliasPages', 'readBriefWorldFacts', 'readBriefEditPage', 'readBriefTimelineEntry',
      'readBriefPageVersions'],
  }, async (engine, backend) => {
    await seedCalendar(engine, backend);
    const floor = { floor: 'operator_curated' as const };
    const meetings = (rows: Array<{ slug: string; source_id: string; attendees: unknown; account: string | null; start: string | null }>) =>
      sorted(rows.map(r => `${r.source_id}:${r.slug}:${r.account}:${JSON.stringify(r.attendees)}:${r.start !== null}`));
    const lo = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const hi = `${new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10)}~`;
    const meetingAnswer = {
      fresh: meetings(await engine.readBriefMeetingPages(['g1', 'g2'], lo, hi)),
      oneSource: meetings(await engine.readBriefMeetingPages(['g2'], lo, hi)),
      none: await engine.readBriefMeetingPages([], lo, hi),
      floored: await engine.readBriefMeetingPages(['g1'], lo, hi, floor),
    };
    const aliasRows = await engine.readBriefEmailAliasPages(SRC, ['bram@example.com', 'alice@example.com', 'hidden@example.com', 'bram@example.com']);
    const aliasAnswer = {
      rows: sorted(aliasRows.map(r => `${r.alias_norm}:${r.slug}:${r.title}:${r.type}`)),
      floored: await engine.readBriefEmailAliasPages(SRC, ['alice@example.com'], floor),
    };
    const world = await engine.insertFact({ fact: 'Alice Example leads the desk.', entity_slug: 'people/alice-example', source: 'test', visibility: 'world', embedding: null } as never, { source_id: SRC });
    const priv = await engine.insertFact({ fact: 'Alice Example has a private plan.', entity_slug: 'people/alice-example', source: 'test', visibility: 'private', embedding: null } as never, { source_id: SRC });
    const worldId = Number((world as { id: number }).id);
    const facts = await engine.readBriefWorldFacts([worldId, Number((priv as { id: number }).id), worldId, 999_999]);
    const factAnswer = {
      rows: facts.map(r => ({ same: r.id === worldId, fact: r.fact, trust_tier: r.trust_tier })),
      floored: await engine.readBriefWorldFacts([worldId], floor),
      none: await engine.readBriefWorldFacts([]),
    };
    await engine.createVersion('people/alice-example', { sourceId: SRC });
    await engine.putPage('people/alice-example', page('person', 'Alice Example', 'Alice Example runs the widget desk.\nAlice Example joined a board.'));
    await engine.addTimelineEntry('people/alice-example', { date: new Date().toISOString().slice(0, 10), summary: 'Alice Example moved desks', detail: '' }, { sourceId: SRC });
    const since = new Date(Date.now() - DAY).toISOString();
    const edit = (slug: string, privacy: 'none' | 'caller' | 'floor', maxBytes = 1_000_000) => engine.readBriefEditPage(SRC, slug, maxBytes, { privacy });
    const alicePage = await edit('people/alice-example', 'floor');
    const pageId = alicePage!.id;
    const editAnswer = {
      floor: alicePage && { body: alicePage.compiled_truth, timeline: alicePage.timeline, trust_tier: alicePage.trust_tier, idMatches: pageId === (await engine.getPage('people/alice-example'))?.id },
      tooBig: await edit('people/alice-example', 'floor', 10).then(r => (r ? r.compiled_truth : 'missing')),
      hiddenFloor: await edit('people/hidden-example', 'floor'),
      hiddenNone: await edit('people/hidden-example', 'none').then(r => (r ? r.compiled_truth : 'missing')),
      missing: await edit('people/nobody-example', 'none'),
    };
    const entry = await engine.readBriefTimelineEntry(pageId, since, { privacy: 'floor' });
    const timelineAnswer = {
      entry: entry && { date: entry.date, summary: entry.summary, detail: entry.detail, dated: entry.created_at instanceof Date },
      future: await engine.readBriefTimelineEntry(pageId, new Date(Date.now() + DAY).toISOString(), { privacy: 'none' }),
      floored: await engine.readBriefTimelineEntry(pageId, since, { privacy: 'none', eligibility: floor }),
    };
    const versions = await engine.readBriefPageVersions(pageId, since, 1_000_000, 5);
    const versionAnswer = {
      rows: versions.map(v => ({ body: v.compiled_truth, deleted: v.is_deleted, dated: v.snapshot_at instanceof Date })),
      tooBig: (await engine.readBriefPageVersions(pageId, since, 10, 1)).map(v => v.compiled_truth),
      future: await engine.readBriefPageVersions(pageId, new Date(Date.now() + DAY).toISOString(), 1_000_000, 5),
      badLimit: await engine.readBriefPageVersions(pageId, since, 10, 0).then(() => 'resolved', (e: Error) => e.name),
    };
    expect(meetingAnswer.fresh.map(m => m.split(':')[1])).toEqual(['meetings/past', 'meetings/soon', 'meetings/stale']);
    expect(aliasAnswer.rows).toEqual([
      'alice@example.com:people/alice-example:Alice Example:person',
      'bram@example.com:people/bram-example:Bram Example:person',
      'bram@example.com:people/bram-other:Bram Other:person',
    ]);
    expect(factAnswer.rows.map(r => r.fact)).toEqual(['Alice Example leads the desk.']);
    expect(editAnswer.tooBig).toBeNull();
    expect(editAnswer.hiddenFloor).toBeNull();
    expect(timelineAnswer.entry?.summary).toBe('Alice Example moved desks');
    expect(versionAnswer.rows.length).toBe(1);
    expect(versionAnswer.badLimit).toBe('RangeError');
    return { meetingAnswer, aliasAnswer, factAnswer, editAnswer, timelineAnswer, versionAnswer };
  });
});
