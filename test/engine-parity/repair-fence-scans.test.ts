/**
 * BrainEngine parity — the page scans of `gbrain repair contact-rows`, `gbrain repair split-facts` and
 * `gbrain repair atom-fence-rows` (batch 8 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain with a page that repeats a contact row, a page whose two sections each hold a facts fence and
 *    world atoms that carry a hidden row of their source page, each kind gives the same preview and the same apply
 *    result, and the scan members return the same rows, on PGLite, Postgres (DATABASE_URL) and the Rust engine
 *    (GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: the three plans (and the contact-rows apply's request read) read through `executeRaw`, which a Rust
 *    brain refuses, so each kind stopped before its first read there. `listContactRowPages`, `listSplitFactsPages`,
 *    `listAtomFenceCandidates`, `listPageTruths` and `listWriteRequestsByRequestIds` now answer them.
 *  - Why existing coverage misses it: test/repair-contact-rows.test.ts, test/repair-split-facts.test.ts and
 *    test/repair-atom-fence-rows.test.ts run on PGLite or Postgres only.
 *  - Seam: none. Generated values (the brain id, timestamps, hashes) are compared by shape.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { HIDDEN_TAKE_ROW, PRIVATE_ROW, WORLD_PAGE_BODY, WORLD_ROW } from '../helpers/world-fence-page.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { upsertFactRow } from '../../src/core/facts-fence.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { isCapabilityMissing } from '../../src/core/rust-engine/errors.ts';

const { parityTest } = parityArms(testBackends());

const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?\b/g;

function shape(result: RepairResult) {
  const { scope, ...rest } = result;
  return JSON.parse(JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>').replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{16,}\b/g, '<hex>').replace(ISO, '<ts>'));
}

const quiet = { info() {}, warn() {}, error() {} } as never;

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-fence-scans-home-'));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Preview, apply what the preview printed (bound by its hash), then preview again. */
async function previewApplyPreview(engine: BrainEngine, kind: RepairKind) {
  const scope = await resolveRepairScope(engine);
  const shown = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true });
  const applied = await (await repairRunner(engine, { apply: true, noEmbed: true, logger: quiet }))
    .run(kind, await resolveRepairScope(engine), { explicit: true, ...(shown.preview_hash ? { expect: shown.preview_hash } : {}) })
    .then(shape, (e: { code?: string; message?: string }) => {
      // A typed capability refusal ends the case (the Rust arm counts it as stopped); any other refusal is the answer.
      if (isCapabilityMissing(e)) throw e;
      return { refused: e.code ?? String(e), message: e.message };
    });
  const again = await (await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine), { explicit: true });
  return { preview: shape(shown), applied, again: shape(again), counts: [shown.affected, (applied as { applied?: number }).applied ?? applied, again.affected] };
}

const contact = (type: string, value: string, last_used: string) => ({ type, value, last_used });
const fence = (rows: Array<[number, string]>) => rows.reduce((body, [rowNum, claim]) =>
  upsertFactRow(body, { rowNum, claim, kind: 'fact', visibility: 'world', confidence: 1, notability: 'medium', source: 'fixture' }).body, '');

