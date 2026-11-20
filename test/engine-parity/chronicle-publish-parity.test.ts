/**
 * BrainEngine parity — a Life Chronicle event generation (chronicle/publish.ts, generations/adapters/chronicle-events.ts)
 * answers PGLite's output on Postgres and on a Rust brain: publish, retire when the depth page is gone, restore when it
 * comes back, and each typed member the chronicle paths read and write through.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each case gives the same answer on PGLite, Postgres and the Rust engine: the events a publication writes
 *    and their projection rows on the depth page's timeline, the events C-6 retires when the depth page is gone
 *    (retireOrphanedChronicleEvents, `retired_by` stamp, projection rows deleted), the event a later publication
 *    writes again over its retired page, which the generation ledger verifies (`ledgerRetired`), with its projection row, and what each chronicle member
 *    returns: readChronicleDepthRow, pageSlugExists, listPageContentHashes (`ids` with deleted pages, `live_slugs`
 *    without), listChronicleEventSlotRows, listEventProjectionRows, readEventProjectionId, deleteEventProjections,
 *    restoreEventProjection, listRetiredGenerationItemKeys, listLiveGenerationItems, listOrphanedChronicleOwners,
 *    listChronicleOwnedHashes and hasChronicleSkipDecision.
 *  - Regression: the chronicle adapter, publish.ts and event-identity.ts sent these reads and writes through
 *    `executeRaw`, so a Rust brain stopped on the typed `raw_sql` refusal at the first chronicle read: it published,
 *    retired and restored no event.
 *  - Rust arm on this branch: the real publication (first case) records derivation edges for each event
 *    (adapters/chronicle-events.ts lowerDerivedPageIn → trust/taint.ts recordTaintEdges →
 *    facts/derivation-inputs.ts recordDerivationInputs), which still send raw SQL here, so that case stops on the typed
 *    `raw_sql` refusal (rust-tally.tsv). The derivation edges are typed on rust-engine/derivation-trust. The second
 *    case runs the same lifecycle with an adapter whose publishItems writes the event without the derivation stamp, so
 *    every other chronicle member is compared on the Rust arm now. The chronicle ledger (`chronicle_page_state`) has
 *    no Rust store yet: listChronicleOwnedHashes answers [] and hasChronicleSkipDecision false, which is what a SQL
 *    brain answers when the ledger holds nothing for the page, as here.
 *  - Why existing coverage misses it: test/trust-taint.test.ts publishes one event on PGLite only and reads it through
 *    executeRaw; no parity file publishes, retires or restores a chronicle event.
 *  - Seam: none. Typed members and the real generation paths only (no executeRaw: D18). Page ids differ between
 *    engines, so every answer names a page by its slug. Postgres runs when DATABASE_URL is set (testBackends); the
 *    Rust arm runs through test/engine-parity/harness.ts.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { buildChronicleEvent, pinDepth, publishChronicleGeneration, retireOrphanedChronicleEvents, type BuiltChronicleEvent } from '../../src/core/chronicle/publish.ts';
import {
  CHRONICLE_EVENT_KIND, chronicleEventAdapter, chronicleEventItem, chronicleOwnerKey, type ChronicleEventContent, type ChronicleGenerationContext,
} from '../../src/core/generations/adapters/chronicle-events.ts';
import { publishGeneration } from '../../src/core/generations/publish.ts';
import { originGone } from '../../src/core/generations/proofs.ts';
import type { GenerationAdapter } from '../../src/core/generations/contract.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';

const { parityTest } = parityArms(testBackends());

const DEPTH = 'meetings/2026-01-05-planning';

async function putDepth(engine: BrainEngine) {
  await engine.putPage(DEPTH, { type: 'meeting' as never, title: 'Planning', compiled_truth: 'We planned the launch and the hiring loop.', timeline: '' });
  return (await engine.readPageSnapshot(DEPTH, { sourceId: 'default' }))!;
}

/** Two events of the depth page, built the way the chronicle extractor builds them. */
async function events(engine: BrainEngine, whats: readonly string[]): Promise<BuiltChronicleEvent[]> {
  const pin = await pinDepth(engine, (await engine.readPageSnapshot(DEPTH, { sourceId: 'default' }))!);
  return whats.map(what => buildChronicleEvent({ when: '2026-01-05', who: ['alice-example'], what, kind: 'decision' }, {
    depthSlug: DEPTH, attendees: [], effectiveDate: '2026-01-05', tz: 'UTC', visibility: pin.visibility, depthHash: pin.contentHash,
    isoDay: when => when.slice(0, 10), normalizeKind: kind => kind,
  }));
}
const A = 'Decided to launch in March';
const B = 'Decided to open two roles';

