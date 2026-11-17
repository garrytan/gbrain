/**
 * #7632/#7659: the purge and withdrawal guards run SECURITY INVOKER and read their ledgers (fact_purges, fact_withdrawals,
 * take_purges, page_purges, the derivation purge tables) as the writing role. A role that neither owns the ledgers nor
 * bypasses RLS, with write policies on the guarded table but none on the ledger, read it empty: a purged claim, take,
 * page or derivation was stored again and a withdrawn fact saved (or set) active, while the owner was refused.
 *
 * Contract (migration v318): each guard refuses with writer_coordinator_required (unreadable_state, the v278/v281
 * refusal, its HINT naming the table and the docs/ENGINES.md recipe) when RLS applies to the caller on its ledger and no
 * permissive policy of the caller covers it. The owner, a role that bypasses RLS, a ledger without RLS and a role
 * holding the docs/ENGINES.md policies (applied verbatim) keep exactly the guard they had. The owner arm runs on PGLite
 * and Postgres (PGLite has no roles); the role arms and the upgrade arm run on Postgres through
 * test/e2e/guard-ledgers-fail-closed-7632-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { FACT_WITHDRAWAL_STAMP_DEFERRED_SETTING } from '../src/core/facts/insert-guard-schema.ts';
import { failClosedLedgerGuards } from '../src/core/guard-ledger-checks.ts';
import { recordDerivationPurge } from '../src/core/page-body/segment-derive.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { databaseRefusal } from '../src/core/persistence/publication-failure.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: Array<{ name: string; engine: BrainEngine }> = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-7632-db-'));
let closePostgres: (() => Promise<void>) | undefined;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const SCOPED = `gbrain_ledger_7632_${suffix}`;
const BYPASS = `gbrain_ledger_bypass_7632_${suffix}`;
const UNREADABLE = /writer_coordinator_required: writer state is unreadable to this database role/;
const PURGED = /purged_content: /;
const ROLLBACK = 'guard-probe-rollback';
const LEDGERS = ['fact_purges', 'fact_withdrawals', 'take_purges', 'page_purges', 'page_segment_derivation_purges', 'page_segment_derivation_purge_pages'];
/** The guards v318 re-creates. */
const GUARD_FUNCTIONS = ['gbrain_guard_inserted_facts', 'gbrain_mark_derivation_scope_entry', 'gbrain_preserve_fact_withdrawal',
  'gbrain_refuse_purged_fact', 'gbrain_refuse_purged_page', 'gbrain_refuse_purged_take', 'gbrain_refuse_purging_derivation'];
