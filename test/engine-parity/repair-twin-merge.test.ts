/**
 * BrainEngine parity — batches 6b and 6c: the twin merge (persistence/twin-merge.ts `mergeTwinInto`, its moves in
 * engine-sql/twin-merge-moves.ts) and the origin-twins merge mode, the twin-merge moves called directly
 * (`moveTwinRelationships`, `moveTwinPageChildren`, `moveTwinFacts`), `recordRenameAlias`, the moved-pages fold's
 * version move (`movePageVersions`) and the secret-spans scan's named stop.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the three moves, `recordRenameAlias` and `movePageVersions` answer the same on PGLite, Postgres and the
 *    Rust engine: links and link transitions of every provenance move onto the survivor (the colliding derived rows
 *    dropped, rows between the pair kept), timeline rows and events, raw data, tags, files and page aliases move unless
 *    the survivor holds the same, facts other pages assert about the twin take the survivor slug, and a rename records
 *    its alias. `mergeTwinInto` merges the twin on the SQL engines; the Rust engine still stops it by name ("repair
 *    twin merge") before it reads or writes anything, until the fact rekey members are served there, so the twin keeps
 *    its page and the survivor gains no page version. origin-twins in merge mode stops by name on Rust the same way;
 *    detach mode stays served. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts).
 *  - Regression: the merge wrote a page version and detached the twin's origin before its first raw statement, where the
 *    Rust engine refused it with an unnamed executeRaw error; and the moves themselves refused by name on Rust.
 *  - Why existing coverage misses it: test/origin-twins-6948.test.ts runs on PGLite and Postgres only.
 *    The fold moves every page version of the old page to the survivor on every engine (a missing survivor refuses), and
 *    secret-spans previews a named page on PGLite and Postgres while the Rust engine stops it by name ("repair
 *    secret-spans scan") before any read.
 *  - Seam: none. The merge runs in the engine's own transaction. Seeding uses typed members only. Two seeds have no
 *    typed writer: a tag with no claim (a legacy NULL tag_source; addTag claims `added` or `frontmatter`) and a link
 *    transition of a producer other than `manual` (writeManualLinkTransitions writes only manual rows). The history half
 *    of recordRenameAlias (slug_rename_history) has no typed read on the SQL engines; its Rust rows are pinned by the
 *    cargo test `record_rename_alias_*` and its alias half is compared here.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { mergeTwinInto } from '../../src/core/persistence/twin-merge.ts';
import { resolveOriginTwin, type OriginTwinPair } from '../../src/core/repair/origin-twins.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

async function seedPair(engine: BrainEngine) {
  const note = (slug: string) => ({ type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '' });
  const survivor = await engine.putPage('notes/twin-survivor', { ...note('notes/twin-survivor'), source_path: 'notes/twin-survivor.md' }, { sourceId: 'default' });
  const twin = await engine.putPage('notes/twin-copy', note('notes/twin-copy'), { sourceId: 'default' });
  return { survivor: { page_id: Number(survivor.id), slug: survivor.slug }, twin: { page_id: Number(twin.id), slug: twin.slug } };
}

/** What the merge would change: whether the twin is live, and each page's version count. */
async function state(engine: BrainEngine) {
  const live = async (slug: string) => (await engine.getPage(slug, { sourceId: 'default' })) !== null;
  const versions = async (slug: string) => (await engine.getVersions(slug, { sourceId: 'default' })).length;
  return { twinLive: await live('notes/twin-copy'), survivorLive: await live('notes/twin-survivor'),
    twinVersions: await versions('notes/twin-copy'), survivorVersions: await versions('notes/twin-survivor') };
}

const note = (slug: string, type = 'note') => ({ type: type as never, title: slug, compiled_truth: `${slug} body.`, timeline: '' });

/**
 * The twin and its survivor with every kind of row the merge moves: links of several provenances (a derived duplicate
 * among them), manual link transitions (one duplicate), timeline rows and event projections, raw data of a shared and
 * an unshared source, tags of each claim, a file, page aliases (one collision) and facts asserted by another page, by
 * no page and by the twin itself. Typed writers only.
 */
