/**
 * `gbrain trust backfill` and doctor `trust_tiers` (#5575: A8, CEO-10, CEO-17,
 * CEO-25, DX-5).
 *
 * Protects: legacy rows are classified from deterministic signals only
 * (connector source, pages.source_kind, transcript/extraction/dream
 * provenance, facts and takes source tags, the page a row lives on, and the
 * journaled request through write_request_id, one class per operation),
 * rows with no signal stay unknown and nothing becomes user_confirmed; the dry
 * run is strictly read-only, matches what an apply writes, reports counts by
 * table x tier and the share at agent_written or below, and works on a schema
 * without the trust columns; an apply resumes from its op_checkpoints cursor
 * and runs inside the coordinator on a managed brain; doctor warns with a
 * `run` fix until a backfill completes. Fails if a signal maps to the wrong
 * tier, a dry run writes anything, or the doctor fix stops naming the command.
 * Runs on PGLite, and on Postgres through test/e2e/trust-backfill-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { readTrustBackfillState, runTrustBackfill, TRUST_BACKFILL_COMPLETED_KEY } from '../src/core/trust/backfill.ts';
import { withWriteAttribution } from '../src/core/persistence/context.ts';
import { trustTiersEntry } from '../src/commands/doctor/checks/trust-tiers.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { renderAction } from '../src/core/agent-output.ts';

interface Backend { name: string; engine: BrainEngine; close: () => Promise<void> }
const backends: Backend[] = [];
beforeAll(async () => {
  for (const name of testBackends()) {
    if (name === 'pglite') {
      const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
      backends.push({ name, engine, close: () => engine.disconnect() });
    } else {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      backends.push({ name, engine: pg.engine, close: pg.close });
    }
  }
}, 180_000);
afterAll(async () => { for (const b of backends) await b.close(); });

const quiet = () => {};
const REQUEST = `principal_kind, principal_id, request_id, operation, source_id, source_incarnation, slug, digest, authority, intent,
  intent_bytes, terminal_reservation, state, outcome`;

/** Fresh fixture rows (all `unknown`): one per signal class, in a source of their own, plus a connector source. */
async function seed(engine: BrainEngine) {
  const tag = randomUUID().slice(0, 8);
  const src = `bf-${tag}`, connector = `bf-gh-${tag}`;
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES($1,$1)`, [src]);
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"kind":"github"}'::jsonb)`, [connector]);
  const pages: Record<string, number> = {};
  const addPage = async (key: string, source: string, sourceKind: string | null, frontmatter: Record<string, unknown> = {}) => {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(slug,type,title,compiled_truth,source_id,source_kind,frontmatter)
      VALUES($1,'note','T','body',$2,$3,$4::text::jsonb) RETURNING id`, [`p/${key}`, source, sourceKind, JSON.stringify(frontmatter)]);
    pages[key] = Number(row!.id);
  };
  await addPage('webhook', src, 'webhook');
  await addPage('mcp', src, 'mcp:put_page');
  await addPage('dream', src, null, { dream_generated: true });
  await addPage('transcript', src, null, { transcript_import: { harness: 'codex', session_id: 's1' } });
  await addPage('extracted', src, null, { provenance: 'auto-extracted' });
  await addPage('plain', src, null);
  await addPage('connector', connector, null);

  const [incarnation] = await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [src]);
  const request = async (operation: string, intent: Record<string, unknown> | null, remote: boolean) => {
    const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_requests (${REQUEST})
      VALUES('local_cli','cli:example',gen_random_uuid(),$1,$2,$3::uuid,'p/x','d',$4::text::jsonb,$5::text::jsonb,1,16384,'committed','{}'::jsonb) RETURNING id::text AS id`,
    [operation, src, incarnation!.i, JSON.stringify({ version: 1, remote, sourceId: src }), intent === null ? null : JSON.stringify(intent)]);
    return row!.id;
  };
  const facts: Record<string, number> = {};
  const addFact = async (key: string, opts: { source?: string; fenced?: string; requestId?: string; sourceId?: string } = {}) => {
    const insert = (db: BrainEngine) => db.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,kind,source,source_markdown_slug,row_num)
      VALUES($1,'e',$2,'fact',$3,$4,$5) RETURNING id`, [opts.sourceId ?? src, `claim ${key}`, opts.source ?? 'manual', opts.fenced ?? null, opts.fenced ? 1 : null]);
    const rows = opts.requestId
      ? await engine.transaction(tx => withWriteAttribution(tx, { requestId: opts.requestId!, principal: { kind: 'local_cli', id: 'cli:example' } }, () => insert(tx)))
      : await insert(engine);
    facts[key] = Number(rows[0]!.id);
  };
  await addFact('sync_request', { requestId: await request('submit_job', { kind: 'managed_sync_import' }, false) });
  await addFact('put_page_request', { requestId: await request('put_page', {}, false) });
  await addFact('remote_request', { requestId: await request('remember', {}, true) });
  await addFact('connector_request', { requestId: await request('submit_job', { kind: 'connector_v2_items' }, false) });
  await addFact('other_request', { requestId: await request('loops_close', { kind: 'retire_loop_fact' }, false) });
  await addFact('compacted_request', { requestId: await request('put_page', null, false) });
  await addFact('lane', { source: 'hook:writeback' });
  await addFact('fenced_external', { fenced: 'p/webhook' });
  await addFact('plain');
  await addFact('connector', { sourceId: connector });
  const [take] = await engine.executeRaw<{ id: number }>(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight,source) VALUES($1,1,'c','take','world',0.5,'take_proposals#7') RETURNING id`, [pages.plain]);
  const [entry] = await engine.executeRaw<{ id: number }>(`INSERT INTO timeline_entries(page_id,date,summary,detail,source) VALUES($1,'2026-01-01','s','d','x') RETURNING id`, [pages.webhook]);
  return { src, connector, pages, facts, take: Number(take!.id), entry: Number(entry!.id) };
}
type Fixture = Awaited<ReturnType<typeof seed>>;
const EXPECTED_PAGES = { webhook: 'external_untrusted', mcp: 'agent_written', dream: 'agent_written', transcript: 'agent_written', extracted: 'agent_written', plain: 'unknown', connector: 'external_untrusted' };
const EXPECTED_FACTS = {
  sync_request: 'operator_curated', put_page_request: 'agent_written', remote_request: 'agent_written', connector_request: 'external_untrusted',
  other_request: 'unknown', compacted_request: 'unknown', lane: 'agent_written', fenced_external: 'external_untrusted', plain: 'unknown', connector: 'external_untrusted',
};
async function tiers(engine: BrainEngine, f: Fixture) {
  const read = async (table: string, ids: Record<string, number>) => {
    const rows = await engine.executeRaw<{ id: number; t: string }>(`SELECT id, trust_tier AS t FROM ${table} WHERE id = ANY($1::bigint[])`, [Object.values(ids)]);
    const byId = new Map(rows.map(r => [Number(r.id), r.t]));
    return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, byId.get(id)]));
  };
  return { pages: await read('pages', f.pages), facts: await read('facts', f.facts), take: (await read('takes', { t: f.take })).t, entry: (await read('timeline_entries', { e: f.entry })).e };
}
/** Everything a dry run could have written: tiers, origins, checkpoints and config. */
async function writableState(engine: BrainEngine) {
  const [row] = await engine.executeRaw<{ s: string }>(`SELECT md5(concat(
    (SELECT string_agg(id || trust_tier || COALESCE(write_origin::text,''), ',' ORDER BY id) FROM pages),
    (SELECT string_agg(id || trust_tier || COALESCE(write_origin::text,''), ',' ORDER BY id) FROM facts),
    (SELECT string_agg(id || trust_tier, ',' ORDER BY id) FROM takes),
    (SELECT string_agg(id || trust_tier, ',' ORDER BY id) FROM timeline_entries),
    (SELECT string_agg(op || fingerprint || completed_keys::text, ',' ORDER BY op, fingerprint) FROM op_checkpoints),
    (SELECT string_agg(key || value, ',' ORDER BY key) FROM config))) AS s`);
  return row!.s;
}
const resetTrust = (engine: BrainEngine) => engine.transaction(async tx => {
  await tx.executeRaw('SET LOCAL session_replication_role = replica');
  for (const table of ['pages', 'facts', 'takes', 'timeline_entries']) await tx.executeRaw(`UPDATE ${table} SET trust_tier='unknown', write_origin=NULL`);
  await tx.executeRaw(`DELETE FROM op_checkpoints WHERE op='trust-backfill'`);
  await tx.executeRaw(`DELETE FROM config WHERE key=$1`, [TRUST_BACKFILL_COMPLETED_KEY]);
});
const doctor = async (engine: BrainEngine) => (await trustTiersEntry.run({ engine } as unknown as DoctorContext) as Check[])[0]!;

