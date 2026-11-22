/**
 * BrainEngine parity — source archive: the soft delete of `gbrain sources archive`, its restore, the archived-source
 * list, the purge sweep's candidate reads, the impact preview counts, the OAuth clients that hold a source and the
 * source delete (engine-sql/source-archive.ts; the delete and its preview in engine-sql/sources.ts, source-delete.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `softDeleteSource` archives an active source with both archive times 72 hours apart and federation off,
 *    and does nothing to an archived or missing source; `listArchivedSources` lists it with its pages (soft-deleted
 *    ones included); `restoreSource` clears both times and turns federation on (or keeps it off for `--no-federate`);
 *    `assessDestructiveImpact` counts pages, chunks, embeddings, facts and the clients (revoked ones included) that hold
 *    the source; `purgeExpiredSources` never purges an unexpired archive or one with no times (it reports the latter)
 *    and purges an expired one: the purge removes the source's pages, its write gate holds and their receipts, its
 *    `managed-sync` cursors and each eval candidate slug no other covered source holds, keeps every other source's
 *    rows, and a source made again with the same id starts empty; an OAuth client of the source, revoked or not,
 *    refuses the delete (`23503`) and the archive stays whole. The same observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that archives without the times, keeps them after a restore, or reads an archive with no
 *    times as expired: the purge sweep deletes a source before its 72-hour recovery window, or never deletes it. An
 *    engine whose delete misses a row family leaves a deleted source's holds, cursors or slugs behind; one that
 *    ignores the client deletes a source an OAuth client still names.
 *  - Why existing coverage misses it: test/destructive-guard.test.ts and test/sources-archive*.test.ts drive these
 *    flows on PGLite alone; no case compares engines, and the Rust engine refused every one of these statements (raw
 *    SQL), so it kept no archive times at all, and refused the source delete (raw SQL), so it purged nothing.
 *  - Seam: none. Real engines; the flows run through destructive-guard.ts, the rows are read with typed members (no
 *    executeRaw: D18). Archive times are compared as the gap between them, never as raw dates.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import {
  assessDestructiveImpact, listArchivedSources, purgeExpiredSources, restoreSource, softDeleteSource,
  type SoftDeletedSource,
} from '../../src/core/destructive-guard.ts';
import { archiveSource as archiveWithoutTimes, createSource, parityArms } from './harness.ts';
import { chunk } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOUR_MS = 3_600_000;

function page(title: string): PageInput {
  return { type: 'note' as never, title, compiled_truth: `${title} body`, timeline: '', frontmatter: {} };
}

/** An archived source with its times as the hours between them, and whether the archive time is real. */
function shape(s: SoftDeletedSource | null) {
  if (!s) return null;
  const at = s.deletedAt.getTime();
  return {
    id: s.id, name: s.name, pageCount: s.pageCount,
    windowHours: (s.expiresAt.getTime() - at) / HOUR_MS,
    realTime: at > Date.UTC(1970, 0, 2),
  };
}

async function federated(engine: BrainEngine, id: string) {
  const row = await engine.getSource(id);
  const config = typeof row?.config === 'string' ? JSON.parse(row.config) : row?.config;
  return (config as Record<string, unknown> | undefined)?.federated ?? null;
}

