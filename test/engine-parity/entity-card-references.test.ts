/**
 * BrainEngine parity: the full entity card of a found entity with referrers, read through the `entity` tool by a
 * trusted local caller and by a remote caller on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the card is the same on PGLite, Postgres and Rust, every field but the lookup latency and the page's
 *    write time. Its referrers are grouped by pack-canonical type, newest first inside a group, each row hydrated with
 *    its title, a body preview, its date source and trust tier; a group truncated at 10 rows carries its total and a
 *    get_backlinks continuation. A local caller counts the private referrer too.
 *  - Regression: a read on the card path that a Rust brain refuses. Before the referrer reads were typed, the whole
 *    lookup answered engine_capability_missing (executeRaw, raw_sql) on a Rust brain.
 *  - Contract: a remote caller (read scope, no private-page grant) gets the same card on every arm with the private
 *    referrer left out of the groups and the count: 13 meetings and 2 notes.
 *  - Regression: an engine that ignores the caller's page policy on the card's referrer reads shows the private note to
 *    a remote caller, or counts it.
 *  - Why existing coverage misses it: the entity card tests (test/entity-card-*.test.ts) run on PGLite only;
 *    entity-card-option-reads.test.ts reads the untrusted referrer groups through readReferrerGroups, not the card
 *    the `entity` tool answers, and pins last_touched.last_retrieved_at after a search, so this file does not repeat it.
 *  - Seam: dispatchToolCall, the MCP tools/call path both transports share; the card is parsed from its text block. An
 *    `engine_capability_missing` answer is rethrown, so an arm that refuses a read on the card path ends on the typed
 *    refusal. The backup check is off: its once-per-process background refresh is not part of the card.
 */
import { describe, expect } from 'bun:test';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { NoticeLedger } from '../../src/core/notice-ledger.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const LOCAL = { remote: false, transport: 'stdio' as const, sourceId: 'default' };
/** A remote caller with a read-scope credential on `default` and no private-page grant. */
const REMOTE = { remote: true, transport: 'http' as const, sourceId: 'default',
  auth: { token: 'parity', clientId: 'parity', clientName: 'parity', scopes: ['read'], sourceId: 'default' } as never };

/** One `entity` tools/call: the parsed card body (or the error text) and the notice codes. */
async function entity(engine: Parameters<typeof dispatchToolCall>[0], name: string, caller: typeof LOCAL | typeof REMOTE = LOCAL) {
  const res = await withEnv({ GBRAIN_BACKUP_CHECK: 'off' },
    () => dispatchToolCall(engine, 'entity', { name }, { ...caller, noticeLedger: new NoticeLedger() }));
  const blocks = res.content.map(c => (c as { text?: string }).text ?? '');
  const text = blocks.find(b => b.trimStart().startsWith('{')) ?? blocks.join('\n');
  const meta = (res as { _meta?: { gbrain_notices?: Array<{ code?: string }> } })._meta;
  const notices = (meta?.gbrain_notices ?? []).map(n => String(n.code)).sort();
  if (res.isError) {
    const parsed = (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })();
    // A brain whose engine refuses a read on the card path: end on that typed refusal, as the Rust arm requires.
    if (parsed?.code === 'engine_capability_missing') throw Object.assign(new Error(String(parsed.message)), parsed);
    return { error: text, body: null, notices };
  }
  return { error: null, body: JSON.parse(text) as Record<string, any>, notices };
}

/** A content date, so a referrer's date is the same on every arm (no row falls back to its write time). */
const dated = (day: string) => ({ effective_date: new Date(`${day}T00:00:00Z`), effective_date_source: 'date' as const });

