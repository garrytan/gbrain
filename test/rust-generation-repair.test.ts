/**
 * The reads of `gbrain repair generations` (generations/repair.ts) on PGLite, Postgres and a Rust brain: the ledger
 * items of a generation pair, the three selected lists (unmatched predecessors, restorable generations, held rows)
 * under every combination of the four selectors, the held proposal an apply rereads and the source incarnations the
 * preview hash binds, as typed engine members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: the six statements repair.ts always sent, with the same parameters and byte order, now that they are
 *    engine members (engine-sql/generation-repair.ts). The selector was SQL text built by `selectorSql`; it is now a
 *    typed filter whose four fragments compose in the same order, so all 16 combinations of `--run`, `--since`,
 *    `--key` and `--generation` (or an entry id) render the old text and parameters. A Rust brain answers the same
 *    rows for each combination.
 *  - Regression: the statements went through `executeRaw`, which the Rust engine refuses (`raw_sql`), so `gbrain repair
 *    generations` could not preview or apply on a Rust brain.
 *  - Why existing coverage misses it: test/generations-repair*.test.ts and the e2e repair tests run on the SQL engines
 *    only and use one selector at a time; this test calls the members directly on all three, with every combination.
 *  - Seam: generations are made with the typed activateGenerationRows and recordHeldGenerationRow members. The PGLite
 *    pin wraps PGLiteEngine.prototype.executeRaw to record each statement and restores it in `finally`. Postgres runs
 *    when DATABASE_URL is set (testBackends) and checks the database name first. The Rust half needs the addon: skipped
 *    without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: the restore and release apply paths themselves (test/generations-repair*.test.ts on the SQL engines;
 *    they also need the fence-restore and fence-evidence reads, which still go through executeRaw). A `--since` that
 *    is not an ISO instant with a zone refuses on every engine; test/engine-parity/generation-output-parity.test.ts
 *    covers it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { repairSinceInstant, type GenerationRepairFilter } from '../src/core/engine-sql/generation-repair.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

interface Selection { run?: string; since?: string; key?: string; generation?: number }

/** repair.ts's selectorSql at 0120895e02, verbatim, except that `since` binds as the canonical instant every engine reads. */
function selectorSql(selection: Selection, params: unknown[], alias: string): string {
  const parts: string[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); parts.push(sql.replace('?', `$${params.length}`)); };
  if (selection.run) add(`${alias}.run_id = ?`, selection.run);
  if (selection.since) add(`${alias}.created_at >= ?::timestamptz`, repairSinceInstant(selection.since));
  if (selection.key) add(`${alias}.owner_key = ?`, selection.key);
  if (selection.generation !== undefined) add(`${alias}.id = ?`, selection.generation);
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

/** The statements repair.ts sent through executeRaw at 0120895e02, with the byte-order ORDER BY the items and incarnations reads now carry. */
const OLD = {
  items: 'SELECT generation_id, item_key, identity_hash, action, preimage FROM derived_generation_items WHERE generation_id = ANY($1::bigint[]) ORDER BY generation_id, item_key COLLATE "C"',
  unmatched: (where: string) => `SELECT g.id, g.source_id, g.owner_key, g.activation_id, g.completeness->'unmatched' AS unmatched FROM derived_generations g
      WHERE g.source_id = ANY($1::text[]) AND g.kind = $2 AND g.state = 'live' AND jsonb_typeof(g.completeness->'unmatched') = 'array'${where} ORDER BY g.id`,
  restorable: (where: string) => `SELECT g.id, g.source_id, g.owner_key, g.generation, p.id AS prev_id, p.generation AS prev_generation
         FROM derived_generations g JOIN derived_generations p ON p.superseded_by = g.id AND p.state = 'superseded'
        WHERE g.source_id = ANY($1::text[]) AND g.kind = $2 AND g.state = 'live'${where} ORDER BY g.id`,
  held: (where: string) => `SELECT g.id, g.source_id, g.owner_key, g.held_reason, g.hold_id, g.input_pin, g.attempts, g.proposal_bytes, jsonb_array_length(g.proposal) AS items
       FROM derived_generations g WHERE g.source_id = ANY($1::text[]) AND g.kind = $2 AND g.state = 'held'${where} ORDER BY g.id`,
  incarnations: 'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"',
  proposal: `SELECT proposal, hold_id FROM derived_generations WHERE id=$1 AND state='held'`,
};

