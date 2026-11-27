/**
 * BrainEngine parity: the session_context_state members of engine-sql/session-state.ts, which context/session-state.ts
 * (the session cursor of context_pack and delta, the checkpoint manifest and its garbage collection) used to run
 * through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts) gives the same answer for one session row keyed by (source_id, client_id,
 *    session_id): the incomplete-wake counter the upsert returns, the stored sets the replace flags keep, the wake time
 *    and facts keyset read back at microsecond precision, the checkpoint manifest, and which rows the 7-day age-out
 *    keeps. The per-(source_id, client_id) row cap is in test/engine-parity/session-state-cap.test.ts.
 *  - Regression: an engine that shares a row across clients or sources, loses a stored set the flags keep, rounds the
 *    cursor to milliseconds, lets a manifest write touch the cursor, or ages out by another window re-delivers or
 *    drops what context_pack and delta show a session.
 *  - Why existing coverage misses it: test/session-state-gc.test.ts, test/ambient-recall.test.ts and
 *    test/checkpoint-manifest.test.ts run on PGLite only and age rows with raw SQL, so no engine is compared.
 *  - Seam: the members on the engine handle and the context/session-state.ts functions that call them. No timestamp
 *    the engine generates is compared.
 */
import { describe, expect } from 'bun:test';
import type { SessionStateWrite } from '../../src/core/engine-sql/session-state.ts';
import {
  appendCheckpointManifest, gcSessionContextState, getCheckpointManifest, getSessionContextState, readDeltaSessionState,
  upsertSessionContextState,
} from '../../src/core/context/session-state.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

function write(degradedWakes: SessionStateWrite['degradedWakes'], extra: Partial<SessionStateWrite> = {}): SessionStateWrite {
  return {
    standingEntities: [], surfacedSlugs: [], lastWakeAt: null, replaceStanding: false, replaceCursorSlug: false,
    factsCursorAt: null, factsCursorId: null, degradedWakes, ...extra,
  };
}

async function threw(run: () => Promise<unknown>): Promise<boolean> {
  return run().then(() => false, () => true);
}

