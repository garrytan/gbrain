/**
 * BrainEngine parity: personal sources (`access_member_sources`, v299) through access/member-sources.ts on every
 * engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `access member source bind` binds a live source to a member once (a second bind changes nothing) and
 *    refuses a removed member, an unknown source and an archived one; `unbind` previews unless applied and refuses a
 *    pair that is not bound; `list` lists every binding, or one member's, by member id and source id in byte order; a
 *    source's owners come back in byte order. An attested read hides every personal source not bound to the attested
 *    member, and under a scope read every personal source; it never adds a source, and a source with no binding stays
 *    readable.
 *  - Regression: an engine that sends these statements as raw SQL (the Rust engine refused them by name, so personal
 *    sources could not be bound, listed or enforced there), that binds twice, that loses a binding on an unbind
 *    preview, or that lists ids in another order than PGLite's byte order (the ids mix `a-z`, `ab`, `a.b`, `a_b`,
 *    and the order case `a1`, `a-x`, `ax`, `b-x`: an en_US Postgres without COLLATE "C" sorted them otherwise).
 *  - Why existing coverage misses it: the other personal-source tests (test/qm-personal-sources.test.ts,
 *    test/thin-client-member-sources.test.ts, test/access-room.test.ts) never run on the Rust engine.
 *  - Seam: none. Real engines; members are written through access/members.ts and sources through the harness.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { addMember, removeMember } from '../../src/core/access/members.ts';
import { attestedReadScope, bindMemberSource, hiddenPersonalSources, listMemberSources, unbindMemberSource } from '../../src/core/access/member-sources.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** Member ids that sort differently by byte and by an en_US collation. */
const MEMBERS = ['ab', 'a_b', 'a-z', 'a.b'];
/** Source ids that sort differently by byte and by an en_US collation. */
const SOURCES = ['dm-ab', 'dm-a-z', 'shared'];

/** An answer as a caller sees it: the value, or the refusal's code and reason. */
async function answer(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OperationError) return { refused: error.code, reason: (error as { reason?: unknown }).reason ?? null };
    throw error;
  }
}

const pairs = (rows: Array<{ member_id: string; source_id: string; created_at: string | null }>) => rows.map(r => `${r.member_id}>${r.source_id}:${r.created_at ? 'stamped' : 'none'}`);