async function seedRichTwin(engine: BrainEngine) {
  const pair = await seedPair(engine);
  const ids: Record<string, number> = {};
  for (const [slug, type] of [['people/alice', 'person'], ['people/bob', 'person'], ['events/launch', 'event'], ['notes/other', 'note']] as const) {
    ids[slug] = Number((await engine.putPage(slug, note(slug, type), { sourceId: 'default' })).id);
  }
  const { twin, survivor } = pair;
  const slugOf = new Map<number, string>([[twin.page_id, twin.slug], [survivor.page_id, survivor.slug], ...Object.entries(ids).map(([slug, id]) => [id, slug] as [number, string])]);
  // Links: a derived duplicate (twin and survivor both mention alice), a frontmatter duplicate by origin, the twin as
  // target and as origin, a manual link that moves, and a link between the pair that stays.
  await engine.addLink(twin.slug, 'people/alice', 'twin mentions alice', 'mentions', 'markdown');
  await engine.addLink(survivor.slug, 'people/alice', 'twin mentions alice', 'mentions', 'markdown');
  await engine.addLink('people/alice', twin.slug, 'alice works at twin', 'works_at', 'frontmatter', 'people/alice', 'company');
  await engine.addLink('people/bob', 'people/alice', 'bob cites alice', 'cites', 'frontmatter', twin.slug, 'attendees');
  await engine.addLink(twin.slug, survivor.slug, 'see also', 'see_also', 'manual');
  await engine.addLink(twin.slug, 'people/bob', 'knows', 'knows', 'manual');
  await engine.addLink(twin.slug, 'people/bob', 'works with', 'works_with', 'frontmatter', twin.slug, 'employer');
  await engine.addLink(survivor.slug, 'people/bob', 'works with', 'works_with', 'frontmatter', survivor.slug, 'employer');
  const rel = (from: string, to: string, linkType: string) => ({ from, to, linkType, sourceId: 'default' });
  await engine.writeManualLinkTransitions(rel(twin.slug, 'people/alice', 'mentions'), [{ kind: 'start', occurred_on: '2020-01-01' }, { kind: 'end', occurred_on: '2021-01-01' }]);
  await engine.writeManualLinkTransitions(rel(survivor.slug, 'people/alice', 'mentions'), [{ kind: 'start', occurred_on: '2020-01-01' }]);
  await engine.writeManualLinkTransitions(rel('people/alice', twin.slug, 'works_at'), [{ kind: 'start', occurred_on: '2019-05-05' }]);
  // Timeline rows (one exact duplicate, one only on each page) and event projections (one on the twin as depth, one as
  // event page that the survivor repeats on its date, one as event page that moves).
  const entry = (date: string, source: string, summary: string, detail: string) => ({ date, source, summary, detail });
  await engine.addTimelineEntry(twin.slug, entry('2024-01-01', 'meeting', 'Kickoff', 'same detail'), { sourceId: 'default' });
  await engine.addTimelineEntry(survivor.slug, entry('2024-01-01', 'meeting', 'Kickoff', 'same detail'), { sourceId: 'default' });
  await engine.addTimelineEntry(twin.slug, entry('2024-02-02', 'note', 'Only on twin', 'twin detail'), { sourceId: 'default' });
  await engine.addTimelineEntry(survivor.slug, entry('2024-06-06', 'note', 'Only on survivor', 'survivor detail'), { sourceId: 'default' });
  await engine.upsertEventProjection({ depthSlug: twin.slug, eventSlug: 'events/launch', date: '2024-03-03', summary: 'Launch', detail: 'twin attended', sourceId: 'default' });
  await engine.upsertEventProjection({ depthSlug: 'people/alice', eventSlug: twin.slug, date: '2024-04-04', summary: 'Alice at twin', sourceId: 'default' });
  await engine.upsertEventProjection({ depthSlug: 'people/bob', eventSlug: survivor.slug, date: '2024-04-04', summary: 'Bob at survivor', sourceId: 'default' });
  await engine.upsertEventProjection({ depthSlug: 'people/bob', eventSlug: twin.slug, date: '2024-05-05', summary: 'Bob at twin', sourceId: 'default' });
  // Raw data of a shared and an unshared source.
  await engine.putRawData(twin.slug, 'shared-src', { n: 1 }, { sourceId: 'default' });
  await engine.putRawData(survivor.slug, 'shared-src', { n: 1 }, { sourceId: 'default' });
  await engine.putRawData(twin.slug, 'only-twin', { n: 2 }, { sourceId: 'default' });
  // Tags of each claim: the twin's added tags (one the survivor holds as import-owned), the twin's own import tag.
  for (const tag of ['added-only', 'second-added', 'both']) await engine.addTag(twin.slug, tag, { sourceId: 'default' });
  await engine.addTag(twin.slug, 'fm-twin', { sourceId: 'default', tagSource: 'frontmatter' });
  await engine.addTag(survivor.slug, 'both', { sourceId: 'default', tagSource: 'frontmatter' });
  await engine.addTag(survivor.slug, 'on-survivor', { sourceId: 'default' });
  // Files, free-text page aliases (one frontmatter and one derived collision) and facts.
  await engine.upsertFile({ source_id: 'default', page_slug: twin.slug, page_id: twin.page_id, filename: 'twin.png', storage_path: 'default/twin/twin.png', content_hash: 'h-twin', metadata: {} });
  await engine.upsertFile({ source_id: 'default', page_slug: survivor.slug, page_id: survivor.page_id, filename: 'survivor.png', storage_path: 'default/survivor/survivor.png', content_hash: 'h-survivor', metadata: {} });
  await engine.setPageAliases(twin.slug, 'default', ['launch day', 'shared alias']);
  await engine.setPageAliases(survivor.slug, 'default', ['shared alias']);
  await engine.replaceDerivedAliases(twin.slug, 'default', [{ alias_norm: 'twin derived', origin: 'declared', case_sensitive: true, alias_text: 'Twin Derived' }, { alias_norm: 'both derived', origin: 'subject', case_sensitive: false, alias_text: 'Both Derived' }]);
  await engine.replaceDerivedAliases(survivor.slug, 'default', [{ alias_norm: 'both derived', origin: 'subject', case_sensitive: false, alias_text: 'Both Derived' }]);
  const fact = (text: string, entity: string, from: string | null, row: number | null) =>
    ({ kind: 'fact', visibility: 'private', fact: text, entity_slug: entity, row_num: row, source_markdown_slug: from, source: 'mcp:extract_facts' });
  await engine.insertFacts([
    fact('About the twin from another page', twin.slug, 'notes/other', 1),
    fact('The twin\'s own fence row', twin.slug, twin.slug, 1),
    fact('About the twin with no page', twin.slug, null, null),
    fact('About the survivor', survivor.slug, survivor.slug, 1),
  ] as never, { source_id: 'default' });
  return { ...pair, slugOf };
}

