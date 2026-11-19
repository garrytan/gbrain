/**
 * BrainEngine parity — `excludePrivate`, the safe-chunk fence, the trust floor (`minTrust`) and the flagged-page filter
 * (`suppressFlagged`) on the keyword members (searchKeyword, searchKeywordChunks, countKeywordPages,
 * searchKeywordPages, searchTitles).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: under `excludePrivate` each keyword member drops the pages the page policy
 *    (`privatePagesFilterForCaller('p')`, src/core/search/private-visibility.ts) hides, and under
 *    `requiresSafeChunks` (which `excludePrivate` implies unless the read says otherwise) the pages short of the
 *    chunker-version fence, before it ranks, limits or counts (`buildVisibilityClause`, search/sql-ranking.ts). A
 *    safe-chunk searchTitles matches and ranks title lexemes only (`buildSearchTitlesStatement`). Under `minTrust`
 *    each member drops the pages whose stamped trust tier ranks below the floor, and under `suppressFlagged` the
 *    pages at or below `agent_written` with a flag receipt in an activation reason family (`pageEligibleSql`).
 *    Every engine arm returns the same rows.
 *  - Regression: an engine that ignores the flag (a private page ranks first in remote keyword search, a hidden page
 *    is counted by the keyword pager), that skips the fence, that applies the fence without `excludePrivate`, or that
 *    lets a safe-chunk title search match a page on its timeline; one that ignores the trust floor or the flag, reads
 *    a flag receipt outside the activation families, or suppresses a flagged page above `agent_written`.
 *  - Why existing coverage misses it: search.test.ts never passes `excludePrivate` or `requireSafeChunks`, and
 *    private-page-reads.test.ts covers the salience, anomaly and chunk reads, not keyword search.
 *  - Caller policy: the last case reads as a member whose identity a page's readers name, then with a private-readable
 *    grant on the source; the Rust store reads both from the policy the TypeScript member sends.
 *  - Owner-only sources: the last describe adds a source of kind imessage and one with owner_only set. A non-owner
 *    read (no caller record, or a reader caller) hides every page while one exists (the closed form, no schema
 *    version in context) and, at schema 320 (the fn form), only the pages in those sources and the concepts
 *    synthesized from them (`ownerOnlyAllowedSql`, src/core/search/private-visibility.ts).
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchOpts, SearchResult } from '../../src/core/types.ts';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';

const { parityTest } = parityArms(testBackends());

/** One page per rule, each named after what it tests. `weight` repeats the shared word so the hidden pages rank first. */
const PAGES: Array<[slug: string, type: string, frontmatter: Record<string, unknown>, weight: number]> = [
  ['notes/private', 'note', { visibility: 'private' }, 6],
  ['notes/readers', 'note', { readable_by: ['alice-example'] }, 5],
  ['notes/access-alias', 'note', { access: 'Restricted' }, 5],
  ['atoms/no-visibility', 'atom', {}, 4],
  ['atoms/origin-private', 'atom', { visibility: 'world', source_slug: 'notes/private' }, 4],
  ['notes/lineage-private', 'note', { derived_from: 'notes/private.md' }, 4],
  ['notes/fence-short', 'note', {}, 3],
  ['notes/open', 'note', {}, 2],
  ['atoms/origin-open', 'atom', { visibility: 'world', source_slug: 'notes/open' }, 1],
  ['notes/access-plain', 'note', { access: 'team' }, 1],
];

async function fixture(engine: BrainEngine, opts: { readers?: boolean } = {}): Promise<void> {
  for (const [slug, type, frontmatter, weight] of PAGES) {
    if (opts.readers === false && 'readable_by' in frontmatter) continue;
    const text = `${Array(weight).fill('zephyr').join(' ')} quartz notes about ${slug}.`;
    await engine.putPage(slug, { type: type as never, title: `Zephyr ${slug}`, compiled_truth: text, timeline: '', frontmatter });
    await installChunks(engine, slug, [chunk(0, text)]);
  }
  // Kept by the page policy, but the shared word is only in its timeline: a title-only (safe-chunk) search misses it.
  await engine.putPage('notes/timeline-only', { type: 'note', title: 'Harbor log', compiled_truth: 'Harbor log.', timeline: '- 2026-01-02: zephyr seen at the harbor' });
  await installChunks(engine, 'notes/timeline-only', [chunk(0, 'Harbor log.'), chunk(1, '- 2026-01-02: zephyr seen at the harbor', { chunk_source: 'timeline' })]);
  // Sealed text, but a chunker version short of the safe fence: only the safe-chunk reads drop it.
  await engine.setChunkerVersion('notes/fence-short', 3);
}