describe('engine parity: session state', () => {
  parityTest(
    'upsertSessionState counts incomplete wakes per (source, client, session) row and refuses a bad wake time',
    { methods: ['upsertSessionState'] },
    async (engine) => {
      const counts = [
        await engine.upsertSessionState('default', 'local', 's', write('increment')),
        await engine.upsertSessionState('default', 'local', 's', write('increment')),
        await engine.upsertSessionState('default', 'local', 's', write('keep')),
        await engine.upsertSessionState('default', 'local', 's', write('reset')),
        await engine.upsertSessionState('default', 'local', 's', write('increment')),
        // Another session, client or source is another row.
        await engine.upsertSessionState('default', 'local', 't', write('keep')),
        await engine.upsertSessionState('default', 'agent-a', 's', write('increment')),
        await engine.upsertSessionState('other', 'local', 's', write('keep')),
        await engine.upsertSessionState('default', 'local', 's', write('increment')),
      ];
      expect(counts).toEqual([1, 2, 2, 0, 1, 0, 1, 0, 2]);
      const refused = {
        wake: await threw(() => engine.upsertSessionState('default', 'local', 's', write('keep', { lastWakeAt: 'not a time' }))),
        factsAt: await threw(() => engine.upsertSessionState('default', 'local', 's', write('keep', { factsCursorAt: 'not a time' }))),
        factsId: await threw(() => engine.upsertSessionState('default', 'local', 's', write('keep', { factsCursorAt: '2026-01-01T00:00:00Z', factsCursorId: 1.5 }))),
      };
      expect(refused).toEqual({ wake: true, factsAt: true, factsId: true });
      return { counts, refused, after: await engine.upsertSessionState('default', 'local', 's', write('keep')) };
    },
  );

  parityTest(
    'readSessionCursor reads the stored sets the replace flags keep and the wake time at microsecond precision',
    { methods: ['upsertSessionState', 'readSessionCursor'] },
    async (engine) => {
      const absent = await engine.readSessionCursor('default', 'local', 's');
      await engine.upsertSessionState('default', 'local', 's', write('keep', {
        standingEntities: ['people/alice-example', 'companies/acme-example'], surfacedSlugs: ['notes/a'],
        lastWakeAt: '2026-11-19T01:02:03.123456Z', replaceStanding: true, replaceCursorSlug: true,
      }));
      const first = await engine.readSessionCursor('default', 'local', 's');
      // No replace flags and no wake time: the stored sets and the wake time stay.
      await engine.upsertSessionState('default', 'local', 's', write('keep', { standingEntities: ['people/bob-example'], surfacedSlugs: ['notes/b'] }));
      const kept = await engine.readSessionCursor('default', 'local', 's');
      // A wake time in another zone is stored as the same instant; an empty set replaces when its flag is set.
      await engine.upsertSessionState('default', 'local', 's', write('keep', {
        standingEntities: [], surfacedSlugs: ['notes/c'], lastWakeAt: '2026-11-19T09:00:00.5+08:00', replaceStanding: true, replaceCursorSlug: true,
      }));
      const replaced = await engine.readSessionCursor('default', 'local', 's');
      const otherClient = await engine.readSessionCursor('default', 'agent-a', 's');
      expect(first).toEqual({
        standing_entities: ['people/alice-example', 'companies/acme-example'], surfaced_slugs: ['notes/a'], last_wake_at: '2026-11-19T01:02:03.123456Z',
      });
      expect(kept).toEqual(first);
      expect(replaced).toEqual({ standing_entities: [], surfaced_slugs: ['notes/c'], last_wake_at: '2026-11-19T01:00:00.500000Z' });
      return { absent, first, kept, replaced, otherClient };
    },
  );

  parityTest(
    'readDeltaSessionRow reads both cursors and the counter; a null facts time keeps the stored keyset pair',
    { methods: ['upsertSessionState', 'readDeltaSessionRow'] },
    async (engine) => {
      const absent = await engine.readDeltaSessionRow('default', 'local', 's');
      await engine.upsertSessionState('default', 'local', 's', write('increment', {
        surfacedSlugs: ['notes/a'], replaceCursorSlug: true, lastWakeAt: '2026-11-19T00:00:00.000001Z',
        factsCursorAt: '2026-11-18T23:59:59.999999Z', factsCursorId: 41,
      }));
      const first = await engine.readDeltaSessionRow('default', 'local', 's');
      // No facts time: the stored (time, id) pair stays even though an id is passed.
      await engine.upsertSessionState('default', 'local', 's', write('increment', { factsCursorId: 99 }));
      const keptPair = await engine.readDeltaSessionRow('default', 'local', 's');
      await engine.upsertSessionState('default', 'local', 's', write('reset', { factsCursorAt: '2026-11-19T00:00:01Z', factsCursorId: 9007199254740991 }));
      const moved = await engine.readDeltaSessionRow('default', 'local', 's');
      expect(first).toEqual({
        surfaced_slugs: ['notes/a'], last_wake_at: '2026-11-19T00:00:00.000001Z', facts_cursor_at: '2026-11-18T23:59:59.999999Z',
        facts_cursor_id: 41, degraded_wakes: 1,
      });
      expect(keptPair).toEqual({ ...first!, degraded_wakes: 2 });
      expect(moved).toEqual({ ...first!, facts_cursor_at: '2026-11-19T00:00:01.000000Z', facts_cursor_id: 9007199254740991, degraded_wakes: 0 });
      return { absent, first, keptPair, moved };
    },
  );

  parityTest(
    'readCheckpointManifestRow reads an empty manifest for a cursor-only row and null for no row',
    { methods: ['upsertSessionState', 'readCheckpointManifestRow'] },
    async (engine) => {
      const absent = await engine.readCheckpointManifestRow('default', 'local', 's');
      await engine.upsertSessionState('default', 'local', 's', write('keep'));
      const empty = await engine.readCheckpointManifestRow('default', 'local', 's');
      expect(absent).toBeNull();
      expect(empty).toEqual({ checkpoint_manifest: [] });
      return { absent, empty, otherSource: await engine.readCheckpointManifestRow('other', 'local', 's') };
    },
  );

  parityTest(
    'writeCheckpointManifest replaces the manifest, creates a row with an empty cursor, and leaves the cursor alone',
    { methods: ['upsertSessionState', 'writeCheckpointManifest', 'readCheckpointManifestRow', 'readSessionCursor', 'readDeltaSessionRow'] },
    async (engine) => {
      const link = (slug: string, n: number) => ({ slug, title: `Title ${slug}`, at: '2026-11-19T00:00:00.000Z', n, seg: 'seg-1' });
      await engine.writeCheckpointManifest('default', 'local', 'new', [link('notes/a', 1)]);
      const created = {
        manifest: await engine.readCheckpointManifestRow('default', 'local', 'new'),
        cursor: await engine.readSessionCursor('default', 'local', 'new'),
        delta: await engine.readDeltaSessionRow('default', 'local', 'new'),
      };
      await engine.upsertSessionState('default', 'local', 's', write('increment', {
        standingEntities: ['people/alice-example'], surfacedSlugs: ['notes/x'], replaceStanding: true, replaceCursorSlug: true,
        lastWakeAt: '2026-11-19T00:00:00Z',
      }));
      await engine.writeCheckpointManifest('default', 'local', 's', [link('notes/a', 1), link('notes/b', 1)]);
      await engine.writeCheckpointManifest('default', 'local', 's', [link('notes/c', 2), { slug: 'notes/d', nested: { k: [1, 2] } }]);
      const rewritten = {
        manifest: await engine.readCheckpointManifestRow('default', 'local', 's'),
        cursor: await engine.readSessionCursor('default', 'local', 's'),
        delta: await engine.readDeltaSessionRow('default', 'local', 's'),
      };
      expect(created.cursor).toEqual({ standing_entities: [], surfaced_slugs: [], last_wake_at: null });
      expect(rewritten.manifest).toEqual({ checkpoint_manifest: [link('notes/c', 2), { slug: 'notes/d', nested: { k: [1, 2] } }] });
      expect(rewritten.delta?.degraded_wakes).toBe(1);
      return { created, rewritten };
    },
  );

  parityTest(
    'ageOutSessionState keeps rows written inside the window',
    { methods: ['upsertSessionState', 'writeCheckpointManifest', 'ageOutSessionState', 'readSessionCursor'] },
    async (engine) => {
      await engine.upsertSessionState('default', 'local', 'a', write('keep'));
      await engine.writeCheckpointManifest('other', 'agent-a', 'b', []);
      await engine.ageOutSessionState(1);
      await engine.ageOutSessionState(7);
      const rows = {
        a: (await engine.readSessionCursor('default', 'local', 'a')) !== null,
        b: (await engine.readSessionCursor('other', 'agent-a', 'b')) !== null,
      };
      expect(rows).toEqual({ a: true, b: true });
      return rows;
    },
  );

  parityTest(
    'context/session-state.ts keeps a wake cursor, a delta read and a checkpoint manifest across calls',
    {
      methods: ['upsertSessionState', 'readSessionCursor', 'readDeltaSessionRow', 'readCheckpointManifestRow', 'writeCheckpointManifest',
        'ageOutSessionState', 'capSessionStatePerClient'],
    },
    async (engine) => {
      const long = 'x'.repeat(250);
      const before = {
        cursor: await getSessionContextState(engine, 'default', null, 'sess'),
        delta: await readDeltaSessionState(engine, 'default', null, 'sess'),
        manifest: await getCheckpointManifest(engine, 'default', null, 'sess'),
      };
      // The first wake banks the standing entities and the keyset; the second moves only the keyset.
      const wakes = [
        await upsertSessionContextState(engine, 'default', null, 'sess', {
          standingEntities: ['people/alice-example'], lastWakeAt: '2026-11-19T00:00:00.000001Z', cursorSlug: 'notes/a', degradedWakes: 'increment',
        }),
        await upsertSessionContextState(engine, 'default', 'local', 'sess', { lastWakeAt: '2026-11-19T00:05:00Z', cursorSlug: '' }),
        await upsertSessionContextState(engine, 'default', '  agent-a  ', long, {
          lastWakeAt: '2026-11-19T00:00:00Z', factsCursor: { at: '2026-11-18T00:00:00.000002Z', id: 7 }, degradedWakes: 'reset',
        }),
        await upsertSessionContextState(engine, 'default', null, 'sess', { lastWakeAt: 'not a time' }),
      ];
      const appended = [
        await appendCheckpointManifest(engine, 'default', null, 'sess', [{ slug: 'notes/b', title: 'B\n title' }], { seg: 'h1', n: 1, at: '2026-11-19T00:01:00.000Z' }),
        await appendCheckpointManifest(engine, 'default', null, 'sess',
          Array.from({ length: 22 }, (_, i) => ({ slug: `notes/c${i}`, title: `C${i}` })).concat([{ slug: 'notes/b', title: 'B again' }]),
          { seg: 'h2', n: 2, at: '2026-11-19T00:02:00.000Z' }),
        await appendCheckpointManifest(engine, 'default', null, 'fresh', [], { seg: 'h3', n: 3 }),
      ];
      await gcSessionContextState(engine);
      const after = {
        cursor: await getSessionContextState(engine, 'default', null, 'sess'),
        delta: await readDeltaSessionState(engine, 'default', null, 'sess'),
        manifest: await getCheckpointManifest(engine, 'default', null, 'sess'),
        agent: await readDeltaSessionState(engine, 'default', 'agent-a', long.slice(0, 200)),
        fresh: await getCheckpointManifest(engine, 'default', null, 'fresh'),
      };
      expect(wakes.map((w) => w.ok)).toEqual([true, true, true, false]);
      expect(after.cursor).toEqual({ standing_entities: ['people/alice-example'], surfaced_slugs: [''], last_wake_at: '2026-11-19T00:05:00.000000Z' });
      expect(after.manifest?.length).toBe(20);
      expect(after.manifest?.[0]).toEqual({ slug: 'notes/c0', title: 'C0', at: '2026-11-19T00:02:00.000Z', n: 2, seg: 'h2' });
      expect(after.agent).toMatchObject({ status: 'loaded', state: { facts_cursor_id: 7, degraded_wakes: 0 } });
      // A failed write reports its error text, which names the engine's parser: compare only that it failed.
      return { before, wakes: wakes.map((w) => (w.ok ? w : { ok: false })), appended, after };
    },
  );
});
