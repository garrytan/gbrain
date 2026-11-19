/**
 * BrainEngine parity — the link and fact reads behind `gbrain entity` and `gbrain recall <entity>`, in their callers' shapes.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the entity card (verbs/entity-card.ts assembleCard) reads the entity's own outgoing links with
 *    `temporal: { status: 'all' }` and `excludePrivate`, from-side scoped by `sourceId` for the trusted local caller and
 *    through the all-endpoints branch (`sourceIds`) for an untrusted one. Every row carries its temporal annotation,
 *    past stints included; a private endpoint and an edge into another source stay off the untrusted read.
 *  - Regression: the Rust arm refused `getLinks` with the `temporal` option, so the card's outgoing links failed open
 *    to an empty list on a Rust brain and `gbrain entity --json` differed from PGLite.
 *  - Why existing coverage misses it: link-read-options.test.ts reads temporal options and excludePrivate apart, never
 *    with the card's scope forms together.
 *  - Contract: the card reads the entity's active facts with `excludePrivate`, an optional `visibility` and the
 *    caller's read `eligibility` (`{}` by default, which hides a fact whose provenance page is quarantined;
 *    a floor also drops facts below its tier); `gbrain recall <entity>` reads them with `excludeAuditRows`, `grep`, `activeOnly`
 *    from `--include-expired` and `eligibility: {}` (commands/recall.ts, the entity arm with no window).
 *  - Regression: the Rust arm refused `listFactsByEntity` with the `eligibility` option, so the card's facts failed open
 *    to an empty list and `gbrain recall <entity>` failed on a Rust brain.
 *  - Why existing coverage misses it: trust-reads.test.ts reads the eligibility in the hot-memory shape only.
 *  - Contract: the card's `referenced_by` groups (mentions/referrers.ts readReferrerGroups, called from entity-card.ts
 *    cardReferences) hold every live page in the caller's sources that links to the entity, grouped by pack-canonical
 *    type, newest `COALESCE(effective_date, updated_at)` first with `(source_id, slug)` breaking a tie, at most
 *    GROUP_ROW_CAP rows per group; an untrusted read leaves out private and restricted referrers and links whose origin
 *    page is private; the eligibility floor and quarantine apply before the cap; each row carries its date source,
 *    preview and trust label.
 *  - Regression: the Rust arm refused the read (raw SQL), so the card's `referenced_by` failed open to empty on a Rust
 *    brain and `gbrain entity --json` differed from PGLite.
 *  - Why existing coverage misses it: no parity case reads the referrer groups; mentions tests run PGLite only.
 *  - Contract: under `eligibility.suppressFlagged` every referrer read (the card groups, the `group: page` referrer page
 *    and its total, the batched counts and records) leaves out a referrer at or below agent_written that carries a
 *    write-gate flag in an instruction family; a flagged referrer above that tier stays, with no label. Without the
 *    filter the flagged agent referrer stays, labelled `unconfirmed`. A referrer with an empty type is its own `untyped`
 *    group with a null `type`.
 *  - Regression: an engine that drops the flag test, or files an empty type under `''`, shows a flagged agent page to
 *    a proactive surface or an extra unnamed group, and the Rust arm differs from PGLite.
 *  - Why existing coverage misses it: the group case above reads no flagged and no untyped referrer; alias-trust.test.ts
 *    reads the flag filter on aliases only.
 *  - Contract: a search records when it surfaced each page (last-retrieved.ts bumpLastRetrievedAt), and the entity card
 *    shows that time as `last_touched.last_retrieved_at` (readEntityCardRows); a page no search surfaced shows null.
 *  - Regression: the Rust arm's readEntityCardRows always answered null, so after a search `gbrain entity --json` showed
 *    a never-retrieved card on a Rust brain and differed from PGLite and Postgres (rust-cli-parity.serial.test.ts).
 *  - Why existing coverage misses it: pages.test.ts reads the retrieval through the samplers only; the CLI census uses a
 *    fresh brain per command, so no search runs before the card.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../../src/core/engine.ts';
import type { Link, PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';
import { readReferrerGroups, readReferrerPage, readTargetReferences, type ReferrerScope } from '../../src/core/mentions/referrers.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { awaitPendingLastRetrievedWrites } from '../../src/core/last-retrieved.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const WIDGET = 'companies/widget-co';

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

const ALICE_BODY = [
  'Alice is CTO of [Acme](../companies/acme-example).',
  '',
  '## Timeline',
  '',
  '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO',
  '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)',
  '- **2025-03-02** | note — works at [Widget](../companies/widget-co)',
].join('\n');

function worksAt(to: string, context: string): LinkBatchInput {
  return { from_slug: ALICE, to_slug: to, link_type: 'works_at', context, link_source: 'markdown', from_source_id: 'default', to_source_id: 'default' };
}

/** A row with its write timestamps replaced by their shape and its `link_id` by its type. */
function view(row: Link): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = k === 'recorded_at' || k === 'retired_at' || k === 'link_id' ? (v == null ? v : typeof v) : v;
  return out;
}