/** One page per trust case: [slug, declared tier (none: the default), flag receipt reason families]. */
const TRUSTED: Array<[slug: string, tier: string | null, flag: string[] | null]> = [
  ['notes/curated', 'operator_curated', null],
  ['notes/curated-flagged', 'operator_curated', ['override']],
  ['notes/observed', 'tool_observed', null],
  ['notes/agent', 'agent_written', null],
  ['notes/agent-flagged', 'agent_written', ['override']],
  ['notes/agent-other-flag', 'agent_written', ['other']],
  ['notes/unknown-flagged', null, ['credential']],
  ['notes/outside', 'external_untrusted', null],
];

async function trustFixture(engine: BrainEngine): Promise<void> {
  for (const [i, [slug, tier, flag]] of TRUSTED.entries()) {
    // The less trusted pages rank first, so a limited read must filter before it limits.
    const text = `${Array(i + 1).fill('nimbus').join(' ')} ledger notes about ${slug}.`;
    const write = async (e: BrainEngine) => {
      await e.putPage(slug, { type: 'note', title: `Nimbus ${slug}`, compiled_truth: text, timeline: '' });
      await installChunks(e, slug, [chunk(0, text)]);
    };
    if (tier) {
      await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_origin'], [tier, JSON.stringify({ channel: tier })]);
        await write(tx);
      });
    } else {
      await write(engine);
    }
    if (flag) {
      await engine.upsertPageWriteGateReceipt('default', slug, {
        content_hash: 'h1', tier: 'agent_written', detector_version: 1, verdict: 'flag', reason_families: flag,
        reasons: flag, detector_error: false, request_id: null,
      });
    }
  }
}

const TRUST_SCOPES: Record<string, SearchOpts> = {
  none: {},
  emptyFloor: { minTrust: '' as never },
  curated: { minTrust: 'operator_curated' },
  agent: { minTrust: 'agent_written' },
  any: { minTrust: 'external_untrusted' },
  suppressed: { suppressFlagged: true },
  agentSuppressed: { minTrust: 'agent_written', suppressFlagged: true },
};

const view = (rows: SearchResult[]) => rows.map((r) => `${r.slug}:${r.chunk_index}${r.keyword_relaxed ? ':relaxed' : ''}`);

const SCOPES: Record<string, SearchOpts> = {
  off: {},
  private: { excludePrivate: true },
  privateNoFence: { excludePrivate: true, requireSafeChunks: false },
  fenceOnly: { requireSafeChunks: true },
};

async function eachScope<T>(read: (scope: SearchOpts) => Promise<T>): Promise<Record<string, T>> {
  const out: Record<string, T> = {};
  for (const [name, scope] of Object.entries(SCOPES)) out[name] = await read(scope);
  return out;
}

/** The pages the page policy keeps (the fence-short page passes the policy). */
const KEPT = ['atoms/origin-open', 'notes/access-plain', 'notes/fence-short', 'notes/open', 'notes/timeline-only'];

