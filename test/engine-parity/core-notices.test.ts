/**
 * BrainEngine parity: listPendingCoreNotices (engine-sql/core-notices.ts), the pending core-edit notices the
 * session-start core block, `gbrain core status` and the doctor core_memory check used to read through
 * `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: PGLite and Postgres return the same notices in the same bytewise order (source, then slug, COLLATE "C"),
 *    one per page (the newest wins), acked notices excluded, filtered by source when asked. The Rust engine keeps no
 *    notices and refuses by name, never an empty list a caller would read as "no remote edits".
 *  - Regression: a Postgres database with a non-C collation listed 'core/alpha' before 'core/Zeta' while PGLite listed
 *    them the other way, so `core status` and the core block printed a different order per backend; a Rust brain
 *    reported zero pending edits it never looked for.
 *  - Why existing coverage misses it: test/core-memory.test.ts runs on PGLite only, whose collation is C.
 *  - Seam: none on the read. The notice rows come from the harness fixture seedCoreEditNotice (the core-page guard's
 *    writer has no typed member).
 */
import { describe, expect } from 'bun:test';
import { parityArms, seedCoreEditNotice } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

describe('core notices', () => {
  parityTest(
    'listPendingCoreNotices lists one pending notice per core page in bytewise order, and refuses by name on Rust',
    { methods: ['listPendingCoreNotices'] },
    async (engine, backend) => {
      const empty = await engine.listPendingCoreNotices().then((rows) => rows, (e: unknown) => e);
      if (backend === 'rust') {
        const refusal = empty as { code?: string; detail?: string };
        expect({ code: refusal?.code, named: refusal?.detail?.includes('member=listPendingCoreNotices ') })
          .toEqual({ code: 'engine_capability_missing', named: true });
        throw empty;
      }
      expect(empty).toEqual([]);
      for (const seed of [
        { sourceId: 'default', slug: 'core/alpha', revision: 'r1', actor: 'agent-a' },
        { sourceId: 'default', slug: 'core/Zeta', revision: 'r2', actor: 'agent-b' },
        { sourceId: 'default', slug: 'core/alpha', revision: 'r3', actor: 'agent-c' },
        { sourceId: 'default', slug: 'core/acked', revision: 'r4', actor: 'agent-d', acked: true },
        { sourceId: 'team', slug: 'core/beta', revision: null, actor: 'agent-e' },
        { sourceId: 'Team', slug: 'core/gamma', revision: 'r6', actor: 'agent-f' },
      ]) await seedCoreEditNotice(engine, backend, seed);
      const shape = (rows: Awaited<ReturnType<typeof engine.listPendingCoreNotices>>) =>
        rows.map((r) => ({ source_id: r.source_id, slug: r.slug, revision: r.revision, actor: r.actor, dated: typeof r.created_at === 'string' && r.created_at.length > 0 }));
      const all = shape(await engine.listPendingCoreNotices());
      const allNull = shape(await engine.listPendingCoreNotices(null));
      const scoped = shape(await engine.listPendingCoreNotices(['team', 'default']));
      const none = await engine.listPendingCoreNotices([]);
      const row = (source_id: string, slug: string, revision: string | null, actor: string) => ({ source_id, slug, revision, actor, dated: true });
      expect({ all, allNull, scoped, none }).toEqual({
        all: [row('Team', 'core/gamma', 'r6', 'agent-f'), row('default', 'core/Zeta', 'r2', 'agent-b'),
          row('default', 'core/alpha', 'r3', 'agent-c'), row('team', 'core/beta', null, 'agent-e')],
        allNull: all,
        scoped: [row('default', 'core/Zeta', 'r2', 'agent-b'), row('default', 'core/alpha', 'r3', 'agent-c'), row('team', 'core/beta', null, 'agent-e')],
        none: [],
      });
      return { all, allNull, scoped, none };
    },
  );
});
