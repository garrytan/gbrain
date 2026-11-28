/**
 * BrainEngine parity: the belief history a remote delta with beliefs pages through, over the served wire: the history read
 * (readBeliefHistoryRows), the link lifetimes a caller may see (listVisibleBeliefLifetimes) and the coverage events that place a
 * window (readBeliefCoverageEvents).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded or served) the reader a remote delta pages
 *    through (belief/history.ts readBeliefHistoryPage with remote: true) keeps the world fact and the link between two readable
 *    pages, and drops a private event, an event on a private page and a link to a private page; it reports what it scanned; the
 *    coverage events are the source's started and complete marks.
 *  - Regression: on the served arm each read was refused for a remote caller (not on OWNER_IPC_REMOTE_TYPED_READS), so the history
 *    read failed with a typed engine_capability_missing refusal or listed nothing.
 *  - Why existing coverage misses it: belief-ledger.test.ts compares the ledger members on the arm's own engine; the delta tests
 *    (delta-beliefs-link-context-2957, belief-ledger-weekly-diff) run PGLite and Postgres only. The delta operation itself cannot
 *    finish on any Rust arm: coverageIntervals (belief/coverage-report.ts:80-104) runs raw SQL after readBeliefCoverageEvents, so the
 *    proof here is the reader, not the operation.
 *  - Seam: none. Pages and events are written with typed members (putPage, mintBeliefLifetime, insertBeliefEvents); coverage by
 *    enableBeliefLedger; the reader is the production one.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventInsertRow } from '../../src/core/engine-sql/belief-ledger.ts';
import { readBeliefHistoryPage } from '../../src/core/belief/history.ts';
import { withRemoteCaller } from '../../src/core/remote-caller.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';
import { enableBeliefLedger } from '../../src/core/belief/coverage.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const worldOnly = <T>(fn: () => Promise<T>) => withRemoteCaller(true, () => withCallerAccess({ identity: [], audience: null, audienceIdentities: [] }, fn));
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const page = (title: string, frontmatter: Record<string, unknown> = {}) => ({ type: 'note' as const, title, compiled_truth: `${title}.`, timeline: '', frontmatter });

const PUB = '00000000-0000-4000-8000-0000000000b1';
const LT = { open: '00000000-0000-4000-8000-0000000000a1', other: '00000000-0000-4000-8000-0000000000a2', hidden: '00000000-0000-4000-8000-0000000000a3' };

function event(incarnation: string, key: string, ord: number, over: Partial<BeliefEventInsertRow>): BeliefEventInsertRow {
  return {
    event_key: key, source_id: 'default', source_incarnation: incarnation, page_lifetime: LT.open, slug: 'notes/bl-open', subject_kind: 'fact',
    subject_key: `fact:${ord}`, event_type: 'fact.asserted', origin: 'live', trust_tier: 'owner', writer_tier: null, tier_basis: 'row',
    visibility: 'world', publication_id: PUB, ord, source_time: null, valid_from: null, valid_until: null,
    value: JSON.stringify({ fact: `claim ${ord}` }), value_hash: `vh${ord}`, prior_hash: null, state_hash: `sh${ord}`,
    cause: JSON.stringify({ op: 'put_page' }), claim_fp: `fp${ord}`, purged: false, redacted_fields: null, ...over,
  };
}

const link = (from: string, to: string, fromSlug: string, toSlug: string) => ({
  subject_kind: 'link', event_type: 'link.asserted', page_lifetime: from === LT.hidden ? LT.hidden : LT.open, slug: fromSlug,
  subject_key: JSON.stringify([`L:${from}`, `L:${to}`, '', 'mentions']),
  value: JSON.stringify({ link_type: 'mentions' }), cause: JSON.stringify({ op: 'put_page', label: { from: ['', fromSlug], to: ['', toSlug] } }),
});

parityTest('the belief history a remote delta pages through keeps the world fact and the link between readable pages, and none of a private event, page or link', {
  methods: ['putPage', 'mintBeliefLifetime', 'insertBeliefEvents', 'readBeliefHistoryRows', 'listVisibleBeliefLifetimes', 'readBeliefCoverageEvents'],
  timeout: 240_000,
}, async (engine: BrainEngine) => {
  const ids: Record<string, number> = {};
  for (const [slug, fm] of [['notes/bl-open', {}], ['notes/bl-other', {}], ['notes/bl-hidden', { visibility: 'private' }]] as const) {
    await engine.putPage(slug, page(slug, fm));
    ids[slug] = (await engine.getPage(slug))!.id;
  }
  const inc = (await engine.readLedgerSource('default'))!.incarnation;
  await engine.mintBeliefLifetime({ lifetime: LT.open, sourceId: 'default', incarnation: inc, slug: 'notes/bl-open', pageId: ids['notes/bl-open']! });
  await engine.mintBeliefLifetime({ lifetime: LT.other, sourceId: 'default', incarnation: inc, slug: 'notes/bl-other', pageId: ids['notes/bl-other']! });
  await engine.mintBeliefLifetime({ lifetime: LT.hidden, sourceId: 'default', incarnation: inc, slug: 'notes/bl-hidden', pageId: ids['notes/bl-hidden']! });
  await enableBeliefLedger(engine, 'default');
  await wait(60);
  const since = new Date().toISOString();
  await wait(60);
  await engine.insertBeliefEvents([
    event(inc, 'dd01', 1, { value: JSON.stringify({ fact: 'beliefmark open claim' }) }),
    event(inc, 'dd02', 2, { visibility: 'private', value: JSON.stringify({ fact: 'beliefmark private claim' }) }),
    event(inc, 'dd03', 3, { page_lifetime: LT.hidden, slug: 'notes/bl-hidden', value: JSON.stringify({ fact: 'beliefmark hidden page claim' }) }),
    event(inc, 'dd04', 4, link(LT.open, LT.other, 'notes/bl-open', 'notes/bl-other')),
    event(inc, 'dd05', 5, link(LT.open, LT.hidden, 'notes/bl-open', 'notes/bl-hidden')),
  ]);
  await engine.markBeliefCommits([PUB]);
  // The reader a remote delta with beliefs pages through (belief/changes.ts readAll), with the remote filter it applies after the raw rows return.
  const history = await worldOnly(() => readBeliefHistoryPage(engine, { sourceId: 'default', remote: true, afterId: 0, limit: 50, recordedAfter: since }));
  const kept = history.rows.map(r => ({ type: r.event_type, kind: r.subject_kind, key: r.subject_key, value: r.value }));
  expect(kept.filter(r => r.kind === 'fact').map(r => r.value?.fact)).toEqual(['beliefmark open claim']);
  expect(kept.filter(r => r.kind === 'link').map(r => r.key)).toEqual([JSON.stringify([`L:${LT.open}`, `L:${LT.other}`, '', 'mentions'])]);
  expect(JSON.stringify(kept)).not.toMatch(/beliefmark (private|hidden)|a3/);
  const coverage = (await worldOnly(() => engine.readBeliefCoverageEvents('default'))).map(e => e.event_type);
  expect(coverage).toEqual(['coverage.started', 'coverage.complete']);
  return { kept, scanned: history.scanned, coverage, readsOnLocal: (await readBeliefHistoryPage(engine, { sourceId: 'default', remote: false, afterId: 0, limit: 50, recordedAfter: since })).rows.length };
});
