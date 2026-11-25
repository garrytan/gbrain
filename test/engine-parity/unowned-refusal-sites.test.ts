/**
 * BrainEngine parity — the refusal-swallow swap blockers with no lane owner (docs/research/rust-refusal-swallow-triage.tsv).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each site's read or write answers on every engine through a typed member, so a Rust brain gets the same
 *    answer as PGLite and Postgres instead of a default its catch made up. The three new members:
 *    countOpenLoopsByCounterpartyEmail counts every open loop of a type per sender email in one source, with no limit;
 *    listPendingCoreEditNotices lists the unacknowledged remote-edit notices of core pages (none on a brain with
 *    none); purgeStaleAppliedCaptures deletes and counts the stale applied-capture records (none on a brain with none).
 *  - Regression: each site ran raw SQL inside a catch, so the Rust arm's refusal turned into an empty, zero or default
 *    answer; `checkRustArm` fails such a case because it reached a refusing member and caught its refusal.
 *  - Why existing coverage misses it: the sites' own tests run on PGLite, where raw SQL answers.
 *  - Seam: none. Real engines, typed methods only.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { LoopType } from '../../src/core/loops/loops-store.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pendingCoreNotices } from '../../src/core/core-memory.ts';
import { purgeStaleAppliedCaptures } from '../../src/core/ingestion/applied-captures.ts';
import { readClientSurfaces } from '../../src/core/advisor/collect-mcp-client-fit.ts';
import { checkpointKey, clearBackfillCheckpoint } from '../../src/core/backfill-base.ts';
import { recordRateLimit } from '../../src/core/connectors/api-source.ts';
import { BrainWriter } from '../../src/core/output/writer.ts';

const { parityTest } = parityArms(testBackends());

const AT = '2026-03-01T10:00:00.000Z';

describe('engine parity: refusal-swallow sites with no lane owner', () => {
  parityTest(
    'countOpenLoopsByCounterpartyEmail counts every open loop of the type per sender email in the source',
    { methods: ['upsertOpenLoop', 'closeOpenLoop', 'countOpenLoopsByCounterpartyEmail'] },
    async (engine: BrainEngine, backend) => {
      await createSource(engine, backend, 'g1');
      await createSource(engine, backend, 'g2');
      const add = (sourceId: string, key: string, email: string, loopType: LoopType = 'unanswered_inbound') => engine.upsertOpenLoop({
        sourceId, dedupKey: key, loopType, counterpartyEmail: email, summary: key, evidence: [], detector: 'manual', lastActivityAt: AT, openedAt: AT });
      const first = await add('g1', 'a1', 'a@example.com');
      await add('g1', 'a2', 'a@example.com');
      await add('g1', 'a3', 'a@example.com');
      await add('g1', 'b1', 'b@example.com');
      await add('g1', 'a-owed', 'a@example.com', 'commitment_owed_by_me');
      await add('g2', 'a-other', 'a@example.com');
      await engine.closeOpenLoop('g1', first.id, 'done', 'parity');
      const count = async (emails: string[]) => (await engine.countOpenLoopsByCounterpartyEmail('g1', emails, 'unanswered_inbound'))
        .map(r => `${r.email}=${r.n}`).sort();
      return {
        both: await count(['a@example.com', 'b@example.com', 'c@example.com']),
        one: await count(['b@example.com']),
        none: await count([]),
      };
    },
  );

  parityTest(
    'the core-notice and applied-capture sites answer on a brain with nothing to report',
    { methods: ['listPendingCoreEditNotices', 'purgeStaleAppliedCaptures'] },
    async (engine: BrainEngine) => ({
      notices: await pendingCoreNotices(engine),
      scoped: await engine.listPendingCoreEditNotices(['default']),
      purged: await purgeStaleAppliedCaptures(engine),
      purgedNow: await engine.purgeStaleAppliedCaptures(0),
    }),
  );

  parityTest(
    'the backfill cursor, the connector rate-limit mark and the advisor client surfaces read and write through typed members',
    { methods: ['setConfig', 'readStoredConfigValue', 'unsetConfig', 'writeOpCheckpointRecord', 'readOpCheckpointRecord', 'listOauthClients'] },
    async (engine: BrainEngine) => {
      await engine.setConfig(checkpointKey('parity'), '42');
      const before = await engine.readStoredConfigValue(checkpointKey('parity'));
      await clearBackfillCheckpoint(engine, 'parity');
      const after = await engine.readStoredConfigValue(checkpointKey('parity'));
      await recordRateLimit(engine, 'default', Date.parse(AT));
      const mark = await engine.readOpCheckpointRecord('connector-rate-limit', 'default');
      const surfaces = await readClientSurfaces({ engine });
      return { before, after, mark: mark?.completed_keys ?? null, surfaces: surfaces ? [...surfaces.entries()] : null };
    },
  );

  parityTest(
    'createEntity holds the desired slug through the writer transaction and writes the page',
    { methods: ['transaction', 'lockPageKeys', 'putPage'] },
    async (engine: BrainEngine) => {
      const writer = new BrainWriter(engine, { strictMode: 'off' });
      const { result } = await writer.transaction(tx => tx.createEntity({
        desiredSlug: 'people/alice-example', displayName: 'Alice Example', type: 'person', compiledTruth: 'Alice is a person.' }),
        { config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, requestId: 'parity', remote: false });
      const page = await engine.getPage(result, { sourceId: 'default' });
      return { slug: result, title: page?.title ?? null };
    },
  );
});