const migration = MIGRATIONS.find(m => m.name === 'guard_ledgers_fail_closed')!;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push({ name: 'pglite', engine });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ name: 'postgres', engine: pg.engine }); closePostgres = pg.close;
  }
}, 180_000);
afterAll(async () => {
  for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

type Exec = Pick<BrainEngine, 'executeRaw'>;
interface Seed { pageId: number; claim: string; hash: string }
/** A page in 'default', written as the owner and committed; each case gets its own claim. */
async function seedPage(engine: BrainEngine): Promise<Seed> {
  const id = randomUUID().slice(0, 8);
  const [page] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,content_hash)
    VALUES('default',$1,'note','Seed','body',repeat('a',64)) RETURNING id`, [`notes/guard-${id}`]);
  return { pageId: page!.id, claim: `Zebra ${id} migrates north every spring`, hash: `${id}${'b'.repeat(56)}` };
}
const insertFact = (s: Seed): [string, unknown[]] => [`INSERT INTO facts(source_id,entity_slug,fact,kind,source,visibility)
  VALUES('default','people/alice-example',$1,'fact','probe','world')`, [s.claim]];
const activeFacts = (s: Seed): [string, unknown[]] => ['SELECT count(*)::int AS active FROM facts WHERE fact=$1 AND expired_at IS NULL', [s.claim]];
const withdraw = (tx: Exec, s: Seed) => tx.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
  VALUES('default','world','*',gbrain_fact_fingerprint($1))`, [s.claim]);
const purgeFact = (tx: Exec, s: Seed) => tx.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash)
  VALUES('default','world','*',gbrain_fact_fingerprint($1))`, [s.claim]);

interface Guard {
  name: string;
  /** The function whose refusal the hidden-ledger case expects. */
  raiser: string;
  /** Each table, hidden from the scoped role on its own, makes this guard refuse. */
  hidden: string[];
  /** Owner writes inside the probe transaction, before the write under test. */
  seed: (tx: Exec, s: Seed) => Promise<unknown>;
  op: (s: Seed) => [string, unknown[]];
  settings?: Record<string, string>;
  /** Read as the owner after the write. */
  probe: (s: Seed) => [string, unknown[]];
  /** What the guard does: refuse the write, or keep the probed state. */
  guarded: { result: string | RegExp; derived?: Record<string, unknown> };
}

const GUARDS: Guard[] = [
  { name: 'a purged claim inserted as a fact', raiser: 'gbrain_guard_inserted_facts', hidden: ['fact_purges'],
    seed: purgeFact, op: insertFact, probe: activeFacts, guarded: { result: PURGED } },
  { name: 'a fact updated to a purged claim', raiser: 'gbrain_refuse_purged_fact', hidden: ['fact_purges'],
    seed: async (tx, s) => { await tx.executeRaw(insertFact(s)[0], [`Placeholder ${s.claim}`]); await purgeFact(tx, s); },
    op: s => ['UPDATE facts SET fact=$1 WHERE fact=$2', [s.claim, `Placeholder ${s.claim}`]], probe: activeFacts, guarded: { result: PURGED } },
  { name: 'a withdrawn fact saved again as active', raiser: 'gbrain_preserve_fact_withdrawal', hidden: ['fact_withdrawals'],
    seed: withdraw, op: insertFact, probe: activeFacts, guarded: { result: 'ok', derived: { active: 0 } } },
  { name: 'a withdrawn fact saved again by a deferred bulk insert', raiser: 'gbrain_guard_inserted_facts', hidden: ['fact_withdrawals'],
    seed: withdraw, op: insertFact, settings: { [FACT_WITHDRAWAL_STAMP_DEFERRED_SETTING]: 'on' }, probe: activeFacts,
    guarded: { result: 'ok', derived: { active: 0 } } },
  { name: 'a withdrawn fact set active again', raiser: 'gbrain_preserve_fact_withdrawal', hidden: ['fact_withdrawals'],
    seed: async (tx, s) => { await withdraw(tx, s); await tx.executeRaw(insertFact(s)[0], insertFact(s)[1]); },
    op: s => ['UPDATE facts SET expired_at=NULL, valid_until=NULL WHERE fact=$1', [s.claim]], probe: activeFacts,
    guarded: { result: 'ok', derived: { active: 0 } } },
  { name: 'a purged take claim', raiser: 'gbrain_refuse_purged_take', hidden: ['take_purges'],
    seed: (tx, s) => tx.executeRaw(`INSERT INTO take_purges(source_id,subject,claim_hash) VALUES('default','*',gbrain_fact_fingerprint($1))`, [s.claim]),
    op: s => [`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight) VALUES($1,1,$2,'take','brain',0.5)`, [s.pageId, s.claim]],
    probe: s => ['SELECT count(*)::int AS takes FROM takes WHERE page_id=$1', [s.pageId]], guarded: { result: PURGED } },
  { name: 'purged page content', raiser: 'gbrain_refuse_purged_page', hidden: ['page_purges'],
    seed: (tx, s) => tx.executeRaw(`INSERT INTO page_purges(source_id,content_hash,slug) VALUES('default',$1,'notes/purged-example')`, [s.hash]),
    op: s => ['UPDATE pages SET content_hash=$1 WHERE id=$2', [s.hash, s.pageId]],
    probe: s => ['SELECT count(*)::int AS pages FROM pages WHERE content_hash=$1', [s.hash]], guarded: { result: PURGED } },
  { name: 'a derivation holding a purged claim', raiser: 'gbrain_refuse_purging_derivation', hidden: ['page_segment_derivation_purges'],
    seed: (tx, s) => recordDerivationPurge(tx, randomUUID(), 'default', [s.pageId], [s.claim]),
    op: s => [`INSERT INTO page_segment_derivations(page_id,pipeline,occurrence_id,pipeline_version,segment_sha256,context_hash,state,output)
      VALUES($1,'links',1,1,sha256('a'::bytea),sha256('b'::bytea),'done',jsonb_build_object('text',$2::text))`, [s.pageId, s.claim]],
    probe: s => ['SELECT count(*)::int AS derivations FROM page_segment_derivations WHERE page_id=$1', [s.pageId]],
    guarded: { result: 'ok', derived: { derivations: 0 } } },
  { name: 'a page leaving a running derivation sweep unnoted', raiser: 'gbrain_mark_derivation_scope_entry',
    hidden: ['page_segment_derivation_purges', 'page_segment_derivation_purge_pages'],
    seed: (tx, s) => recordDerivationPurge(tx, randomUUID(), 'default', [], [s.claim]),
    op: s => ['UPDATE pages SET deleted_at=now() WHERE id=$1', [s.pageId]],
    probe: s => ['SELECT count(*)::int AS noted FROM page_segment_derivation_purge_pages WHERE page_id=$1', [s.pageId]],
    guarded: { result: 'ok', derived: { noted: 1 } } },
];

interface Outcome { result: string; derived?: Record<string, unknown>; error?: unknown }
/**
 * Runs `before`, seeds the ledger and runs the guarded write in a transaction that always rolls back: the write as `role`
 * when given (with the guard's settings and `scopes`), then the probe as the owner. `result` is 'ok' or the error message.
 */
async function run(engine: BrainEngine, g: Guard, s: Seed, opts: { role?: string; scopes?: string; before?: string } = {}): Promise<Outcome> {
  let derived: Record<string, unknown> | undefined;
  try {
    await engine.transaction(async tx => {
      if (opts.before) await tx.executeRaw(opts.before);
      await g.seed(tx, s);
      if (opts.role) await tx.executeRaw(`SET LOCAL ROLE ${opts.role}`);
      if (opts.scopes) await tx.executeRaw(`SELECT set_config('app.scopes',$1,true)`, [opts.scopes]);
      for (const [key, value] of Object.entries(g.settings ?? {})) await tx.executeRaw('SELECT set_config($1,$2,true)', [key, value]);
      await tx.executeRaw(...g.op(s));
      if (opts.role) await tx.executeRaw('RESET ROLE');
      [derived] = await tx.executeRaw<Record<string, unknown>>(...g.probe(s));
      throw new Error(ROLLBACK);
    });
    return { result: 'unreachable' };
  } catch (error) {
    const message = (error as Error).message;
    return message === ROLLBACK ? { result: 'ok', derived } : { result: message, error };
  }
}

function expectGuarded(outcome: Outcome, g: Guard, label: string) {
  expect({ result: outcome.result, derived: outcome.derived }, label)
    .toEqual({ result: typeof g.guarded.result === 'string' ? g.guarded.result : expect.stringMatching(g.guarded.result), derived: g.guarded.derived });
}

describe('owner behaviour is unchanged', () => {
  for (const g of GUARDS) {
    test(`${g.raiser}: the owner is guarded against ${g.name}`, async () => {
      for (const { name, engine } of engines) expectGuarded(await run(engine, g, await seedPage(engine)), g, `${name} ${g.name}`);
    });
  }
});

/** The SQL between `marker` recipe comments in docs/ENGINES.md, for `role`. */
function docsRecipe(marker: string, role: string): string {
  // test-reads-source-ok[structural]: the operator recipes are applied verbatim, so the documented policies are the tested ones.
  const doc = readFileSync(new URL('../docs/ENGINES.md', import.meta.url), 'utf8');
  const block = new RegExp(`<!-- gbrain:${marker}:begin[^>]*-->\\s*\`\`\`sql\\n([\\s\\S]*?)\`\`\`\\s*<!-- gbrain:${marker}:end -->`).exec(doc);
  if (!block) throw new Error(`docs/ENGINES.md has no ${marker} block`);
  return block[1]!.replaceAll('<writer-role>', role);
}