describe('engine parity: source archive', () => {
  parityTest(
    'archiving keeps both times 72 hours apart and turns federation off; restore clears them and sets federation',
    { methods: [
      'archiveSource', 'restoreArchivedSource', 'listArchivedSourceRows', 'readSourceDeleteImpact', 'listSourceOAuthClients',
      'countSourcePages', 'putPage', 'softDeletePage', 'upsertChunks', 'insertOauthClient', 'getSource', 'upsertFile',
    ] },
    async (engine, backend) => {
      await createSource(engine, backend, 'wiki', { federated: true });
      await createSource(engine, backend, 'other', {});
      await engine.putPage('notes/one', page('One'), { sourceId: 'wiki' });
      await engine.putPage('notes/two', page('Two'), { sourceId: 'wiki' });
      await engine.putPage('notes/elsewhere', page('Elsewhere'), { sourceId: 'other' });
      await engine.upsertChunks('notes/one', [chunk(0, 'first'), chunk(1, 'second')], { sourceId: 'wiki' });
      await engine.softDeletePage('notes/two', { sourceId: 'wiki' });
      await engine.insertOauthClient({ client_id: 'zed-app', client_name: 'Zed', source_id: 'wiki' });
      await engine.insertOauthClient({ client_id: 'amy-app', client_name: 'Amy', source_id: 'wiki', deleted_at: new Date('2026-01-01T00:00:00Z') });
      await engine.insertOauthClient({ client_id: 'bob-app', client_name: 'Bob', source_id: 'other' });
      // An upper-case id sorts before the lower-case ones in byte order, and between them in a language collation.
      await engine.insertOauthClient({ client_id: 'Max-app', client_name: 'Max', source_id: 'wiki' });
      // The delete preview counts the files of the source, and only those.
      for (const [sourceId, path] of [['wiki', 'assets/one.png'], ['wiki', 'assets/two.png'], ['other', 'assets/three.png']]) {
        await engine.upsertFile({ source_id: sourceId, filename: path.slice(7), storage_path: path, content_hash: `hash-${path}` });
      }
      const impact = await assessDestructiveImpact(engine, 'wiki');
      const clients = await engine.listSourceOAuthClients('wiki');
      const missing = [await assessDestructiveImpact(engine, 'nope'), await engine.listSourceOAuthClients('nope')];
      const counts = [await engine.readSourceDeleteImpact('wiki'), await engine.readSourceDeleteImpact('nope')];
      const archived = shape(await softDeleteSource(engine, 'wiki'));
      const again = await softDeleteSource(engine, 'wiki');
      const absent = await softDeleteSource(engine, 'nope');
      const listed = (await listArchivedSources(engine)).map(shape);
      const offWhileArchived = await federated(engine, 'wiki');
      const restored = [await restoreSource(engine, 'wiki'), await restoreSource(engine, 'wiki')];
      const notArchived = await engine.restoreArchivedSource('wiki', true);
      const afterRestore = { listed: await listArchivedSources(engine), federated: await federated(engine, 'wiki') };
      await softDeleteSource(engine, 'wiki');
      const noFederate = [await restoreSource(engine, 'wiki', false), await federated(engine, 'wiki')];
      const pages = await engine.countSourcePages('wiki', { includeDeleted: true });
      return {
        impact, clients, missing, counts, archived, again, absent, listed,
        offWhileArchived, restored, notArchived, afterRestore, noFederate, pages,
      };
    },
  );

  parityTest(
    'archives with the same archive time list by id, last id first',
    { methods: ['listArchivedSourceRows'] },
    async (engine, backend) => {
      for (const id of ['alpha', 'beta', 'gamma']) await createSource(engine, backend, id, {});
      for (const id of ['alpha', 'gamma', 'beta']) await archiveWithoutTimes(engine, backend, id);
      return {
        rows: (await engine.listArchivedSourceRows()).map(r => r.id),
        listed: (await listArchivedSources(engine)).map(s => s.id),
      };
    },
  );

  parityTest(
    'the purge sweep keeps an unexpired archive and reports one with no times instead of purging it',
    { methods: ['archiveSource', 'listArchivedSourceRows', 'listExpiredArchivedSources', 'listUnverifiedArchivedSourceIds'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'fresh', {});
      await createSource(engine, backend, 'untimed', {});
      await createSource(engine, backend, 'active', {});
      await softDeleteSource(engine, 'fresh');
      await archiveWithoutTimes(engine, backend, 'untimed');
      const listed = (await listArchivedSources(engine)).map(s => ({ id: s.id, realTime: s.deletedAt.getTime() > Date.UTC(1970, 0, 2) }));
      const expired = await engine.listExpiredArchivedSources();
      const unverified = await engine.listUnverifiedArchivedSourceIds();
      const result = await purgeExpiredSources(engine);
      return { listed, expired, unverified, result, after: (await engine.listArchivedSourceRows()).map(r => r.id).sort() };
    },
  );

  parityTest(
    'the purge sweep deletes an archive whose window has passed',
    { methods: ['archiveSource', 'listExpiredArchivedSources', 'listArchivedSourceRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'stale', { kind: 'local' }, '/work/stale');
      await engine.archiveSource('stale', -1);
      const expired = (await engine.listExpiredArchivedSources()).map(r => ({
        id: r.id, local_path: r.local_path, incarnation: typeof r.incarnation,
        federated: (typeof r.config === 'string' ? JSON.parse(r.config) : r.config as Record<string, unknown>).federated,
      }));
      const result = await purgeExpiredSources(engine);
      return { expired, result, after: (await engine.listArchivedSourceRows()).map(r => r.id) };
    },
  );

  parityTest(
    'purging an expired archive removes its pages and every row that names it, and keeps what other sources still hold',
    { methods: [
      'archiveSource', 'deleteSourceRecord', 'putPage', 'upsertChunks', 'getPage', 'countSourcePages', 'upsertWriteGateHold',
      'upsertWriteGateReceipt', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor', 'logEvalCandidate', 'listEvalCandidates',
      'writeOpCheckpointRecord', 'readOpCheckpointRecord', 'listArchivedSourceRows',
    ] },
    async (engine, backend) => {
      await createSource(engine, backend, 'stale', {});
      await createSource(engine, backend, 'keeper', {});
      for (const slug of ['notes/only-here', 'notes/shared']) await engine.putPage(slug, page(slug), { sourceId: 'stale' });
      await engine.putPage('notes/shared', page('Shared'), { sourceId: 'keeper' });
      await engine.upsertChunks('notes/only-here', [chunk(0, 'first'), chunk(1, 'second')], { sourceId: 'stale' });
      const hold = (sourceId: string) => ({
        kind: 'fact' as const, source_id: sourceId, slug: 'notes/shared', fingerprint: `fp-${sourceId}`, detector_version: 1,
        tier: 'agent_written', reason_families: ['prompt_injection'], reasons: ['ignore previous instructions'], detector_error: false,
        payload: { fact: 'A fact' }, write_origin: null, request_id: null,
      });
      const holds = { stale: await engine.upsertWriteGateHold(hold('stale')), keeper: await engine.upsertWriteGateHold(hold('keeper')) };
      for (const [sourceId, id] of Object.entries(holds)) {
        await engine.upsertWriteGateReceipt({
          target_table: 'write_gate_holds', target_id: String(id), source_id: sourceId, content_hash: 'h1', tier: 'agent_written',
          detector_version: 1, verdict: 'flag', reason_families: ['prompt_injection'], reasons: ['held'], detector_error: false, request_id: null,
        });
      }
      const candidate = (query: string, sourceIds: string[]) => engine.logEvalCandidate({
        tool_name: 'query', query, retrieved_slugs: ['notes/only-here', 'notes/shared', 'notes/nowhere'], retrieved_chunk_ids: [],
        source_ids: sourceIds, expand_enabled: null, detail: null, detail_resolved: null, vector_enabled: false, expansion_applied: false,
        latency_ms: 1, remote: false, job_id: null, subagent_id: null, embedding_column: null,
      });
      await candidate('covers both', ['stale', 'keeper']);
      await candidate('covers stale', ['stale']);
      await candidate('covers keeper', ['keeper']);
      const cursor = (sourceId: string) => [{ runId: `run-${sourceId}`, index: 0, sourceId, incarnation: 'i', done: false }];
      await engine.writeOpCheckpointRecord('managed-sync', 'stale-cursor', cursor('stale'));
      await engine.writeOpCheckpointRecord('managed-sync', 'keeper-cursor', cursor('keeper'));
      await engine.writeOpCheckpointRecord('other-op', 'stale-other', cursor('stale'));
      await engine.archiveSource('stale', -1);
      const result = await purgeExpiredSources(engine);
      const receipts = async (id: number) => (await engine.listWriteGateReceiptsFor('write_gate_holds', String(id), 10)).length;
      const cursors = async () => Promise.all(['stale-cursor', 'keeper-cursor'].map(async fp => (await engine.readOpCheckpointRecord('managed-sync', fp)) !== null));
      const after = {
        result,
        archived: (await engine.listArchivedSourceRows()).map(r => r.id),
        holds: (await engine.listWriteGateHoldRows({ status: 'all', limit: 100 })).map(h => h.source_id),
        receipts: { stale: await receipts(holds.stale), keeper: await receipts(holds.keeper) },
        slugs: (await engine.listEvalCandidates()).map(c => [c.query, c.retrieved_slugs]).sort(),
        cursors: await cursors(),
        otherOp: (await engine.readOpCheckpointRecord('other-op', 'stale-other')) !== null,
        keeper: [await engine.countSourcePages('keeper'), (await engine.getPage('notes/shared', { sourceId: 'keeper' }))?.title],
      };
      // A source made again with the same id starts empty: no page of the purged one is left behind.
      await createSource(engine, backend, 'stale', {});
      return { ...after, recreated: [await engine.countSourcePages('stale', { includeDeleted: true }), await engine.getPage('notes/only-here', { sourceId: 'stale' })] };
    },
  );

  parityTest(
    'an OAuth client of an expired archive, revoked or not, blocks its purge and the archive stays whole',
    { methods: ['archiveSource', 'deleteSourceRecord', 'insertOauthClient', 'putPage', 'countSourcePages', 'listArchivedSourceRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'held', {});
      await engine.putPage('notes/kept', page('Kept'), { sourceId: 'held' });
      await engine.insertOauthClient({ client_id: 'old-app', client_name: 'Old', source_id: 'held', deleted_at: new Date('2026-01-01T00:00:00Z') });
      await engine.archiveSource('held', -1);
      const result = await purgeExpiredSources(engine);
      return {
        result, archived: (await engine.listArchivedSourceRows()).map(r => r.id),
        pages: await engine.countSourcePages('held', { includeDeleted: true }),
        direct: await engine.deleteSourceRecord('held', { expiredArchiveOnly: true }).then(() => 'deleted', (e: { code?: string }) => e.code),
      };
    },
  );
});
