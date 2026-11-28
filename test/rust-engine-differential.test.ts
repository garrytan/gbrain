/**
 * The Rust engine against PGLite on RAW values.
 *
 * The parity suite compares what a case chooses to return, which is usually a projection (a count, a slug list, a few
 * fields), so a missing key, a lost value or a different default never shows. These scenarios run the same calls on
 * a PGLite engine and on a Rust engine and compare everything the member returned: every key (null or not), every
 * value, and the error a call threw. Only what no two runs can share is normalised: timestamps, UUIDs and row ids.
 *
 * Each scenario says what the Rust engine owes it:
 *  - `equal`: the same outcome as PGLite, value for value.
 *  - `refused`: a typed `engine_capability_missing` refusal, with PGLite doing something else (a refusal is a
 *    statement that the store does not answer this exactly, so it must be a typed one and never a near answer).
 *
 * The test needs the addon `bun run rust:build` writes and skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a
 * missing addon an error, as in test/rust-engine-store.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { createRustSource, openRustBrain, removeBrainDir, rustArmAddonPath, type RustBrainDir } from './engine-parity/rust-arm.ts';

const TARGET = detectAddonTarget();
const HAVE_ADDON = TARGET !== null && existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

type Outcome = { ok: unknown } | { threw: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP_KEYS = /(^|_)(created_at|updated_at|updated_at_iso|deleted_at|snapshot_at|ingested_at|embedded_at|last_written_at|last_sync_at)$/;
const ID_KEYS = new Set(['id', 'page_id', 'event_page_id', 'chunk_id']);

/** What two runs cannot share (clock, UUIDs, row ids) is replaced; every key and every other value stays. */
function normalize(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value === undefined ? '<undefined>' : null;
  if (value instanceof Date) return TIMESTAMP_KEYS.test(key) ? '<timestamp>' : `<Date ${value.toISOString()}>`;
  if (typeof value === 'string') {
    if (UUID.test(value)) return '<uuid>';
    if (TIMESTAMP_KEYS.test(key)) return '<timestamp>';
    return value;
  }
  if (typeof value === 'number' && ID_KEYS.has(key)) return '<id>';
  if (Array.isArray(value)) return value.map((item) => normalize(item, key));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, normalize((value as Record<string, unknown>)[k], k)]));
  }
  return value;
}

async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: normalize(await run()) };
  } catch (error) {
    const e = error as { code?: string; name?: string };
    return { threw: e.code ?? e.name ?? String(error) };
  }
}

interface Arm { engine: BrainEngine; backend: 'pglite' | 'rust' }
type Scenario = { name: string; expect: 'equal' | 'refused'; run: (arm: Arm) => Promise<unknown> };

const NOTE = { type: 'note', title: 'Heliotrope', compiled_truth: 'heliotrope body', timeline: '' } as const;
const text = (index: number, body: string): ChunkInput => ({ chunk_index: index, chunk_text: body, chunk_source: 'compiled_truth' });

/** Live pages of a slug, per source. */
async function liveIn(engine: BrainEngine, slug: string, sources: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const sourceId of sources) out[sourceId] = (await engine.getPage(slug, { sourceId })) !== null;
  return out;
}

/**
 * The links a page owns as the store keeps them, link_kind and resolution_type included (getLinks does not return
 * them). PGLite answers readBeliefStateRows; the Rust engine serves it from its store but refuses it as a member, so
 * the scenario asks the store directly.
 */
