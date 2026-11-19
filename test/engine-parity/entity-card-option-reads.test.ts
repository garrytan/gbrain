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
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, LinkBatchInput } from '../../src/core/engine.ts';
import type { Link, PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

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