/** A date column as `YYYY-MM-DD` (PGLite and Postgres answer a Date, the Rust store a string). */
const day = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);

const PAGES = ['notes/twin-copy', 'notes/twin-survivor', 'people/alice', 'people/bob'] as const;

/** Every link (by its from page) and every manual transition of the seeded pages, as sorted text. */
async function relationshipState(engine: BrainEngine) {
  const links: string[] = [];
  const transitions: string[] = [];
  for (const slug of PAGES) {
    for (const l of await engine.getLinks(slug, { sourceId: 'default' })) {
      links.push(`${l.from_slug} > ${l.to_slug} ${l.link_type} [${l.link_source}] origin=${l.origin_slug ?? '-'} ctx=${l.context}`);
    }
    for (const t of await engine.listManualLinkTransitions(slug, 'default')) transitions.push(`${slug} > ${t.to_slug} ${t.link_type} ${t.kind} ${day(t.occurred_on)}`);
  }
  return { links: links.sort(), transitions: transitions.sort() };
}

/** The timeline, raw data, tags, files and page aliases of the twin and the survivor (and the timeline of the pages that project events). */
async function childrenState(engine: BrainEngine, rich: { twin: { page_id: number; slug: string }; survivor: { page_id: number; slug: string }; slugOf: Map<number, string> }) {
  const pages = [rich.twin, rich.survivor];
  const timeline: Record<string, string[]> = {};
  for (const slug of PAGES) {
    timeline[slug] = (await engine.getTimeline(slug, { limit: 100, sourceId: 'default' } as never)).map(e => {
      const event = (e as { event_page_id?: number | null }).event_page_id;
      return `${day(e.date)} ${e.source} ${e.summary} ${e.detail} event=${event ? rich.slugOf.get(Number(event)) : '-'}`;
    }).sort();
  }
  const raw: Record<string, string[]> = {};
  const tags: Record<string, string[]> = {};
  const files: Record<string, string[]> = {};
  for (const page of pages) {
    raw[page.slug] = (await engine.getRawData(page.slug, undefined, { sourceId: 'default' } as never)).map(r => `${r.source} ${JSON.stringify(r.data)}`).sort();
    tags[page.slug] = (await engine.getTags(page.slug, { sourceId: 'default' })).sort();
    files[page.slug] = (await engine.listFilesForPage(page.page_id)).map(f => `${f.filename} ${f.page_slug} ${rich.slugOf.get(Number(f.page_id))}`).sort();
  }
  const aliases = (await engine.readPageAliasRows(['default'], pages.map(p => p.slug))).map(a => `${a.slug} ${a.alias_norm} ${a.origin} ${a.alias_text}`).sort();
  return { timeline, raw, tags, files, aliases };
}