/** The id of each page of `slugs` that exists, deleted pages included. */
async function pageIds(engine: BrainEngine, slugs: readonly string[]) {
  const out: Array<{ slug: string; id: number }> = [];
  for (const slug of slugs) {
    const snap = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
    if (snap) out.push({ slug, id: Number(snap.page.id) });
  }
  return out;
}

/** Each event page's state and the projection rows of the depth page, by slug and summary. */
async function state(engine: BrainEngine, slugs: readonly string[]) {
  const pages = await Promise.all(slugs.map(async slug => {
    const snap = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
    return { slug, live: snap ? !snap.page.deleted_at : null, retiredBy: snap?.page.frontmatter?.retired_by ?? null };
  }));
  const ids = await pageIds(engine, slugs);
  const projections = (await engine.listEventProjectionRows(ids.map(r => r.id)))
    .map(row => `${ids.find(r => r.id === Number(row.event_page_id))?.slug} ${row.date} ${row.summary}`).sort();
  const slots = (await engine.listChronicleEventSlotRows('default', slugs)).map(row => `${row.slug} ${row.when} ${row.where} ${row.kind}`).sort();
  return { pages, projections, slots };
}

/** The chronicle adapter without the derivation stamp: the event page and its projection row, as publishItems writes them. */
const unstampedAdapter: GenerationAdapter<ChronicleGenerationContext> = {
  ...chronicleEventAdapter,
  async publishItems(tx, key, items) {
    const depth = key.ownerKey.slice('depth:'.length);
    for (const item of items) {
      const event = JSON.parse(item.content) as ChronicleEventContent;
      const live = await tx.readPageSnapshot(item.key, { sourceId: key.sourceId });
      if (live) await tx.createVersion(item.key, { sourceId: key.sourceId, preimage: live });
      await tx.putPage(item.key, { type: 'event', title: event.title, compiled_truth: event.compiledTruth, frontmatter: { type: 'event', ...event.frontmatter },
        effective_date: new Date(event.when) }, { sourceId: key.sourceId });
      await tx.upsertEventProjection({ depthSlug: depth, eventSlug: item.key, date: event.day, summary: event.summary, sourceId: key.sourceId });
    }
  },
};

async function publishUnstamped(engine: BrainEngine, built: readonly BuiltChronicleEvent[], opts: { gone?: boolean } = {}) {
  const key = { kind: CHRONICLE_EVENT_KIND, sourceId: 'default', ownerKey: chronicleOwnerKey(DEPTH) };
  const context: ChronicleGenerationContext = { decisionRequestId: null };
  const items = built.map(event => chronicleEventItem(event.slug, { markdown: serializeMarkdown(event.frontmatter, event.compiledTruth, '', { type: 'event', title: event.title, tags: [] }),
    title: event.title, compiledTruth: event.compiledTruth, frontmatter: event.frontmatter, when: event.when, day: event.day, summary: event.summary }));
  context.planned = Object.fromEntries(items.map(item => [item.key, item.identityHash]));
  const input = opts.gone ? null : await chronicleEventAdapter.readInput(engine, key, context);
  const outcome = await publishGeneration(engine, unstampedAdapter, { key, items, input, partial: false, ...(opts.gone ? { proof: originGone() } : {}), context });
  return outcome ? { state: outcome.state, retired: 'retired' in outcome ? [...outcome.retired].sort() : [] } : null;
}

