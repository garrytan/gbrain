/**
 * BrainEngine parity — belief ledger writes (src/core/engine-sql/belief-ledger.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the page lifetimes (mint, open read, moved read, rename, end), the event append and its commit marks,
 *    the redaction copies and releases, the tombstone read and the purge-epoch read return the same observable result
 *    on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1). The
 *    Rust store serves every write and the append's reads; it still refuses the history read (readBeliefHistoryRows)
 *    and a tombstone read whose fact half needs a fact purge tombstone read by fingerprint.
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
    'readBeliefTombstones finds a fact purge tombstone by fingerprint, alongside a take one (Rust refuses the fact half for now)',
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
});
