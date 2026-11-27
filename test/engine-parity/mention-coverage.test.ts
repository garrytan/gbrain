/**
 * BrainEngine parity — the mention-index coverage read (mentions/coverage.ts readMentionCoverage) and its callers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: before any mention pass ran, coverage over the caller's sources is `pending` with every live page of
 *    each listed source counted (a soft-deleted page and an unknown source count nothing), no pass time and
 *    `degraded: true`; with `mentions.auto_link` off it is `disabled` with 0 pending. The entity card carries that
 *    coverage on a linkable type and `type_not_linkable` on another; get_backlinks with `group: "page"` returns it; a
 *    search whose query names an entity, and an entity-names lookup whose entity has referrers, emit the
 *    `mention_index` notice for it.
 *    The coverage counts a private page of a source like any live page (a count, never a slug), and a remote caller
 *    who reads world pages only gets the same paged backlinks as PGLite, with the private referrer absent.
 *  - Regression: the Rust arm refused the read (raw SQL), so the card's references failed to `read_failed`, the
 *    paged backlinks call failed, and search and entity-names dropped the notice on a Rust brain.
 *  - Why existing coverage misses it: the mentions tests run PGLite only and seed status rows through executeRaw;
 *    no parity case reads coverage.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). No mention pass runs (the Rust store keeps
 *    no pass state), so only the no-row branch is compared here; the status-row branches (the saved count, the
 *    written-since count and the recount's compare-and-set) are pinned per engine by
 *    test/mention-coverage-members.test.ts.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { readMentionCoverage } from '../../src/core/mentions/coverage.ts';
import { MENTION_EXTRACTOR_VERSION } from '../../src/core/mentions/pass.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { lookupEntityNames } from '../../src/core/verbs/entity-names.ts';

const { parityTest } = parityArms(testBackends());

const ACME = 'companies/acme-example';

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

/**
 * Acme (a company, alias "acme co") with two referring notes, a topic note, a soft-deleted note, and two pages in
 * another source: 4 live pages in `default`, 2 in `other`.
 */
async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, 'other');
  await engine.putPage(ACME, page('Acme Example', { type: 'company', compiled_truth: 'Acme Example builds widgets.' }));
  await engine.putPage('notes/one', page('One', { compiled_truth: 'Met Acme Example about the discount.' }));
  await engine.putPage('notes/two', page('Two', { compiled_truth: 'Acme Example discount follow-up.' }));
  await engine.putPage('notes/roadmap', page('Roadmap'));
  await engine.putPage('notes/gone', page('Gone'));
  await engine.softDeletePage('notes/gone', { sourceId: 'default' });
  await engine.putPage('notes/elsewhere', page('Elsewhere'), { sourceId: 'other' });
  await engine.putPage('notes/elsewhere-2', page('Elsewhere two'), { sourceId: 'other' });
  await engine.setPageAliases(ACME, 'default', ['acme co']);
  await engine.addLinksBatch(['notes/one', 'notes/two'].map(from => ({ from_slug: from, to_slug: ACME, link_type: 'mentions', context: 'Acme Example',
    link_source: 'manual', from_source_id: 'default', to_source_id: 'default' })));
}

const PENDING_DEFAULT = { state: 'pending' as const, pending_pages: 4, last_pass_at: null, degraded: true as const };

function ctxFor(engine: BrainEngine, notices: Notice[]): OperationContext {
  return { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} }, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as OperationContext;
}

/** Adds a private page that refers to Acme, and a private page that nobody refers to, in `default` (and one in `other`). */
async function seedPrivate(engine: BrainEngine): Promise<void> {
  await engine.putPage('notes/secret', page('Secret', { compiled_truth: 'Secret about Acme Example.', frontmatter: { visibility: 'private' } }));
  await engine.putPage('notes/hidden', page('Hidden', { frontmatter: { visibility: 'private' } }));
  await engine.putPage('notes/secret-elsewhere', page('Secret elsewhere', { frontmatter: { visibility: 'private' } }), { sourceId: 'other' });
  await engine.addLinksBatch([{ from_slug: 'notes/secret', to_slug: ACME, link_type: 'mentions', context: 'Acme Example',
    link_source: 'manual', from_source_id: 'default', to_source_id: 'default' }]);
}