const SRC = 'default';
const SOURCES = [SRC, 'elsewhere'];
const KIND = 'repair_walk';
const OTHER_KIND = 'repair_walk_other';
const KEYS = ['k1', 'k2', 'k3', 'k4', 'k5'] as const;
const RUN: Record<string, string | null> = { k1: 'ra', k2: 'ra', k3: 'ra', k4: 'rb', k5: null };
type ListName = 'unmatched' | 'restorable' | 'held';
const LISTS: ListName[] = ['unmatched', 'restorable', 'held'];
const FLAGS = ['run', 'since', 'key', 'id'] as const;
/** The 16 subsets of the four selectors. */
const COMBOS = Array.from({ length: 16 }, (_, mask) => FLAGS.filter((_, bit) => mask & (1 << bit)));

const key = (ownerKey: string, kind = KIND) => ({ sourceId: SRC, kind, ownerKey });
const activation = (generation: number, runId: string | null, completeness: unknown) => ({ generation, runId, operationId: `op-${Math.random()}`,
  inputPin: `pin-${generation}`, inputSize: 1, completeness: JSON.stringify(completeness), setHash: `set-${generation}`, restoreOf: null, activationId: null,
  locator: null });
const ledger = (item_key: string, action: string, preimage: Record<string, unknown> | null) =>
  ({ item_key, identity_hash: `id-${item_key}`, action, preimage, preimage_bytes: preimage ? 8 : null, pending: false });
const unmatched = (owner: string) => ({ unmatched: [{ slug: `walk/${owner}-old`, why: 'no_subject', missing: { claims: 1, quotes: 0, citations: 2 } }] });

interface Seeded { label: Map<number, string>; since: string; ids: Record<ListName, number>; pair: [number, number]; heldK3: number; liveK3: number }

/** Seeds k1..k5 (k1 before `since`) and an other-kind k1 the kind scope must hide. */
async function seed(engine: BrainEngine): Promise<Seeded> {
  const label = new Map<number, string>();
  let since = '';
  let pair: [number, number] = [0, 0];
  for (const owner of KEYS) {
    const run = RUN[owner]!;
    await engine.transaction(async tx => {
      if (owner === 'k5') {
        label.set(await tx.activateGenerationRows(key(owner), null, activation(1, run, { complete: true }), [ledger('walk/k5', 'published', null)]), `${owner}.live`);
        return;
      }
      const prev = await tx.activateGenerationRows(key(owner), null, activation(1, run, { complete: true }), [ledger(`walk/${owner}-a`, 'published', null)]);
      const live = await tx.activateGenerationRows(key(owner), prev, activation(2, run, { complete: true, ...unmatched(owner) }),
        [ledger(`walk/${owner}-a`, 'kept', { x: 1 }), ledger(`walk/${owner}-b`, 'retired', null)]);
      label.set(prev, `${owner}.prev`).set(live, `${owner}.live`);
      if (owner === 'k1') pair = [live, prev];
    });
    await engine.transaction(tx => tx.recordHeldGenerationRow(key(owner), { holdId: `hold-${owner}`, runId: run, inputPin: `held-pin-${owner}`, inputSize: 2,
      setHash: `held-set-${owner}`, reason: owner === 'k4' ? 'no_proof' : 'shrunk', context: JSON.stringify({ owner }),
      proposal: owner === 'k2' ? null : JSON.stringify([{ slug: `walk/${owner}-p1` }, { slug: `walk/${owner}-p2` }]), proposalBytes: 40 }));
    if (owner === 'k1') {
      await Bun.sleep(5);
      since = new Date().toISOString();
      await Bun.sleep(5);
    }
  }
  await engine.transaction(async tx => {
    const prev = await tx.activateGenerationRows(key('k1', OTHER_KIND), null, activation(1, 'ra', { complete: true }), []);
    await tx.activateGenerationRows(key('k1', OTHER_KIND), prev, activation(2, 'ra', unmatched('k1')), []);
  });
  await engine.transaction(tx => tx.recordHeldGenerationRow(key('k1', OTHER_KIND), { holdId: 'hold-other', runId: 'ra', inputPin: null, inputSize: null,
    setHash: 'held-set-other', reason: 'shrunk', context: '{}', proposal: '[]', proposalBytes: 2 }));
  const held = await engine.listHeldGenerationRows(SOURCES, KIND, {});
  for (const row of held) label.set(Number(row.id), `${row.owner_key}.held`);
  const heldK3 = Number(held.find(row => row.owner_key === 'k3')!.id);
  const liveK3 = [...label].find(([, name]) => name === 'k3.live')![0];
  return { label, since, ids: { unmatched: liveK3, restorable: liveK3, held: heldK3 }, pair, heldK3, liveK3 };
}

