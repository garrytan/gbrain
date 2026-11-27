/**
 * BrainEngine parity — deleting a source (`gbrain sources remove`, the `sources_remove` op).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `gbrain sources remove <id>` prints the same impact preview, refusals and "Removed source" line, and
 *    exits the same way, on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1), and leaves the same state: the source, its pages and every record keyed by the source are
 *    gone, other sources are untouched, and a new source with the same id starts empty. The `sources_remove` op
 *    (removeSource) returns the same result and leaves the same state.
 *  - Regression: on a Rust brain the delete stopped on the raw_sql refusal (deleteSourceRow, assessDestructiveImpact
 *    and clientsReferencingSource ran `executeRaw`), so a source could not be removed; a store delete that missed a
 *    keyspace would leave a fact, an alias or a write gate hold that a same-id source then reads as its own.
 *  - Why existing coverage misses it: the delete ran through `executeRaw`, which parity cases cannot call (D18), and
 *    the per-engine tests (sources-remove-*.test.ts) run on PGLite and Postgres only.
 *  - Seam: `process.exit` and `console` are captured around `runSources`, as test/guests-cli.test.ts does. Sources
 *    and the other fixtures go through the typed members or the harness fixtures. Generated values
 *    (ids, timestamps) are never compared by value.
 */
import { describe, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSources } from '../../src/commands/sources.ts';
import { removeSource } from '../../src/core/sources-ops.ts';
import { withEnv } from '../helpers/with-env.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'doomed';
const KEEP = 'keeper';
const JOURNAL_REQUEST = 'b0000000-0000-4000-8000-0000000000b9';
const JOURNAL_WRITER = 'd0000000-0000-4000-8000-0000000000d9';
const note = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, frontmatter: {} });

/** Run `gbrain sources <args>` and return what it printed and how it exited. */
async function cli(engine: BrainEngine, args: string[]): Promise<{ exit: number | null; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  let exit: number | null = null;
  const realExit = process.exit;
  (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
    exit = n;
    throw new Error(`__test_exit_${n}__`);
  }) as never;
  const spies = [
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); }),
    spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); }),
  ];
  try {
    await runSources(engine, args).catch((e: Error) => { if (!/^__test_exit_/.test(e.message)) throw e; });
  } finally {
    process.exit = realExit;
    for (const s of spies) s.mockRestore();
  }
  return { exit, out, err };
}

/** Fixture: a source with two pages and the records a delete has to take with it, plus a second source that keeps its own. */
async function seedDoomed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]): Promise<void> {
  await createSource(engine, backend, SRC, { federated: false });
  await createSource(engine, backend, KEEP, { federated: false });
  for (const sourceId of [SRC, KEEP]) {
    await engine.putPage('notes/a', note('A', `alpha body of ${sourceId}`), { sourceId });
    await engine.putPage('private/b', note('B', `beta body of ${sourceId}`), { sourceId });
    await engine.upsertChunks('notes/a', [{ chunk_index: 0, chunk_text: `alpha body of ${sourceId}`, chunk_source: 'compiled_truth' }], { sourceId });
    await engine.addLink('notes/a', 'private/b', 'see also', 'mentions', 'markdown', undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId } as never);
    await engine.insertFacts([
      { fact: `a fact of ${sourceId}`, entity_slug: null, kind: 'fact', visibility: 'world', source: 'fence', row_num: 1, source_markdown_slug: 'notes/a' },
    ] as never, { source_id: sourceId });
    await engine.setPageAliases('notes/a', sourceId, [`alias-${sourceId}`, 'shared alias']);
    await engine.upsertWriteGateHold({
      kind: 'fact', source_id: sourceId, slug: 'notes/a', fingerprint: `fp-${sourceId}`, detector_version: 1, tier: 'agent_written',
      reason_families: ['override'], reasons: ['override found'], detector_error: false, payload: { row_num: 1, fact: 'x' },
      write_origin: null, request_id: null,
    } as never);
  }
}