for (const backendName of testBackends()) {
  const engineOf = () => backends.find(b => b.name === backendName)!.engine;

  describe(`trust backfill (${backendName})`, () => {
    test('classifies each signal class; the read-only dry run projects exactly what the apply writes', async () => {
      const engine = engineOf();
      await resetTrust(engine);
      const f = await seed(engine);
      const before = await writableState(engine);
      const preview = await runTrustBackfill(engine, { dryRun: true, batchSize: 3 });
      expect(await writableState(engine)).toBe(before);
      expect(preview).toMatchObject({ mode: 'dry_run', schema: 'trust_columns', status: 'complete' });
      expect(preview.tables.map(t => t.table)).toEqual(['pages', 'facts', 'takes', 'timeline_entries']);
      expect(preview.projected.user_confirmed).toBe(0);
      expect(preview.signals).toEqual(expect.arrayContaining(['connector_source', 'pages_source_kind', 'frontmatter_provenance', 'facts_source_lane', 'write_request']));

      const doc = await doctor(engine);
      expect(doc.status).toBe('warn');
      const fix = renderAction(doc.fix!, { transport: 'cli', isCallable: () => false, preapproved: () => true });
      expect({ next: fix.next, argv: fix.argv }).toEqual({ next: 'run', argv: ['gbrain', 'trust', 'backfill'] });

      const applied = await runTrustBackfill(engine, { log: quiet, batchSize: 4 });
      expect(await tiers(engine, f)).toEqual({ pages: EXPECTED_PAGES, facts: EXPECTED_FACTS, take: 'agent_written', entry: 'external_untrusted' });
      for (const t of applied.tables) expect({ table: t.table, counts: t.projected }).toEqual({ table: t.table, counts: preview.tables.find(p => p.table === t.table)!.projected });
      const low = preview.projected.agent_written + preview.projected.unknown + preview.projected.external_untrusted;
      expect(preview.at_or_below_agent_written).toBe(low);
      expect(preview.at_or_below_agent_written_pct).toBe(Math.round((low / preview.rows) * 10_000) / 100);
      const [origin] = await engine.executeRaw<{ o: unknown }>('SELECT write_origin AS o FROM pages WHERE id=$1', [f.pages.webhook]);
      expect(origin!.o).toEqual({ channel: 'trust_backfill' });
      expect((await doctor(engine)).status).toBe('ok');
      expect(await runTrustBackfill(engine, { log: quiet })).toMatchObject({ tables: expect.arrayContaining([expect.objectContaining({ table: 'facts', updated: 0 })]) });
      const chunkColumns = await engine.executeRaw(`SELECT 1 FROM information_schema.columns WHERE table_name='content_chunks' AND column_name='trust_tier'`);
      expect(chunkColumns).toHaveLength(0);
    });

    test('--resume continues from the stored cursor; without it every unknown row is scanned', async () => {
      const engine = engineOf();
      await resetTrust(engine);
      const f = await seed(engine);
      const cursor = Math.max(...Object.values(f.pages));
      await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('trust-backfill','v1',$1::text::jsonb)`, [JSON.stringify([{ pages: cursor }])]);
      expect(await readTrustBackfillState(engine)).toMatchObject({ interrupted: true });
      const doc = await doctor(engine);
      expect(renderAction(doc.fix!, { transport: 'cli', isCallable: () => false, preapproved: () => true }).argv).toEqual(['gbrain', 'trust', 'backfill', '--resume']);
      await runTrustBackfill(engine, { resume: true, log: quiet });
      expect((await tiers(engine, f)).pages.webhook).toBe('unknown');
      expect((await tiers(engine, f)).facts.lane).toBe('agent_written');
      expect(await readTrustBackfillState(engine)).toMatchObject({ interrupted: false });
      await runTrustBackfill(engine, { log: quiet });
      expect((await tiers(engine, f)).pages.webhook).toBe('external_untrusted');
    });

    test('runs inside the coordinator on a managed brain', async () => {
      const engine = engineOf();
      await resetTrust(engine);
      const f = await seed(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await expect(engine.executeRaw(`UPDATE pages SET trust_tier='external_untrusted' WHERE id=$1`, [f.pages.webhook])).rejects.toThrow(/writer_coordinator_required/);
        await runTrustBackfill(engine, { log: quiet, batchSize: 2 });
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
      expect(await tiers(engine, f)).toMatchObject({ pages: EXPECTED_PAGES, facts: EXPECTED_FACTS });
    });
  });
}

describe('trust backfill dry run before the trust migration', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('classifies from existing columns only and writes nothing', async () => {
    const f = await seed(engine);
    for (const table of ['facts', 'takes', 'timeline_entries', 'pages']) await engine.executeRaw(`ALTER TABLE ${table} DROP COLUMN trust_tier CASCADE, DROP COLUMN write_origin`);
    const [before] = await engine.executeRaw<{ n: number }>(`SELECT (SELECT count(*) FROM op_checkpoints) + (SELECT count(*) FROM config) AS n`);
    const report = await runTrustBackfill(engine, { dryRun: true });
    const [after] = await engine.executeRaw<{ n: number }>(`SELECT (SELECT count(*) FROM op_checkpoints) + (SELECT count(*) FROM config) AS n`);
    expect(Number(after!.n)).toBe(Number(before!.n));
    expect(report.schema).toBe('pre_trust');
    expect(report.tables.every(t => t.current === undefined)).toBe(true);
    expect(report.projected).toEqual({ user_confirmed: 0, operator_curated: 1, tool_observed: 0, agent_written: 8, unknown: 4, external_untrusted: 6 });
    expect(report.rows).toBe(Object.keys(f.pages).length + Object.keys(f.facts).length + 2);
    expect((await doctor(engine)).details).toEqual({ schema: 'pre_trust' });
    await expect(runTrustBackfill(engine, { log: quiet })).rejects.toMatchObject({ code: 'migrations_pending' });
  });
});
