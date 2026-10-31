/**
 * #7777: the persistence protocol guards (shared-skills/persistence-schema.ts) raise SQLSTATE 42501 with a fixed
 * `<code>: <diagnostic>` message. 42501 is also ordinary permission denial, so `databaseRefusal` left them unclassified
 * and a refusal during publication was stored as an unexpected owner exception (`storage_error`) whose hint says its
 * cause is unknown. Contract: a 42501 is typed only when the innermost PL/pgSQL frame is a known protocol guard and the
 * message is one of that guard's own diagnostics, verbatim; the receipt, `writeResponse` and writer status then carry
 * the guard's remedy. Anything else at 42501 stays unclassified.
 * Runs on PGLite, and on an isolated Postgres database through test/e2e/protocol-guard-refusal-7777-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, receiptFor } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { databaseRefusal } from '../src/core/persistence/publication-failure.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';
import { writeResponse } from '../src/core/persistence/service.ts';
import { DATABASE_REFUSAL_HINT } from '../src/core/persistence/connector-errors.ts';
import {
  EFFECT_PROTOCOL_GUARD_SQL, PROTOCOL_ACTIVATION_GUARD_SQL, REQUEST_PROTOCOL_GUARD_SQL, SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS,
} from '../src/core/shared-skills/persistence-schema.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'source-a';
const hostId = randomUUID();
const ROLLBACK = 'protocol-probe-rollback';
const NO_PROTOCOL = "SELECT set_config('gbrain.persistence_protocol','',true)";
const QUIESCED = "SELECT set_config('gbrain.persistence_protocol','2',true),set_config('gbrain.writer_quiesced','true',true)";

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
    await registerLocalWriter(engine, 'cli');
  }
}, 180_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

/** Replaces the singleton (the activation guard forbids lowering the floor by UPDATE), keeping its other columns. */
async function singleton(engine: BrainEngine, enabled: boolean, floor: 1 | 2) {
  await engine.executeRaw(`WITH old AS (DELETE FROM persistence_brain WHERE singleton = 1 RETURNING *)
    INSERT INTO persistence_brain SELECT (jsonb_populate_record(NULL::persistence_brain, to_jsonb(old)
      || jsonb_build_object('enabled', $1::boolean, 'writer_protocol_floor', $2::int, 'skill_bundles_enabled', false))).* FROM old`, [enabled, floor]);
}

type Statement = string | [string, unknown[]];
/** Runs the statements in a transaction that always rolls back and returns what it threw. */
async function refusal(engine: BrainEngine, statements: Statement[]): Promise<unknown> {
  try {
    await engine.transaction(async tx => {
      for (const statement of statements) await (typeof statement === 'string' ? tx.executeRaw(statement) : tx.executeRaw(...statement));
      throw new Error(ROLLBACK);
    });
  } catch (error) { return error; }
  return null;
}

const ctx = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind }, sourceId, remote: false,
  dryRun: false, logger: { info() {}, warn() {}, error() {} } });
const input = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
async function claimed(engine: BrainEngine, slug: string) {
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const authority = await submissionAuthority(ctx(engine), 'put_page', sourceId, source!.incarnation, slug);
  await admitWrite(engine, { principal: authority.principal, operation: 'put_page', sourceId, sourceIncarnation: source!.incarnation, slug,
    pageId: null, requestId: randomUUID(), callerIntent: { content: slug }, intent: { content: slug }, authority });
  return (await claimNextWrite(engine, hostId))!;
}
function refusedResponse(row: Parameters<typeof writeResponse>[0]): Record<string, unknown> {
  try { writeResponse(row); } catch (error) { return error as Record<string, unknown>; }
  throw new Error('expected writeResponse to refuse');
}