const byEdge = (rows: Link[]) => sorted(rows.map(view), r => `${r.from_slug}>${r.to_slug}:${r.link_type}:${r.to_source_id ?? ''}`);

describe('engine parity: the entity card outgoing link read', () => {
  parityTest(
    'getLinks with temporal status all, excludePrivate and the card scope forms annotates every own edge and hides private and cross-source endpoints from the untrusted read',
    { methods: ['putPage', 'readPageSnapshot', 'replaceDerivedLinks', 'addLink', 'addLinksBatch', 'getLinks'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'team');
      await engine.putPage(ACME, page('Acme', { type: 'company' }));
      await engine.putPage(WIDGET, page('Widget', { type: 'company' }));
      await engine.putPage('notes/private', page('Private', { frontmatter: { visibility: 'private' } }));
      await engine.putPage(ALICE, page('Alice', { type: 'person', compiled_truth: ALICE_BODY }));
      await engine.putPage('notes/team-plan', page('Team plan'), { sourceId: 'team' });
      const snapshot = (await engine.readPageSnapshot(ALICE, { sourceId: 'default' }))!;
      await engine.replaceDerivedLinks({ slug: ALICE, sourceId: 'default', expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation },
        [worksAt(ACME, 'CTO of Acme'), worksAt(WIDGET, 'works at Widget')]);
      await engine.addLink(ALICE, ACME, 'mentions Acme in passing', 'mentions', 'manual');
      await engine.addLink(ALICE, 'notes/private', 'keeps a private note', 'cites', 'manual');
      await engine.addLinksBatch([{ from_slug: ALICE, to_slug: 'notes/team-plan', link_type: 'cites', context: 'team plan', link_source: 'manual', from_source_id: 'default', to_source_id: 'team' }]);

      const temporal = { status: 'all' as const };
      const out = {
        local: byEdge(await engine.getLinks(ALICE, { sourceId: 'default', excludePrivate: false, temporal })),
        localHidden: byEdge(await engine.getLinks(ALICE, { sourceId: 'default', excludePrivate: true, temporal })),
        remote: byEdge(await engine.getLinks(ALICE, { sourceIds: ['default'], excludePrivate: true, temporal })),
      };
      const edges = (rows: Array<Record<string, unknown>>) => rows.map(r => `${r.to_slug}:${r.link_type}:${r.status ?? 'none'}`);
      expect(edges(out.local)).toEqual([
        'companies/acme-example:mentions:reference', 'companies/acme-example:works_at:ended', 'companies/widget-co:works_at:live',
        'notes/private:cites:reference', 'notes/team-plan:cites:reference',
      ]);
      expect(edges(out.localHidden)).not.toContain('notes/private:cites:reference');
      expect(edges(out.remote)).toEqual(['companies/acme-example:mentions:reference', 'companies/acme-example:works_at:ended', 'companies/widget-co:works_at:live']);
      return out;
    },
  );
});