describe('engine parity: excludePrivate and the safe-chunk fence on keyword search', () => {
  parityTest(
    'searchKeyword and searchKeywordChunks drop hidden and fence-short pages before they rank and limit',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'searchKeyword', 'searchKeywordChunks'] },
    async (engine) => {
      await fixture(engine);
      const keyword = await eachScope(async (scope) => view(await engine.searchKeyword('zephyr', { limit: 3, ...scope })));
      const all = await eachScope(async (scope) => sorted(view(await engine.searchKeyword('zephyr', { limit: 20, ...scope }))));
      const chunks = await eachScope(async (scope) => view(await engine.searchKeywordChunks('zephyr', { limit: 3, ...scope })));
      const relaxed = await eachScope(async (scope) => view(await engine.searchKeyword('zephyr qqqqzzzz', { limit: 3, orFallback: true, ...scope })));
      // The hidden pages rank first without the flag, so the limited read must filter before it limits.
      expect(keyword.off![0]!.startsWith('notes/private:')).toBe(true);
      expect(keyword.private).toEqual(['notes/open:0', 'atoms/origin-open:0', 'notes/access-plain:0']);
      expect(all.private!.map((r) => r.split(':')[0])).toEqual(KEPT.filter((s) => s !== 'notes/fence-short'));
      expect(all.privateNoFence!.map((r) => r.split(':')[0])).toEqual(KEPT);
      expect(all.fenceOnly!).not.toContain('notes/fence-short:0');
      expect(all.fenceOnly!).toContain('notes/private:0');
      return { keyword, all, chunks, relaxed };
    },
  );

  parityTest(
    'countKeywordPages and searchKeywordPages count and page only the pages the scope keeps',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'countKeywordPages', 'searchKeywordPages'] },
    async (engine) => {
      await fixture(engine);
      const counts = await eachScope((scope) => engine.countKeywordPages('zephyr', scope));
      const pages = await eachScope(async (scope) => view(await engine.searchKeywordPages('zephyr', scope, { limit: 2, offset: 1 })));
      expect(counts.off).toBe(PAGES.length + 1);
      expect(counts.private).toBe(KEPT.length - 1);
      expect(counts.privateNoFence).toBe(KEPT.length);
      expect(counts.fenceOnly).toBe(PAGES.length);
      return { counts, pages };
    },
  );

  parityTest(
    'searchTitles under the safe-chunk fence matches titles only and drops hidden pages, on the strict and the OR attempts',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'searchTitles'] },
    async (engine) => {
      await fixture(engine);
      const strict = await eachScope(async (scope) => sorted(view(await engine.searchTitles('zephyr', { limit: 20, ...scope }))));
      const limited = await eachScope(async (scope) => view(await engine.searchTitles('zephyr', { limit: 2, offset: 1, ...scope })));
      const anyWord = await eachScope(async (scope) => sorted(view(await engine.searchTitles('zephyr qqqqzzzz', { limit: 20, ...scope }))));
      const slugs = (rows: string[]) => rows.map((r) => r.split(':')[0]);
      expect(slugs(strict.off!)).toContain('notes/timeline-only');
      expect(slugs(strict.privateNoFence!)).toEqual(KEPT);
      // Title-only: the timeline match is gone, and so is the fence-short page.
      expect(slugs(strict.private!)).toEqual(['atoms/origin-open', 'notes/access-plain', 'notes/open']);
      expect(slugs(strict.fenceOnly!)).not.toContain('notes/timeline-only');
      expect(slugs(anyWord.private!)).toEqual(['atoms/origin-open', 'notes/access-plain', 'notes/open']);
      return { strict, limited, anyWord };
    },
  );

  parityTest(
    'every keyword member drops pages below the trust floor and flagged pages before it ranks, limits or counts',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'sealChunks', 'upsertPageWriteGateReceipt',
      'searchKeyword', 'searchKeywordChunks', 'countKeywordPages', 'searchKeywordPages', 'searchTitles'] },
    async (engine) => {
      await trustFixture(engine);
      const out: Record<string, Record<string, unknown>> = {};
      for (const [name, scope] of Object.entries(TRUST_SCOPES)) {
        out[name] = {
          keyword: view(await engine.searchKeyword('nimbus', { limit: 2, ...scope })),
          all: sorted(view(await engine.searchKeyword('nimbus', { limit: 20, ...scope }))),
          chunks: view(await engine.searchKeywordChunks('nimbus', { limit: 2, ...scope })),
          count: await engine.countKeywordPages('nimbus', scope),
          pages: view(await engine.searchKeywordPages('nimbus', scope, { limit: 2, offset: 1 })),
          titles: sorted(view(await engine.searchTitles('nimbus', { limit: 20, ...scope }))),
          titlesAnyWord: view(await engine.searchTitles('nimbus qqqqzzzz', { limit: 2, ...scope })),
        };
      }
      const slugs = (name: string) => (out[name]!.all as string[]).map((r) => r.split(':')[0]!).sort();
      expect(out.none!.count).toBe(TRUSTED.length);
      expect(slugs('emptyFloor')).toEqual(slugs('none'));
      expect(slugs('any')).toEqual(slugs('none'));
      expect(slugs('curated')).toEqual(['notes/curated', 'notes/curated-flagged']);
      expect(slugs('agent')).toEqual(['notes/agent', 'notes/agent-flagged', 'notes/agent-other-flag', 'notes/curated',
        'notes/curated-flagged', 'notes/observed']);
      // A flag outside the activation families, or on a page above agent_written, suppresses nothing.
      expect(slugs('suppressed')).toEqual(['notes/agent', 'notes/agent-other-flag', 'notes/curated', 'notes/curated-flagged',
        'notes/observed', 'notes/outside']);
      expect(out.agentSuppressed!.count).toBe(5);
      expect(out.suppressed!.keyword).toEqual(['notes/outside:0', 'notes/agent-other-flag:0']);
      return out;
    },
  );
});