const filterOf = (flags: readonly string[], seeded: Seeded, list: ListName): GenerationRepairFilter => ({
  ...(flags.includes('run') ? { runId: 'ra' } : {}), ...(flags.includes('since') ? { since: seeded.since } : {}),
  ...(flags.includes('key') ? { ownerKey: 'k2' } : {}), ...(flags.includes('id') ? { id: seeded.ids[list] } : {}) });
const selectionOf = (filter: GenerationRepairFilter): Selection => ({ ...(filter.runId ? { run: filter.runId } : {}),
  ...(filter.since ? { since: filter.since } : {}), ...(filter.ownerKey ? { key: filter.ownerKey } : {}), ...(filter.id !== undefined ? { generation: filter.id } : {}) });

/** The keys each list holds with no filter, and each selector's own set: a combination expects their intersection. */
function expectedKeys(list: ListName, flags: readonly string[]): string[] {
  const all = list === 'held' ? [...KEYS] : ['k1', 'k2', 'k3', 'k4'];
  return all.filter(owner => (!flags.includes('run') || RUN[owner] === 'ra') && (!flags.includes('since') || owner !== 'k1')
    && (!flags.includes('key') || owner === 'k2') && (!flags.includes('id') || owner === 'k3'));
}

async function readList(engine: BrainEngine, list: ListName, filter: GenerationRepairFilter, seeded: Seeded) {
  const name = (id: unknown) => seeded.label.get(Number(id)) ?? `unknown:${id}`;
  if (list === 'unmatched') {
    return (await engine.listUnmatchedGenerationRows(SOURCES, KIND, filter)).map(row => ({ row: name(row.id), source_id: row.source_id, owner_key: row.owner_key,
      activation_id: row.activation_id, unmatched: row.unmatched }));
  }
  if (list === 'restorable') {
    return (await engine.listRestorableGenerationRows(SOURCES, KIND, filter)).map(row => ({ row: name(row.id), prev: name(row.prev_id), source_id: row.source_id,
      owner_key: row.owner_key, generation: Number(row.generation), prev_generation: Number(row.prev_generation) }));
  }
  return (await engine.listHeldGenerationRows(SOURCES, KIND, filter)).map(row => ({ row: name(row.id), source_id: row.source_id, owner_key: row.owner_key,
    held_reason: row.held_reason, hold_id: row.hold_id, input_pin: row.input_pin, attempts: Number(row.attempts),
    proposal_bytes: row.proposal_bytes === null ? null : Number(row.proposal_bytes), items: row.items === null ? null : Number(row.items) }));
}

function expectedRow(list: ListName, owner: string) {
  if (list === 'unmatched') return { row: `${owner}.live`, source_id: SRC, owner_key: owner, activation_id: null, unmatched: unmatched(owner).unmatched };
  if (list === 'restorable') return { row: `${owner}.live`, prev: `${owner}.prev`, source_id: SRC, owner_key: owner, generation: 2, prev_generation: 1 };
  return { row: `${owner}.held`, source_id: SRC, owner_key: owner, held_reason: owner === 'k4' ? 'no_proof' : 'shrunk', hold_id: `hold-${owner}`,
    input_pin: `held-pin-${owner}`, attempts: 1, proposal_bytes: 40, items: owner === 'k2' ? null : 2 };
}

/** Every list under every combination, the item pair, the proposal reads and the incarnations; each engine must agree. */
async function walk(engine: BrainEngine) {
  const seeded = await seed(engine);
  const lists: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  for (const list of LISTS) {
    for (const flags of COMBOS) {
      const name = `${list}[${flags.join('+') || 'none'}]`;
      lists[name] = await readList(engine, list, filterOf(flags, seeded, list), seeded);
      expected[name] = expectedKeys(list, flags).map(owner => expectedRow(list, owner));
    }
  }
  const items = (await engine.readGenerationItemsByIds(seeded.pair)).map(row => ({ ...row, generation_id: seeded.label.get(Number(row.generation_id)) }))
    .sort((a, b) => `${a.generation_id}/${a.item_key}`.localeCompare(`${b.generation_id}/${b.item_key}`));
  const proposal = await engine.readHeldGenerationProposal(seeded.heldK3);
  const proposalOfLive = await engine.readHeldGenerationProposal(seeded.liveK3);
  const proposalMissing = await engine.readHeldGenerationProposal(987654321);
  const incarnations = (await engine.listGenerationSourceIncarnations([...SOURCES, SRC])).map(row => ({ id: row.id, incarnation: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.incarnation) ? 'UUID' : row.incarnation }));
  return { actual: { lists, items, proposal, proposalOfLive, proposalMissing, incarnations }, expected: { lists: expected, items: [
    { generation_id: 'k1.live', item_key: 'walk/k1-a', identity_hash: 'id-walk/k1-a', action: 'kept', preimage: { x: 1 } },
    { generation_id: 'k1.live', item_key: 'walk/k1-b', identity_hash: 'id-walk/k1-b', action: 'retired', preimage: null },
    { generation_id: 'k1.prev', item_key: 'walk/k1-a', identity_hash: 'id-walk/k1-a', action: 'published', preimage: null },
  ], proposal: { proposal: [{ slug: 'walk/k3-p1' }, { slug: 'walk/k3-p2' }], hold_id: 'hold-k3' }, proposalOfLive: null, proposalMissing: null,
  incarnations: [{ id: SRC, incarnation: 'UUID' }] } };
}