async function storedLinks({ engine, backend }: Arm, slug: string): Promise<unknown> {
  const state = backend === 'rust'
    ? await (engine as unknown as { openStore(member: string): { brain: { readBeliefStateRows(args: unknown): Promise<{ links: Array<Record<string, unknown>>; endpoints: Array<Record<string, unknown>> }> } } })
      .openStore('differential').brain.readBeliefStateRows({ sourceId: 'default', slugs: [slug], pageIds: [], knownFp: {}, visibility: { honorAliases: false, entityPrivacy: false } })
    : await engine.readBeliefStateRows({
      sourceId: 'default', slugs: [slug], pageIds: [], knownFp: {}, knownCounts: null, knownPages: [], knownEntitySlugs: [], suppressed: false, planModePrev: null,
    }) as { links: Array<Record<string, unknown>>; endpoints: Array<Record<string, unknown>> };
  const slugOf = new Map((state.endpoints ?? []).map((e) => [Number(e.id), String(e.slug)]));
  return (state.links ?? []).map((l) => ({
    from: slugOf.get(Number(l.f)), to: slugOf.get(Number(l.t)), link_type: l.link_type, link_source: l.link_source,
    context: l.context, link_kind: l.link_kind ?? null, resolution_type: l.resolution_type ?? null,
  })).sort((a, b) => String(a.to).localeCompare(String(b.to)));
}