describe('engine parity: excludePrivate on keyword search for a caller with a reader identity and a private-readable grant', () => {
  parityTest(
    'every keyword member under excludePrivate applies a caller\'s reader identity and private-readable grant',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'searchKeyword', 'searchKeywordChunks', 'countKeywordPages',
      'searchKeywordPages', 'searchTitles'] },
    async (engine) => {
      await fixture(engine);
      const slugs = (rows: SearchResult[]) => sorted(rows.map((r) => r.slug));
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, async () => ({
        keyword: slugs(await engine.searchKeyword('zephyr', { limit: 20, excludePrivate: true })),
        top: view(await engine.searchKeyword('zephyr', { limit: 2, excludePrivate: true })),
        chunks: slugs(await engine.searchKeywordChunks('zephyr', { limit: 20, excludePrivate: true })),
        count: await engine.countKeywordPages('zephyr', { excludePrivate: true }),
        pages: view(await engine.searchKeywordPages('zephyr', { excludePrivate: true }, { limit: 2, offset: 1 })),
        titles: slugs(await engine.searchTitles('zephyr', { limit: 20, excludePrivate: true })),
      }));
      const member = await read({ identity: ['member:alice-example', 'group:team-a'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const stranger = await read({ identity: ['member:bob-example'], hidePrivate: true });
      // The fence-short page fails the safe-chunk fence excludePrivate implies, for every caller.
      const memberKept = sorted([...KEPT.filter((s) => s !== 'notes/fence-short'), 'notes/readers']);
      expect(member.keyword).toEqual(memberKept);
      expect(member.count).toBe(memberKept.length);
      expect(member.top).toEqual(['notes/readers:0', 'notes/open:0']);
      expect(stranger.keyword).toEqual(KEPT.filter((s) => s !== 'notes/fence-short'));
      expect(granted.keyword).toEqual(sorted([...PAGES.map(([slug]) => slug), 'notes/timeline-only'].filter((s) => s !== 'notes/fence-short')));
      expect(granted.top).toEqual(['notes/private:0', 'notes/readers:0']);
      expect(granted.titles).not.toContain('notes/timeline-only');
      return { member, granted, stranger };
    },
  );
});

describe('engine parity: excludePrivate on keyword search for a remote caller on a brain with no member restriction', () => {
  // A remote request on a brain whose config holds no access.restrictions_present (no page names readers, no member
  // exists) renders the short member-access form (`page_readers IS NULL AND folder_rule_ids IS NULL`). The fixture
  // keeps that true: no page here names readers.
  parityTest(
    'every keyword member under excludePrivate serves an unrestricted remote caller, with and without a private-readable grant',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'searchKeyword', 'searchKeywordChunks', 'countKeywordPages',
      'searchKeywordPages', 'searchTitles'] },
    async (engine) => {
      await fixture(engine, { readers: false });
      const slugs = (rows: SearchResult[]) => sorted(rows.map((r) => r.slug));
      const snippets = (rows: SearchResult[]) => rows.map((r) => `${r.slug}:${r.chunk_text}`);
      const read = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess({ restricted: false, ...access }, async () => ({
        keyword: slugs(await engine.searchKeyword('zephyr', { limit: 20, excludePrivate: true })),
        top: view(await engine.searchKeyword('zephyr', { limit: 2, excludePrivate: true })),
        snippets: snippets(await engine.searchKeywordChunks('zephyr', { limit: 3, excludePrivate: true })),
        count: await engine.countKeywordPages('zephyr', { excludePrivate: true }),
        pages: view(await engine.searchKeywordPages('zephyr', { excludePrivate: true }, { limit: 2, offset: 1 })),
        titles: slugs(await engine.searchTitles('zephyr', { limit: 20, excludePrivate: true })),
      }));
      const plain = await read({ hidePrivate: true });
      const member = await read({ identity: ['member:alice-example'], hidePrivate: true });
      const granted = await read({ identity: ['member:alice-example'], privateReadableSources: ['default'], hidePrivate: true });
      const kept = KEPT.filter((s) => s !== 'notes/fence-short');
      // The plain caller sees no private page, by rows, count, snippet or rank.
      expect(plain.keyword).toEqual(kept);
      expect(plain.count).toBe(kept.length);
      expect(plain.top).toEqual(['notes/open:0', 'atoms/origin-open:0']);
      expect(plain.snippets.join('\n')).not.toContain('notes/private');
      // A member identity reads nothing more: no page names readers here.
      expect(member).toEqual(plain);
      // The grant shows the private pages of the source, ranked by their weight.
      const all = sorted([...PAGES.map(([slug]) => slug), 'notes/timeline-only'].filter((s) => s !== 'notes/fence-short' && s !== 'notes/readers'));
      expect(granted.keyword).toEqual(all);
      expect(granted.count).toBe(all.length);
      expect(granted.top).toEqual(['notes/private:0', 'notes/access-alias:0']);
      return { plain, member, granted };
    },
  );
});

