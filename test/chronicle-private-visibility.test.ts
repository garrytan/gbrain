/**
 * Chronicle reads under the page-visibility gate (#4352 class).
 *
 * `get_page`, `search`, `recall` and the other page reads hide
 * `visibility: private` pages from untrusted callers. The chronicle reads
 * (chronicle_day / chronicle_since / chronicle_on_this_day /
 * chronicle_last_seen / ontology_get / ontology_conflicts /
 * volunteer_chronicle) join the same pages but only redacted the diary
 * prefix, so a remote caller who could not read a private page still got
 * its chronicle pointer (page_slug / event_slug) with a non-empty summary
 * and detail. These tests pin:
 *
 *  1. No content and no pointer: a private depth page, a private event page,
 *     and a private entity page produce nothing for `remote: true` and for
 *     the fail-closed `remote: undefined` shape; a trusted local caller
 *     (`remote: false`) still sees every row.
 *  2. Pre-LIMIT: the predicate runs inside the engine query, so a hidden row
 *     never consumes a limit slot (limit=1 still returns the visible row).
 *  3. Ontology resolution: a private provenance page drops out BEFORE the
 *     per-dimension resolution, so the untrusted caller resolves the newest
 *     value they may see rather than a hole; a conflict that only exists
 *     because of a hidden provenance is not reported.
 *  4. The operator opt-out (`search.remote_private_pages=visible`) restores
 *     the pre-gate behavior, same as the sibling reads.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import {
  REMOTE_PRIVATE_PAGES_KEY,
  __resetPrivateVisibilityCacheForTests,
} from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;

const op = (name: string) => operations.find((o) => o.name === name)!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}
const local = () => ctxOf({ remote: false });
const remote = () => ctxOf({ remote: true });
// remote UNDEFINED is the fail-closed `ctx.remote !== false` shape.
const remoteUndef = () => ctxOf({ remote: undefined as unknown as boolean });

// Every token below lives ONLY on private pages or on rows derived from them.
const PRIVATE_TOKENS = [
  'SECRETMARK', 'meetings/secret-sync', 'life/events/2026-06-18-hidden-ev',
  'life/events/2025-06-18-secret', 'people/secret-person', 'secretvalue',
];
function privateToken(payload: unknown): string | null {
  const text = JSON.stringify(payload) ?? '';
  for (const t of PRIVATE_TOKENS) if (text.includes(t)) return t;
  return null;
}

const ANCHOR = '2026-06-18';
const PRIOR = '2025-06-18';

async function insertPage(opts: {
  slug: string; type: string; effectiveDate?: string | null; frontmatter?: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id, slug, type, title, effective_date, frontmatter)
     VALUES ('default', $1, $2, $1, $3::timestamptz, $4::text::jsonb)
     RETURNING id`,
    [opts.slug, opts.type, opts.effectiveDate ?? null, opts.frontmatter ?? '{}'],
  );
  return rows[0].id;
}

const PRIVATE = '{"visibility":"private"}';
const ids: Record<string, number> = {};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  __resetPrivateVisibilityCacheForTests();

  // Depth pages: one world, one private.
  await insertPage({ slug: 'meetings/open-sync', type: 'meeting' });
  await insertPage({ slug: 'meetings/secret-sync', type: 'meeting', frontmatter: PRIVATE });
  // Entity pages: one world, one private (own timeline row below).
  ids.openPerson = await insertPage({ slug: 'people/open-person', type: 'person' });
  ids.secretPerson = await insertPage({ slug: 'people/secret-person', type: 'person', frontmatter: PRIVATE });

  // Event pages. The private/secret rows sort EARLIER in the day than the
  // open row so a post-LIMIT filter would hand a limit=1 caller nothing.
  await insertPage({
    slug: 'life/events/2026-06-18-open', type: 'event', effectiveDate: '2026-06-18T10:00:00Z',
    frontmatter: '{"event":{"who":["people/open-person"],"kind":"meeting"}}',
  });
  await insertPage({
    slug: 'life/events/2026-06-18-from-secret', type: 'event', effectiveDate: '2026-06-18T08:00:00Z',
    frontmatter: '{"event":{"who":["people/open-person"],"kind":"meeting"}}',
  });
  await insertPage({
    slug: 'life/events/2026-06-18-hidden-ev', type: 'event', effectiveDate: '2026-06-18T09:00:00Z',
    frontmatter: `{"visibility":"private","event":{"who":["people/only-seen-privately"],"kind":"meeting"}}`,
  });
  await insertPage({
    slug: 'life/events/2025-06-18-open', type: 'event', effectiveDate: '2025-06-18T10:00:00Z',
    frontmatter: '{"event":{"who":["people/open-person"],"kind":"meeting"}}',
  });
  await insertPage({
    slug: 'life/events/2025-06-18-secret', type: 'event', effectiveDate: '2025-06-18T09:00:00Z',
    frontmatter: '{"visibility":"private","event":{"who":["people/open-person"],"kind":"meeting"}}',
  });

  // Projections: open depth + open event (visible), private depth + world
  // event (hidden by the depth page), open depth + private event (hidden by
  // the event page), prior-year pair for on_this_day.
  await engine.upsertEventProjection({
    depthSlug: 'meetings/open-sync', eventSlug: 'life/events/2026-06-18-open',
    date: ANCHOR, summary: 'open sync event', detail: 'open detail',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/secret-sync', eventSlug: 'life/events/2026-06-18-from-secret',
    date: ANCHOR, summary: 'SECRETMARK from private depth page', detail: 'SECRETMARK detail',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/open-sync', eventSlug: 'life/events/2026-06-18-hidden-ev',
    date: ANCHOR, summary: 'SECRETMARK private event page', detail: 'SECRETMARK detail',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/open-sync', eventSlug: 'life/events/2025-06-18-open',
    date: PRIOR, summary: 'open anniversary',
  });
  await engine.upsertEventProjection({
    depthSlug: 'meetings/open-sync', eventSlug: 'life/events/2025-06-18-secret',
    date: PRIOR, summary: 'SECRETMARK private anniversary',
  });
  // Entity pages' own timeline rows (the getLastSeen `p.slug` arm), on
  // dates outside ANCHOR so the day/since fixtures stay event-only.
  for (const [id, date, summary] of [
    [ids.openPerson, '2026-06-20', 'open person seen'],
    [ids.secretPerson, '2026-06-16', 'SECRETMARK person seen'],
  ] as const) {
    await engine.executeRaw(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       VALUES ($1, $2::date, 'manual', $3, '')`,
      [id, date, summary],
    );
  }

  // Ontology: a newer private-sourced value and an older world-sourced value
  // that stay open side by side (the backdated-conflict shape: the second
  // write is older, so it is inserted without closing the first). Resolution
  // picks the newer valid_from, so local resolves the private value; an
  // untrusted caller must resolve the older world value, not a hole. The
  // same pair is a two-provenance conflict that only exists with the private
  // side present.
  await engine.mergeOntologyFact({
    entitySlug: 'people/open-person', dimension: 'role', value: 'secretvalue',
    source: 'meetings/secret-sync', validFrom: '2026-05-01',
  });
  await engine.mergeOntologyFact({
    entitySlug: 'people/open-person', dimension: 'role', value: 'openvalue',
    source: 'meetings/open-sync', validFrom: '2026-01-01',
  });
  await engine.mergeOntologyFact({
    entitySlug: 'people/conf-person', dimension: 'role', value: 'secretvalue',
    source: 'meetings/secret-sync', validFrom: '2026-05-01',
  });
  await engine.mergeOntologyFact({
    entitySlug: 'people/conf-person', dimension: 'role', value: 'yes',
    source: 'meetings/open-sync', validFrom: '2026-01-01',
  });
}, 60_000);

type Row = { page_slug: string; event_slug: string | null; summary: string; detail: string };

describe('chronicle timeline reads hide private pages from untrusted callers', () => {
  test('chronicle_day: local sees the private rows, remote and remote-undefined get neither content nor pointer', async () => {
    const seen = await op('chronicle_day').handler(local(), { date: ANCHOR }) as Row[];
    expect(privateToken(seen)).not.toBeNull(); // anti-vacuity: the fixture leaks locally
    expect(seen.some((r) => r.page_slug === 'meetings/secret-sync')).toBe(true);
    expect(seen.some((r) => r.event_slug === 'life/events/2026-06-18-hidden-ev')).toBe(true);

    for (const c of [remote(), remoteUndef()]) {
      const rows = await op('chronicle_day').handler(c, { date: ANCHOR }) as Row[];
      expect(privateToken(rows)).toBeNull();
      expect(rows.map((r) => r.event_slug)).toEqual(['life/events/2026-06-18-open']);
      expect(rows[0].summary).toBe('open sync event');
    }
  });

  test('chronicle_since: hidden rows do not consume limit slots (predicate lands before LIMIT)', async () => {
    // The two hidden rows sort first (08:00, 09:00); the visible row is 10:00.
    const rows = await op('chronicle_since').handler(remote(), { date: ANCHOR, limit: 1 }) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].event_slug).toBe('life/events/2026-06-18-open');
    expect(privateToken(rows)).toBeNull();

    const all = await op('chronicle_since').handler(local(), { date: ANCHOR, limit: 1 }) as Row[];
    expect(all).toHaveLength(1);
    expect(all[0].page_slug).toBe('meetings/secret-sync'); // local: the earliest row is the private one
    expect(all[0].event_slug).toBe('life/events/2026-06-18-from-secret');
  });

  test('chronicle_on_this_day: a private prior-year event is hidden remotely, visible locally', async () => {
    const seen = await op('chronicle_on_this_day').handler(local(), { date: ANCHOR }) as Row[];
    expect(seen.some((r) => r.event_slug === 'life/events/2025-06-18-secret')).toBe(true);
    const rows = await op('chronicle_on_this_day').handler(remote(), { date: ANCHOR }) as Row[];
    expect(privateToken(rows)).toBeNull();
    expect(rows.map((r) => r.event_slug)).toEqual(['life/events/2025-06-18-open']);
  });

  test('chronicle_last_seen: a private entity page reads as never seen remotely', async () => {
    type Seen = { last_date: string | null; last_event_slug: string | null; days_ago: number | null };
    const seen = await op('chronicle_last_seen').handler(local(), { entity: 'people/secret-person', asof: '2026-06-20' }) as Seen;
    expect(seen.last_date).toBe('2026-06-16');
    for (const c of [remote(), remoteUndef()]) {
      const hidden = await op('chronicle_last_seen').handler(c, { entity: 'people/secret-person', asof: '2026-06-20' }) as Seen;
      expect(hidden).toMatchObject({ last_date: null, last_event_slug: null, days_ago: null });
    }
  });

  test('chronicle_last_seen: a sighting that exists only through a private event is not evidence remotely', async () => {
    type Seen = { last_date: string | null; last_event_slug: string | null };
    const seen = await op('chronicle_last_seen').handler(local(), { entity: 'people/only-seen-privately', asof: '2026-06-20' }) as Seen;
    expect(seen.last_event_slug).toBe('life/events/2026-06-18-hidden-ev');
    const hidden = await op('chronicle_last_seen').handler(remote(), { entity: 'people/only-seen-privately', asof: '2026-06-20' }) as Seen;
    expect(hidden.last_date).toBeNull();
    expect(hidden.last_event_slug).toBeNull();
  });
});

describe('ontology provenance rows follow the same page-visibility policy', () => {
  test('ontology_get: a private provenance page drops before resolution, so remote resolves the older world value', async () => {
    type Val = { dimension: string; value: string; source: string };
    const seen = await op('ontology_get').handler(local(), { entity: 'people/open-person' }) as Val[];
    expect(seen.find((v) => v.dimension === 'role')?.value).toBe('secretvalue');

    for (const c of [remote(), remoteUndef()]) {
      const rows = await op('ontology_get').handler(c, { entity: 'people/open-person' }) as Val[];
      expect(privateToken(rows)).toBeNull();
      expect(rows.find((v) => v.dimension === 'role')?.value).toBe('openvalue');
    }
  });

  test('ontology_conflicts: a disagreement that needs a private provenance is not reported remotely', async () => {
    type Conflict = { entity_slug: string; values: { value: string; source: string }[] };
    const seen = await op('ontology_conflicts').handler(local(), {}) as Conflict[];
    expect(seen.some((c) => c.entity_slug === 'people/conf-person')).toBe(true);
    const rows = await op('ontology_conflicts').handler(remote(), {}) as Conflict[];
    expect(rows.some((c) => c.entity_slug === 'people/conf-person')).toBe(false);
    expect(privateToken(rows)).toBeNull();
  });

  test('volunteer_chronicle: recent_timeline and ontologies carry no private page, pointer or value', async () => {
    type Vol = { recent_timeline: Row[]; ontologies: Record<string, { value: string }[]> };
    const args = { days: 3650, limit: 50, entities: 'people/open-person' };
    const seen = await op('volunteer_chronicle').handler(local(), args) as Vol;
    expect(privateToken(seen)).not.toBeNull();
    expect(seen.ontologies['people/open-person'].map((v) => v.value)).toContain('secretvalue');

    for (const c of [remote(), remoteUndef()]) {
      const vol = await op('volunteer_chronicle').handler(c, args) as Vol;
      expect(privateToken(vol)).toBeNull();
      expect(vol.recent_timeline.map((r) => `${r.page_slug}|${r.event_slug}`).sort()).toEqual([
        'meetings/open-sync|life/events/2025-06-18-open',
        'meetings/open-sync|life/events/2026-06-18-open',
        'people/open-person|null',
      ]);
      expect(vol.ontologies['people/open-person'].map((v) => v.value)).toEqual(['openvalue']);
    }
  });
});

describe('operator opt-out matches the sibling reads', () => {
  test(`${REMOTE_PRIVATE_PAGES_KEY}=visible restores private rows for remote callers`, async () => {
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    try {
      const rows = await op('chronicle_day').handler(remote(), { date: ANCHOR }) as Row[];
      expect(rows.some((r) => r.page_slug === 'meetings/secret-sync')).toBe(true);
    } finally {
      await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, '');
      __resetPrivateVisibilityCacheForTests();
    }
  });
});