(backends.includes('postgres') ? describe : describe.skip)('a scoped writer without policies on a guard ledger (Postgres)', () => {
  let engine: BrainEngine;
  let tables: string[] = [];
  const as = { role: SCOPED };
  /** Open policies for the scoped role on every table except `hidden`. */
  async function policies(hidden: string[]) {
    for (const table of tables) {
      await engine.executeRaw(`DROP POLICY IF EXISTS ${SCOPED}_open ON ${table}`);
      if (hidden.includes(table)) continue;
      await engine.executeRaw(`CREATE POLICY ${SCOPED}_open ON ${table} FOR ALL TO ${SCOPED} USING (true) WITH CHECK (true)`);
    }
  }

  beforeAll(async () => {
    engine = engines.find(e => e.name === 'postgres')!.engine;
    for (const role of [SCOPED, BYPASS]) {
      await engine.executeRaw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER ${role === BYPASS ? 'BYPASSRLS' : 'NOBYPASSRLS'}`);
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await engine.executeRaw(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
      await engine.executeRaw(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    }
    for (const table of [...LEDGERS, 'facts', 'takes', 'pages', 'sources', 'page_segment_derivations']) {
      await engine.executeRaw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    }
    tables = (await engine.executeRaw<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map(r => r.t);
    const [effective] = await engine.transaction(async tx => {
      await tx.executeRaw(`SET LOCAL ROLE ${SCOPED}`);
      return tx.executeRaw<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }>(`SELECT rolsuper, rolbypassrls,
        pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.fact_withdrawals'::regclass), 'USAGE') AS owns
        FROM pg_roles WHERE rolname = current_user`);
    });
    expect(effective).toEqual({ rolsuper: false, rolbypassrls: false, owns: false });
  }, 60_000);
  afterAll(async () => {
    if (!engine) return;
    for (const role of [SCOPED, BYPASS]) {
      await engine.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  test('with a policy on every table the scoped role is guarded like the owner', async () => {
    await policies([]);
    for (const g of GUARDS) expectGuarded(await run(engine, g, await seedPage(engine), as), g, g.name);
  });

  for (const g of GUARDS) {
    for (const hidden of g.hidden) {
      test(`${g.raiser}: no policy on ${hidden} refuses ${g.name} instead of passing it`, async () => {
        await policies([hidden]);
        const outcome = await run(engine, g, await seedPage(engine), as);
        expect({ result: outcome.result, derived: outcome.derived }).toEqual({ result: expect.stringMatching(UNREADABLE), derived: undefined });
        expect(databaseRefusal(outcome.error)).toMatchObject({ code: 'writer_coordinator_required',
          detail: { origin: 'database_guard', sqlstate: 'P0001', raiser: g.raiser, relationship: 'unreadable_state', state: hidden } });
        const hint = (outcome.error as { hint?: string }).hint ?? '';
        expect(hint).toContain(`a policy on ${hidden} allowing`);
        expect(hint).toContain('docs/ENGINES.md#purge-and-withdrawal-guards');
      });
    }
  }

  test('a policy for another role does not count as the caller\'s', async () => {
    const g = GUARDS[2]!;
    await policies(['fact_withdrawals']);
    await engine.executeRaw(`CREATE POLICY ${SCOPED}_other ON fact_withdrawals FOR SELECT TO ${BYPASS} USING (true)`);
    try {
      expect((await run(engine, g, await seedPage(engine), as)).result).toMatch(UNREADABLE);
    } finally {
      await engine.executeRaw(`DROP POLICY ${SCOPED}_other ON fact_withdrawals`);
    }
  });

  test('a writer that may only insert facts is refused only when a withdrawal matches a fact it inserts', async () => {
    await policies(['facts']);
    await engine.executeRaw(`CREATE POLICY ${SCOPED}_read ON facts FOR SELECT TO ${SCOPED} USING (true)`);
    await engine.executeRaw(`CREATE POLICY ${SCOPED}_insert ON facts FOR INSERT TO ${SCOPED} WITH CHECK (true)`);
    const unrelated = (g: Guard): Guard => ({ ...g, seed: (tx, s) => withdraw(tx, { ...s, claim: `Other ${s.claim}` }) });
    try {
      for (const g of [GUARDS[2]!, GUARDS[3]!]) {
        expect(await run(engine, unrelated(g), await seedPage(engine), as), g.name).toEqual({ result: 'ok', derived: { active: 1 } });
      }
      expect((await run(engine, GUARDS[3]!, await seedPage(engine), as)).result).toMatch(UNREADABLE);
    } finally {
      for (const name of ['read', 'insert']) await engine.executeRaw(`DROP POLICY ${SCOPED}_${name} ON facts`);
    }
  });

  test('a ledger without row-level security guards the scoped role with no policy on it', async () => {
    for (const g of GUARDS) {
      await policies(g.hidden);
      const off = g.hidden.map(t => `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`).join('; ');
      expectGuarded(await run(engine, g, await seedPage(engine), { ...as, before: off }), g, g.name);
    }
  });

  test('a role that bypasses RLS is guarded with no policies at all', async () => {
    for (const table of tables) await engine.executeRaw(`DROP POLICY IF EXISTS ${SCOPED}_open ON ${table}`);
    for (const g of GUARDS) expectGuarded(await run(engine, g, await seedPage(engine), { role: BYPASS }), g, g.name);
  });

  test('the docs/ENGINES.md maintainer and ledger recipes, applied verbatim, guard a scoped writer like the owner', async () => {
    const recipe = [docsRecipe('maintainer-rls-recipe', SCOPED), docsRecipe('ledger-rls-recipe', SCOPED)].join('\n');
    const created = [...recipe.matchAll(/CREATE POLICY (\w+) ON (\w+)/g)].map(match => ({ name: match[1]!, table: match[2]! }));
    expect(created.filter(p => LEDGERS.includes(p.table)).map(p => p.table).sort()).toEqual([...LEDGERS].sort());
    await policies([...new Set(created.map(p => p.table))]);
    await engine.executeRaw(recipe);
    try {
      for (const g of GUARDS) expectGuarded(await run(engine, g, await seedPage(engine), { ...as, scopes: 'default' }), g, g.name);
    } finally {
      for (const p of created) await engine.executeRaw(`DROP POLICY IF EXISTS ${p.name} ON ${p.table}`);
    }
  });

  // From before v277 (whose search_path hardening now re-creates guards missing their check), from v283 and from v317.
  for (const from of [276, 283, migration.version - 1]) test(`an upgraded brain at v${from} ends with every guard failing closed`, async () => {
    for (const fn of GUARD_FUNCTIONS) {
      await engine.executeRaw(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql
        SET search_path = pg_catalog, public, pg_temp AS $fn$ BEGIN RETURN ${fn === 'gbrain_guard_inserted_facts' || fn === 'gbrain_mark_derivation_scope_entry' ? 'NULL' : 'NEW'}; END $fn$`);
    }
    await engine.setConfig('version', String(from));
    await runMigrations(engine);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    const rows = await engine.executeRaw<{ proname: string; definer: boolean; path: string[]; checks: string[] }>(`SELECT p.proname, p.prosecdef AS definer,
        p.proconfig AS path, ARRAY(SELECT DISTINCT m[1] FROM regexp_matches(p.prosrc, 'row_security_active\\(''(\\w+)''\\)', 'g') AS m ORDER BY 1) AS checks
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`, [GUARD_FUNCTIONS]);
    const path = ['search_path=pg_catalog, public, pg_temp'];
    expect(rows).toEqual([
      { proname: 'gbrain_guard_inserted_facts', definer: false, path, checks: ['fact_purges', 'fact_withdrawals', 'facts'] },
      { proname: 'gbrain_mark_derivation_scope_entry', definer: false, path, checks: ['page_segment_derivation_purge_pages', 'page_segment_derivation_purges'] },
      { proname: 'gbrain_preserve_fact_withdrawal', definer: false, path, checks: ['fact_withdrawals'] },
      { proname: 'gbrain_refuse_purged_fact', definer: false, path, checks: ['fact_purges'] },
      { proname: 'gbrain_refuse_purged_page', definer: false, path, checks: ['page_purges'] },
      { proname: 'gbrain_refuse_purged_take', definer: false, path, checks: ['pages', 'take_purges'] },
      { proname: 'gbrain_refuse_purging_derivation', definer: false, path, checks: ['page_segment_derivation_purges', 'pages'] },
    ]);
    for (const g of GUARDS) {
      await policies([g.hidden[0]!]);
      expect((await run(engine, g, await seedPage(engine), as)).result, g.name).toMatch(UNREADABLE);
    }
  }, 120_000);

  test('a guard another role owns is left and named, and the next migration run of a role that owns it fails it closed', async () => {
    const closed = async (tx: Exec) => (await tx.executeRaw<{ closed: boolean }>(
      "SELECT strpos(prosrc, 'row_security_active(''fact_purges'')') > 0 AS closed FROM pg_proc WHERE proname = 'gbrain_refuse_purged_fact'"))[0]!.closed;
    try {
      await engine.transaction(async tx => {
        await tx.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_refuse_purged_fact() RETURNS trigger LANGUAGE plpgsql
          SET search_path = pg_catalog, public, pg_temp AS $fn$ BEGIN RETURN NEW; END $fn$`);
        await tx.executeRaw(`SET LOCAL ROLE ${SCOPED}`);
        expect(await failClosedLedgerGuards(tx)).toEqual({ left: ['gbrain_refuse_purged_fact()'], role: SCOPED });
        expect(await closed(tx)).toBe(false);
        await tx.executeRaw('RESET ROLE');
        expect((await failClosedLedgerGuards(tx)).left).toEqual([]);
        expect(await closed(tx)).toBe(true);
        throw new Error(ROLLBACK);
      });
    } catch (error) {
      if ((error as Error).message !== ROLLBACK) throw error;
    }
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_refuse_purged_fact() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $fn$ BEGIN RETURN NEW; END $fn$`);
    expect((await runMigrations(engine)).applied).toBe(0);
    expect(await closed(engine)).toBe(true);
  });
});