/** Publish [A, B], soft-delete the depth page and retire its events, bring the depth page back and publish [A]. */
async function lifecycle(engine: BrainEngine, publish: (built: BuiltChronicleEvent[]) => Promise<unknown>, retire: () => Promise<unknown>) {
  await putDepth(engine);
  const both = await events(engine, [A, B]);
  const slugs = both.map(e => e.slug).sort();
  const published = await publish(both);
  const afterPublish = await state(engine, slugs);
  await engine.softDeletePage(DEPTH, { sourceId: 'default' });
  const orphaned = await engine.listOrphanedChronicleOwners('default', CHRONICLE_EVENT_KIND, 10);
  const retired = await retire();
  const afterRetire = await state(engine, slugs);
  const ledgerRetired = await engine.listRetiredGenerationItemKeys('default', CHRONICLE_EVENT_KIND, slugs);
  await engine.restorePage(DEPTH, { sourceId: 'default' });
  const again = await publish(await events(engine, [A]));
  const afterRestore = await state(engine, slugs);
  const live = (await engine.listLiveGenerationItems({ sourceId: 'default', kind: CHRONICLE_EVENT_KIND, ownerKey: chronicleOwnerKey(DEPTH) })).map(r => r.item_key).sort();
  const label = (slug: string) => (slug === both[0]!.slug ? 'A' : 'B');
  return { published, afterPublish, orphaned, retired, afterRetire, ledgerRetired: ledgerRetired.map(label).sort(), again, afterRestore, live: live.map(label).sort(), slugs };
}