describe('engine parity: owner-only sources on excludePrivate keyword search', () => {
  parityTest(
    'every keyword member under excludePrivate hides every page while a source is owner-only (closed form) and only owner-only pages and their concepts at schema 320 (fn form)',
    { methods: ['putPage', 'addLink', 'sealChunks', 'searchKeyword', 'searchKeywordChunks', 'countKeywordPages', 'searchKeywordPages', 'searchTitles'] },
    async (engine, backend) => {
      const seed = async (slug: string, sourceId: string, type = 'note', frontmatter: Record<string, unknown> = {}) => {
        const opts = sourceId === 'default' ? undefined : { sourceId };
        const text = `zephyr quartz notes about ${slug}.`;
        await engine.putPage(slug, { type: type as never, title: `Zephyr ${slug}`, compiled_truth: text, timeline: '', frontmatter }, opts);
        await installChunks(engine, slug, [chunk(0, text)], opts);
      };
      const concept = { visibility: 'world', synthesized_by: 'dream' };
      await seed('notes/open', 'default');
      await seed('concepts/from-open', 'default', 'concept', concept);
      await engine.addLink('concepts/from-open', 'notes/open', '', 'synthesized_from', 'concept-provenance');

      const slugs = (rows: SearchResult[]) => sorted(rows.map((r) => `${r.source_id}:${r.slug}`));
      const read = async () => {
        const run = async () => ({
          keyword: slugs(await engine.searchKeyword('zephyr', { limit: 20, excludePrivate: true })),
          chunks: slugs(await engine.searchKeywordChunks('zephyr', { limit: 20, excludePrivate: true })),
          count: await engine.countKeywordPages('zephyr', { excludePrivate: true }),
          pages: slugs(await engine.searchKeywordPages('zephyr', { excludePrivate: true }, { limit: 20, offset: 0 })),
          titles: slugs(await engine.searchTitles('zephyr', { limit: 20, excludePrivate: true })),
        });
        return { none: await run(), reader: await withCallerAccess({ identity: ['member:alice-example'], hidePrivate: true }, run) };
      };
      const kept = ['default:concepts/from-open', 'default:notes/open'];
      const keptAnswer = { keyword: kept, chunks: kept, count: 2, pages: kept, titles: kept };
      const hidden = { keyword: [], chunks: [], count: 0, pages: [], titles: [] };

      // Before an owner-only source exists the default pages read: the case is not vacuous.
      const before = await read();
      expect(before.none).toEqual(keptAnswer);

      await createSource(engine, backend, 'chat', { kind: 'imessage' });
      await createSource(engine, backend, 'vault', { owner_only: true });
      await seed('notes/chat-note', 'chat');
      await seed('notes/vault-note', 'vault');
      await seed('concepts/from-chat', 'default', 'concept', concept);
      await engine.addLink('concepts/from-chat', 'notes/chat-note', '', 'synthesized_from', 'concept-provenance', undefined, undefined, { toSourceId: 'chat' });

      // Closed form: no schema version in context. A non-owner reads nothing while any source is owner-only.
      const closed = await read();
      expect(closed.none).toEqual(hidden);
      expect(closed.reader).toEqual(hidden);

      // Fn form (schema 320): only owner-only pages, and the concept synthesized from one, are hidden.
      noteSchemaVersion(engine, LATEST_SCHEMA_VERSION);
      let fn;
      try {
        fn = await withEngineScope(engine, read);
      } finally {
        noteSchemaVersion(engine, Number.NaN);
      }
      expect(fn.none).toEqual(keptAnswer);
      expect(fn.reader).toEqual(keptAnswer);
      return { before, closed, fn };
    },
  );
});