/** Run `fn` in a transaction whose write trust settings declare `tier`; `null` writes with no declared tier. */
function declared<T>(engine: BrainEngine, tier: string | null, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  if (tier === null) return fn(engine);
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

/**
 * Alice's facts: a curated world fact, a private one, a lapsed one, an outside one, an audit outcome row, and a curated
 * fact whose provenance page is quarantined after the write. Two facts share a `valid_from`, so the id tiebreak shows.
 */
async function seedFacts(engine: BrainEngine): Promise<void> {
  await engine.putPage(ALICE, page('Alice', { type: 'person' }));
  await engine.putPage('notes/held', page('Held'));
  const facts: Array<{ fact: string; tier: string | null; day: number; extra?: Record<string, unknown> }> = [
    { fact: 'Alice leads the platform team', tier: 'operator_curated', day: 1 },
    { fact: 'Alice moved to Widget', tier: 'operator_curated', day: 3 },
    { fact: 'Alice prefers async reviews', tier: 'tool_observed', day: 3 },
    { fact: 'Alice keeps a private diary', tier: 'operator_curated', day: 4, extra: { visibility: 'private' } },
    { fact: 'Alice was on call last spring', tier: 'operator_curated', day: 5, extra: { valid_until: new Date(Date.UTC(2026, 4, 6)) } },
    { fact: 'Alice is said to be leaving', tier: 'external_untrusted', day: 6 },
    { fact: 'EXTRACTION_COMPLETE', tier: null, day: 7, extra: { source: TERMINAL_AUDIT_SOURCE } },
  ];
  for (const f of facts) {
    await declared(engine, f.tier, tx => tx.insertFact({
      fact: f.fact, entity_slug: ALICE, visibility: 'world', source: 'mcp:remember', embedding: null,
      valid_from: new Date(Date.UTC(2026, 4, f.day)), ...f.extra,
    } as never, { source_id: 'default' }));
  }
  await declared(engine, 'operator_curated', tx => tx.insertFacts([{
    fact: 'Alice joined the board', entity_slug: ALICE, source_markdown_slug: 'notes/held', row_num: 1, kind: 'fact',
    visibility: 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 4, 8)),
  }] as never, { source_id: 'default' }));
  await engine.putPage('notes/held', page('Held', { frontmatter: { quarantine: { reason: 'test' } } }));
}

const texts = (rows: Array<{ fact: string }>) => rows.map(r => r.fact);