for (const backend of backends) describe(`${backend}: protocol guard refusals during publication (#7777)`, () => {
  const engine = () => engines.find(e => e.kind === backend)!;

  test('a writer without protocol 2 on a floor-2 brain fails writer_upgrade_required with the upgrade remedy', async () => {
    const db = engine();
    await singleton(db, true, 2);
    try {
      const slug = `notes/protocol-floor-${backend}`;
      const row = await claimed(db, slug);
      const done = await publishMutation(db, row, { observedRevision: null, apply: async tx => {
        await tx.putPage(slug, input('must roll back'), { sourceId });
        // An older gbrain declares no protocol: the request guard calls gbrain_require_persistence_protocol, which raises.
        await tx.executeRaw(NO_PROTOCOL);
        await tx.executeRaw('UPDATE persistence_requests SET updated_at=now() WHERE id=$1::uuid', [row.id]);
        return { status: 'created' };
      } }, hostId);

      expect(done.state).toBe('failed');
      expect(done.error_code).toBe('writer_upgrade_required');
      expect(done.error_message).toBe('The persistence protocol guard (gbrain_require_persistence_protocol) refused this write: this mutation requires persistence protocol 2. Nothing was committed.');
      expect(done.error_detail).toMatchObject({ origin: 'database_guard', sqlstate: '42501', raiser: 'gbrain_require_persistence_protocol', stage: 'publication' });
      expect(await db.readPageSnapshot(slug, { sourceId })).toBeNull();
      expect((receiptFor(done) as Record<string, unknown>).write_error_detail)
        .toEqual({ origin: 'database_guard', sqlstate: '42501', raiser: 'gbrain_require_persistence_protocol', stage: 'publication' });

      const refused = refusedResponse(done);
      expect(refused).toMatchObject({ code: 'writer_upgrade_required', detail: 'database_guard', docs: 'docs/guides/write-refusals.md#protocol-guard' });
      expect(refused.suggestion).toContain('does not declare the persistence protocol this brain requires');
      expect(refused.suggestion).toContain('Never lower the protocol floor');
      const failure = (await readWriterDiagnostics(db)).recent_failures.find(f => f.request_id === done.request_id)!;
      expect(failure.next_action).toBe(refused.suggestion as string);
    } finally {
      await singleton(db, false, 1);
    }
  });

  test('writer state the role cannot read fails writer_coordinator_required (unreadable_state) with the role remedy', async () => {
    const db = engine();
    await singleton(db, true, 1);
    try {
      const slug = `notes/protocol-unreadable-${backend}`;
      const row = await claimed(db, slug);
      const done = await publishMutation(db, row, { observedRevision: null, apply: async tx => {
        await tx.putPage(slug, input('must roll back'), { sourceId });
        // The request guard reads persistence_brain as the writing role; a missing row is what row-level security shows it.
        await tx.executeRaw('DELETE FROM persistence_brain WHERE singleton=1');
        await tx.executeRaw('UPDATE persistence_requests SET updated_at=now() WHERE id=$1::uuid', [row.id]);
        return { status: 'created' };
      } }, hostId);

      expect(done.state).toBe('failed');
      expect(done.error_code).toBe('writer_coordinator_required');
      expect(done.error_detail).toMatchObject({ origin: 'database_guard', sqlstate: '42501', raiser: 'gbrain_guard_request_protocol',
        branch: 'unreadable_state', relationship: 'unreadable_state', stage: 'publication' });
      expect(await db.readPageSnapshot(slug, { sourceId })).toBeNull();
      expect(await db.executeRaw('SELECT count(*)::int AS n FROM persistence_brain')).toEqual([{ n: 1 }]);

      const refused = refusedResponse(done);
      expect(refused).toMatchObject({ code: 'writer_coordinator_required', detail: 'database_guard' });
      expect(refused.suggestion).not.toBe(DATABASE_REFUSAL_HINT);
      expect(refused).toMatchObject({ docs: 'docs/guides/write-refusals.md#protocol-guard' });
      expect(refused.suggestion).toContain('cannot fully read the writer state the guard checks');
      expect(done.error_detail).toMatchObject({ state: 'persistence_brain' });
      const failure = (await readWriterDiagnostics(db)).recent_failures.find(f => f.request_id === done.request_id)!;
      expect(failure.next_action).toBe(refused.suggestion as string);
    } finally {
      await singleton(db, false, 1);
    }
  });

  test('real guard raises outside publication map to their own typed codes', async () => {
    const db = engine();
    const [request] = await db.executeRaw<{ id: string }>(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,
        source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation)
      SELECT 'application','protocol-7777',gen_random_uuid(),'put_page',id,incarnation,'notes/protocol-7777','digest','{}'::jsonb,0,0
      FROM sources WHERE id=$1 RETURNING id::text AS id`, [sourceId]);
    const on = (sql: string): Statement => [sql, [request!.id]];
    const cases: Array<{ statements: Statement[]; code: string; raiser: string; unreadable?: boolean }> = [
      { statements: [NO_PROTOCOL, on("UPDATE persistence_requests SET target_kind='skill_bundle' WHERE id=$1::uuid")],
        code: 'writer_upgrade_required', raiser: 'gbrain_require_persistence_protocol' },
      { statements: [QUIESCED, on("UPDATE persistence_requests SET target_kind='skill_bundle' WHERE id=$1::uuid")],
        code: 'unsupported_mutation_protocol', raiser: 'gbrain_guard_request_protocol' },
      { statements: ['DELETE FROM persistence_brain WHERE singleton=1', on('UPDATE persistence_requests SET updated_at=now() WHERE id=$1::uuid')],
        code: 'writer_coordinator_required', raiser: 'gbrain_guard_request_protocol', unreadable: true },
      { statements: ['DELETE FROM persistence_brain WHERE singleton=1', on("INSERT INTO persistence_effects(request_id,kind,data) VALUES($1::uuid,'embedding','{}'::jsonb)")],
        code: 'writer_coordinator_required', raiser: 'gbrain_guard_effect_protocol', unreadable: true },
      { statements: [QUIESCED, 'UPDATE persistence_brain SET writer_protocol_floor=2 WHERE singleton=1'],
        code: 'writer_not_quiesced', raiser: 'gbrain_guard_protocol_activation' },
    ];
    try {
      for (const probe of cases) {
        const error = await refusal(db, probe.statements);
        expect((error as { code?: unknown }).code, probe.raiser).toBe('42501');
        expect(databaseRefusal(error), probe.raiser).toEqual({ code: probe.code,
          message: expect.stringMatching(new RegExp(`^The persistence protocol guard \\(${probe.raiser}\\) refused this write: .+\\. Nothing was committed\\.$`)),
          detail: { origin: 'database_guard', sqlstate: '42501', raiser: probe.raiser,
            ...(probe.unreadable ? { branch: 'unreadable_state', relationship: 'unreadable_state', state: 'persistence_brain' } : {}) } });
      }
      await singleton(db, false, 2);
      const lowered = await refusal(db, ['UPDATE persistence_brain SET writer_protocol_floor=1 WHERE singleton=1']);
      expect(databaseRefusal(lowered)).toMatchObject({ code: 'writer_upgrade_required', detail: { raiser: 'gbrain_guard_protocol_activation' } });
    } finally {
      await singleton(db, false, 1);
      await db.executeRaw('DELETE FROM persistence_requests WHERE id=$1::uuid', [request!.id]);
    }
  });
});

const GUARD_SQL = [REQUEST_PROTOCOL_GUARD_SQL, EFFECT_PROTOCOL_GUARD_SQL, PROTOCOL_ACTIVATION_GUARD_SQL, ...SHARED_SKILLS_PERSISTENCE_SCHEMA_STATEMENTS];
/** Every 42501 diagnostic the guard functions raise, paired with the function that raises it. */
const DIAGNOSTICS: Array<[string, string]> = [...new Set(GUARD_SQL.flatMap(sql => {
  const raiser = /^CREATE OR REPLACE FUNCTION ([a-z_]+)\(/.exec(sql)?.[1];
  return raiser ? [...sql.matchAll(/RAISE EXCEPTION '([^']+)' USING ERRCODE='42501'/g)].map(m => `${raiser}\t${m[1]}`) : [];
}))].map(entry => entry.split('\t') as [string, string]);
const raised = (message: string, where: string, code = '42501') => Object.assign(new Error(message), { code, where, routine: 'exec_stmt_raise' });
const frame = (fn: string) => `PL/pgSQL function ${fn}() line 3 at RAISE`;

describe('protocol guard classification is closed (#7777)', () => {
  test('every 42501 diagnostic a protocol guard raises is typed by its own code', () => {
    expect(new Set(DIAGNOSTICS.map(([raiser]) => raiser))).toEqual(new Set(['gbrain_guard_request_protocol', 'gbrain_guard_effect_protocol',
      'gbrain_guard_protocol_activation', 'gbrain_require_persistence_protocol', 'gbrain_guard_skill_publication']));
    expect(DIAGNOSTICS.length).toBe(15);
    for (const [raiser, message] of DIAGNOSTICS) {
      const failure = databaseRefusal(raised(message, frame(raiser)));
      expect(failure?.code, message).toBe(message.slice(0, message.indexOf(':')));
      expect(failure?.detail, message).toMatchObject({ origin: 'database_guard', sqlstate: '42501', raiser });
    }
  });

  test('ordinary permission denial, unknown raisers, mismatched pairs and altered text stay unclassified', () => {
    const unreadable = 'writer_coordinator_required: writer state is unreadable to this database role';
    for (const error of [
      Object.assign(new Error('permission denied for table pages'), { code: '42501' }),
      raised('permission denied for table pages', ''),
      raised(unreadable, ''),
      raised(unreadable, frame('operator_hook')),
      raised(unreadable, `${frame('operator_hook')}\nSQL statement "SELECT operator_hook()"\n${frame('gbrain_guard_request_protocol')}`),
      raised(unreadable, frame('gbrain_require_persistence_protocol')),
      raised(`${unreadable} for alice-example`, frame('gbrain_guard_request_protocol')),
      raised('writer_upgrade_required: acme-example', frame('gbrain_guard_request_protocol')),
      raised(unreadable, frame('constructor')),
    ]) expect(databaseRefusal(error)).toBeNull();
    expect(databaseRefusal(raised(unreadable, frame('gbrain_guard_request_protocol'), '23505'))).toBeNull();
  });
});
