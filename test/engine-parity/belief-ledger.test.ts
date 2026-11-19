/**
 * BrainEngine parity — belief ledger writes (src/core/engine-sql/belief-ledger.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the page lifetimes (mint, open read, moved read, rename, end), the event append and its commit marks,
 *    the redaction copies and releases, the tombstone read and the purge-epoch read return the same observable result
 *    on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1, which
 *    refuses every member until its store keeps the ledger).
 *  - Regression: an engine that mints a second open lifetime at one (incarnation, slug), that reports a renamed page's
 *    lifetime as moved, that re-inserts an event key, that drops a redaction's release, or that answers 0 instead of
 *    null for an unknown source's purge epoch: the ledger would fork a page's history or lose a suppression.
 *  - Why existing coverage misses it: the belief ledger tests drive these statements on PGLite alone; no case compares
 *    engines.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BeliefEventInsertRow } from '../../src/core/engine-sql/belief-ledger.ts';

const { parityTest } = parityArms(testBackends());

const L1 = '00000000-0000-4000-8000-0000000000a1';
const L2 = '00000000-0000-4000-8000-0000000000a2';
const PUB1 = '00000000-0000-4000-8000-0000000000b1';
const PUB2 = '00000000-0000-4000-8000-0000000000b2';
const PURGE = '00000000-0000-4000-8000-0000000000c1';
const REFUSAL = /the belief ledger, which the store does not keep/;

/** Every member of the domain, called with harmless input; on Rust each must refuse. */
async function refusals(engine: BrainEngine): Promise<unknown[]> {
  const fail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
  return [
    await fail(engine.readBeliefTombstones('default', [], [])),
    await fail(engine.readBeliefRedactions('default', [], [])),
    await fail(engine.insertBeliefRedaction({ sourceId: 'default', subjectKey: 'k', field: 'value', purgeRequest: PURGE, fieldHash: 'h' })),
    await fail(engine.releaseBeliefRedactions([], PUB1, 'h')),
    await fail(engine.readSourcePurgeEpoch('default')),
    await fail(engine.insertBeliefEvents([])),
    await fail(engine.markBeliefCommits([])),
    await fail(engine.readOpenBeliefLifetimes([])),
    await fail(engine.endBeliefLifetime(L1)),
    await fail(engine.mintBeliefLifetime({ lifetime: L1, sourceId: 'default', incarnation: L2, slug: 's', pageId: 1 })),
    await fail(engine.renameBeliefLifetime(L1, 's', 1)),
    await fail(engine.readMovedBeliefLifetimes([])),
  ];
}

function refuseAll(errors: unknown[]): never {
  expect(errors.map(e => (e instanceof Error ? REFUSAL.test(e.message) : e))).toEqual(errors.map(() => true));
  throw errors[0];
}

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
    async (engine, backend) => {
      await engine.putPage('notes/a', { type: 'note', title: 'A', compiled_truth: 'body', timeline: '' });
      const page = await engine.getPage('notes/a');
      const inc = await incarnationOf(engine);
      if (backend === 'rust') refuseAll(await refusals(engine));
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
    'insertBeliefEvents skips a repeated event key, the history read returns the rows in id order, and commit marks are idempotent',
    { methods: ['readLedgerSource', 'insertBeliefEvents', 'readBeliefHistoryRows', 'markBeliefCommits'] },
    async (engine, backend) => {
      const inc = await incarnationOf(engine);
      if (backend === 'rust') refuseAll(await refusals(engine));
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
    'redactions: copies read by subject or by field hash, a release binds the publication and hash; a fact purge tombstone and the purge epochs read back',
    { methods: ['insertFactPurge', 'insertBeliefRedaction', 'readBeliefRedactions', 'releaseBeliefRedactions', 'readBeliefTombstones', 'readSourcePurgeEpoch'] },
    async (engine, backend) => {
      // A fact purge tombstone of the source (subject '*'), so the tombstone read has a row to find.
      await engine.insertFactPurge({ sourceId: 'default', visibility: 'world', subject: '*', factHash: 'fp1', requestId: PURGE, actor: 'owner:local', reason: 'parity' });
      if (backend === 'rust') refuseAll(await refusals(engine));
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
        tombstones: await engine.readBeliefTombstones('default', ['fp1', 'fp2'], ['tp1']),
        tombstonesOtherSource: await engine.readBeliefTombstones('missing', ['fp1'], []),
        tombstonesEmpty: await engine.readBeliefTombstones('default', [], []),
        epoch: await engine.readSourcePurgeEpoch('default'),
        epochMissing: await engine.readSourcePurgeEpoch('missing'),
      };
    },
  );
});
