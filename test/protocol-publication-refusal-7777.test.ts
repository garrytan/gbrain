/** #7777: real protocol-fence errors must survive as bounded typed refusals, not opaque storage errors. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { databaseRefusal, publicFailureDetail } from '../src/core/persistence/publication-failure.ts';
import { receiptDeliveredHint } from '../src/core/persistence/connector-errors.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 180_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

async function refused(engine: BrainEngine, statements: string[]): Promise<unknown> {
  try {
    await engine.transaction(async tx => {
      for (const statement of statements) await tx.executeRaw(statement);
      throw new Error('expected protocol refusal');
    });
  } catch (error) { return error; }
}
const request = `INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation)
  SELECT 'application','protocol-test',gen_random_uuid(),'put_page','default',incarnation,'notes/protocol-test','digest','{}'::jsonb,0,0 FROM sources WHERE id='default'`;

for (const backend of backends) describe(`${backend}: real protocol guard diagnostics`, () => {
  const engine = () => engines.find(e => e.kind === backend)!;
  test('nested protocol helper identifies an upgrade, not generic permission denial', async () => {
    const error = await refused(engine(), ["SELECT set_config('gbrain.persistence_protocol','',true)", 'SELECT gbrain_require_persistence_protocol(2)']);
    expect(error).toMatchObject({ code: '42501' });
    const failure = databaseRefusal(error)!;
    expect(failure).toMatchObject({ code: 'writer_upgrade_required', detail: { sqlstate: '42501', raiser: 'gbrain_require_persistence_protocol', origin: 'database_guard' } });
    expect(failure.message).toContain('protocol 2');
    const hint = receiptDeliveredHint({ error_code: failure.code, error_detail: { ...failure.detail } });
    expect(hint?.suggestion).toContain('upgrade');
  });
  test('missing singleton on request and effect guards identifies unreadable state', async () => {
    for (const target of ['request', 'effect']) {
      const error = await refused(engine(), [request, 'DELETE FROM persistence_brain WHERE singleton=1', target === 'request'
        ? "UPDATE persistence_requests SET updated_at=now() WHERE principal_id='protocol-test'"
        : `INSERT INTO persistence_effects(request_id,kind,data) SELECT id,'embedding','{}'::jsonb FROM persistence_requests WHERE principal_id='protocol-test'`]);
      expect(error).toMatchObject({ code: '42501' });
      const failure = databaseRefusal(error)!;
      expect(failure).toMatchObject({ code: 'writer_coordinator_required', detail: { sqlstate: '42501', raiser: `gbrain_guard_${target}_protocol`, branch: 'unreadable_state', relationship: 'unreadable_state' } });
      expect(failure.message).toContain('unreadable');
      expect(receiptDeliveredHint({ error_code: failure.code, error_detail: { ...failure.detail } })?.suggestion).toContain('row-level security');
      expect(await engine().executeRaw('SELECT singleton FROM persistence_brain')).toEqual([{ singleton: 1 }]);
    }
  });
  test('activation and request intent guards keep distinct typed remedies', async () => {
    const cases = [
      { statements: ['UPDATE persistence_brain SET writer_protocol_floor=0 WHERE singleton=1'], code: 'writer_upgrade_required', raiser: 'gbrain_guard_protocol_activation' },
      { statements: ['UPDATE persistence_brain SET writer_protocol_floor=2,skill_bundles_enabled=true WHERE singleton=1'], code: 'writer_not_quiesced', raiser: 'gbrain_guard_protocol_activation' },
      { statements: [request, "UPDATE persistence_requests SET target_kind='skill_bundle' WHERE principal_id='protocol-test'"], code: 'unsupported_mutation_protocol', raiser: 'gbrain_guard_request_protocol' },
    ];
    for (const probe of cases) {
      const error = await refused(engine(), ["SELECT set_config('gbrain.persistence_protocol','2',true)", ...probe.statements]);
      expect(error).toMatchObject({ code: '42501' });
      const failure = databaseRefusal(error)!;
      expect(failure).toMatchObject({ code: probe.code, detail: { sqlstate: '42501', raiser: probe.raiser } });
      expect(receiptDeliveredHint({ error_code: failure.code, error_detail: { ...failure.detail } })?.suggestion).toBeTruthy();
    }
  });
});

const errorShape = (message: string, raiser = 'gbrain_guard_request_protocol', overrides = {}) => Object.assign(new Error(message), {
  code: '42501', where: `PL/pgSQL function public.${raiser}() line 3 at RAISE`, routine: 'exec_stmt_raise', ...overrides,
});
test.each([
  ['gbrain_guard_request_protocol', 'unsupported_mutation_protocol', 'skill operations require a typed target'],
  ['gbrain_guard_request_protocol', 'unsupported_mutation_protocol', 'invalid skill target'],
  ['gbrain_guard_request_protocol', 'unsupported_mutation_protocol', 'invalid page target'],
  ['gbrain_guard_request_protocol', 'unsupported_mutation_protocol', 'recovery target mismatch'],
  ['gbrain_guard_request_protocol', 'writer_not_quiesced', 'shared publication is disabled'],
  ['gbrain_guard_request_protocol', 'writer_not_quiesced', 'canonical owner capability must be revalidated'],
  ['gbrain_guard_skill_publication', 'writer_not_quiesced', 'shared publication is disabled'],
  ['gbrain_guard_skill_publication', 'writer_coordinator_required', 'canonical skill writes require a coordinated source capability'],
])('%s: %s: %s preserves the closed code without arbitrary database text', (raiser, code, text) => {
  const failure = databaseRefusal(errorShape(`${code}: ${text}`, raiser));
  expect(failure).toMatchObject({ code, detail: { origin: 'database_guard', sqlstate: '42501', raiser } });
  expect(databaseRefusal(errorShape(`${code}: ${text} private-canary`, raiser))).toBeNull();
});
test('classification requires the exact SQLSTATE, inner raiser and closed diagnostic; never copies raw values', () => {
  const message = 'writer_coordinator_required: writer state is unreadable to this database role';
  const failure = databaseRefusal(errorShape(message))!;
  expect(failure?.code).toBe('writer_coordinator_required');
  expect(publicFailureDetail(failure.detail)).toMatchObject({ relationship: 'unreadable_state' });
  for (const error of [
    errorShape(message, 'operator_hook'), errorShape(message, undefined, { where: '' }),
    errorShape(message + ' private-canary'), errorShape('writer_upgrade_required: private-canary'),
    errorShape(message, 'gbrain_require_persistence_protocol'),
    errorShape(message, undefined, { code: '23505' }),
    errorShape('permission denied for table private-canary'),
    errorShape(message, undefined, { where: 'PL/pgSQL function operator_hook() line 1 at RAISE\nPL/pgSQL function gbrain_guard_request_protocol() line 2 at SQL statement' }),
  ]) expect(databaseRefusal(error)).toBeNull();
  expect(JSON.stringify(failure)).not.toContain('private-canary');
});