describe('engine parity: repair fence scans', () => {
  parityTest('contact-rows collapses the same repeated contact rows on every engine', {
    methods: ['putPage', 'readPageSnapshot', 'listContactRowPages', 'listWriteRequestsByRequestIds'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    const person = (slug: string, contacts: unknown[]) => engine.putPage(slug, { type: 'person', title: slug, compiled_truth: `${slug} is a synthetic person.`,
      timeline: '', frontmatter: { company: 'acme-example', contacts } }, { sourceId: 'default' });
    await person('people/alice-example', [contact('phone', '+15550100', '2026-10-01'), contact('email', 'alice@example.com', '2026-09-01'),
      contact('phone', '+15550100', '2026-10-03')]);
    await person('people/bob-example', [contact('phone', '+15550111', '2026-10-01'), contact('email', 'bob@example.com', '2026-09-01')]);
    await person('people/carol-example', [contact('phone', '+15550122', '2026-10-01')]);
    const slugs = (pages: Array<{ id: number; source_id: string; slug: string }>) => pages.map(page => `${page.source_id}:${page.slug}:${typeof page.id}`);
    const first = await engine.listContactRowPages(['default'], { afterId: 0, limit: 1, slugs: [] });
    const scans = {
      all: slugs(await engine.listContactRowPages(['default'], { afterId: 0, limit: 10, slugs: [] })),
      first: slugs(first),
      next: slugs(await engine.listContactRowPages(['default'], { afterId: first[0]!.id, limit: 10, slugs: [] })),
      named: slugs(await engine.listContactRowPages(['default'], { afterId: 0, limit: 10, slugs: ['people/bob-example', 'people/carol-example'] })),
      elsewhere: slugs(await engine.listContactRowPages(['no-such-source'], { afterId: 0, limit: 10, slugs: [] })),
      requests_none: await engine.listWriteRequestsByRequestIds([]),
      requests_unknown: await engine.listWriteRequestsByRequestIds(['00000000-0000-4000-8000-000000000000']),
    };
    expect(scans.all).toEqual(['default:people/alice-example:number', 'default:people/bob-example:number']);
    expect(scans.next).toEqual(['default:people/bob-example:number']);
    const result = await previewApplyPreview(engine, 'contact-rows');
    const rows = (await engine.readPageSnapshot('people/alice-example', { sourceId: 'default' }))!.page.frontmatter.contacts;
    expect(result.counts).toEqual([1, 1, 0]);
    expect(rows).toHaveLength(2);
    return { ...result, rows, scans };
  }));

  parityTest('split-facts merges the same split fences on every engine', {
    methods: ['putPage', 'readPageSnapshot', 'listSplitFactsPages'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    await engine.putPage('people/split-example', { type: 'person', title: 'Split', compiled_truth: `Synthetic biography.\n\n${fence([[8, 'Prefers asynchronous weekly reports']])}`,
      timeline: `## Timeline\n\n- 2026-10-01: Preserved event.\n\n${fence([[7, 'Prefers written agendas']])}` }, { sourceId: 'default' });
    await engine.putPage('people/whole-example', { type: 'person', title: 'Whole', compiled_truth: 'Synthetic biography.',
      timeline: `## Timeline\n\n${fence([[1, 'Keeps one fence']])}` }, { sourceId: 'default' });
    const found = await engine.listSplitFactsPages(['default']);
    const scans = { inline: found.inline.map(page => `${page.source_id}:${page.slug}:${typeof page.id}`), segmented: found.segmented,
      elsewhere: await engine.listSplitFactsPages(['no-such-source']) };
    expect(scans.inline).toEqual(['default:people/split-example:number']);
    const result = await previewApplyPreview(engine, 'split-facts');
    const page = (await engine.readPageSnapshot('people/split-example', { sourceId: 'default' }))!.page;
    expect(result.counts).toEqual([1, 1, 0]);
    return { ...result, truth: page.compiled_truth, timeline: page.timeline, scans };
  }));

  parityTest('atom-fence-rows narrows the same world atoms on every engine', {
    methods: ['putPage', 'readPageSnapshot', 'listAtomFenceCandidates', 'listPageTruths'],
    timeout: 60_000,
  }, async (engine) => withHome(async () => {
    const origin = 'notes/launch-review';
    await engine.putPage(origin, { type: 'note', title: 'Launch review', compiled_truth: WORLD_PAGE_BODY, timeline: '' }, { sourceId: 'default' });
    await engine.putPage('notes/plain-example', { type: 'note', title: 'Plain', compiled_truth: 'No fence here.', timeline: '' }, { sourceId: 'default' });
    const atom = (slug: string, body: string, frontmatter: Record<string, unknown> = {}) => engine.putPage(slug, { type: 'atom', title: slug.split('/').at(-1)!,
      compiled_truth: body, frontmatter: { atom_type: 'insight', source_slug: origin, source_hash: 'aaaaaaaaaaaaaaaa', visibility: 'world', ...frontmatter } },
      { sourceId: 'default' });
    await atom('atoms/2026-01-01/renewal-terms', `Recorded on the page: ${PRIVATE_ROW}.`);
    await atom('atoms/2026-01-01/launch-move', 'A launch decision was recorded.', { source_quote: HIDDEN_TAKE_ROW });
    await atom('atoms/2026-01-01/launch-checklist', `Recorded on the page: ${WORLD_ROW}.`, { source_quote: WORLD_ROW });
    await atom('atoms/2026-01-01/renewal-private', `Recorded on the page: ${PRIVATE_ROW}.`, { visibility: 'private' });
    await atom('atoms/2026-01-01/plain-atom', `Recorded on the page: ${PRIVATE_ROW}.`, { source_slug: 'notes/plain-example' });
    const view = (rows: Awaited<ReturnType<BrainEngine['listAtomFenceCandidates']>>) => rows.map(row => ({ slug: row.slug, source_id: row.source_id,
      id: typeof row.id, revision: typeof row.revision, text: row.text, origin_id: typeof row.origin_id, origin_slug: row.origin_slug,
      origin_hash: typeof row.origin_hash, origin_unread: row.origin_unread }));
    const all = await engine.listAtomFenceCandidates(['default'], { atomId: null, afterId: 0, limit: 10 });
    const truths = await engine.listPageTruths([all[0]!.origin_id, 999_999_999]);
    const scans = {
      all: view(all),
      first: view(await engine.listAtomFenceCandidates(['default'], { atomId: null, afterId: 0, limit: 1 })),
      after: view(await engine.listAtomFenceCandidates(['default'], { atomId: null, afterId: all[0]!.id, limit: 10 })),
      one: view(await engine.listAtomFenceCandidates(['default'], { atomId: all[1]!.id, afterId: 0, limit: 10 })),
      truths: truths.map(row => ({ id: row.id === all[0]!.origin_id, body: row.body })),
      no_truths: await engine.listPageTruths([]),
    };
    expect(scans.all.map(row => row.slug)).toEqual(['atoms/2026-01-01/renewal-terms', 'atoms/2026-01-01/launch-move', 'atoms/2026-01-01/launch-checklist']);
    expect(scans.truths).toEqual([{ id: true, body: WORLD_PAGE_BODY }]);
    const result = await previewApplyPreview(engine, 'atom-fence-rows');
    expect(result.counts).toEqual([2, 2, 0]);
    const visibility: Record<string, unknown> = {};
    for (const slug of ['renewal-terms', 'launch-move', 'launch-checklist', 'renewal-private', 'plain-atom']) {
      visibility[slug] = (await engine.readPageSnapshot(`atoms/2026-01-01/${slug}`, { sourceId: 'default' }))!.page.frontmatter.visibility;
    }
    expect(visibility).toEqual({ 'renewal-terms': 'private', 'launch-move': 'private', 'launch-checklist': 'world', 'renewal-private': 'private', 'plain-atom': 'world' });
    return { ...result, visibility, scans };
  }));
});