describe('engine parity: the twin merge on every engine', () => {
  parityTest('mergeTwinInto merges the twin on the SQL engines, and the Rust engine stops it by name before any write', {
    methods: ['putPage', 'transaction', 'getPage', 'getVersions'], requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    const pair = await seedPair(engine);
    const before = await state(engine);
    try {
      const source = await engine.readSourceIncarnation('default');
      const merged = await engine.transaction(tx => mergeTwinInto(tx, { sourceId: 'default', incarnation: source!.incarnation, ...pair }));
      const after = await state(engine);
      expect(after).toEqual({ ...before, twinLive: false, twinVersions: before.twinVersions + 1 });
      return { merged: { ...merged, links_moved: merged.links_moved.length, facts_moved: merged.facts_moved.length }, before, after };
    } catch (err) {
      if (backend === 'rust') {
        expect(refusalText(err)).toContain('repair twin merge');
        expect(await state(engine)).toEqual(before);
      }
      throw err;
    }
  });

  parityTest('origin-twins merge mode stops by name on the Rust engine before it reads the pair', {
    methods: ['putPage'], requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    const seeded = await seedPair(engine);
    const pair: OriginTwinPair = { source_id: 'default', source_path: 'notes/twin-survivor.md', twin_path: 'notes/twin-survivor.md',
      survivor: { ...seeded.survivor, revision: '0' } as never, twin: { ...seeded.twin, revision: '0' } as never, mode: 'merge' };
    const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as never;
    const before = await state(engine);
    try {
      const outcome = await resolveOriginTwin(ctx, pair, null, async () => 'c0000000-0000-4000-8000-0000000000e1');
      expect(await state(engine)).toEqual(before);
      return outcome;
    } catch (err) {
      if (backend === 'rust') {
        expect(refusalText(err)).toContain('repair twin merge');
        expect(await state(engine)).toEqual(before);
      }
      throw err;
    }
  });

  parityTest('movePageVersions moves every version of the old page to the survivor, and refuses a missing survivor', {
    methods: ['putPage', 'createVersion', 'getVersions', 'movePageVersions'], timeout: 60_000,
  }, async (engine) => {
    const pair = await seedPair(engine);
    await engine.createVersion(pair.twin.slug, { sourceId: 'default' });
    await engine.createVersion(pair.twin.slug, { sourceId: 'default' });
    await engine.createVersion(pair.survivor.slug, { sourceId: 'default' });
    const moved = await engine.movePageVersions(pair.twin.page_id, pair.survivor.page_id);
    const none = await engine.movePageVersions(pair.twin.page_id, pair.survivor.page_id);
    await engine.createVersion(pair.twin.slug, { sourceId: 'default' });
    const missing = await engine.movePageVersions(pair.twin.page_id, 987_654).then(() => 'moved', () => 'refused');
    const count = async (slug: string) => (await engine.getVersions(slug, { sourceId: 'default' })).length;
    const answers = { moved: moved.length, ascending: moved.every((id, i) => i === 0 || id > moved[i - 1]!), none, missing,
      twin: await count(pair.twin.slug), survivor: await count(pair.survivor.slug) };
    expect(answers).toEqual({ moved: 2, ascending: true, none: [], missing: 'refused', twin: 1, survivor: 3 });
    return answers;
  });

  parityTest('secret-spans previews a named page on the SQL engines, and the Rust engine stops the scan by name', {
    methods: ['putPage'], requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => {
    await seedPair(engine);
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-b6b-home-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        try {
          const result = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: { info() {}, warn() {}, error() {} } as never }))
            .run('secret-spans', await resolveRepairScope(engine, 'default'), { explicit: true, remote: false, slugs: ['notes/twin-copy'] } as never);
          return { affected: result.affected, residuals: result.residuals };
        } catch (err) {
          if (backend === 'rust') expect(refusalText(err)).toContain('repair secret-spans scan');
          throw err;
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  parityTest('moveTwinRelationships moves links and transitions of every provenance onto the survivor, dropping the colliding derived rows', {
    methods: ['putPage', 'addLink', 'writeManualLinkTransitions', 'listManualLinkTransitions', 'getLinks', 'transaction', 'moveTwinRelationships'],
    timeout: 60_000,
  }, async engine => {
    const rich = await seedRichTwin(engine);
    const before = await relationshipState(engine);
    const moves = await engine.transaction(tx => tx.moveTwinRelationships({ twinId: rich.twin.page_id, survivorId: rich.survivor.page_id }));
    const after = await relationshipState(engine);
    const label = (key: { from_page_id: number; to_page_id: number; link_type: string }) =>
      `${rich.slugOf.get(key.from_page_id)} > ${rich.slugOf.get(key.to_page_id)} ${key.link_type}`;
    const answer = {
      before: moves.before.map(label).sort(), after: moves.after.map(label).sort(),
      linksMoved: moves.linksMoved.length, idsAreNumbers: moves.linksMoved.every(id => Number.isInteger(id)),
      transitionsMoved: moves.transitionsMoved, deduplicated: moves.deduplicated,
      linksBefore: before.links, linksAfter: after.links, transitionsBefore: before.transitions, transitionsAfter: after.transitions,
    };
    expect(answer.deduplicated).toBe(3);
    expect(answer.transitionsMoved).toBe(2);
    // Nothing is left between the twin and a third page except what stayed: the rows between the pair.
    expect(after.links.filter(l => l.includes('notes/twin-copy') && !l.includes('notes/twin-survivor'))).toEqual([]);
    return answer;
  });

  parityTest('moveTwinPageChildren moves timeline rows and events, raw data, tags, files and page aliases the survivor lacks', {
    methods: ['putPage', 'addTimelineEntry', 'upsertEventProjection', 'getTimeline', 'putRawData', 'getRawData', 'addTag', 'getTags', 'pruneFrontmatterTags', 'upsertFile',
      'listFilesForPage', 'setPageAliases', 'replaceDerivedAliases', 'readPageAliasRows', 'transaction', 'moveTwinPageChildren'],
    timeout: 60_000,
  }, async engine => {
    const rich = await seedRichTwin(engine);
    const before = await childrenState(engine, rich);
    const tags = await engine.transaction(tx => tx.moveTwinPageChildren({
      twinId: rich.twin.page_id, survivorId: rich.survivor.page_id, sourceId: 'default', twinSlug: rich.twin.slug, survivorSlug: rich.survivor.slug,
    }));
    const after = await childrenState(engine, rich);
    // The import-owned survivor tag the twin held as its own was claimed `added`, so it outlives the frontmatter prune.
    await engine.pruneFrontmatterTags(rich.survivor.slug, [], { sourceId: 'default' });
    const pruned = { survivor: (await engine.getTags(rich.survivor.slug, { sourceId: 'default' })).sort(), twin: (await engine.getTags(rich.twin.slug, { sourceId: 'default' })).sort() };
    const answer = { tags: [...tags].sort(), before, after, pruned };
    expect(answer.tags).toEqual(['added-only', 'second-added']);
    expect(pruned.survivor).toEqual(['added-only', 'both', 'on-survivor', 'second-added']);
    expect(pruned.twin).toEqual(['both', 'fm-twin']);
    return answer;
  });

  parityTest('moveTwinFacts rekeys the facts other pages assert about the twin, and leaves the twin\'s own fence rows', {
    methods: ['putPage', 'insertFacts', 'listFactsByEntity', 'transaction', 'moveTwinFacts'], timeout: 60_000,
  }, async engine => {
    const rich = await seedRichTwin(engine);
    const facts = async (entity: string) => (await engine.listFactsByEntity('default', entity, { activeOnly: false, limit: 100 } as never))
      .map(f => ({ id: Number(f.id), fact: f.fact, entity: f.entity_slug })).sort((a, b) => a.fact.localeCompare(b.fact));
    const before = { twin: await facts(rich.twin.slug), survivor: await facts(rich.survivor.slug) };
    // The move runs in the engine's transaction: a rollback leaves every fact where it was.
    await engine.transaction(async tx => {
      expect((await tx.moveTwinFacts('default', rich.twin.slug, rich.survivor.slug)).length).toBe(2);
      throw new Error('roll back');
    }).catch(() => undefined);
    expect({ twin: await facts(rich.twin.slug), survivor: await facts(rich.survivor.slug) }).toEqual(before);
    const moved = await engine.transaction(tx => tx.moveTwinFacts('default', rich.twin.slug, rich.survivor.slug));
    const after = { twin: await facts(rich.twin.slug), survivor: await facts(rich.survivor.slug) };
    const text = (id: number) => [...before.twin, ...before.survivor].find(f => f.id === id)!.fact;
    const strip = (rows: typeof before.twin) => rows.map(({ id: _id, ...row }) => row);
    const answer = { moved: moved.map(text).sort(), before: { twin: strip(before.twin), survivor: strip(before.survivor) }, after: { twin: strip(after.twin), survivor: strip(after.survivor) },
      again: await engine.transaction(tx => tx.moveTwinFacts('default', rich.twin.slug, rich.survivor.slug)).then(ids => ids.length) };
    expect(answer.moved).toEqual(['About the twin from another page', 'About the twin with no page']);
    expect(answer.after.twin.map(f => f.fact)).toEqual(['The twin\'s own fence row']);
    return answer;
  });

  parityTest('recordRenameAlias records the rename in the slug aliases, repoints the aliases of the old slug and drops one named like the new slug', {
    methods: ['putPage', 'updateSlug', 'listSlugAliases', 'transaction', 'recordRenameAlias', 'resolveSlugWithAlias'], timeout: 60_000,
  }, async engine => {
    const note = (slug: string) => ({ type: 'note' as never, title: slug, compiled_truth: `${slug} body.`, timeline: '' });
    await engine.putPage('rename/one', note('rename/one'), { sourceId: 'default' });
    expect(await engine.updateSlug('rename/one', 'rename/two', { sourceId: 'default' })).toBe(1);
    const aliases = async () => (await engine.listSlugAliases('default')).map(a => `${a.alias_slug} > ${a.canonical_slug}`).sort();
    const first = await aliases();
    // A merge records the twin's slug as an alias of the survivor and repoints what named the twin.
    await engine.transaction(tx => tx.recordRenameAlias('default', 'rename/two', 'rename/three'));
    const second = await aliases();
    // An alias spelled like the new slug is dropped: a live page owns that slug now.
    await engine.transaction(tx => tx.recordRenameAlias('default', 'rename/three', 'rename/one'));
    const third = await aliases();
    await engine.transaction(tx => tx.recordRenameAlias('default', 'rename/same', 'rename/same'));
    const unchanged = await aliases();
    const resolved = await engine.resolveSlugWithAlias('rename/two', 'default');
    const answer = { first, second, third, unchanged, resolved };
    expect(answer.first).toEqual(['rename/one > rename/two']);
    expect(answer.unchanged).toEqual(answer.third);
    return answer;
  });
});

