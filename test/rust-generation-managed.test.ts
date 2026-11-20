/**
 * The managed generation activation rows (generations/managed.ts) on PGLite, Postgres and a Rust brain: the activation
 * record, the flip to activated, the member gate, the settle and the two operator lists as typed engine members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: the seven statements managed.ts always sent, with the same parameters and byte order, now that they are
 *    engine members (engine-sql/generation-activations.ts, and lockGenerationKey of engine-sql/fence-holds.ts for the
 *    key lock), and a Rust brain answers the same walk: a recorded activation keeps its first members, gates a member
 *    until its generation is live and the item is pending, lists the pending members in key order, settles one, and
 *    lists as orphans only the `create` members of a pending activation whose page is live and that no live
 *    generation owns.
 *  - Regression: the statements went through `executeRaw`, which the Rust engine refuses (`raw_sql`), so a managed
 *    publication stopped at recordActivation on a Rust brain (0120895e02).
 *  - Why existing coverage misses it: test/git-door-g6-*.test.ts, test/pathological/g1-managed-atom-probes.test.ts and
 *    test/managed-atom-release-resume-9079-9275.test.ts run managed publications on the SQL engines only; this test
 *    calls the managed.ts functions directly on all three.
 *  - Seam: the generation is made with the typed activateGenerationRows member, and the pages with putPage. The PGLite
 *    pin wraps PGLiteEngine.prototype.executeRaw to record each statement and restores it in `finally`. Postgres runs
 *    when DATABASE_URL is set (testBackends) and checks the database name first. The Rust half needs the addon: skipped
 *    without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: an orphan whose request is still unfinished in the write journal (the walk admits no request), the
 *    activation request itself (prepareGenerationActivation, which test/git-door-g6-*.test.ts drive), and an
 *    activation id that is not a UUID (Postgres's `a.id::uuid` cast may refuse it; the Rust engine matches no request).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertMemberPending, listOrphanCandidates, listPendingMembers, recordActivation, settleMember,
  type ActivationPlanIntent } from '../src/core/generations/managed.ts';
import { generationKeyLock } from '../src/core/generations/publish.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

/** The statements managed.ts sent through executeRaw at 0120895e02, plus a byte-order ORDER BY. */
const OLD = {
  record: `INSERT INTO derived_generation_activations (id, source_id, kind, owner_key, expected_generation, input_pin, item_set_hash, state, members)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::text::jsonb) ON CONFLICT (id) DO NOTHING`,
  lock: `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
  mark: `UPDATE derived_generation_activations SET state='activated', generation_id=$2, updated_at=now() WHERE id=$1`,
  state: `SELECT a.state, g.state AS generation_state, i.pending FROM derived_generation_activations a
       LEFT JOIN derived_generations g ON g.id=a.generation_id
       LEFT JOIN derived_generation_items i ON i.generation_id=a.generation_id AND i.item_key=$2
      WHERE a.id=$1 AND a.source_id=$3`,
  settle: `UPDATE derived_generation_items SET pending=false
    WHERE generation_id=(SELECT generation_id FROM derived_generation_activations WHERE id=$1) AND item_key=$2`,
  pending: `SELECT g.source_id, g.kind, g.owner_key, g.id AS generation_id, g.activation_id, i.item_key AS slug, i.action AS item_action, i.identity_hash AS identity
       FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE i.pending AND g.state='live' AND g.source_id=ANY($1::text[]) AND ($2::text IS NULL OR g.kind=$2) ORDER BY g.source_id COLLATE "C", g.kind COLLATE "C", g.owner_key COLLATE "C", i.item_key COLLATE "C"`,
  orphans: `SELECT a.source_id, a.kind, a.owner_key, a.id AS activation_id, m->>'slug' AS slug, a.created_at::text AS created_at
       FROM derived_generation_activations a CROSS JOIN LATERAL jsonb_array_elements(a.members) m
      WHERE a.state='pending' AND a.source_id=ANY($1::text[]) AND ($2::text IS NULL OR a.kind=$2) AND m->>'action'='create'
        AND NOT EXISTS (SELECT 1 FROM persistence_requests r WHERE r.request_id=a.id::uuid AND r.state IN ('queued','deferred','running','recovering'))
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=m->>'slug' AND p.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
          WHERE g.source_id=a.source_id AND g.kind=a.kind AND g.state='live' AND i.item_key=m->>'slug' AND i.action<>'retired')
      ORDER BY a.source_id COLLATE "C", a.kind COLLATE "C", a.owner_key COLLATE "C", (m->>'slug') COLLATE "C", a.id COLLATE "C"`,
};
const NAME = new Map(Object.entries(OLD).map(([name, sql]) => [sql, name]));

const SRC = 'default';
const KIND = 'managed_walk';
const KEY = { sourceId: SRC, kind: KIND, ownerKey: 'input:m' };
const A1 = '00000000-0000-8000-a000-00000000aa01';
const A2 = '00000000-0000-8000-a000-00000000aa02';
const P = (name: string) => `managed-walk/${name}`;

const intent = (activationId: string, members: ActivationPlanIntent['members']) => ({ activationId, key: KEY, expectedGeneration: 0,
  input: { pin: 'pin-1' }, setHash: 'set-1', members }) as unknown as ActivationPlanIntent;
const member = (slug: string, action: 'create' | 'overwrite' | 'retire') => ({ slug: P(slug), action, identity: `id-${slug}`, before: action === 'create' ? null : `old-${slug}` });

async function gate(engine: BrainEngine, slug: string): Promise<string> {
  try {
    await assertMemberPending(engine, { request_id: 'r', source_id: SRC, slug: P(slug) }, A1, KIND);
    return 'applied';
  } catch (e) {
    return `${(e as { code?: string }).code}: ${(e as Error).message}`;
  }
}

/** The managed walk each engine runs; every engine must answer the same EXPECTED. */
async function walk(engine: BrainEngine) {
  for (const slug of ['orphan', 'owned', 'other']) await engine.putPage(P(slug), { type: 'note', title: slug, compiled_truth: `${slug} body` });
  await engine.transaction(tx => recordActivation(tx, intent(A1, [member('m', 'overwrite'), member('r', 'retire')])));
  // ON CONFLICT (id) DO NOTHING: the second record keeps the first members.
  await engine.transaction(tx => recordActivation(tx, intent(A1, [member('orphan', 'create')])));
  const before = await gate(engine, 'm');
  const beforeState = await engine.readGenerationActivationState(A1, P('m'), SRC);
  const generationId = await engine.transaction(async tx => {
    await tx.lockGenerationKey(generationKeyLock(KEY));
    const id = await tx.activateGenerationRows(KEY, null, { generation: 1, runId: null, operationId: 'managed-op', inputPin: 'pin-1', inputSize: 1,
      completeness: JSON.stringify({ complete: true, managed: true }), setHash: 'set-1', restoreOf: null, activationId: A1, locator: null }, [
      { item_key: P('m'), identity_hash: 'id-m', action: 'published', preimage: null, preimage_bytes: null, pending: true },
      { item_key: P('r'), identity_hash: 'id-r', action: 'retired', preimage: null, preimage_bytes: null, pending: true },
      { item_key: P('owned'), identity_hash: 'id-owned', action: 'kept', preimage: null, preimage_bytes: null, pending: false },
    ]);
    await tx.markGenerationActivated(A1, id);
    return id;
  });
  const gid = (rows: Array<{ generation_id: number }>) => rows.map(row => ({ ...row, generation_id: row.generation_id === generationId ? 'G' : row.generation_id }));
  const activeState = await engine.readGenerationActivationState(A1, P('m'), SRC);
  const otherSourceState = await engine.readGenerationActivationState(A1, P('m'), 'elsewhere');
  const missingItemState = await engine.readGenerationActivationState(A1, P('nothing'), SRC);
  const applied = await gate(engine, 'm');
  const pending = gid(await listPendingMembers(engine, [SRC]));
  const pendingOtherKind = await listPendingMembers(engine, [SRC], 'other_kind');
  await engine.transaction(tx => settleMember(tx, A1, P('m')));
  const settled = await gate(engine, 'm');
  const pendingAfter = gid(await listPendingMembers(engine, [SRC, 'elsewhere'], KIND));
  // A2 never activates: its live-page create member that no generation owns is an orphan.
  await engine.transaction(tx => recordActivation(tx, intent(A2, [member('owned', 'create'), member('orphan', 'create'), member('gone', 'create'),
    member('other', 'overwrite')])));
  const orphans = (await listOrphanCandidates(engine, [SRC])).map(row => ({ ...row, created_at: /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(row.created_at) ? 'T' : row.created_at }));
  const orphansOtherKind = await listOrphanCandidates(engine, [SRC], 'other_kind');
  const orphansOtherSource = await listOrphanCandidates(engine, ['elsewhere']);
  return { before, beforeState, activeState, otherSourceState, missingItemState, applied, pending, pendingOtherKind, settled, pendingAfter,
    orphans, orphansOtherKind, orphansOtherSource };
}

const NEVER = 'revision_conflict: The generation member was not applied: its generation was never activated.';
const EXPECTED: Record<string, unknown> = {
  before: NEVER,
  beforeState: { state: 'pending', generation_state: null, pending: null },
  activeState: { state: 'activated', generation_state: 'live', pending: true },
  otherSourceState: null,
  missingItemState: { state: 'activated', generation_state: 'live', pending: null },
  applied: 'applied',
  pending: [
    { source_id: SRC, kind: KIND, owner_key: 'input:m', generation_id: 'G', activation_id: A1, slug: P('m'), action: 'overwrite', identity: 'id-m' },
    { source_id: SRC, kind: KIND, owner_key: 'input:m', generation_id: 'G', activation_id: A1, slug: P('r'), action: 'retire', identity: 'id-r' },
  ],
  pendingOtherKind: [],
  settled: 'revision_conflict: The generation member was not applied: the item is already settled.',
  pendingAfter: [
    { source_id: SRC, kind: KIND, owner_key: 'input:m', generation_id: 'G', activation_id: A1, slug: P('r'), action: 'retire', identity: 'id-r' },
  ],
  orphans: [{ source_id: SRC, kind: KIND, owner_key: 'input:m', activation_id: A2, slug: P('orphan'), created_at: 'T' }],
  orphansOtherKind: [],
  orphansOtherSource: [],
};

async function clean(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM derived_generation_activations WHERE source_id=$1 AND kind=$2`, [SRC, KIND]);
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2`, [SRC, KIND]);
  await engine.executeRaw(`DELETE FROM pages WHERE source_id=$1 AND slug LIKE 'managed-walk/%'`, [SRC]);
}

describe('managed generation activations on every engine', () => {
  let pg: PGLiteEngine;
  let pgHome: string;
  const quiet = console.error;

  beforeAll(async () => {
    console.error = () => {};
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-generation-managed-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    console.error = quiet;
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements managed.ts always sent', async () => {
    await clean(pg);
    const sent: Array<{ name: string; params: unknown[] | undefined }> = [];
    const proto = PGLiteEngine.prototype as unknown as { executeRaw: BrainEngine['executeRaw'] };
    const original = proto.executeRaw;
    proto.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      const name = NAME.get(sql);
      if (name) sent.push({ name, params });
      return original.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      await pg.transaction(async tx => {
        await recordActivation(tx, intent(A1, [member('m', 'overwrite'), member('orphan', 'create')]));
        await tx.lockGenerationKey(generationKeyLock(KEY));
        // No row has this id, so the flip changes nothing (and checks no foreign key).
        await tx.markGenerationActivated(A2, 7);
      });
      await assertMemberPending(pg, { request_id: 'r', source_id: SRC, slug: P('m') }, A1, KIND).catch(() => {});
      await settleMember(pg, A1, P('m'));
      await listPendingMembers(pg, [SRC]);
      await listPendingMembers(pg, [SRC], KIND);
      await listOrphanCandidates(pg, [SRC, 'elsewhere']);
      await listOrphanCandidates(pg, [SRC], KIND);
      expect(sent).toEqual([
        { name: 'record', params: [A1, SRC, KIND, 'input:m', 0, 'pin-1', 'set-1',
          JSON.stringify([{ slug: P('m'), action: 'overwrite', identity: 'id-m', before: 'old-m' }, { slug: P('orphan'), action: 'create', identity: 'id-orphan', before: null }])] },
        { name: 'lock', params: [`gbrain:generation:${KIND}:${SRC}:input:m`] },
        { name: 'mark', params: [A2, 7] },
        { name: 'state', params: [A1, P('m'), SRC] },
        { name: 'settle', params: [A1, P('m')] },
        { name: 'pending', params: [[SRC], null] },
        { name: 'pending', params: [[SRC], KIND] },
        { name: 'orphans', params: [[SRC, 'elsewhere'], null] },
        { name: 'orphans', params: [[SRC], KIND] },
      ]);
    } finally {
      proto.executeRaw = original;
      await clean(pg);
    }
  });

  test('PGLite walks a managed publication', async () => {
    await clean(pg);
    expect(await walk(pg)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    await clean(pg);
  });

  postgresRun('Postgres walks a managed publication', async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 4 } as never);
    try {
      await engine.initSchema();
      await clean(engine);
      expect(await walk(engine)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    } finally {
      await clean(engine).catch(() => {});
      await engine.disconnect();
    }
  }, 60_000);

  rustRun('Rust walks a managed publication', async () => {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    try {
      expect(await walk(engine)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    } finally {
      await engine.disconnect().catch(() => {});
      removeBrainDir(brain.dir);
    }
  }, 60_000);
});