/** Seed `people/alice-example` with 13 meeting referrers (one group truncates at 10), two notes and one private note. */
async function seed(engine: Parameters<typeof dispatchToolCall>[0]): Promise<void> {
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example runs widget-co.' });
  for (let i = 1; i <= 13; i++) {
    const day = String(i).padStart(2, '0');
    const slug = `meetings/2026-03-${day}`;
    await engine.putPage(slug, { type: 'meeting', title: `Standup ${day}`, compiled_truth: `Met with Alice Example on day ${day}.`,
      frontmatter: { date: `2026-03-${day}` }, ...dated(`2026-03-${day}`) });
    await engine.addLink(slug, 'people/alice-example', 'attendee', 'attendee', 'frontmatter');
  }
  await engine.putPage('notes/widget-plan', { type: 'note', title: 'Widget plan', compiled_truth: 'Alice Example owns the plan.',
    frontmatter: { date: '2026-02-01' }, ...dated('2026-02-01') });
  await engine.addLink('notes/widget-plan', 'people/alice-example', 'owner', 'mentions', 'markdown');
  await engine.putPage('notes/old-idea', { type: 'note', title: 'Old idea', compiled_truth: 'An old idea from Alice Example.',
    frontmatter: { date: '2025-06-01' }, ...dated('2025-06-01') });
  await engine.addLink('notes/old-idea', 'people/alice-example', '', 'mentions', 'markdown');
  await engine.putPage('notes/secret', { type: 'note', title: 'Secret', compiled_truth: 'Private words on Alice Example.',
    frontmatter: { visibility: 'private', date: '2026-01-15' }, ...dated('2026-01-15') });
  await engine.addLink('notes/secret', 'people/alice-example', '', 'mentions', 'markdown');
}

/** The whole card, with the two values that differ by run (the lookup's latency, the page's write time) set aside. */
function cardView(answer: Awaited<ReturnType<typeof entity>>) {
  const body = answer.body ? structuredClone(answer.body) : null;
  if (body) {
    expect(typeof body.latency_ms).toBe('number');
    delete body.latency_ms;
    const touched = body.card?.last_touched as Record<string, unknown> | undefined;
    if (touched) {
      expect(typeof touched.updated_at).toBe('string');
      touched.updated_at = '<write time>';
    }
  }
  return { error: answer.error, notices: answer.notices, body };
}

describe('engine parity: the entity card reference groups', () => {
  parityTest('a found entity shows the same full card, its referrers grouped by type, on every arm',
    { methods: ['putPage', 'addLink', 'readEntityCardRows', 'readReferrerGroupRows', 'readReferrerPageDetails', 'readMentionIndexStatus', 'countLivePagesInSource'] },
    async (engine) => {
      await seed(engine);
      const view = cardView(await entity(engine, 'Alice Example'));
      const card = view.body?.card as Record<string, any> | undefined;
      expect(view.error).toBeNull();
      expect(view.body?.found).toBe(true);
      expect(card?.references_unavailable).toBeUndefined();
      // A local caller reads the private note too: 13 meetings, 3 notes.
      expect(card?.referenced_by_count).toBe(16);
      const groups = (card?.referenced_by ?? []) as Array<{ canonical_type: string; total: number; rows: Array<{ slug: string }>; next?: unknown }>;
      expect(groups.map(g => [g.canonical_type, g.total, g.rows.length, g.next !== undefined])).toEqual([['meeting', 13, 10, true], ['note', 3, 3, false]]);
      expect(groups[0]!.rows[0]!.slug).toBe('meetings/2026-03-13');
      return view;
    });

  parityTest('a remote caller sees the same full card on every arm, with the private referrer left out',
    { methods: ['putPage', 'addLink', 'readEntityCardRows', 'readReferrerGroupRows', 'readReferrerPageDetails', 'readMentionIndexStatus', 'countLivePagesInSource'] },
    async (engine) => {
      await seed(engine);
      const view = cardView(await entity(engine, 'Alice Example', REMOTE));
      const card = view.body?.card as Record<string, any> | undefined;
      expect(view.error).toBeNull();
      expect(view.body?.found).toBe(true);
      expect(card?.references_unavailable).toBeUndefined();
      expect(card?.referenced_by_count).toBe(15);
      const groups = (card?.referenced_by ?? []) as Array<{ canonical_type: string; total: number; rows: Array<{ slug: string }>; next?: unknown }>;
      expect(groups.map(g => [g.canonical_type, g.total, g.rows.length, g.next !== undefined])).toEqual([['meeting', 13, 10, true], ['note', 2, 2, false]]);
      expect(groups.flatMap(g => g.rows.map(r => r.slug))).not.toContain('notes/secret');
      return view;
    });
});
