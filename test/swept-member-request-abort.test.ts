/**
 * GBRA-156 for the typed Postgres members that replaced an `executeRaw` call in the N3, S2b-ns and S2b-st moves and
 * were not covered by the other request-abort tests (`engineRead`: test/n3-typed-read-guards.test.ts; `decideRead`,
 * `whenNotAborted`, `timelineBoundedRead`, `writeMiscRead` members: test/decide-read-request-abort.test.ts;
 * `getSource` and its callers: test/source-read-request-abort.test.ts). `executeRaw` refused a cancelled request
 * before sending its statement; a typed member that goes straight to the connection must do the same, or a request
 * nobody waits for starts a query that can hold a pooled connection behind a lock.
 *
 * Protects:
 * - the health memo's config read (`getConfigValues`, health-memo.ts) sends no config SELECT for a cancelled request;
 * - a frontmatter-tag prune (`pruneFrontmatterTags`, streamed-import.ts) sends no DELETE for a cancelled request;
 * - one table over every swept member: a cancelled request makes each reject with the request's AbortError and
 *   send zero statements.
 * Fails when a swept member loses its request-abort check (refuseAborted / throwIfRequestAborted).
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { memoizedHealth } from '../src/core/health-memo.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('client went away'));
  return controller.signal;
}

function fakeEngine() {
  const fake = makeFakeSql();
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { fake, engine: engine as unknown as BrainEngine };
}

test('the health memo sends no config SELECT for a cancelled request', async () => {
  const { fake, engine } = fakeEngine();
  await withRequestSignal(aborted(), () => memoizedHealth(engine, {}, async () => ({ ok: true })));
  expect(fake.statements()).toHaveLength(0);
});

test('a frontmatter-tag prune sends no DELETE for a cancelled request', async () => {
  const { fake, engine } = fakeEngine();
  const error = await withRequestSignal(aborted(), () => engine.pruneFrontmatterTags('notes/a', ['x'], { sourceId: 'default' })).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements()).toHaveLength(0);
});

/** Every swept member and a valid call for it. */
const SWEPT: Record<string, (engine: BrainEngine) => Promise<unknown>> = {
  getSource: (e) => e.getSource('default'),
  getConfigValues: (e) => e.getConfigValues(['k']),
  getConfig: (e) => e.getConfig('k'),
  pruneFrontmatterTags: (e) => e.pruneFrontmatterTags('notes/a', ['x'], { sourceId: 'default' }),
  listExportPageKeys: (e) => e.listExportPageKeys({ afterId: '0', sourceId: null, type: null, slugPrefix: null }),
  readExportPageRows: (e) => e.readExportPageRows(['1']),
  normalizeFenceLines: (e) => e.normalizeFenceLines(['body'], ['timeline']),
  readSegmentedPageHead: (e) => e.readSegmentedPageHead(1),
  readBodyManifestRows: (e) => e.readBodyManifestRows(1, null),
  readBodyManifestMeta: (e) => e.readBodyManifestMeta(1, [1], 1),
  readBodyManifestOutline: (e) => e.readBodyManifestOutline(1, [1], 1),
  listAccessPolicySourceIds: (e) => e.listAccessPolicySourceIds(),
  countSearchVectorRows: (e) => e.countSearchVectorRows(),
  listVersionTrustTiers: (e) => e.listVersionTrustTiers([1]),
  listVersionReasonWriters: (e) => e.listVersionReasonWriters([1]),
  listPageRefsByIds: (e) => e.listPageRefsByIds([1]),
  readWithdrawalDiscovery: (e) => e.readWithdrawalDiscovery({ kind: 'sample_slugs', sourceId: 'default', ids: [1] }),
};

for (const [member, call] of Object.entries(SWEPT)) {
  test(`${member} refuses inside a cancelled request and sends no statement`, async () => {
    const { fake, engine } = fakeEngine();
    const error = await withRequestSignal(aborted(), () => call(engine)).then(() => null, (e: unknown) => e);
    expect((error as Error | null)?.name, `${member} ran inside a cancelled request`).toBe('AbortError');
    expect((error as Error).message).toBe('client went away');
    expect(fake.statements()).toHaveLength(0);
  });
}
