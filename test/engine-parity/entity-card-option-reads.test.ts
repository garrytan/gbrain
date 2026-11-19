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
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../../src/core/engine.ts';
import type { Link, PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';

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