describe('engine parity: the entity card and recall fact reads', () => {
  parityTest(
    'listFactsByEntity in the entity card shape applies the read eligibility, visibility and excludePrivate in valid_from order',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'listFactsByEntity'] },
    async (engine: BrainEngine) => {
      await seedFacts(engine);
      const card = (opts: { visibility?: Array<'private' | 'world'>; excludePrivate: boolean; eligibility: Record<string, unknown> }) =>
        engine.listFactsByEntity('default', ALICE, {
          activeOnly: true, limit: 100, ...(opts.visibility ? { visibility: opts.visibility } : {}),
          excludePrivate: opts.excludePrivate, eligibility: opts.eligibility,
        } as never).then(texts);
      const out = {
        local: await card({ excludePrivate: false, eligibility: {} }),
        localHidden: await card({ excludePrivate: true, eligibility: {} }),
        worldOnly: await card({ visibility: ['world'], excludePrivate: false, eligibility: {} }),
        floored: await card({ excludePrivate: false, eligibility: { floor: 'operator_curated' } }),
      };
      // Newest valid_from first; the two facts of day 3 tie and the later write comes first.
      const all = ['EXTRACTION_COMPLETE', 'Alice is said to be leaving', 'Alice keeps a private diary', 'Alice prefers async reviews',
        'Alice moved to Widget', 'Alice leads the platform team'];
      expect(out).toEqual({
        local: all,
        localHidden: all,
        worldOnly: all.filter(f => f !== 'Alice keeps a private diary'),
        floored: ['Alice keeps a private diary', 'Alice moved to Widget', 'Alice leads the platform team'],
      });
      return out;
    },
  );
  parityTest(
    'listFactsByEntity in the recall entity shape drops audit rows, honors grep and include-expired, and applies the default eligibility',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFact', 'insertFacts', 'listFactsByEntity'] },
    async (engine: BrainEngine) => {
      await seedFacts(engine);
      // commands/recall.ts, the entity arm with no --since window.
      const recall = (flags: { includeExpired?: boolean; grep?: string; limit?: number }) =>
        engine.listFactsByEntity('default', ALICE, {
          sessionId: undefined, activeOnly: !flags.includeExpired, limit: flags.limit ?? 20, grep: flags.grep ?? undefined,
          excludeAuditRows: true, eligibility: {},
        }).then(texts);
      const out = {
        plain: await recall({}),
        expired: await recall({ includeExpired: true }),
        grep: await recall({ grep: 'widget' }),
        limited: await recall({ limit: 2 }),
      };
      expect(out).toEqual({
        plain: ['Alice is said to be leaving', 'Alice keeps a private diary', 'Alice prefers async reviews', 'Alice moved to Widget',
          'Alice leads the platform team'],
        expired: ['Alice is said to be leaving', 'Alice was on call last spring', 'Alice keeps a private diary', 'Alice prefers async reviews',
          'Alice moved to Widget', 'Alice leads the platform team'],
        grep: ['Alice moved to Widget'],
        limited: ['Alice is said to be leaving', 'Alice keeps a private diary'],
      });
      return out;
    },
  );
});

/**
 * Pages that link to Acme: two people dated on one day (the slug tie), a meeting stored as the pack alias `call`,
 * twelve dated notes (past the per-group cap), an undated note, private, restricted and quarantined referrers, a note
 * whose link's origin page is private, a soft-deleted referrer and a referrer in another source.
 */
async function seedReferrers(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'team');
  const dated = (date: string, extra: Partial<PageInput> = {}, source: 'date' | 'event_date' = 'date'): Partial<PageInput> =>
    ({ ...extra, frontmatter: { date, ...(extra.frontmatter ?? {}) }, effective_date: new Date(`${date}T00:00:00Z`), effective_date_source: source });
  await engine.putPage(ACME, page('Acme', { type: 'company' }));
  await declared(engine, 'operator_curated', tx => tx.putPage(ALICE, page('Alice', dated('2026-03-01', { type: 'person',
    compiled_truth: '# Alice\n\nAlice   works with Acme on the platform.' }))));
  await engine.putPage('people/bob-example', page('Bob', dated('2026-03-01', { type: 'person' })));
  await engine.putPage('meetings/standup', page('Standup', dated('2026-02-01', { type: 'call' }, 'event_date')));
  await declared(engine, 'operator_curated', tx => tx.putPage('meetings/review', page('Review', dated('2026-04-01', { type: 'meeting' }))));
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(2, '0');
    await engine.putPage(`notes/n${n}`, page(`Note ${n}`, dated(`2026-01-${n}`)));
  }
  await engine.putPage('notes/undated', page('Undated'));
  await engine.putPage('notes/private-ref', page('Private ref', dated('2026-05-01', { frontmatter: { visibility: 'private' } })));
  await engine.putPage('notes/restricted', page('Restricted', dated('2026-05-02', { frontmatter: { readable_by: ['member:bob-example'] } })));
  await engine.putPage('notes/via-private', page('Via private', dated('2026-05-03')));
  await engine.putPage('notes/held', page('Held', dated('2026-05-04', { frontmatter: { quarantine: { reason: 'test' } } })));
  await engine.putPage('notes/gone', page('Gone', dated('2026-05-05')));
  await engine.putPage('notes/team-ref', page('Team ref', dated('2026-06-01')), { sourceId: 'team' });
  const refs = [ALICE, 'people/bob-example', 'meetings/standup', 'meetings/review', 'notes/undated', 'notes/private-ref',
    'notes/restricted', 'notes/held', 'notes/gone', ...Array.from({ length: 12 }, (_, i) => `notes/n${String(i + 1).padStart(2, '0')}`)];
  await engine.addLinksBatch(refs.map(from => ({ from_slug: from, to_slug: ACME, link_type: 'mentions', context: 'Acme',
    link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })));
  await engine.addLinksBatch([
    { from_slug: 'notes/via-private', to_slug: ACME, link_type: 'works_at', context: 'Acme', link_source: 'frontmatter',
      origin_slug: 'notes/private-ref', origin_field: 'company', from_source_id: 'default', to_source_id: 'default', origin_source_id: 'default' } as LinkBatchInput,
    { from_slug: 'notes/team-ref', to_slug: ACME, link_type: 'mentions', context: 'Acme', link_source: 'manual',
      from_source_id: 'team', to_source_id: 'default' },
  ]);
  await engine.softDeletePage('notes/gone', { sourceId: 'default' });
}