describe('engine parity: Life Chronicle event generations', () => {
  parityTest('publishChronicleGeneration publishes the events, C-6 retires them when the depth page is gone, and a later publication restores one', {
    methods: ['putPage', 'readPageSnapshot', 'softDeletePage', 'restorePage', 'readChronicleDepthRow', 'listChronicleOwnedHashes', 'listRetiredGenerationItemKeys',
      'listEventProjectionRows', 'listPageContentHashes', 'listLiveGenerationItems', 'pageSlugExists', 'deleteEventProjections',
      'listOrphanedChronicleOwners', 'listChronicleEventSlotRows'],
  }, async (engine) => {
    const out = await lifecycle(engine,
      async built => {
        const pin = await pinDepth(engine, (await engine.readPageSnapshot(DEPTH, { sourceId: 'default' }))!);
        const r = await publishChronicleGeneration(engine, { sourceId: 'default', pin, events: built, decisionRequestId: null, replaces: true, maintenance: null });
        return { written: r.written.map(w => w.slug).sort(), retired: [...r.retired].sort(), protected: r.protected, superseded: r.superseded ?? null };
      },
      () => retireOrphanedChronicleEvents(engine, 'default', null));
    expect(out.retired).toBe(2);
    expect(out.afterRetire.projections).toEqual([]);
    expect(out.ledgerRetired).toEqual(['A', 'B']);
    expect(out.live).toEqual(['A']);
    return out;
  });

  parityTest('the same lifecycle without the derivation stamp: every chronicle member answers PGLite on each arm', {
    methods: ['putPage', 'readPageSnapshot', 'softDeletePage', 'restorePage', 'readChronicleDepthRow', 'listChronicleOwnedHashes', 'listRetiredGenerationItemKeys',
      'listEventProjectionRows', 'listPageContentHashes', 'listLiveGenerationItems', 'deleteEventProjections',
      'listOrphanedChronicleOwners', 'listChronicleEventSlotRows', 'upsertEventProjection'],
  }, async (engine) => {
    const out = await lifecycle(engine, built => publishUnstamped(engine, built), () => publishUnstamped(engine, [], { gone: true }));
    expect(out.ledgerRetired).toEqual(['A', 'B']);
    expect(out.live).toEqual(['A']);
    return out;
  });

  parityTest('each chronicle member read and write, called directly', {
    methods: ['putPage', 'softDeletePage', 'readChronicleDepthRow', 'pageSlugExists', 'listPageContentHashes', 'listChronicleEventSlotRows', 'upsertEventProjection',
      'listEventProjectionRows', 'readEventProjectionId', 'deleteEventProjections', 'restoreEventProjection', 'listChronicleOwnedHashes', 'hasChronicleSkipDecision',
      'listOrphanedChronicleOwners', 'listRetiredGenerationItemKeys', 'listLiveGenerationItems'],
  }, async (engine) => {
    const depth = await putDepth(engine);
    const [a, b] = await events(engine, [A, B]);
    for (const e of [a!, b!]) {
      await engine.putPage(e.slug, { type: 'event', title: e.title, compiled_truth: e.compiledTruth, frontmatter: { type: 'event', ...e.frontmatter }, timeline: '' });
      await engine.upsertEventProjection({ depthSlug: DEPTH, eventSlug: e.slug, date: e.day, summary: e.summary, sourceId: 'default' });
    }
    await engine.softDeletePage(b!.slug, { sourceId: 'default' });
    const slugs = [a!.slug, b!.slug, 'life/events/none'];
    const slotRows = await engine.listChronicleEventSlotRows('default', slugs);
    const slots = await pageIds(engine, slugs);
    const idOf = new Map(slots.map(row => [row.id, row.slug]));
    const name = (id: unknown) => idOf.get(Number(id)) ?? (Number(id) === Number(depth.page.id) ? DEPTH : `#${id}`);
    const depthRow = await engine.readChronicleDepthRow('default', DEPTH);
    const projections = async () => (await engine.listEventProjectionRows([...idOf.keys()])).map(r => `${name(r.event_page_id)} ${r.date} ${r.summary} ${r.detail ?? ''}`).sort();
    const before = await projections();
    const entryA = await engine.readEventProjectionId(slots.find(s => s.slug === a!.slug)!.id, a!.day);
    const noEntry = await engine.readEventProjectionId(slots.find(s => s.slug === a!.slug)!.id, '2025-12-31');
    await engine.deleteEventProjections('default', [a!.slug, b!.slug]);
    const afterDelete = await projections();
    await engine.restoreEventProjection({ depthPageId: Number(depth.page.id), date: a!.day, source: `life-chronicle:event:${a!.slug}`, summary: a!.summary,
      detail: 'restored', eventPageId: slots.find(s => s.slug === a!.slug)!.id });
    const afterRestore = await projections();
    const missingDepth = await engine.restoreEventProjection({ depthPageId: 987_654, date: a!.day, source: 'x', summary: 's', detail: '', eventPageId: slots[0]!.id })
      .then(() => 'ok', () => 'refused');
    const hashes = async (q: Parameters<BrainEngine['listPageContentHashes']>[0]) => (await engine.listPageContentHashes(q)).map(r => `${r.slug} ${r.content_hash !== null}`).sort();
    return {
      depthRow: depthRow && { idMatches: Number(depthRow.id) === Number(depth.page.id), live: depthRow.live },
      noDepth: await engine.readChronicleDepthRow('default', 'meetings/none'),
      exists: [await engine.pageSlugExists('default', a!.slug), await engine.pageSlugExists('default', b!.slug), await engine.pageSlugExists('default', 'life/events/none')],
      slots: slotRows.map(s => `${s.slug} ${s.when} ${s.where} ${s.kind}`).sort(),
      byIds: await hashes({ sourceId: 'default', match: 'ids', ids: slots.map(s => s.id) }),
      otherSource: await hashes({ sourceId: 'elsewhere', match: 'ids', ids: slots.map(s => s.id) }),
      liveSlugs: await hashes({ sourceId: 'default', match: 'live_slugs', slugs }),
      before, entryFound: entryA !== null, noEntry, afterDelete, afterRestore, missingDepth,
      owned: await engine.listChronicleOwnedHashes('default', Number(depth.page.id)),
      skip: await engine.hasChronicleSkipDecision({ sourceId: 'default', pageId: Number(depth.page.id), contentHash: String(depth.page.content_hash), extractorVersion: 1, reason: 'too_short' }),
      orphaned: await engine.listOrphanedChronicleOwners('default', CHRONICLE_EVENT_KIND, 10),
      negativeLimit: await engine.listOrphanedChronicleOwners('default', CHRONICLE_EVENT_KIND, -1).then(() => 'ok', () => 'refused'),
      retiredKeys: await engine.listRetiredGenerationItemKeys('default', CHRONICLE_EVENT_KIND, slugs),
      liveItems: await engine.listLiveGenerationItems({ sourceId: 'default', kind: CHRONICLE_EVENT_KIND, ownerKey: chronicleOwnerKey(DEPTH) }),
    };
  });
});
