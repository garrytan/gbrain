/**
 * BrainEngine parity — the remote `links` effect when its transaction runs again.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a transaction callback may run more than once (the multi-user Rust engine runs it again from a fresh snapshot
 *    after a commit lost on write_conflict, design interface I-1), and the run that commits is the only one that counts. So the
 *    links effect of a remote page write sends each missing mention target to replaceWantedLinkRows once per run, finishes
 *    committed with each skipped target listed once, and leaves one wanted row per missing target, on every arm.
 *  - Regression: runLinksEffect built its skipped-target list outside engine.transaction and writableTargets pushed into it
 *    inside the callback, so a second run sent every missing target twice. Every store refuses two rows with the same
 *    reference (the Rust store fails closed in wanted_links.rs; Postgres and PGLite say ON CONFLICT DO UPDATE cannot affect a
 *    row a second time), so the effect stayed queued as effect_unavailable and the page's links never landed.
 *  - Why existing coverage misses it: no case makes the links effect's transaction run twice. Only an ambient multi-user lane
 *    under contention did, by chance (labelled-only-policy's links case, KNOWN RED 17).
 *  - Seam: none in production. The test wraps engine.transaction for the effect's own transaction (its callback calls
 *    lockedPage). On a multi-user Rust brain the first run ends with a write_conflict error, so the engine's real optimistic
 *    retry runs the callback again. Every other arm has no optimistic retry, so the wrapper runs the callback once in a
 *    transaction it rolls back and then once for real: the same two runs from a fresh state.
 *  - Not forced on the served Rust arm (GBRAIN_TEST_RUST_SERVED=1): there the brain's owner, behind the served client, runs
 *    the effect on its own engine (a client's run is refused host_fence_required), out of the case's reach. The case still
 *    runs there and checks the same end state (waiting for the owner, as a client's own effect run is refused there), but
 *    nothing makes the callback run twice, so that arm proves no rerun.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, WantedLinkRowsReplacement } from '../../src/core/engine.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { rustServedRequested } from './rust-arm.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import type { AuthInfo } from '../../src/core/ops/contract.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'work';
const OWNER = 'alice-example';
const FORCED = 'forced second run of the links effect';

/**
 * Makes the transaction of the links effect run its callback twice, the first run thrown away, and records the targets each
 * run sends to replaceWantedLinkRows. The run that first calls replaceWantedLinkRows is the one forced again: on a multi-user
 * Rust brain it ends with a write_conflict error, so the engine's own optimistic retry runs the callback again; on every other
 * arm the transaction rolls back and the callback runs once more in a new one. The effect runs on the brain's own effect worker
 * or on the test's runPersistenceEffects, whichever claims it first, so the engine's transaction member is replaced for the
 * case and restored after. The harness hands the case a recording Proxy with no set trap: the replacement lands on the engine
 * behind it and is called with that engine as `this`, and it calls the engine's own member found by descriptor.
 */
function forceOneRerun(engine: BrainEngine) {
  const seen = { forced: 0, runs: 0, sent: [] as string[][] };
  const multiuser = (engine as { multiuser?: boolean }).multiuser === true;
  let holder: object | null = engine;
  let found: PropertyDescriptor | undefined;
  while (holder && !(found = Object.getOwnPropertyDescriptor(holder, 'transaction'))) holder = Object.getPrototypeOf(holder);
  const original = found!.value as (...args: unknown[]) => Promise<unknown>;
  /** One run of the callback on a tx whose replaceWantedLinkRows is recorded; `linked` says whether the run called it. */
  const run = async <T>(fn: (tx: BrainEngine) => Promise<T>, tx: BrainEngine): Promise<{ value: T; linked: boolean }> => {
    let linked = false;
    const watched = new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop !== 'replaceWantedLinkRows') return Reflect.get(target, prop, receiver);
        return (origin: { pageId: number; sourceId: string }, replacement: WantedLinkRowsReplacement) => {
          if (!linked) seen.runs++;
          linked = true;
          seen.sent.push(replacement.rows.map(row => row.target_ref));
          return target.replaceWantedLinkRows(origin, replacement);
        };
      },
    });
    return { value: await fn(watched), linked };
  };
  const transaction = async function (this: unknown, fn: (tx: BrainEngine) => Promise<unknown>, ...rest: unknown[]) {
    const call = (cb: (tx: BrainEngine) => Promise<unknown>) => original.call(this, cb, ...rest);
    if (seen.forced > 0) return call(fn);
    let forcedHere = false;
    const once = async (tx: BrainEngine) => {
      const { value, linked } = await run(fn, tx);
      if (linked && seen.forced === 0) {
        seen.forced++;
        forcedHere = true;
        throw multiuser ? Object.assign(new Error(FORCED), { code: 'write_conflict' }) : new Error(FORCED);
      }
      return value;
    };
    if (multiuser) return call(once);
    try { return await call(once); }
    catch (error) { if (!forcedHere) throw error; return call(async tx => (await run(fn, tx)).value); }
  };
  // Restored as it was: an own member is put back, an inherited one is uncovered.
  const own = Object.getOwnPropertyDescriptor(engine, 'transaction');
  Object.defineProperty(engine, 'transaction', { value: transaction, configurable: true, writable: true });
  const restore = () => { if (own) Object.defineProperty(engine, 'transaction', own); else delete (engine as { transaction?: unknown }).transaction; };
  return { seen, restore };
}