/** What a reader sees of one source: its row, pages, facts and aliases. */
async function observeSource(engine: BrainEngine, sourceId: string) {
  const source = await engine.getSource(sourceId);
  const pages = await Promise.all(['notes/a', 'private/b'].map(async (slug) => {
    const page = await engine.getPage(slug, { sourceId });
    return page ? { slug: page.slug, title: page.title } : null;
  }));
  const aliases = await engine.resolveAliases([`alias-${sourceId}`, 'shared alias'], { sourceId });
  return {
    source: source ? { id: source.id, name: source.name, config: source.config } : null,
    pageCount: await engine.countSourcePages(sourceId, { includeDeleted: true }),
    pages,
    facts: (await engine.listFactsForPage(sourceId, 'notes/a')).map((f) => (f as { fact: string }).fact).sort(),
    aliases: sorted([...aliases].map(([alias, rows]) => `${alias}=>${rows.map((r) => `${r.source_id}:${r.slug}`).sort().join(',')}`)),
  };
}

describe('engine parity: source delete', () => {
  parityTest('sources remove deletes the source, its pages and what is keyed by it, and leaves other sources as they were',
    { methods: ['getSource', 'countSourcePages', 'deleteSourceRecord', 'readSourceDeleteImpact', 'listOauthClients'], timeout: 120_000 },
    async (engine, backend) => {
      await seedDoomed(engine, backend);
      const keptBefore = await observeSource(engine, KEEP);
      const preview = await cli(engine, ['remove', SRC, '--dry-run']);
      // A source with pages needs --confirm-destructive; --yes alone refuses.
      const refused = await cli(engine, ['remove', SRC, '--yes']);
      const removed = await cli(engine, ['remove', SRC, '--confirm-destructive']);
      const gone = await observeSource(engine, SRC);
      const kept = await observeSource(engine, KEEP);
      expect(kept).toEqual(keptBefore);
      const again = await cli(engine, ['remove', SRC, '--confirm-destructive']);
      // A new source with the same id starts empty: nothing the old one had reads as its own.
      await engine.insertSource({ id: SRC, name: SRC, local_path: null, config: {} });
      const reborn = await observeSource(engine, SRC);
      const sourceIds = (await engine.listAllSources({ includeArchived: true })).map((s) => s.id).sort();
      return { preview, refused, removed, gone, kept, again, reborn, sourceIds };
    });

  parityTest('sources remove refuses while an OAuth client names the source, and deletes nothing',
    { methods: ['listSourceOAuthClients', 'insertOauthClient', 'getSource'], timeout: 120_000 },
    async (engine, backend) => {
      await seedDoomed(engine, backend);
      await engine.insertOauthClient({ client_id: 'client-live', client_name: 'Live client', source_id: SRC });
      await engine.insertOauthClient({ client_id: 'client-gone', client_name: 'Revoked client', source_id: SRC, deleted_at: new Date('2026-01-02T03:04:05Z') });
      await engine.insertOauthClient({ client_id: 'client-other', client_name: 'Other client', source_id: KEEP });
      const removed = await cli(engine, ['remove', SRC, '--confirm-destructive']);
      const after = await observeSource(engine, SRC);
      return { removed, after };
    });

  // The write journal is not keyed by the source. On Postgres and PGLite, persistence_requests and
  // persistence_topology_changes carry source_id with no foreign key to sources, and persistence_effects references
  // persistence_requests, so a source delete leaves all three. The Rust store keeps them under the d keyspace (request,
  // d 0x03 topology, d 0x05/0x06 effects), which its source delete does not touch. Receipts of the old source stay
  // readable by (writer, request id), and a same-id source gets a new incarnation, so the old rows never read as its own.
  parityTest('a source delete keeps the write journal: the request, its effects and the lifecycle receipt that name the source',
    { methods: ['readSourceMembership', 'insertWriteRequest', 'insertPublicationEffects', 'insertTopologyChange', 'deleteSourceRecord',
      'readWriteRequestById', 'readRequestEffects', 'readTopologyChange', 'findTopologyChanges'], timeout: 120_000 },
    async (engine, backend) => {
      await seedDoomed(engine, backend);
      const incarnation = (await engine.readSourceMembership(SRC))!.incarnation;
      const keys = ['principal:local_cli:parity-writer', 'brain'];
      await engine.lockPersistenceCounters(keys);
      const request = await engine.insertWriteRequest({
        principalKind: 'local_cli', principalId: 'parity-writer', requestId: JOURNAL_REQUEST, operation: 'put_page', sourceId: SRC,
        sourceIncarnation: incarnation, pageId: null, slug: 'notes/a', worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64),
        intent: { kind: 'put_page', slug: 'notes/a' }, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096,
        targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null,
        state: 'queued', deferredRefreshId: null,
      });
      const queued = await engine.transactionDirect(async (tx) => {
        await tx.declarePersistence();
        return tx.insertPublicationEffects({ requestId: request.id, revision: 'e0000000-0000-4000-8000-0000000000e1', sourceId: SRC,
          sourceIncarnation: incarnation, worktreeId: null, effects: [{ kind: 'embedding', data: { slug: 'notes/a', page_id: 1 } }] });
      });
      await engine.insertTopologyChange({
        principalId: JOURNAL_WRITER, requestId: JOURNAL_REQUEST, digest: 'e'.repeat(64), operation: 'claim', sourceId: SRC,
        sourceIncarnation: incarnation, worktreeIds: [], state: 'committed', terminalBytes: 4096, outcome: { operation: 'claim', source_id: SRC },
      });
      const journal = async () => {
        const row = await engine.readWriteRequestById(request.id);
        const receipt = await engine.readTopologyChange(JOURNAL_WRITER, JOURNAL_REQUEST);
        return {
          request: row && { source: row.source_id, oldIncarnation: row.source_incarnation === incarnation, state: row.state },
          effects: (await engine.readRequestEffects(request.id)).map((e) => `${e.kind}:${e.state}`),
          receipt: receipt && { source: receipt.source_id, oldIncarnation: receipt.source_incarnation === incarnation, operation: receipt.operation, state: receipt.state },
          found: (await engine.findTopologyChanges(JOURNAL_WRITER, [JOURNAL_REQUEST])).map((r) => r.request_id),
        };
      };
      const before = await journal();
      expect(before.request).not.toBeNull();
      expect(before.receipt).not.toBeNull();
      expect(before.effects.length).toBeGreaterThan(0);
      expect(before.found).toEqual([JOURNAL_REQUEST]);
      const removed = await engine.deleteSourceRecord(SRC);
      const after = await journal();
      expect(after).toEqual(before);
      await engine.insertSource({ id: SRC, name: SRC, local_path: null, config: {} });
      const reborn = (await engine.readSourceMembership(SRC))!.incarnation;
      return { queued, removed, before, after, newIncarnation: reborn !== incarnation, source: await engine.getSource(SRC).then((s) => s?.id ?? null) };
    });

  parityTest('the sources_remove op deletes the source and its pages and returns what it removed',
    { methods: ['getSource', 'countSourcePages', 'deleteSourceRecord'], timeout: 120_000 },
    async (engine, backend) => {
      await seedDoomed(engine, backend);
      const dry = await removeSource(engine, { id: SRC, dryRun: true });
      const unconfirmed = await removeSource(engine, { id: SRC }).then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
      const result = await removeSource(engine, { id: SRC, confirmDestructive: true });
      const missing = await removeSource(engine, { id: SRC, confirmDestructive: true }).then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
      const gone = await observeSource(engine, SRC);
      await engine.insertSource({ id: SRC, name: SRC, local_path: null, config: {} });
      const reborn = await observeSource(engine, SRC);
      return { dry, unconfirmed, result, missing, gone, reborn, kept: await observeSource(engine, KEEP) };
    });
  parityTest('a source delete removes its writer binding, so a new source with the same id can claim a checkout again',
    { methods: ['getWorktreeBinding', 'worktreeClaimStore', 'deleteSourceRecord', 'listOrphanBindings', 'insertSource'], timeout: 120_000 },
    async (engine) => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-parity-bound-delete-'));
      try {
        return await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          await engine.insertSource({ id: SRC, name: SRC, local_path: dir, config: {} });
          await registerLocalWriter(engine, 'cli');
          await claimWorktree(engine, SRC, dir);
          const bound = (await engine.getWorktreeBinding(SRC, null)) !== null;
          const deleted = (await engine.deleteSourceRecord(SRC)).deleted;
          const after = await engine.getWorktreeBinding(SRC, null);
          const orphans = (await engine.listOrphanBindings()).map(row => row.source_id);
          await engine.insertSource({ id: SRC, name: SRC, local_path: dir, config: {} });
          const reclaim = await claimWorktree(engine, SRC, dir).then(() => 'claimed', (e: { code?: string }) => e.code ?? String(e));
          expect({ bound, deleted, after, orphans, reclaim }).toEqual({ bound: true, deleted: true, after: null, orphans: [], reclaim: 'claimed' });
          return { bound, deleted, after, orphans, reclaim };
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
});