const PACK = { page_types: [{ name: 'meeting', aliases: ['call'] }, { name: 'person' }, { name: 'note' }, { name: 'company' }] };

describe('engine parity: the entity card referrer groups', () => {
  parityTest(
    'readReferrerGroups in the entity card shape groups referrers by canonical type, newest first, capped per group, under each caller scope',
    { methods: ['putPage', 'transaction', 'applyTransactionSettings', 'addLinksBatch', 'softDeletePage'] },
    async (engine: BrainEngine, backend) => {
      await seedReferrers(engine, backend);
      const read = async (opts: Partial<ReferrerScope>) => {
        const out = await readReferrerGroups(engine, {
          slug: ACME, sourceId: 'default', referrerSources: ['default'], excludePrivate: false, pack: PACK,
          keepVisibility: ['private', 'world'], ...opts,
        });
        return { total: out.total, groups: out.groups.map(g => ({ type: g.canonical_type, total: g.total,
          rows: g.rows.map(r => ({ ...r, date: r.date_source === 'updated_at' ? typeof r.date : r.date })) })) };
      };
      const out = {
        local: await read({}),
        remote: await read({ excludePrivate: true, keepVisibility: ['world'] }),
        floored: await read({ eligibility: { floor: 'operator_curated' } }),
        quarantined: await read({ includeQuarantined: true }),
        bothSources: await read({ referrerSources: ['default', 'team'] }),
      };
      const shape = (r: typeof out.local) => r.groups.map(g => `${g.type}:${g.total}:${g.rows.map(x => x.slug).join(',')}`);
      const notes = (newest: number, count: number) => Array.from({ length: count }, (_, k) => `notes/n${String(newest - k).padStart(2, '0')}`).join(',');
      const others = ['meeting:2:meetings/review,meetings/standup', 'person:2:people/alice-example,people/bob-example'];
      // The undated note sorts by its write time (newest); Alice and Bob share a date and the slug breaks the tie.
      expect({ local: shape(out.local), remote: shape(out.remote), floored: shape(out.floored), quarantined: shape(out.quarantined),
        bothSources: shape(out.bothSources) }).toEqual({
        local: [`note:16:notes/undated,notes/via-private,notes/restricted,notes/private-ref,${notes(12, 6)}`, ...others],
        remote: [`note:13:notes/undated,${notes(12, 9)}`, ...others],
        floored: ['meeting:1:meetings/review', 'person:1:people/alice-example'],
        quarantined: [`note:17:notes/undated,notes/held,notes/via-private,notes/restricted,notes/private-ref,${notes(12, 5)}`, ...others],
        bothSources: [`note:17:notes/undated,notes/team-ref,notes/via-private,notes/restricted,notes/private-ref,${notes(12, 5)}`, ...others],
      });
      expect(out.local.groups[1]!.rows[1]).toMatchObject({ slug: 'meetings/standup', type: 'call', canonical_type: 'meeting',
        date: '2026-02-01T00:00:00.000000Z', date_source: 'event_date' });
      expect(out.local.groups[2]!.rows[0]).toMatchObject({ preview: 'Alice works with Acme on the platform.', trust_tier: 'operator_curated' });
      return out;
    },
  );
});