/** A remote caller that reads world pages only: the read policy hides a private page from it. */
function worldOnlyCtx(engine: BrainEngine, notices: Notice[]): OperationContext {
  return { ...ctxFor(engine, notices), remote: true, transport: 'stdio', takesHoldersAllowList: ['world'] } as unknown as OperationContext;
}

const codes = (notices: Notice[]) => notices.map(n => n.code).sort();

describe('engine parity: mention-index coverage', () => {
  parityTest(
    'readMentionCoverage before any pass counts every live page of each listed source as pending, and is disabled when mention linking is off',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'setConfig', 'readMentionIndexStatus', 'countLivePagesInSource'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const on = {
        default: await readMentionCoverage(engine, ['default']),
        all: await readMentionCoverage(engine, ['default', 'other', 'ghost']),
        ghost: await readMentionCoverage(engine, ['ghost']),
        none: await readMentionCoverage(engine, []),
      };
      await engine.setConfig('mentions.auto_link', 'false');
      const off = await readMentionCoverage(engine, ['default', 'other']);
      const out = { on, off };
      expect(out).toEqual({
        on: {
          default: PENDING_DEFAULT,
          all: { ...PENDING_DEFAULT, pending_pages: 6 },
          ghost: { state: 'complete', pending_pages: 0, last_pass_at: null },
          none: { state: 'complete', pending_pages: 0, last_pass_at: null },
        },
        off: { state: 'disabled', pending_pages: 0, last_pass_at: null, degraded: true },
      });
      return out;
    },
  );

  parityTest(
    'countMentionDueSince counts the live pages of a source written at or after the bound, none past a future bound',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'countMentionDueSince'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const due = (sourceId: string, since: string) => engine.countMentionDueSince(sourceId, since, MENTION_EXTRACTOR_VERSION);
      // Not '-infinity': postgres.js binds a timestamptz parameter through Date and refuses it ("Invalid Date").
      // Coverage passes it only for a status row with no counted_at, which the mention pass never writes.
      const past = '2000-01-01T00:00:00.000Z';
      const out = {
        other: await due('other', past),
        ghost: await due('ghost', past),
        past: await due('default', past),
        future: await due('default', '2999-01-01T00:00:00.000Z'),
      };
      expect(out).toEqual({ other: 2, ghost: 0, past: 4, future: 0 });
      return out;
    },
  );

  parityTest(
    'recountMentionIndexStatus on a source with no status row writes nothing, and coverage is unchanged',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'recountMentionIndexStatus', 'readMentionIndexStatus'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      await engine.recountMentionIndexStatus('default', { pending: 9, fingerprint: 'h;v', expectedFingerprint: null });
      await engine.recountMentionIndexStatus('ghost', { pending: 9, fingerprint: 'h;v', expectedFingerprint: 'h;old' });
      const out = { rows: await engine.readMentionIndexStatus(['default', 'ghost']), coverage: await readMentionCoverage(engine, ['default']) };
      expect(out).toEqual({ rows: [], coverage: PENDING_DEFAULT });
      return out;
    },
  );

  parityTest(
    'a private page counts in the live-page count and the written-since count exactly like any live page',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'addLinksBatch', 'countLivePagesInSource', 'countMentionDueSince', 'readMentionIndexStatus'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      await seedPrivate(engine);
      const past = '2000-01-01T00:00:00.000Z';
      const out = {
        live: { default: await engine.countLivePagesInSource('default'), other: await engine.countLivePagesInSource('other'), ghost: await engine.countLivePagesInSource('ghost') },
        since: { default: await engine.countMentionDueSince('default', past, MENTION_EXTRACTOR_VERSION), other: await engine.countMentionDueSince('other', past, MENTION_EXTRACTOR_VERSION) },
        coverage: await readMentionCoverage(engine, ['default', 'other']),
      };
      // 4 live + the 2 private pages in `default`; 2 live + 1 private in `other`. A count only: no slug is read.
      expect(out).toEqual({
        live: { default: 6, other: 3, ghost: 0 },
        since: { default: 6, other: 3 },
        coverage: { ...PENDING_DEFAULT, pending_pages: 9 },
      });
      return out;
    },
  );

  parityTest(
    'a world-only remote caller gets the same paged backlinks as a local one, minus the private referrer, and the same coverage',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'addLinksBatch', 'listReferrerTargetSources', 'countReferrerRows', 'readReferrerRows'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      await seedPrivate(engine);
      const op = operations.find(o => o.name === 'get_backlinks')!;
      const read = async (ctx: OperationContext) => {
        const r = await op.handler(ctx, { slug: ACME, group: 'page' }) as { rows: Array<{ slug: string }>; total: number; coverage: unknown };
        return { slugs: r.rows.map(x => x.slug).sort(), total: r.total, coverage: r.coverage };
      };
      const localNotices: Notice[] = [];
      const remoteNotices: Notice[] = [];
      const out = { local: await read(ctxFor(engine, localNotices)), remote: await read(worldOnlyCtx(engine, remoteNotices)),
        notices: { local: codes(localNotices), remote: codes(remoteNotices) } };
      expect(out.local.slugs).toEqual(['notes/one', 'notes/secret', 'notes/two']);
      expect(out.remote.slugs).toEqual(['notes/one', 'notes/two']);
      expect([out.local.total, out.remote.total]).toEqual([3, 2]);
      expect(JSON.stringify(out.remote)).not.toContain('secret');
      expect(out.remote.coverage).toEqual({ ...PENDING_DEFAULT, pending_pages: 6 });
      expect(out.notices).toEqual({ local: ['mention_index'], remote: ['mention_index'] });
      return out;
    },
  );

  parityTest(
    'the entity card carries the coverage on a linkable type and type_not_linkable on another, and a miss carries it too',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'addLinksBatch'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const card = async (name: string) => {
        const r = await buildEntityCard(engine, 'default', name, { remote: false, includeReferences: true });
        return r.found && r.card
          ? { found: true, coverage: r.card.coverage, count: r.card.referenced_by_count, unavailable: r.card.references_unavailable ?? null }
          : { found: false, coverage: r.coverage };
      };
      const out = { company: await card('Acme Example'), note: await card('Roadmap'), miss: await card('Nobody Example') };
      expect(out).toEqual({
        company: { found: true, coverage: PENDING_DEFAULT, count: 2, unavailable: null },
        note: { found: true, coverage: { ...PENDING_DEFAULT, state: 'type_not_linkable' }, count: 0, unavailable: null },
        miss: { found: false, coverage: PENDING_DEFAULT },
      });
      return out;
    },
  );

  parityTest(
    'get_backlinks with group page returns the coverage of the entity source and emits its notice',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'addLinksBatch'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const notices: Notice[] = [];
      const op = operations.find(o => o.name === 'get_backlinks')!;
      const r = await op.handler(ctxFor(engine, notices), { slug: ACME, group: 'page' }) as { rows: Array<{ slug: string }>; total: number; coverage: unknown };
      const out = { slugs: r.rows.map(x => x.slug).sort(), total: r.total, coverage: r.coverage, notices: codes(notices) };
      expect(out).toEqual({ slugs: ['notes/one', 'notes/two'], total: 2, coverage: PENDING_DEFAULT, notices: ['mention_index'] });
      return out;
    },
  );

  parityTest(
    'a search whose query names an entity emits the mention_index notice for its source',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'addLinksBatch'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const notices: Notice[] = [];
      const op = operations.find(o => o.name === 'search')!;
      await op.handler(ctxFor(engine, notices), { query: 'Acme Example discount' });
      const out = { notices: codes(notices).filter(c => c === 'mention_index') };
      expect(out).toEqual({ notices: ['mention_index'] });
      return out;
    },
  );

  parityTest(
    'an entity-names lookup whose entity has referrers emits the mention_index notice',
    { methods: ['putPage', 'softDeletePage', 'setPageAliases', 'addLinksBatch'] },
    async (engine: BrainEngine, backend) => {
      await seed(engine, backend);
      const notices: Notice[] = [];
      const r = await lookupEntityNames(engine, 'default', ['Acme Example', 'Nobody Example'], { remote: false, emitNotice: n => { notices.push(n); } });
      const out = { found: r.found, missing: r.missing, count: (r.results[0] as { referenced_by_count?: number }).referenced_by_count,
        notices: codes(notices).filter(c => c === 'mention_index') };
      expect(out).toEqual({ found: 1, missing: 1, count: 2, notices: ['mention_index'] });
      return out;
    },
  );
});