async function clean(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind = ANY($2::text[])`, [SRC, [KIND, OTHER_KIND]]);
}

describe('generation repair reads on every engine', () => {
  let pg: PGLiteEngine;
  let pgHome: string;
  const quiet = console.error;

  beforeAll(async () => {
    console.error = () => {};
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-generation-repair-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    console.error = quiet;
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements repair.ts always sent, for all 16 selector combinations', async () => {
    await clean(pg);
    const seeded = await seed(pg);
    const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const proto = PGLiteEngine.prototype as unknown as { executeRaw: BrainEngine['executeRaw'] };
    const original = proto.executeRaw;
    const capture = async <T>(run: () => Promise<T>) => {
      sent.length = 0;
      proto.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
        sent.push({ sql, params });
        return original.call(this, sql, params);
      } as BrainEngine['executeRaw'];
      try {
        const result = await run();
        return { result, sent: [...sent] };
      } finally {
        proto.executeRaw = original;
      }
    };
    try {
      for (const list of LISTS) {
        for (const flags of COMBOS) {
          const filter = filterOf(flags, seeded, list);
          const params: unknown[] = [SOURCES, KIND];
          const sql = OLD[list](selectorSql(selectionOf(filter), params, 'g'));
          const old = await pg.executeRaw(sql, params);
          const call: () => Promise<unknown[]> = list === 'unmatched' ? () => pg.listUnmatchedGenerationRows(SOURCES, KIND, filter)
            : list === 'restorable' ? () => pg.listRestorableGenerationRows(SOURCES, KIND, filter) : () => pg.listHeldGenerationRows(SOURCES, KIND, filter);
          const { result, sent: statements } = await capture(call);
          expect({ list, flags, statements }).toEqual({ list, flags, statements: [{ sql, params }] });
          expect({ list, flags, rows: result }).toEqual({ list, flags, rows: old as never });
        }
        // An entry id alone (`(params.push(id), \` AND g.id = $3\`)`) is the id-only combination.
        const params: unknown[] = [SOURCES, KIND];
        params.push(seeded.ids[list]);
        expect(OLD[list](` AND g.id = $${params.length}`)).toBe(OLD[list](selectorSql({ generation: seeded.ids[list] }, [SOURCES, KIND], 'g')));
      }
      const singles: Array<[() => Promise<unknown>, string, unknown[]]> = [
        [() => pg.readGenerationItemsByIds(seeded.pair), OLD.items, [seeded.pair]],
        [() => pg.readHeldGenerationProposal(seeded.heldK3), OLD.proposal, [seeded.heldK3]],
        [() => pg.listGenerationSourceIncarnations(SOURCES), OLD.incarnations, [SOURCES]],
        // listSourceIncarnations is the sources member (engine-sql/sources.ts), pinned with the sources reads.
      ];
      for (const [call, sql, params] of singles) {
        const old = await pg.executeRaw(sql, params);
        const { result, sent: statements } = await capture(call);
        expect(statements).toEqual([{ sql, params }]);
        expect(Array.isArray(result) ? result : [result]).toEqual(old as never);
      }
    } finally {
      proto.executeRaw = original;
      await clean(pg);
    }
  });

  test('PGLite answers every selector combination', async () => {
    await clean(pg);
    const { actual, expected } = await walk(pg);
    expect(actual).toEqual(expected as typeof actual);
    await clean(pg);
  });

  postgresRun('Postgres answers every selector combination', async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 4 } as never);
    try {
      await engine.initSchema();
      await clean(engine);
      const { actual, expected } = await walk(engine);
      expect(actual).toEqual(expected as typeof actual);
    } finally {
      await clean(engine).catch(() => {});
      await engine.disconnect();
    }
  }, 60_000);

  rustRun('Rust answers every selector combination', async () => {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    try {
      const { actual, expected } = await walk(engine);
      expect(actual).toEqual(expected as typeof actual);
    } finally {
      await engine.disconnect().catch(() => {});
      removeBrainDir(brain.dir);
    }
  }, 60_000);
});