describe('engine parity: the entity card last_touched after a search', () => {
  parityTest(
    'a search then the entity card on one brain shows the retrieval time of the surfaced page and null for a page no search surfaced',
    { methods: ['putPage', 'sealChunks', 'searchKeyword', 'bumpPageRetrievals', 'readEntityCardRows'] },
    async (engine: BrainEngine) => {
      // Sealed chunks, so the search serves the pages (chunk-fixtures.ts).
      const person = (slug: string, title: string, text: string) =>
        seedPage(engine, { slug, input: page(title, { type: 'person', compiled_truth: text }), chunks: [chunk(0, text)] });
      await person(ALICE, 'Alice Example', 'Alice Example runs the zephyr rollout.');
      await person('people/bob-example', 'Bob Example', 'Bob Example writes the docs.');
      const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
        logger: { info() {}, warn() {}, error() {} }, emitNotice() {} } as unknown as OperationContext;
      const op = (name: string) => operations.find(o => o.name === name)!;
      const hits = await op('search').handler(ctx, { query: 'zephyr rollout' }) as Array<{ slug: string }>;
      expect((await awaitPendingLastRetrievedWrites()).outcome).toBe('drained');
      const touched = async (name: string) => {
        const r = await op('entity').handler(ctx, { name }) as { card?: { last_touched: { updated_at: string; last_retrieved_at: string | null; last_timeline_date: string | null } } };
        const t = r.card!.last_touched;
        return { retrieved: t.last_retrieved_at === null ? null : typeof t.last_retrieved_at,
          retrievedAfterWrite: t.last_retrieved_at === null ? null : Date.parse(t.last_retrieved_at) >= Date.parse(t.updated_at),
          timeline: t.last_timeline_date };
      };
      const out = { hits: hits.map(h => h.slug), alice: await touched('Alice Example'), bob: await touched('Bob Example') };
      expect(out).toEqual({ hits: [ALICE], alice: { retrieved: 'string', retrievedAfterWrite: true, timeline: null },
        bob: { retrieved: null, retrievedAfterWrite: null, timeline: null } });
      return out;
    },
  );
});

/** Acme's referrers for the flag filter: a flagged agent note, a flagged curated note, a clean agent note and an untyped one. */
async function seedFlaggedReferrers(engine: BrainEngine): Promise<void> {
  await engine.putPage(ACME, page('Acme', { type: 'company' }));
  const dated = (date: string, extra: Partial<PageInput> = {}): PageInput =>
    page(extra.title ?? 'x', { ...extra, effective_date: new Date(`${date}T00:00:00Z`), effective_date_source: 'date' });
  const rows: Array<[slug: string, tier: string, flag: boolean, date: string, type: string]> = [
    ['notes/flagged-agent', 'agent_written', true, '2026-03-04', 'note'],
    ['notes/flagged-curated', 'operator_curated', true, '2026-03-03', 'note'],
    ['notes/clean-agent', 'agent_written', false, '2026-03-02', 'note'],
    ['notes/loose', 'agent_written', false, '2026-03-01', ''],
  ];
  for (const [slug, tier, flag, date, type] of rows) {
    await declared(engine, tier, tx => tx.putPage(slug, dated(date, { title: slug.slice(6), type })));
    if (flag) {
      await engine.upsertPageWriteGateReceipt('default', slug, {
        content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: ['override'],
        reasons: ['override'], detector_error: false, request_id: null,
      });
    }
  }
  await engine.addLinksBatch(rows.map(([from]) => ({ from_slug: from, to_slug: ACME, link_type: 'mentions', context: 'Acme',
    link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })));
}

