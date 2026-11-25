/**
 * BrainEngine parity — belief ledger writes (src/core/engine-sql/belief-ledger.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the page lifetimes (mint, open read, moved read, rename, end), the event append and its commit marks,
 *    the redaction copies and releases, the tombstone read and the purge-epoch read return the same observable result
 *    on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1). The
 *    Rust store serves every write, the append's reads and the history, visible-lifetime, ledger-source and
 *    covered-source reads, and the coverage reads enable and disable make (newest coverage event, a slug's baseline by
 *    run, the pending slugs, the baselined count), so enabling a source with no pages runs on every arm. A failed event insert keeps the ids its rows took, as a Postgres sequence does, so the ids after it
 *    match. One case fills the ledger through the real writers (resolveLifetimes, appendBeliefEvents with a take
 *    tombstone, a redaction and an owner release, markBeliefCommits) and compares every read over it.
 *  - Regression: an engine that mints a second open lifetime at one (incarnation, slug), that reports a renamed page's
 *    lifetime as moved, that re-inserts an event key, that drops a redaction's release, or that answers 0 instead of
 *    null for an unknown source's purge epoch, or that sorts the pending baseline slugs by locale instead of bytes:
 *    the ledger would fork a page's history, lose a suppression or skip a page when a run resumes.
 *  - Why existing coverage misses it: the belief ledger tests drive these statements on PGLite alone; no case compares
 *    engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventInsertRow } from '../../src/core/engine-sql/belief-ledger.ts';
import { appendBeliefEvents, markBeliefCommits, type BeliefEventDraft } from '../../src/core/belief/append.ts';
import { renameLifetime, resolveLifetimes } from '../../src/core/belief/lifetimes.ts';
import { readBeliefHistory } from '../../src/core/belief/history.ts';
import { COVERAGE_KEY, fieldHash } from '../../src/core/belief/keys.ts';
import { disableBeliefLedger, enableBeliefLedger, latestCoverage } from '../../src/core/belief/coverage.ts';
import { lockedBeliefBatch } from '../../src/core/belief/writers.ts';
import { readBeliefState } from '../../src/core/belief/state.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const { parityTest } = parityArms(testBackends());

const L1 = '00000000-0000-4000-8000-0000000000a1';
const L2 = '00000000-0000-4000-8000-0000000000a2';
const PUB1 = '00000000-0000-4000-8000-0000000000b1';
const PUB2 = '00000000-0000-4000-8000-0000000000b2';
const PURGE = '00000000-0000-4000-8000-0000000000c1';
const PUB3 = '00000000-0000-4000-8000-0000000000b3';

async function incarnationOf(engine: BrainEngine): Promise<string> {
  const source = await engine.readLedgerSource('default');
  return source!.incarnation;
}

function event(incarnation: string, key: string, ord: number, over: Partial<BeliefEventInsertRow> = {}): BeliefEventInsertRow {
  return {
    event_key: key, source_id: 'default', source_incarnation: incarnation, page_lifetime: L1, slug: 'notes/a', subject_kind: 'fact',
    subject_key: `fact:${ord}`, event_type: 'fact.asserted', origin: 'live', trust_tier: 'owner', writer_tier: null, tier_basis: 'row',
    visibility: 'world', publication_id: PUB1, ord, source_time: '2026-03-01T10:00:00.000Z', valid_from: null, valid_until: null,
    value: JSON.stringify({ claim: `claim ${ord}` }), value_hash: `vh${ord}`, prior_hash: null, state_hash: `sh${ord}`,
    cause: JSON.stringify({ kind: 'test' }), claim_fp: `fp${ord}`, purged: false, redacted_fields: null, ...over,
  };
}

describe('engine parity: belief ledger writes', () => {
  parityTest(
    'page lifetimes: one open lifetime per slug, the moved read follows the page, a rename moves the lifetime and an end closes it once',
    { methods: ['putPage', 'getPage', 'readLedgerSource', 'mintBeliefLifetime', 'readOpenBeliefLifetimes', 'readMovedBeliefLifetimes', 'renameBeliefLifetime', 'endBeliefLifetime'] },
    async (engine) => {
      await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'body', timeline: '' });
      const page = await engine.getPage('notes/a');
      const inc = await incarnationOf(engine);
      const pid = page!.id;
      const norm = <T extends { page_id?: number | null; source_incarnation?: string }>(rows: T[]) => rows
        .map(r => ({ ...r, ...(r.page_id === undefined ? {} : { page_id: r.page_id === pid ? 'PID' : r.page_id }), ...(r.source_incarnation === undefined ? {} : { source_incarnation: r.source_incarnation === inc ? 'INC' : r.source_incarnation }) }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const first = await engine.mintBeliefLifetime({ lifetime: L1, sourceId: 'default', incarnation: inc, slug: 'notes/a', pageId: pid });
      const again = await engine.mintBeliefLifetime({ lifetime: L2, sourceId: 'default', incarnation: inc, slug: 'notes/a', pageId: pid });
      expect([first, again]).toEqual([L1, L1]);
      const open = norm(await engine.readOpenBeliefLifetimes([{ incarnation: inc, slug: 'notes/a' }, { incarnation: inc, slug: 'notes/none' }]));
      const moved = norm(await engine.readMovedBeliefLifetimes([pid, pid + 1000]));
      await engine.renameBeliefLifetime(L1, 'notes/b', pid);
      const movedAfterRename = norm(await engine.readMovedBeliefLifetimes([pid]));
      const openAtB = norm(await engine.readOpenBeliefLifetimes([{ incarnation: inc, slug: 'notes/b' }, { incarnation: inc, slug: 'notes/a' }]));
      await engine.endBeliefLifetime(L1);
      await engine.endBeliefLifetime(L1);
      const openAfterEnd = norm(await engine.readOpenBeliefLifetimes([{ incarnation: inc, slug: 'notes/b' }]));
      const reminted = await engine.mintBeliefLifetime({ lifetime: L2, sourceId: 'default', incarnation: inc, slug: 'notes/b', pageId: pid });
      expect({ moved: moved.length, movedAfterRename, openAfterEnd, reminted }).toEqual({ moved: 1, movedAfterRename: [], openAfterEnd: [], reminted: L2 });
      return { first, again, open, moved, movedAfterRename, openAtB, openAfterEnd, reminted,
        empty: { open: await engine.readOpenBeliefLifetimes([]), moved: await engine.readMovedBeliefLifetimes([]) } };
    },
  );

  parityTest(
    'insertBeliefEvents counts the rows it inserts, a constraint failure inserts none, and commit marks accept any publication list',
    { methods: ['readLedgerSource', 'insertBeliefEvents', 'markBeliefCommits'] },
    async (engine) => {
      const inc = await incarnationOf(engine);
      const rows = [event(inc, 'bb02', 2), event(inc, 'BB01', 1), event(inc, 'bb01', 3)];
      const inserted = await engine.insertBeliefEvents(rows);
      const failed = (p: Promise<unknown>) => p.then(() => 'ok', () => 'failed');
      const checks = {
        origin: await failed(engine.insertBeliefEvents([event(inc, 'bb09', 0), event(inc, 'bb10', 1, { origin: 'nope' })])),
        subjectKind: await failed(engine.insertBeliefEvents([event(inc, 'bb11', 0, { subject_kind: 'nope' })])),
        stateHash: await failed(engine.insertBeliefEvents([event(inc, 'bb12', 0, { state_hash: null as unknown as string })])),
      };
      const afterFailures = await engine.insertBeliefEvents([event(inc, 'bb09', 0), event(inc, 'bb01', 1)]);
      await engine.markBeliefCommits([PUB1, PUB2]);
      await engine.markBeliefCommits([PUB1]);
      return { inserted, checks, afterFailures, empty: await engine.insertBeliefEvents([]) };
    },
  );

  parityTest(
    'insertBeliefEvents skips a repeated event key, the history read returns the rows in id order, and commit marks are idempotent',
    { methods: ['readLedgerSource', 'insertBeliefEvents', 'readBeliefHistoryRows', 'markBeliefCommits'] },
    async (engine) => {
      const inc = await incarnationOf(engine);
      const rows = [event(inc, 'aa01', 0), event(inc, 'aa01', 1), event(inc, 'aa02', 2, { visibility: 'private', redacted_fields: ['value'], value: null, value_hash: null })];
      const inserted = await engine.insertBeliefEvents(rows);
      const repeated = await engine.insertBeliefEvents([event(inc, 'aa02', 0), event(inc, 'aa03', 1, { publication_id: PUB2, page_lifetime: null, subject_kind: 'take', value: JSON.stringify({ holder: 'people/x' }) })]);
      const none = await engine.insertBeliefEvents([]);
      await engine.markBeliefCommits([PUB1, PUB2]);
      await engine.markBeliefCommits([PUB1]);
      await engine.markBeliefCommits([]);
      const base = { sourceId: 'default', slug: null, subjectKey: null, afterId: 0, limit: 10, recordedAfter: null, recordedUntil: null, subjectKeys: null, beforeId: null };
      const clean = (list: Array<Record<string, unknown>>) => list.map(({ id: _id, recorded_at: _at, ...rest }) =>
        Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
      const history = clean(await engine.readBeliefHistoryRows({ ...base, descending: false }));
      const bySubject = clean(await engine.readBeliefHistoryRows({ ...base, subjectKeys: ['fact:2', 'fact:1'], descending: true }));
      expect({ inserted, repeated, none, count: history.length }).toEqual({ inserted: 2, repeated: 1, none: 0, count: 3 });
      return { inserted, repeated, none, history, bySubject };
    },
  );

  parityTest(
    'a failed insertBeliefEvents keeps the ids its rows took, as a sequence does, so the next insert ids match',
    { methods: ['readLedgerSource', 'insertBeliefEvents', 'readBeliefHistoryRows'] },
    async (engine) => {
      const inc = await incarnationOf(engine);
      await engine.insertBeliefEvents([event(inc, 'cc01', 0)]);
      // Row ord 1 takes an id, row ord 2 takes one and fails its check, row ord 3 never runs.
      const checkFailed = await engine.insertBeliefEvents([event(inc, 'cc02', 1), event(inc, 'cc03', 2, { origin: 'nope' }), event(inc, 'cc04', 3)])
        .then(() => 'ok', () => 'failed');
      // A cast failure fails before any row takes an id.
      const castFailed = await engine.insertBeliefEvents([event(inc, 'cc05', 0, { source_incarnation: 'not-a-uuid' })])
        .then(() => 'ok', () => 'failed');
      const after = await engine.insertBeliefEvents([event(inc, 'cc06', 1), event(inc, 'cc07', 2)]);
      const history = await engine.readBeliefHistoryRows({ sourceId: 'default', slug: null, subjectKey: null, afterId: 0, limit: 10,
        recordedAfter: null, recordedUntil: null, subjectKeys: null, beforeId: null, descending: false });
      const ids = history.map(r => Number(r.id));
      // Ids relative to the first row, so a Postgres sequence left by an earlier test does not matter.
      const relative = ids.map(id => id - ids[0]!);
      expect({ checkFailed, castFailed, after, relative }).toEqual({ checkFailed: 'failed', castFailed: 'failed', after: 2, relative: [0, 3, 4] });
      return { checkFailed, castFailed, after, relative };
    },
  );

  parityTest(
    'the real writers fill the ledger, and the history, visible-lifetime, ledger-source and covered-source reads answer the same',
    { methods: ['putPage', 'getPage', 'updateSlug', 'deletePage', 'readLedgerSource', 'insertTakePurge', 'insertBeliefRedaction', 'readBeliefRedactions',
      'releaseBeliefRedactions', 'readBeliefTombstones', 'mintBeliefLifetime', 'readOpenBeliefLifetimes', 'readMovedBeliefLifetimes', 'renameBeliefLifetime',
      'endBeliefLifetime', 'insertBeliefEvents', 'markBeliefCommits', 'readBeliefHistoryRows', 'listVisibleBeliefLifetimes', 'listCoveredSources'] },
    async (engine) => {
      const put = async (slug: string, frontmatter: Record<string, unknown> = {}) => {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}`, timeline: '', frontmatter });
        return (await engine.getPage(slug))!.id;
      };
      const inc = await incarnationOf(engine);
      const need = (slug: string, pageId: number) => ({ sourceId: 'default', incarnation: inc, slug, pageId });
      const one = async (slug: string, pageId: number) => (await resolveLifetimes(engine, [need(slug, pageId)])).get(pageId)!;
      // A rename: the page moves, its writer renames the lifetime, and a caller that read the old slug still finds it (the moved read).
      const a = await put('notes/a');
      const la = await one('notes/a', a);
      await engine.updateSlug('notes/a', 'notes/a2');
      await renameLifetime(engine, la, 'notes/a2', a);
      const renamed = { kept: await one('notes/a2', a) === la, moved: await one('notes/a', a) === la };
      // A recreate: a new page at the slug ends the old lifetime and mints a new one.
      const lc1 = await one('notes/c', await put('notes/c'));
      await engine.deletePage('notes/c');
      const lc2 = await one('notes/c', await put('notes/c'));
      const lp = await one('notes/p', await put('notes/p', { visibility: 'private' }));
      const lq = await one('notes/q', await put('notes/q', { quarantine: { reason: 'parity' } }));
      const label = new Map([[la, 'LA'], [lc1, 'LC1'], [lc2, 'LC2'], [lp, 'LP'], [lq, 'LQ']]);

      await engine.insertTakePurge({ sourceId: 'default', subject: '*', claimHash: 'tp1', requestId: PURGE });
      await engine.insertBeliefRedaction({ sourceId: 'default', subjectKey: 'fact:r', field: 'context', purgeRequest: PURGE, fieldHash: fieldHash('secret ctx') });
      const draft = (lifetime: string | null, slug: string, subjectKind: BeliefEventDraft['subjectKind'], subjectKey: string, eventType: string,
        over: Partial<BeliefEventDraft> = {}): BeliefEventDraft => ({ sourceId: 'default', incarnation: inc, lifetime, slug, subjectKind, subjectKey, eventType,
        trustTier: 'agent_written', visibility: 'world', value: { claim: subjectKey }, stateHash: `s-${subjectKey}-${eventType}`, cause: { op: 'parity' }, ...over });
      const live = { publicationId: PUB1, origin: 'live' as const, writerTier: 'agent_written', remote: false };
      const first = await appendBeliefEvents(engine, [
        draft(la, 'notes/a2', 'page', 'page:a', 'page.created', { value: { title: 'A' } }),
        draft(la, 'notes/a2', 'fact', 'fact:a1', 'fact.asserted', { claimFp: 'fpa1', value: { claim: 'a1', context: 'ctx a' } }),
        draft(lc1, 'notes/c', 'fact', 'fact:c1', 'fact.asserted', { claimFp: 'fpc1' }),
        draft(lp, 'notes/p', 'fact', 'fact:p1', 'fact.asserted', { claimFp: 'fpp1' }),
        draft(lq, 'notes/q', 'page', 'page:q', 'page.created', { value: { title: 'Q' } }),
        draft(lq, 'notes/q', 'fact', 'fact:q1', 'fact.asserted', { claimFp: 'fpq1' }),
        draft(la, 'notes/a2', 'take', 'take:a1', 'take.asserted', { claimFp: 'tp1', value: { holder: 'world', claim: 'purged take' } }),
        draft(la, 'notes/a2', 'take', 'take:a2', 'take.asserted', { claimFp: 'tp2', value: { holder: 'people/x', claim: 'held take' } }),
        draft(la, 'notes/a2', 'fact', 'fact:r', 'fact.asserted', { claimFp: 'fpr', value: { claim: 'r', context: 'secret ctx' } }),
        draft(la, 'notes/a2', 'fact', 'fact:w', 'fact.asserted', { claimFp: 'fpw' }),
        draft(la, 'notes/a2', 'fact', 'fact:h', 'fact.asserted', { claimFp: 'fph' }),
        draft(lc2, 'notes/c', 'fact', 'fact:c2', 'fact.asserted', { claimFp: 'fpc2' }),
        draft(null, 'notes/a2', 'coverage', COVERAGE_KEY, 'coverage.started', { value: null }),
      ], live);
      const second = await appendBeliefEvents(engine, [
        draft(la, 'notes/a2', 'take', 'take:a2', 'take.removed', { claimFp: 'tp2', value: null }),
        draft(la, 'notes/a2', 'fact', 'fact:w2', 'fact.asserted', { claimFp: 'fpw', visibility: 'private' }),
        draft(la, 'notes/a2', 'fact', 'fact:h', 'derived.hidden', { value: null }),
        draft(null, 'notes/a2', 'coverage', COVERAGE_KEY, 'coverage.restored', { value: null }),
      ], { ...live, publicationId: PUB2 });
      // An owner edit of the redacted field releases the suppression and records the release.
      const third = await appendBeliefEvents(engine, [
        draft(la, 'notes/a2', 'fact', 'fact:r', 'fact.revised', { claimFp: 'fpr', trustTier: 'user_confirmed', value: { claim: 'r', context: 'new ctx' } }),
      ], { publicationId: PUB3, origin: 'live', writerTier: 'user_confirmed', remote: false, ownerEdit: true });
      await markBeliefCommits(engine, [PUB1, PUB2, PUB3]);

      const base = { sourceId: 'default', slug: null, subjectKey: null, afterId: 0, limit: 100, recordedAfter: null, recordedUntil: null, subjectKeys: null, beforeId: null };
      const all = await engine.readBeliefHistoryRows({ ...base, descending: false });
      const firstId = Number(all[0]!.id);
      const clean = (list: Array<Record<string, unknown>>) => list.map(({ recorded_at: _at, ...rest }) => Object.fromEntries(Object.entries(rest).map(([k, v]) =>
        [k, k === 'id' ? Number(v) - firstId : k === 'page_lifetime' && typeof v === 'string' ? label.get(v) ?? v : v instanceof Date ? v.toISOString() : v])));
      const history = clean(all);
      const window = clean(await engine.readBeliefHistoryRows({ ...base, subjectKeys: ['take:a2', 'fact:w', 'fact:r'], beforeId: firstId + 15, descending: true }));
      const bySlug = clean(await engine.readBeliefHistoryRows({ ...base, slug: 'notes/c', afterId: firstId, descending: false }));
      const byKey = clean(await engine.readBeliefHistoryRows({ ...base, subjectKey: 'take:a2', limit: 1, descending: true }));
      const keys = (rows: Array<{ subject_key: string; event_type: string }>) => rows.map(r => `${r.subject_key} ${r.event_type}`);
      const local = keys(await readBeliefHistory(engine, { sourceId: 'default', remote: false }));
      const remote = keys(await readBeliefHistory(engine, { sourceId: 'default', remote: true }));
      const visible = (await engine.listVisibleBeliefLifetimes([lq, lp, lc2, lc1, la, lc2, '00000000-0000-4000-8000-0000000000ff'])).map(l => label.get(l) ?? l).sort();  // lifetime order is uuid order, and the uuids are random
      const { incarnation: _inc, ...source } = (await engine.readLedgerSource('default'))!;
      const covered = { coverage: await engine.listCoveredSources(COVERAGE_KEY), other: await engine.listCoveredSources('["other"]') };
      expect({ renamed, ended: lc1 !== lc2, appended: [first, second, third], count: history.length, source, covered })
        .toEqual({ renamed: { kept: true, moved: true }, ended: true, appended: [13, 4, 2], count: 18, source: { purgeEpoch: 0, coverage: 'coverage.started', purgesPossible: true },
          covered: { coverage: ['default'], other: [] } });
      expect(local).not.toContain('fact:h fact.asserted');
      expect(remote).not.toContain('fact:w fact.asserted');
      return { renamed, history, window, bySlug, byKey, local, remote, visible, source, covered };
    },
  );

  parityTest(
    'the pre-v341 fingerprint probes find no claim that holds no character the folds disagree on, and no tombstone for an empty probe list',
    { methods: ['readLegacyClaimFingerprints', 'readLegacyBeliefTombstones'] },
    async (engine) => {
      const got = {
        none: await engine.readLegacyClaimFingerprints('default', ['Acme will win the market', 'a b']),
        empty: await engine.readLegacyClaimFingerprints('default', []),
        tombstones: await engine.readLegacyBeliefTombstones('default', [{ kind: 'fact', claimFp: 'fp1', claim: 'Acme will win the market' }, { kind: 'take', claimFp: 'tp1', claim: 'a b' }]),
        noProbes: await engine.readLegacyBeliefTombstones('default', []),
      };
      expect(got).toEqual({ none: [], empty: [], tombstones: [], noProbes: [] });
      return got;
    },
  );

  parityTest(
    'redactions: copies read by subject or by field hash, a release binds the publication and hash; a take purge tombstone reads back',
    { methods: ['insertTakePurge', 'insertBeliefRedaction', 'readBeliefRedactions', 'releaseBeliefRedactions', 'readBeliefTombstones'] },
    async (engine) => {
      // A take purge tombstone of the source (subject '*'), so the tombstone read has a row to find.
      await engine.insertTakePurge({ sourceId: 'default', subject: '*', claimHash: 'tp1', requestId: PURGE });
      const a = await engine.insertBeliefRedaction({ sourceId: 'default', subjectKey: 'fact:a', field: 'value', purgeRequest: PURGE, fieldHash: 'ha' });
      const b = await engine.insertBeliefRedaction({ sourceId: 'default', subjectKey: 'fact:b', field: 'claim', purgeRequest: PURGE, fieldHash: 'hb' });
      expect(b).toBeGreaterThan(a);
      const label = new Map([[a, 'A'], [b, 'B']]);
      const read = async (subjects: string[], hashes: string[], sourceId = 'default') =>
        (await engine.readBeliefRedactions(sourceId, subjects, hashes)).map(r => ({ ...r, id: label.get(r.id) ?? r.id }))
          .sort((x, y) => String(x.id).localeCompare(String(y.id)));
      const bySubject = await read(['fact:a'], []);
      const byHash = await read([], ['hb']);
      const both = await read(['fact:a'], ['hb']);
      await engine.releaseBeliefRedactions([a], PUB1, 'released-a');
      await engine.releaseBeliefRedactions([], PUB2, 'nothing');
      const afterRelease = await read(['fact:a', 'fact:b'], []);
      expect(afterRelease.map(r => r.released_hash)).toEqual(['released-a', null]);
      return {
        bySubject, byHash, both, afterRelease,
        otherSource: await read(['fact:a'], ['hb'], 'missing'),
        tombstones: (await engine.readBeliefTombstones('default', ['fp1'], ['tp1', 'tp2', 'tp1'])).sort(),
        tombstonesOtherSource: await engine.readBeliefTombstones('missing', ['fp1'], ['tp1']),
        tombstonesEmpty: await engine.readBeliefTombstones('default', [], []),
      };
    },
  );

  parityTest(
    'readBeliefTombstones finds a fact purge tombstone by fingerprint, alongside a take one (tombstones seeded through insertFactPurge until the Rust purge commit writes them)',
    { methods: ['insertFactPurge', 'insertTakePurge', 'readBeliefTombstones'] },
    async (engine) => {
      await engine.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: '*', factHash: 'fp1', requestId: PURGE, actor: 'owner:local', reason: 'parity' });
      await engine.insertTakePurge({ sourceId: 'default', subject: 'notes/a', claimHash: 'tp1', requestId: PURGE });
      return {
        both: (await engine.readBeliefTombstones('default', ['fp1', 'fp2'], ['tp1'])).sort(),
        takesOnly: await engine.readBeliefTombstones('default', [], ['tp1']),
      };
    },
  );

  parityTest(
    'readBeliefTombstones reads fact tombstones at any visibility and subject of the source only, each fingerprint once (seeded through insertFactPurge until the Rust purge commit writes them)',
    { methods: ['insertSource', 'insertFactPurge', 'insertTakePurge', 'readBeliefTombstones'] },
    async (engine) => {
      await engine.insertSource({ id: 'team', name: 'team', local_path: null, config: {} });
      const fact = (sourceId: string, visibility: 'world' | 'private', subject: string, factHash: string) =>
        engine.insertFactPurge({ sourceId, visibility, subject, factHash, requestId: PURGE, actor: 'owner:local', reason: null });
      await fact('default', 'private', 'notes/a', 'fp2');
      await fact('default', 'world', 'notes/b', 'shared');
      await fact('default', 'world', '*', 'fp9');
      await fact('team', 'world', '*', 'fp3');
      await engine.insertTakePurge({ sourceId: 'default', subject: '*', claimHash: 'shared', requestId: PURGE });
      const answer = {
        mixed: (await engine.readBeliefTombstones('default', ['fp2', 'fp3', 'fp4', 'shared', 'fp2'], ['shared', 'tp9'])).sort(),
        otherSource: (await engine.readBeliefTombstones('team', ['fp2', 'fp3'], [])).sort(),
        none: await engine.readBeliefTombstones('default', [], []),
      };
      expect(answer).toEqual({ mixed: ['fp2', 'shared'], otherSource: ['fp3'], none: [] });
      return answer;
    },
  );

  parityTest(
    'the coverage reads: the newest coverage event of the current incarnation, a slug\'s baseline by run, the pending slugs in byte order after a cursor, and the baselined count',
    { methods: ['putPage', 'softDeletePage', 'insertFact', 'insertFacts', 'readLedgerSource', 'insertBeliefEvents', 'readLatestBeliefCoverage', 'hasBeliefBaseline',
      'listBeliefBaselinePending', 'countBeliefBaselineSlugs'] },
    async (engine) => {
      const page = (slug: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body', timeline: '' });
      // 'notes-x' sorts before 'notes/a' in byte order ('-' < '/') and after it in a locale collation that skips punctuation.
      for (const slug of ['notes/b', 'notes/a', 'notes-x', 'gone/page']) await page(slug);
      await engine.softDeletePage('gone/page');
      // A page-less database-only fact names its entity; a fence fact names its page, which is already a page.
      await engine.insertFact({ fact: 'db only', entity_slug: 'people/q-example', visibility: 'world', source: 'test', embedding: null }, { source_id: 'default' });
      await engine.insertFacts([{ fact: 'fenced', entity_slug: 'people/r-example', source_markdown_slug: 'notes/b', row_num: 1, kind: 'fact', visibility: 'world', source: 'fence' }] as never,
        { source_id: 'default' });
      const inc = await incarnationOf(engine);
      const pendingBefore = await engine.listBeliefBaselinePending('default', 'r1', '', [], 10);
      const noCoverage = await engine.readLatestBeliefCoverage('default');
      const cov = (key: string, ord: number, type: string, run: string) => event(inc, key, ord, { slug: '', page_lifetime: null, subject_kind: 'coverage',
        subject_key: COVERAGE_KEY, event_type: type, value: null, value_hash: null, state_hash: '', cause: JSON.stringify({ op: type, run }), claim_fp: null });
      const base = (key: string, ord: number, slug: string, run: string) => event(inc, key, ord, { slug, subject_kind: 'page', subject_key: `page:${slug}`,
        event_type: 'baseline', origin: 'baseline', cause: JSON.stringify({ op: 'baseline', run }) });
      await engine.insertBeliefEvents([cov('cc01', 0, 'coverage.started', 'r1'), base('ba01', 1, 'notes/b', 'r1'), base('ba02', 2, 'notes-x', 'r2'),
        base('ba03', 3, 'people/q-example', 'r1'), cov('cc02', 4, 'coverage.restored', 'r1')]);
      const latest = await engine.readLatestBeliefCoverage('default');
      expect(latest?.recorded_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const answer = {
        noCoverage,
        latest: latest && { event_type: latest.event_type, run: latest.run, idIsNumber: Number.isSafeInteger(latest.id) },
        unknownSource: await engine.readLatestBeliefCoverage('no-such-source'),
        has: await Promise.all([['notes/b', 'r1'], ['notes/b', 'r2'], ['notes-x', 'r2'], ['notes/a', 'r1']].map(([slug, run]) => engine.hasBeliefBaseline('default', slug!, run!))),
        pendingBefore,
        pendingR1: await engine.listBeliefBaselinePending('default', 'r1', '', [], 10),
        pendingR2: await engine.listBeliefBaselinePending('default', 'r2', '', [], 10),
        afterCursor: await engine.listBeliefBaselinePending('default', 'r1', 'notes-x', [], 10),
        skipped: await engine.listBeliefBaselinePending('default', 'r1', '', ['gone/page', 'notes/a'], 10),
        limited: await engine.listBeliefBaselinePending('default', 'r1', '', [], 2),
        counts: { r1: await engine.countBeliefBaselineSlugs('default', 'r1'), r2: await engine.countBeliefBaselineSlugs('default', 'r2'),
          none: await engine.countBeliefBaselineSlugs('default', 'r9') },
      };
      expect(answer.pendingBefore).toEqual(['gone/page', 'notes-x', 'notes/a', 'notes/b', 'people/q-example']);
      expect(answer.pendingR1).toEqual(['gone/page', 'notes-x', 'notes/a']);
      expect(answer.latest).toEqual({ event_type: 'coverage.started', run: 'r1', idIsNumber: true });
      expect(answer.counts).toEqual({ r1: 2, r2: 1, none: 0 });
      return answer;
    },
  );

  parityTest(
    'enableBeliefLedger on a source with no pages completes a run under the source row lock, a second enable resumes it, and disable stops it once',
    { methods: ['transaction', 'lockSourceRow', 'readLedgerSource', 'readLatestBeliefCoverage', 'insertBeliefEvents', 'markBeliefCommits', 'listBeliefBaselinePending',
      'countBeliefBaselineSlugs', 'readBeliefHistoryRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const first = await enableBeliefLedger(engine, 'work');
      expect(first.runId).toMatch(UUID);
      const again = await enableBeliefLedger(engine, 'work');
      const complete = await latestCoverage(engine, 'work');
      const rows = await engine.readBeliefHistoryRows({ sourceId: 'work', slug: null, subjectKey: null, afterId: 0, limit: 10, recordedAfter: null, recordedUntil: null,
        subjectKeys: [COVERAGE_KEY], beforeId: null, descending: false });
      const causes = rows.map(r => { const c = (typeof r.cause === 'string' ? JSON.parse(r.cause) : r.cause) as Record<string, unknown>;
        return { event_type: r.event_type, op: c.op, sameRun: c.run === first.runId, pages: c.pages ?? null }; });
      const stopped = await disableBeliefLedger(engine, 'work');
      const stoppedAgain = await disableBeliefLedger(engine, 'work');
      const afterStop = await latestCoverage(engine, 'work');
      const missing = await enableBeliefLedger(engine, 'no-such-source').then(() => 'ok', (e: Error) => e.message);
      const answer = {
        first: { ...first, runId: 'uuid' }, again: { ...again, runId: again.runId === first.runId ? 'same' : 'other' },
        complete: complete && { type: complete.type, sameRun: complete.run === first.runId }, causes, stopped, stoppedAgain,
        afterStop: afterStop && { type: afterStop.type, sameRun: afterStop.run === first.runId }, missing,
      };
      expect(answer.first).toMatchObject({ resumed: false, pages: 0, complete: true, unkeyable: [] });
      expect(answer.again).toMatchObject({ runId: 'same', resumed: true, complete: true });
      expect(answer.causes.map(c => c.event_type)).toEqual(['coverage.started', 'coverage.complete']);
      expect({ stopped, stoppedAgain, afterStop: answer.afterStop, missing }).toEqual({ stopped: true, stoppedAgain: false,
        afterStop: { type: 'coverage.stopped', sameRun: true }, missing: 'source not found: no-such-source' });
      return answer;
    },
  );

  parityTest(
    'enableBeliefLedger on a source with pages baselines each page\'s facts, takes, links and transitions, and a covered write records its fact',
    { methods: ['transaction', 'lockPageKeys', 'readLedgerSource', 'insertBeliefEvents', 'markBeliefCommits', 'listBeliefBaselinePending',
      'readBeliefHistoryRows', 'readBeliefStateRows', 'readBeliefFactsById'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const on = { sourceId: 'work' };
      const a = await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'alpha body', timeline: '' }, on);
      await engine.putPage('people/b-example', { type: 'person', title: 'B', compiled_truth: 'bravo body', timeline: '' }, on);
      await engine.insertFacts([{ fact: 'Alpha ships in March.', entity_slug: 'people/b-example', source_markdown_slug: 'notes/a', row_num: 1, kind: 'fact',
        visibility: 'world', source: 'fence', confidence: 0.8 }] as never, { source_id: 'work' });
      await engine.insertFact({ fact: 'Bravo  likes TEA!', entity_slug: 'people/b-example', visibility: 'world', source: 'test', embedding: null }, { source_id: 'work' });
      await engine.addTakesBatch([{ page_id: a.id, row_num: 1, claim: 'Alpha will win.', kind: 'take', holder: 'people/b-example', weight: 0.7, since_date: '2026-01-02' }]);
      await engine.addLink('notes/a', 'people/b-example', 'mentions B', 'mentions', 'markdown', 'notes/a', undefined, { fromSourceId: 'work', toSourceId: 'work', originSourceId: 'work' });
      await engine.writeManualLinkTransitions({ from: 'notes/a', to: 'people/b-example', linkType: 'works_with', sourceId: 'work' }, [{ kind: 'start', occurred_on: '2026-02-03' }]);
      const enabled = await enableBeliefLedger(engine, 'work');
      await engine.transaction(tx => lockedBeliefBatch(tx, { sourceId: 'work', slugs: ['people/b-example'], op: 'test_write', remote: false },
        () => tx.insertFact({ fact: 'Bravo moved to Lisbon.', entity_slug: 'people/b-example', visibility: 'world', source: 'test', embedding: null }, { source_id: 'work' })));
      const rows = await engine.readBeliefHistoryRows({ sourceId: 'work', slug: null, subjectKey: null, afterId: 0, limit: 100, recordedAfter: null, recordedUntil: null,
        subjectKeys: null, beforeId: null, descending: false } as never);
      const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown> | null;
      // Ids, revisions, lifetimes and now() timestamps differ between arms; the rest of each event and state row is compared.
      const strip = (v: Record<string, unknown> | null) => v && Object.fromEntries(Object.entries(v).map(([k, x]) =>
        [k, k === 'valid_from' || k === 'revision_after' ? typeof x : x]));
      const events = rows.map(r => ({ type: r.event_type, kind: r.subject_kind, slug: r.slug, tier: r.trust_tier, visibility: r.visibility, op: parse(r.cause)?.op,
        value: r.subject_kind === 'coverage' ? null : strip(parse(r.value)), fp: r.claim_fp ?? null }))
        .sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1);
      const state = await readBeliefState(engine, 'work', ['notes/a', 'people/b-example', 'notes/none']);
      const ids = new Map(state.pages.map(p => [p.id, p.slug]));
      const end = (e: { id: number; slug: string; source_id: string } | null) => e && { slug: e.slug, source_id: e.source_id };
      const shaped = {
        pages: state.pages.map(p => ({ ...p, id: p.slug, revision: typeof p.revision, incarnation: typeof p.incarnation, content_hash: typeof p.content_hash }))
          .sort((x, y) => x.id < y.id ? -1 : 1),
        facts: state.facts.map(f => ({ ...f, id: typeof f.id, entity_page_id: f.entity_page_id == null ? null : ids.get(f.entity_page_id), valid_from: typeof f.valid_from }))
          .sort((x, y) => x.fact < y.fact ? -1 : 1),
        takes: state.takes.map(k => ({ ...k, id: typeof k.id, page_id: ids.get(k.page_id) })),
        links: state.links.map(l => ({ ...l, id: typeof l.id, from: end(l.from), to: end(l.to), origin: end(l.origin) })),
        transitions: state.transitions.map(x => ({ ...x, id: typeof x.id, from: end(x.from), to: end(x.to), origin: end(x.origin) })),
        writerTier: state.writerTier,
      };
      // The two members called directly: one stream's raw rows, and the stream's facts read back by id.
      const direct = await engine.transaction(tx => tx.readBeliefStateRows({ sourceId: 'work', slugs: ['notes/a'], pageIds: [], knownFp: {}, knownCounts: null,
        knownPages: [], knownEntitySlugs: [], suppressed: false, planModePrev: null }));
      const raw = { pages: direct.pages.map(p => p.slug), facts: direct.facts?.map(f => f.fact).sort() ?? null, takes: direct.takes?.length ?? null,
        links: direct.links?.length ?? null, transitions: direct.transitions?.length ?? null, writerTier: direct.writer_tier };
      const byId = (await engine.readBeliefFactsById(state.facts.map(f => f.id))).map(f => f.fact).sort();
      expect(byId).toEqual(shaped.facts.map(f => f.fact).sort());
      expect(await engine.readBeliefFactsById([])).toEqual([]);
      const answer = { enabled: { ...enabled, runId: 'uuid' }, events, state: shaped, raw, byId };
      expect(answer.enabled).toMatchObject({ resumed: false, pages: 2, complete: true, unkeyable: [] });
      expect(events.filter(e => e.type === 'baseline').map(e => e.kind).sort()).toEqual(['fact', 'page', 'page']);
      expect(events.find(e => e.kind === 'page' && e.slug === 'notes/a')?.value?.counts).toEqual({ facts: 1, links: 1, takes: 1, link_transitions: 1 });
      expect(events.filter(e => e.op === 'test_write').map(e => [e.type, e.kind])).toEqual([['fact.asserted', 'fact']]);
      expect([shaped.facts.length, shaped.takes.length, shaped.links.length, shaped.transitions.length]).toEqual([3, 1, 1, 1]);
      return answer;
    },
  );
});