/** Steps run in order and stop at the first throw, which is the scenario's outcome. */
const scenarios: Scenario[] = [
  // 1. scope of delete, soft delete and restore
  {
    name: 'deletePage with no source touches only the default source',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('del/one', NOTE);
      await engine.putPage('del/one', NOTE, { sourceId: 'work' });
      await engine.deletePage('del/one');
      return liveIn(engine, 'del/one', ['default', 'work']);
    },
  },
  {
    name: 'softDeletePage with no source hides the slug in every source, and says so',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('del/soft', NOTE);
      await engine.putPage('del/soft', NOTE, { sourceId: 'work' });
      const result = await engine.softDeletePage('del/soft');
      return { result, live: await liveIn(engine, 'del/soft', ['default', 'work']) };
    },
  },
  {
    name: 'restorePage with no source brings the slug back in every source',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('del/back', NOTE);
      await engine.putPage('del/back', NOTE, { sourceId: 'work' });
      await engine.softDeletePage('del/back', { sourceId: 'default' });
      await engine.softDeletePage('del/back', { sourceId: 'work' });
      const restored = await engine.restorePage('del/back');
      return { restored, live: await liveIn(engine, 'del/back', ['default', 'work']), again: await engine.restorePage('del/back') };
    },
  },
  {
    name: 'a slug is matched as written by delete, soft delete and restore (PGLite does not fold case there)',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('del/case', NOTE);
      const soft = await engine.softDeletePage('Del/Case');
      await engine.deletePage('Del/Case');
      return { soft, still: await engine.getPage('del/case') !== null, restored: await engine.restorePage('Del/Case') };
    },
  },

  // 2. two live slugs in one source cannot claim one source_path
  {
    name: 'a second live slug claiming the same source_path is rejected',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('origin/a', { ...NOTE, source_path: 'origin/shared.md' });
      await engine.putPage('origin/b', { ...NOTE, source_path: 'origin/shared.md' });
      return 'both written';
    },
  },

  // 3. putPage neither chunks nor seals; chunks are read only while they describe the current text
  {
    name: 'putPage installs no chunks and leaves the projection unsealed; sealing, then a tag change, hides and shows them as PGLite does',
    expect: 'equal',
    run: async ({ engine }) => {
      const put = await engine.putPage('chunks/life', NOTE);
      const afterPut = await engine.getChunks('chunks/life');
      await engine.sealChunks('chunks/life', [text(0, 'heliotrope body')]);
      const sealed = await engine.getChunks('chunks/life');
      const sealedPage = await engine.getPage('chunks/life');
      await engine.addTag('chunks/life', 'late');
      const afterTag = await engine.getChunks('chunks/life');
      await engine.sealChunks('chunks/life', [text(0, 'heliotrope body')]);
      return { put, afterPut, sealed, sealedMatches: sealedPage?.text_projection_revision === sealedPage?.knowledge_revision, afterTag, resealed: (await engine.getChunks('chunks/life')).length };
    },
  },
  {
    name: 'an upsertChunks write without a revision leaves the page unsealed, so the chunks are not read',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('chunks/loose', NOTE);
      await engine.upsertChunks('chunks/loose', [text(0, 'heliotrope body')]);
      return { read: (await engine.getChunks('chunks/loose')).length, page: (await engine.getPage('chunks/loose'))?.text_projection_revision ?? null };
    },
  },

  {
    name: 'upsertChunks with the current revision only checks it; sealChunks seals, and a later upsertChunks leaves the seal alone',
    expect: 'equal',
    run: async ({ engine }) => {
      const put = await engine.putPage('chunks/rev', NOTE);
      await engine.upsertChunks('chunks/rev', [text(0, 'heliotrope body')], { expectedRevision: put.knowledge_revision as string });
      const first = (await engine.getChunks('chunks/rev')).map((c) => c.chunk_text);
      await engine.sealChunks('chunks/rev', [text(0, 'sealed body')]);
      await engine.upsertChunks('chunks/rev', [text(0, 'rewritten body')]);
      const page = await engine.getPage('chunks/rev');
      return { first, second: (await engine.getChunks('chunks/rev')).map((c) => c.chunk_text), sealed: page?.text_projection_revision === page?.knowledge_revision };
    },
  },
  {
    name: 'an upsertChunks write that repeats a chunk keeps the metadata it had; fewer chunks drop the rest; sealChunks replaces outright',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('chunks/inc', NOTE);
      await engine.sealChunks('chunks/inc', [{ ...text(0, 'alpha'), language: 'ts', symbol_name: 'f', start_line: 1, end_line: 4 }, text(1, 'beta'), text(2, 'gamma')]);
      await engine.upsertChunks('chunks/inc', [text(0, 'alpha'), text(1, 'beta changed')]);
      const merged = await engine.getChunks('chunks/inc');
      await engine.sealChunks('chunks/inc', [text(0, 'alpha')]);
      return { merged, replaced: await engine.getChunks('chunks/inc') };
    },
  },
  {
    name: 'an empty chunk list removes the chunks and unseals the page',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('chunks/empty', NOTE);
      await engine.sealChunks('chunks/empty', [text(0, 'alpha')]);
      await engine.upsertChunks('chunks/empty', []);
      const page = await engine.getPage('chunks/empty');
      return { chunks: await engine.getChunks('chunks/empty'), projection: page?.text_projection_revision ?? null };
    },
  },
  {
    name: 'getChunks matches the slug as written, and a soft-deleted page reads as PGLite reads it',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('chunks/case', NOTE);
      await engine.sealChunks('chunks/case', [text(0, 'alpha')]);
      const mixed = (await engine.getChunks('Chunks/Case')).length;
      await engine.softDeletePage('chunks/case');
      const afterSoft = (await engine.getChunks('chunks/case')).length;
      await engine.restorePage('chunks/case');
      const afterRestore = (await engine.getChunks('chunks/case')).length;
      return { mixed, afterSoft, afterRestore };
    },
  },

  // 4. cancellation
  {
    name: 'an already-aborted addTimelineEntriesBatch throws RetryAbortError and writes nothing',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('abort/tl', NOTE);
      const controller = new AbortController();
      controller.abort();
      const outcome = await outcomeOf(() => engine.addTimelineEntriesBatch([{ slug: 'abort/tl', date: '2026-01-02', summary: 's' }] as never, { signal: controller.signal }));
      return { outcome, rows: (await engine.getTimeline('abort/tl')).length };
    },
  },
  {
    name: 'an already-aborted addLinksBatch throws RetryAbortError and writes nothing',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('abort/from', NOTE);
      await engine.putPage('abort/to', NOTE);
      const controller = new AbortController();
      controller.abort();
      const outcome = await outcomeOf(() => engine.addLinksBatch([{ from_slug: 'abort/from', to_slug: 'abort/to' }] as never, { signal: controller.signal }));
      return { outcome, links: (await engine.getLinks('abort/from')).length };
    },
  },
  {
    name: 'an already-aborted upsertChunks throws RetryAbortError and writes nothing',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('abort/chunks', NOTE);
      await engine.sealChunks('abort/chunks', [text(0, 'before')]);
      const controller = new AbortController();
      controller.abort();
      const outcome = await outcomeOf(() => engine.upsertChunks('abort/chunks', [text(0, 'x')], { signal: controller.signal }));
      return { outcome, chunks: (await engine.getChunks('abort/chunks')).map((c) => c.chunk_text) };
    },
  },

  // 7. federated chunk reads
  {
    name: 'getChunks over two sources',
    expect: 'refused',
    run: async ({ engine }) => {
      await engine.putPage('fed/a', NOTE);
      await engine.putPage('fed/a', { ...NOTE, compiled_truth: 'work text' }, { sourceId: 'work' });
      await engine.sealChunks('fed/a', [text(0, 'heliotrope body')]);
      await engine.sealChunks('fed/a', [text(0, 'work text')], { sourceId: 'work' });
      return (await engine.getChunks('fed/a', { sourceIds: ['default', 'work'] })).map((c) => c.chunk_text);
    },
  },

  // 8. search results carry PGLite's projected fields
  {
    name: 'a keyword hit carries effective_date as YYYY-MM-DD and the projected source',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('search/dated', { ...NOTE, compiled_truth: 'quillfeather wombat', effective_date: '2026-03-04', effective_date_source: 'frontmatter' } as never);
      await engine.sealChunks('search/dated', [text(0, 'quillfeather wombat')]);
      const hits = await engine.searchKeyword('quillfeather');
      return hits.map(({ score: _score, ...rest }) => rest);
    },
  },
  {
    name: 'a keyword hit on an undated page carries effective_date and effective_date_source as null, and a dated one beside it carries both',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('search/undated', { ...NOTE, compiled_truth: 'zephyrquill moth' });
      await engine.sealChunks('search/undated', [text(0, 'zephyrquill moth')]);
      await engine.putPage('search/dated-too', { ...NOTE, compiled_truth: 'zephyrquill owl', effective_date: '2026-05-06', effective_date_source: 'frontmatter' } as never);
      await engine.sealChunks('search/dated-too', [text(0, 'zephyrquill owl')]);
      const hits = await engine.searchKeyword('zephyrquill');
      return hits.map(({ score: _score, ...rest }) => rest).sort((a, b) => a.slug.localeCompare(b.slug));
    },
  },

  // 9. shapes
  {
    name: 'putPage, getPage, readPageSnapshot and listPages return the keys and values PGLite returns for each',
    expect: 'equal',
    run: async ({ engine }) => {
      const put = await engine.putPage('shape/page', { ...NOTE, frontmatter: { k: 1 } });
      return {
        put,
        get: await engine.getPage('shape/page'),
        snapshot: (await engine.readPageSnapshot('shape/page'))?.page,
        list: (await engine.listPages({ slugPrefix: 'shape/' })),
      };
    },
  },
  {
    name: 'a chunk reads back with every metadata key and the model PGLite stamps on it',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('shape/chunk', NOTE);
      await engine.sealChunks('shape/chunk', [text(0, 'heliotrope body'), { ...text(1, 'second'), model: 'test:explicit-model', token_count: 7, language: 'ts', symbol_name: 'f', start_line: 3, end_line: 9 }]);
      return engine.getChunks('shape/chunk');
    },
  },
  {
    name: 'a version keeps valid_from, valid_until and replaced_because as PGLite reads them, and no content_hash',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('shape/version', { ...NOTE, frontmatter: { valid_from: '2026-01-05', valid_until: '2026-08-01' } });
      const created = await engine.createVersion('shape/version');
      return { created, listed: await engine.getVersions('shape/version') };
    },
  },
  {
    name: 'a timeline row carries the trust and provenance fields PGLite defaults',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('shape/timeline', NOTE);
      await engine.addTimelineEntry('shape/timeline', { date: '2026-01-02', summary: 'summary' });
      await engine.addTimelineEntriesBatch([{ slug: 'shape/timeline', date: '2026-02-03', summary: 'batched' }] as never);
      return engine.getTimeline('shape/timeline');
    },
  },

  // 10. listColumnsOnly
  {
    name: 'listPages with listColumnsOnly',
    expect: 'refused',
    run: async ({ engine }) => {
      await engine.putPage('cols/page', NOTE);
      return engine.listPages({ slugPrefix: 'cols/', listColumnsOnly: true } as never);
    },
  },

  // 11. source config patch
  {
    name: 'a null in a source config patch is kept as JSON null',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.updateSourceConfig('work', { keep: 1, nullable: null });
      const config = (await engine.listAllSources()).find((s) => s.id === 'work')?.config;
      await engine.updateSourceConfig('work', { keep: null });
      return { config, after: (await engine.listAllSources()).find((s) => s.id === 'work')?.config };
    },
  },

  // 12. slug resolution
  {
    name: 'resolveSlugs answers an exact live slug',
    expect: 'equal',
    run: async ({ engine }) => {
      await engine.putPage('resolve/exact', NOTE);
      return engine.resolveSlugs('resolve/exact');
    },
  },
  {
    name: 'resolveSlugs on a partial name (trigram matching is a later step)',
    expect: 'refused',
    run: async ({ engine }) => {
      await engine.putPage('resolve/zulu-note', { ...NOTE, title: 'Alpha Zulu' });
      return engine.resolveSlugs('Zula');
    },
  },
  {
    name: 'an empty source id never widens a getChunks read: it matches no source, as in PGLite',
    expect: 'equal',
    run: async ({ engine }) => {
      for (const sourceId of ['default', 'work']) {
        await engine.putPage('empty/p', { ...NOTE, timeline: '- **2026-01-01** | x' }, { sourceId });
        await engine.putPage('empty/q', NOTE, { sourceId });
        await engine.addTag('empty/p', `tag-${sourceId}`, { sourceId });
        await engine.sealChunks('empty/p', [text(0, `chunk from ${sourceId}`)], { sourceId });
        await engine.addTimelineEntry('empty/p', { date: '2026-01-02', summary: `entry ${sourceId}` }, { sourceId });
        await engine.addLink('empty/p', 'empty/q', '', 'mentions', undefined, undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
        await engine.createVersion('empty/p', { sourceId });
      }
      const out: unknown[] = [];
      for (const scope of [{ sourceId: '' }, { sourceIds: [''] }, { sourceIds: ['work', ''] }, { sourceId: '', sourceIds: ['work'] }, { sourceIds: [] }, { sourceId: 'nowhere' }]) out.push(await engine.getChunks('empty/p', scope).then((rows) => rows.map((c) => c.chunk_text), (e: { code?: string }) => `threw ${e.code}`));
      return out;
    },
  },
  {
    name: 'an empty source id never widens a getTags read: it matches no source, as in PGLite',
    expect: 'equal',
    run: async ({ engine }) => {
      for (const sourceId of ['default', 'work']) {
        await engine.putPage('empty/p', { ...NOTE, timeline: '- **2026-01-01** | x' }, { sourceId });
        await engine.putPage('empty/q', NOTE, { sourceId });
        await engine.addTag('empty/p', `tag-${sourceId}`, { sourceId });
        await engine.sealChunks('empty/p', [text(0, `chunk from ${sourceId}`)], { sourceId });
        await engine.addTimelineEntry('empty/p', { date: '2026-01-02', summary: `entry ${sourceId}` }, { sourceId });
        await engine.addLink('empty/p', 'empty/q', '', 'mentions', undefined, undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
        await engine.createVersion('empty/p', { sourceId });
      }
      const out: unknown[] = [];
      for (const scope of [{ sourceId: '' }, { sourceIds: [''] }, { sourceIds: ['work', ''] }, { sourceId: '', sourceIds: ['work'] }, { sourceIds: [] }, { sourceId: 'nowhere' }]) out.push(await engine.getTags('empty/p', scope));
      return out;
    },
  },
  {
    name: 'every scoped read treats an empty source id as PGLite does (getPage, snapshot, list, links, graph, timeline, versions, search)',
    expect: 'equal',
    run: async ({ engine }) => {
      for (const sourceId of ['default', 'work']) {
        await engine.putPage('empty/p', { ...NOTE, timeline: '- **2026-01-01** | x' }, { sourceId });
        await engine.putPage('empty/q', NOTE, { sourceId });
        await engine.addTag('empty/p', `tag-${sourceId}`, { sourceId });
        await engine.sealChunks('empty/p', [text(0, `chunk from ${sourceId}`)], { sourceId });
        await engine.addTimelineEntry('empty/p', { date: '2026-01-02', summary: `entry ${sourceId}` }, { sourceId });
        await engine.addLink('empty/p', 'empty/q', '', 'mentions', undefined, undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
        await engine.createVersion('empty/p', { sourceId });
      }
      const out: Record<string, unknown> = {};
      for (const [i, scope] of ([{ sourceId: '' }, { sourceIds: [''] }, { sourceIds: ['work', ''] }, { sourceId: '', sourceIds: ['work'] }] as const).entries()) {
        const sources = (rows: Array<{ source_id?: string }>) => rows.map((r) => r.source_id);
        out[`getPage ${i}`] = (await engine.getPage('empty/p', scope as never))?.source_id ?? null;
        out[`snapshot ${i}`] = (await engine.readPageSnapshot('empty/p', scope as never))?.page.source_id ?? null;
        out[`list ${i}`] = sources(await engine.listPages({ slugPrefix: 'empty/', ...scope } as never));
        out[`links ${i}`] = (await engine.getLinks('empty/p', scope as never)).length;
        out[`backlinks ${i}`] = (await engine.getBacklinks('empty/q', scope as never)).length;
        out[`graph ${i}`] = (await engine.traverseGraph('empty/p', 2, scope as never)).length;
        out[`timeline ${i}`] = (await engine.getTimeline('empty/p', scope as never)).map((t) => t.summary);
        out[`versions ${i}`] = (await engine.getVersions('empty/p', scope as never)).length;
        out[`search ${i}`] = sources(await engine.searchKeyword('chunk', scope as never));
      }
      return out;
    },
  },
  {
    name: 'an empty source id on a delete, restore or link write acts as it does in PGLite (an unscoped soft delete, no link removed)',
    expect: 'equal',
    run: async ({ engine }) => {
      for (const sourceId of ['default', 'work']) {
        await engine.putPage('empty/p', { ...NOTE, timeline: '- **2026-01-01** | x' }, { sourceId });
        await engine.putPage('empty/q', NOTE, { sourceId });
        await engine.addTag('empty/p', `tag-${sourceId}`, { sourceId });
        await engine.sealChunks('empty/p', [text(0, `chunk from ${sourceId}`)], { sourceId });
        await engine.addTimelineEntry('empty/p', { date: '2026-01-02', summary: `entry ${sourceId}` }, { sourceId });
        await engine.addLink('empty/p', 'empty/q', '', 'mentions', undefined, undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
        await engine.createVersion('empty/p', { sourceId });
      }
      const out: unknown[] = [];
      out.push(await engine.removeLink('empty/p', 'empty/q', undefined, undefined, { fromSourceId: '' }));
      out.push(await engine.removeLink('empty/p', 'empty/q', undefined, undefined, { toSourceId: '' }));
      out.push((await engine.getLinks('empty/p', { sourceId: 'default' })).length);
      out.push(await engine.addLink('empty/p', 'empty/q', '', 'cites', undefined, undefined, undefined, { fromSourceId: '' }).then(() => 'added', (e: { name?: string }) => e.name));
      out.push(await engine.softDeletePage('empty/p', { sourceId: '' }));
      out.push(await liveIn(engine, 'empty/p', ['default', 'work']));
      out.push(await engine.restorePage('empty/p', { sourceId: '' }));
      out.push(await liveIn(engine, 'empty/p', ['default', 'work']));
      return out;
    },
  },

  // 8. link_kind and resolution_type on a batch write are stored, not refused
  {
    name: 'addLinksBatch stores link_kind and resolution_type, and a value outside their allowed set is rejected',
    expect: 'equal',
    run: async (arm) => {
      const { engine } = arm;
      for (const slug of ['kind/from', 'kind/plain', 'kind/ner', 'kind/bare']) await engine.putPage(slug, NOTE);
      const batch = [
        { from_slug: 'kind/from', to_slug: 'kind/plain', link_type: 'mentions', context: 'c1', link_source: 'mentions', link_kind: 'plain', resolution_type: 'unqualified' as const },
        { from_slug: 'kind/from', to_slug: 'kind/ner', link_type: 'works_at', context: 'c2', link_source: 'mentions', link_kind: 'typed_ner', resolution_type: 'qualified' as const },
        { from_slug: 'kind/from', to_slug: 'kind/bare', link_type: 'cites', context: 'c3', link_source: 'manual' },
      ];
      const first = await outcomeOf(() => engine.addLinksBatch(batch));
      const replay = await outcomeOf(() => engine.addLinksBatch(batch));
      // PGLite names a check violation by its SQL state and the Rust engine by its typed code, so compare only that the
      // write was rejected for the value (not refused as an unsupported option).
      const rejectedForValue = (o: Outcome) => 'threw' in o && o.threw !== 'engine_capability_missing';
      const badKind = rejectedForValue(await outcomeOf(() => engine.addLinksBatch([{ from_slug: 'kind/from', to_slug: 'kind/bare', link_type: 'bad', link_kind: 'nonsense' }])));
      const badResolution = rejectedForValue(await outcomeOf(() => engine.addLinksBatch([{ from_slug: 'kind/from', to_slug: 'kind/bare', link_type: 'bad', resolution_type: 'nonsense' as never }])));
      return { first, replay, badKind, badResolution, stored: await storedLinks(arm, 'kind/from'), read: await engine.getLinks('kind/from') };
    },
  },
];

describe('Rust engine against PGLite on raw values', () => {
  let pglite: PGLiteEngine;
  let rust: RustBrainDir | undefined;

  beforeAll(async () => {
    if (!HAVE_ADDON) return;
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    await pglite.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('work', 'work', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`);
    rust = await openRustBrain();
    await createRustSource(rust.engine, 'work', {});
  }, 120_000);

  afterAll(async () => {
    if (!HAVE_ADDON) return;
    await pglite.disconnect();
    await rust?.engine.disconnect();
    if (rust) removeBrainDir(rust.dir);
  });

  for (const scenario of scenarios) {
    withAddon(`${scenario.expect}: ${scenario.name}`, async () => {
      const reference = await outcomeOf(() => scenario.run({ engine: pglite, backend: 'pglite' }));
      const actual = await outcomeOf(() => scenario.run({ engine: rust!.engine as unknown as BrainEngine, backend: 'rust' }));
      if (scenario.expect === 'equal') {
        expect(actual).toEqual(reference);
      } else {
        expect('threw' in reference && reference.threw === 'engine_capability_missing').toBe(false);
        expect(actual).toEqual({ threw: 'engine_capability_missing' });
      }
    }, 60_000);
  }
});

// Runs without the addon, so the file always executes a test (the stress gate fails a file that runs none).
describe('the differential comparison itself', () => {
  test('normalize replaces only the clock, UUIDs and row ids, and keeps every other key and value', async () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    const row = {
      slug: 'notes/a', id: 7, page_id: 8, chunk_id: 9, count: 3, title: 'Created 2026-01-02',
      created_at: at, updated_at: '2026-01-02T03:04:05Z', when: at, owner: '123e4567-e89b-12d3-a456-426614174000',
      tags: ['x', 'y'], missing: undefined, empty: null,
    };
    expect(normalize(row)).toEqual({
      chunk_id: '<id>', count: 3, created_at: '<timestamp>', empty: null, id: '<id>', missing: '<undefined>',
      owner: '<uuid>', page_id: '<id>', slug: 'notes/a', tags: ['x', 'y'], title: 'Created 2026-01-02',
      updated_at: '<timestamp>', when: '<Date 2026-01-02T03:04:05.000Z>',
    });
    expect(Object.keys(normalize({ b: 1, a: 2 }) as object)).toEqual(['a', 'b']);
    expect(await outcomeOf(async () => { throw Object.assign(new Error('no'), { code: 'engine_capability_missing' }); }))
      .toEqual({ threw: 'engine_capability_missing' });
    expect(await outcomeOf(async () => ({ id: 1, slug: 's' }))).toEqual({ ok: { id: '<id>', slug: 's' } });
  });

  test('scenario names are unique, so each one is its own test', () => {
    const names = scenarios.map((s) => s.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });
});