describe('engine parity: the referrer reads under the flag filter and with an untyped referrer', () => {
  parityTest(
    'every referrer read drops a flagged agent referrer under suppressFlagged, labels it unconfirmed without the filter, keeps a flagged curated one, and names the untyped group',
    { methods: ['putPage', 'transaction', 'applyTransactionSettings', 'upsertPageWriteGateReceipt', 'addLinksBatch', 'readReferrerGroupRows',
      'readReferrerPageDetails', 'countReferrerRows', 'readReferrerRows', 'readReferrerTargetCounts', 'readReferrerRecordCandidates', 'readReferrerRecordPages'] },
    async (engine: BrainEngine) => {
      await seedFlaggedReferrers(engine);
      const scope = (suppressFlagged: boolean): ReferrerScope => ({ slug: ACME, sourceId: 'default', referrerSources: ['default'],
        excludePrivate: false, pack: PACK, keepVisibility: ['private', 'world'], eligibility: suppressFlagged ? { suppressFlagged: true } : {} });
      const row = (r: { slug: string; type: string | null; canonical_type: string; unconfirmed?: true }) =>
        `${r.canonical_type}:${r.type ?? 'null'}:${r.slug}${r.unconfirmed ? ':unconfirmed' : ''}`;
      const read = async (suppressFlagged: boolean) => {
        const groups = await readReferrerGroups(engine, scope(suppressFlagged));
        const all = await readReferrerPage(engine, scope(suppressFlagged), { limit: 10 });
        const untyped = await readReferrerPage(engine, scope(suppressFlagged), { type: 'untyped', limit: 10 });
        const { slug: _s, sourceId: _i, ...batch } = scope(suppressFlagged);
        const [target] = await readTargetReferences(engine, batch, [{ slug: ACME, sourceId: 'default' }], { recordTypes: ['note'] });
        return {
          groups: groups.groups.map(g => `${g.canonical_type}:${g.total}:${g.rows.map(row).join(',')}`),
          page: { total: all.total, rows: all.rows.map(row) },
          untyped: { total: untyped.total, rows: untyped.rows.map(row) },
          records: { count: target!.referenced_by_count, notes: (target!.records ?? []).map(g => `${g.canonical_type}:${g.total}:${g.rows.map(x => x.slug).join(',')}`) },
        };
      };
      const out = { open: await read(false), suppressed: await read(true) };
      expect(out).toEqual({
        open: {
          groups: ['note:3:note:note:notes/flagged-agent:unconfirmed,note:note:notes/flagged-curated,note:note:notes/clean-agent', 'untyped:1:untyped:null:notes/loose'],
          page: { total: 4, rows: ['note:note:notes/flagged-agent:unconfirmed', 'note:note:notes/flagged-curated', 'note:note:notes/clean-agent', 'untyped:null:notes/loose'] },
          untyped: { total: 1, rows: ['untyped:null:notes/loose'] },
          records: { count: 4, notes: ['note:3:notes/flagged-agent,notes/flagged-curated,notes/clean-agent'] },
        },
        suppressed: {
          groups: ['note:2:note:note:notes/flagged-curated,note:note:notes/clean-agent', 'untyped:1:untyped:null:notes/loose'],
          page: { total: 3, rows: ['note:note:notes/flagged-curated', 'note:note:notes/clean-agent', 'untyped:null:notes/loose'] },
          untyped: { total: 1, rows: ['untyped:null:notes/loose'] },
          records: { count: 3, notes: ['note:2:notes/flagged-curated,notes/clean-agent'] },
        },
      });
      return out;
    },
  );
});