describe('engine parity: personal sources', () => {
  parityTest('bind, unbind and list personal sources in byte order, and an attested read hides the ones of other members',
    {
      methods: ['readSourceRow', 'insertAccessMemberSource', 'readAccessMemberSource', 'deleteAccessMemberSource', 'listAccessMemberSources',
        'listAccessMemberSourceOwners', 'readMemberSourceBindings'],
      timeout: 120_000,
    },
    async (engine: BrainEngine, backend) => {
      for (const s of [...SOURCES, 'old']) await createSource(engine, backend, s);
      await archiveSource(engine, backend, 'old');
      for (const m of MEMBERS) await addMember(engine, m, { name: m });
      await addMember(engine, 'gone', { name: 'gone' });
      await removeMember(engine, 'gone');

      const out: Record<string, unknown> = {};
      const first = await bindMemberSource(engine, 'ab', 'dm-ab');
      out.first = { applied: first.applied, changed: first.changed, owners: first.owners, stamped: first.binding.created_at !== null };
      const again = await bindMemberSource(engine, 'ab', 'dm-ab');
      out.again = { applied: again.applied, changed: again.changed, owners: again.owners, same: again.binding.created_at === first.binding.created_at };
      const dry = await bindMemberSource(engine, 'a_b', 'dm-ab', { dryRun: true });
      out.dry = { applied: dry.applied, changed: dry.changed, owners: dry.owners, stamped: dry.binding.created_at !== null };
      for (const m of ['a_b', 'a-z', 'a.b']) await bindMemberSource(engine, m, 'dm-ab');
      await bindMemberSource(engine, 'a-z', 'dm-a-z');
      out.removedMember = await answer(() => bindMemberSource(engine, 'gone', 'dm-ab'));
      out.unknownSource = await answer(() => bindMemberSource(engine, 'ab', 'nowhere'));
      out.archivedSource = await answer(() => bindMemberSource(engine, 'ab', 'old'));
      out.unknownMember = await answer(() => bindMemberSource(engine, 'nobody', 'dm-ab'));

      out.all = pairs(await listMemberSources(engine));
      out.ofAZ = pairs(await listMemberSources(engine, { member: 'a-z' }));
      out.owners = await engine.listAccessMemberSourceOwners('dm-ab');

      const preview = await unbindMemberSource(engine, 'a.b', 'dm-ab');
      out.preview = { applied: preview.applied, owners: preview.owners, still: preview.still_personal };
      out.afterPreview = (await engine.listAccessMemberSourceOwners('dm-ab')).length;
      const applied = await unbindMemberSource(engine, 'a.b', 'dm-ab', { apply: true });
      out.applied = { applied: applied.applied, owners: applied.owners, still: applied.still_personal };
      const last = await unbindMemberSource(engine, 'a-z', 'dm-a-z', { apply: true });
      out.last = { owners: last.owners, still: last.still_personal };
      out.notBound = await answer(() => unbindMemberSource(engine, 'a-z', 'dm-a-z', { apply: true }));

      out.hiddenForAB = [...await hiddenPersonalSources(engine, SOURCES, 'ab', false)].sort();
      out.hiddenForOther = [...await hiddenPersonalSources(engine, SOURCES, 'zz', false)].sort();
      out.hiddenScope = [...await hiddenPersonalSources(engine, SOURCES, 'ab', true)].sort();
      const auth = { allowedSources: [...SOURCES], sourceId: 'dm-ab' } as never;
      const scoped = await attestedReadScope(engine, { auth, sourceId: 'dm-ab' }, 'zz', false);
      out.scopeForOther = { sourceId: scoped.sourceId, allowed: (scoped.auth as { allowedSources?: string[] }).allowedSources };
      const own = await attestedReadScope(engine, { auth, sourceId: 'dm-ab' }, 'ab', false);
      out.scopeForOwner = { sourceId: own.sourceId, allowed: (own.auth as { allowedSources?: string[] }).allowedSources };

      const want = {
        first: { applied: true, changed: true, owners: ['ab'], stamped: true },
        again: { applied: false, changed: false, owners: ['ab'], same: true },
        dry: { applied: false, changed: true, owners: ['a_b', 'ab'], stamped: false },
        removedMember: { refused: 'access_member_invalid', reason: 'removed' },
        unknownSource: { refused: 'unknown_source', reason: null },
        archivedSource: { refused: 'unknown_source', reason: null },
        unknownMember: { refused: 'access_member_invalid', reason: 'unknown' },
        all: ['a-z>dm-a-z:stamped', 'a-z>dm-ab:stamped', 'a.b>dm-ab:stamped', 'a_b>dm-ab:stamped', 'ab>dm-ab:stamped'],
        ofAZ: ['a-z>dm-a-z:stamped', 'a-z>dm-ab:stamped'],
        owners: ['a-z', 'a.b', 'a_b', 'ab'],
        preview: { applied: false, owners: ['a-z', 'a_b', 'ab'], still: true },
        afterPreview: 4,
        applied: { applied: true, owners: ['a-z', 'a_b', 'ab'], still: true },
        last: { owners: [], still: false },
        notBound: { refused: 'invalid_params', reason: 'unknown_binding' },
        hiddenForAB: [],
        hiddenForOther: ['dm-ab'],
        hiddenScope: ['dm-ab'],
        scopeForOther: { sourceId: 'dm-a-z', allowed: ['dm-a-z', 'shared'] },
        scopeForOwner: { sourceId: 'dm-ab', allowed: ['dm-ab', 'dm-a-z', 'shared'] },
      };
      if (JSON.stringify(out) !== JSON.stringify(want)) throw new Error(`personal sources: ${JSON.stringify(out)}`);
      return out;
    });

  // An en_US Postgres (the CI image's default) sorts `a1` before `a-x` and `dm1` before `dm-x`; byte order puts the
  // dash first. Without COLLATE "C" on the sort keys these lists differ from PGLite and the store on such a server.
  parityTest('personal-source lists sort member and source ids by byte on every Postgres locale',
    { methods: ['insertAccessMemberSource', 'listAccessMemberSources', 'listAccessMemberSourceOwners'], timeout: 120_000 },
    async (engine: BrainEngine, backend) => {
      for (const s of ['dm-x', 'dm1', 'dmx']) await createSource(engine, backend, s);
      for (const m of ['a1', 'a-x', 'ax', 'b-x']) await addMember(engine, m, { name: m });
      for (const [m, s] of [['ax', 'dmx'], ['b-x', 'dm-x'], ['a1', 'dm1'], ['ax', 'dm-x'], ['a-x', 'dmx'], ['a1', 'dm-x'], ['a-x', 'dm-x']]) {
        await engine.insertAccessMemberSource(m, s);
      }
      const ids = (rows: Array<{ member_id: string; source_id: string }>) => rows.map(r => `${r.member_id}>${r.source_id}`);
      const out = {
        all: ids(await engine.listAccessMemberSources(null)),
        ofA1: ids(await engine.listAccessMemberSources('a1')),
        ofAX: ids(await engine.listAccessMemberSources('ax')),
        ownersDashX: await engine.listAccessMemberSourceOwners('dm-x'),
        ownersDmx: await engine.listAccessMemberSourceOwners('dmx'),
      };
      const want = {
        all: ['a-x>dm-x', 'a-x>dmx', 'a1>dm-x', 'a1>dm1', 'ax>dm-x', 'ax>dmx', 'b-x>dm-x'],
        ofA1: ['a1>dm-x', 'a1>dm1'],
        ofAX: ['ax>dm-x', 'ax>dmx'],
        ownersDashX: ['a-x', 'a1', 'ax', 'b-x'],
        ownersDmx: ['a-x', 'ax'],
      };
      if (JSON.stringify(out) !== JSON.stringify(want)) throw new Error(`personal-source order: ${JSON.stringify(out)}`);
      return out;
    });
});
