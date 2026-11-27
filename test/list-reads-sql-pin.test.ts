/**
 * Byte-identical pins for the list-read members (src/core/engine-sql/list-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends PGLite and Postgres exactly the statement text and parameters its caller sent through
 *    executeRaw before the move, for every filter and policy shape the caller builds.
 *  - Regression: a member that renumbers a placeholder, drops a filter or reorders a parameter would answer differently
 *    while the parity cases on small fixtures may still pass.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only, and these members live outside them.
 *  - Seam: a recording executeRaw stand-in; no database runs. test/helpers/list-reads-caller-sql.ts holds the callers' text.
 */
import { describe, expect, test } from 'bun:test';
import * as Member from '../src/core/engine-sql/list-reads.ts';
import * as Caller from './helpers/list-reads-caller-sql.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';

type Mod = typeof Member;
function recorder() {
  const log: Array<[string, unknown[]]> = [];
  const raw = async (sql: string, params?: unknown[]) => {
    log.push([sql, [...(params ?? [])]]);
    return [{ n: 1, cnt: '1', issued_at: '1', completed_keys: [] }] as never;
  };
  return { log, raw: raw as never };
}

async function same(call: (m: Mod, raw: never) => Promise<unknown>) {
  const before = recorder(), after = recorder();
  await call(Caller as unknown as Mod, before.raw);
  await call(Member, after.raw);
  expect(after.log.length).toBeGreaterThan(0);
  expect(after.log).toEqual(before.log);
}

const POLICIES = [{}, { sourceId: 'x' }, { sourceIds: ['a', 'b'], excludePrivate: true }, { minTrust: 'tool_observed' as const, suppressFlagged: true }];
const FILTERS = [{}, { status: 'stored' }, { store: 'b2', onSourceMachine: false }, { status: 'x', store: 'y', onSourceMachine: true }];

describe('list-read members send the statements their callers sent', () => {
  test('policy-scoped page and card reads', async () => {
    for (const p of POLICIES) {
      await same((m, r) => m.resolveChainAnchorRows(r, 's', p as never));
      for (const manifest of [true, false]) await same((m, r) => m.probeTargetRows(r, 's', p as never, manifest));
      for (const f of FILTERS) {
        await same((m, r) => m.listCardRows(r, { sourceId: 's', type: 't', filters: f, policy: p as never, limit: 3, offset: 2 }));
        await same((m, r) => m.findCardRows(r, { sourceId: 's', type: 't', query: 'q', aliasNorm: 'a', terms: ['x', 'y'], filters: f, policy: p as never }));
      }
    }
  });

  test('slug, path, schema-pack, attendance, upload and chat reads', async () => {
    for (const src of [undefined, 'w']) {
      await same((m, r) => m.listLiveSlugOrigins(r, ['a', 'b', 'c'], src));
      for (const form of ['fn', 'closed', 'mode'] as const) await same((m, r) => m.readWhoCanReadRows(r, 's', src, form));
    }
    for (const q of [{ fromType: 't' }, { fromType: 't', pathFilter: 'a%', slugFilter: 'b%', sourceId: 'x' }, { fromType: 't', slugFilter: 'b' }]) {
      await same((m, r) => m.probeRetypeRows(r, q));
    }
    for (const scope of [{}, { sourceId: 'x' }, { sourceIds: ['a'] }]) {
      await same((m, r) => m.countLivePagesByType(r, scope));
      await same((m, r) => m.listTypeOrphanRows(r, scope, ['u1', 'u2'], 7));
    }
    await same((m, r) => m.readAttendanceWindow(r, 's', 'a', 5));
    await same((m, r) => m.readUploadSessionByRequest(r, 'k', 'i', 'c'));
    for (const hide of [true, false]) await same((m, r) => m.readChatCensusRows(r, ['a'], ['t'], ['d'], hide));
  });

  test('member-access reads under a caller record', async () => {
    for (const access of [{ identity: ['member:a'], restricted: true }, { identity: [], restricted: false }]) {
      await withCallerAccess(access as never, async () => {
        await same((m, r) => m.readPageAccessAllowed(r, 's', 'p', ['member:a']));
        await same((m, r) => m.readPageFolderRulesAllowed(r, 's', 'p', ['s:r1']));
      });
    }
  });
});