async function ownerPut(engine: BrainEngine, params: Record<string, unknown>, credential: { id?: string }) {
  const minted = await mintLegacyToken(engine, { name: `k-${OWNER}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { member: OWNER });
  credential.id = minted.id;
  const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).verifyAccessToken(minted.token) as unknown as AuthInfo;
  return dispatchToolCall(engine, 'put_page', params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
}

async function seed(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, SRC);
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
}

describe('engine parity: the links effect of a remote write when its transaction runs again', () => {
  parityTest('a links effect whose transaction runs twice sends each missing target once, lists each skip once and commits', { methods: ['replaceWantedLinkRows', 'readLinkTargetPages', 'getLinks', 'listWantedPages'], timeout: 240_000 }, async (engine, backend) => {
    await seed(engine, backend);
    await engine.putPage('notes/real', { type: 'note', title: 'Real', compiled_truth: 'Real fixture.', timeline: '', frontmatter: {} }, { sourceId: SRC });
    await engine.putPage('notes/mine', { type: 'note', title: 'Mine', compiled_truth: 'First.', timeline: '', frontmatter: {} }, { sourceId: SRC });
    const revision = (await engine.getPage('notes/mine', { sourceId: SRC }))?.knowledge_revision;
    // The served arm's owner runs the effect where the case cannot reach it (header): nothing is forced there.
    const served = backend === 'rust' && rustServedRequested();
    const { seen, restore } = served ? { seen: null, restore: () => {} } : forceOneRerun(engine);
    try {
      const credential: { id?: string } = {};
      const dispatched = await ownerPut(engine, { slug: 'notes/mine', content: '---\ntitle: Mine\n---\nMentions [[notes/real]], [[notes/ghost]] and [[notes/ghost-two]].', expected_revision: revision }, credential);
      expect(dispatched.isError === true).toBe(false);
      const clientRequestId = (JSON.parse(dispatched.content.map(c => c.text).join('')) as { request_id?: string }).request_id;
      const request = await engine.readWriteRequest('legacy_token', credential.id!, clientRequestId!);
      expect(request?.id).toBeTruthy();
      const links = async () => (await engine.readRequestEffects(request!.id)).find(e => e.kind === 'links');
      for (let pass = 0; pass < 100 && !(await links())?.outcome?.links; pass++) {
        // On the served arm the owner's effect worker runs it; a client's own run is refused host_fence_required and backs off.
        if (!served) await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
        await Bun.sleep(50);
      }
      const effect = await links();
      const outcome = effect?.outcome as { links?: string; added?: number; skipped_targets?: Array<{ slug: string; reason: string }> } | undefined;
      // Two runs, each sending the two missing targets once; the effect commits on its first claim.
      if (seen) expect({ forced: seen.forced, runs: seen.runs, sent: seen.sent }).toEqual({ forced: 1, runs: 2, sent: [['notes/ghost', 'notes/ghost-two'], ['notes/ghost', 'notes/ghost-two']] });
      expect({ state: effect?.state, links: outcome?.links, added: outcome?.added, skipped: outcome?.skipped_targets })
        .toEqual({ state: 'committed', links: 'committed', added: 1, skipped: [{ slug: 'notes/ghost', reason: 'missing' }, { slug: 'notes/ghost-two', reason: 'missing' }] });
      const edges = (await engine.getLinks('notes/mine', { sourceId: SRC })).map(l => `${l.link_type}:${l.to_slug}`).sort();
      expect(edges).toEqual(['mentions:notes/real']);
      const wanted = (await engine.listWantedPages({ sourceId: SRC, limit: 50, offset: 0 })).rows.map(row => ({ target: row.target, referenced_by: row.referenced_by, link_types: row.link_types }));
      expect(wanted).toEqual([{ target: 'notes/ghost', referenced_by: 1, link_types: ['mentions'] }, { target: 'notes/ghost-two', referenced_by: 1, link_types: ['mentions'] }]);
      return { outcome: { links: outcome?.links, added: outcome?.added, skipped: outcome?.skipped_targets }, edges, wanted };
    } finally { restore(); }
  });
});
