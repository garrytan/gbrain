/**
 * `gbrain migrate --to` refusals carry the agent contract (Foundations 2,
 * "Lane B: refusal now", refusal envelopes and refusal branches).
 *
 * Protects: the envelope an agent reads when the legacy engine copier refuses
 * a brain. The history refusal and the managed-brain refusal are `opError`s
 * with `why` and a filled `fix` that names the refusing side: a PGLite brain
 * gets the user's choice (turn graduation back on and preview the move with
 * its read-only plan, or stay on PGLite and share it with `gbrain mcp
 * expose`), a Postgres
 * brain moving down keeps its datastore, and a target that already holds
 * history needs an empty database. Every branch verifies read-only with
 * `gbrain doctor --no-migrate --json`. The unknown-engine error is an
 * `invalid_params` opError, and the usage text names every accepted engine.
 * Fails when: a refusal goes back to a prose-only OperationError (no `fix`),
 * a branch loses its side, or the usage text drops `postgres`.
 * Why new: test/persistence-migration-preservation.test.ts pins only the code.
 * Seam: none (real PGLite brains; toAgentError renders the CLI and MCP wire).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assertLegacyEngineMigration, assertUnmanagedCanonicalWriter } from '../src/core/persistence/maintenance.ts';
import { runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { toAgentError, type RenderContext } from '../src/core/agent-output.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const routing = { brain: 'host', source: 'default' };
const cli: RenderContext = { transport: 'cli', isCallable: () => false, preapproved: () => false, routing };
const stdio: RenderContext = { transport: 'stdio', surface: 'full', isCallable: () => true, preapproved: () => false, routing };
const VERIFY = ['gbrain', 'doctor', '--no-migrate', '--json'];

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES('default','world','refusal-example')");
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  const error = await run().then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OperationError);
  return error as OperationError;
}
const envelope = (e: unknown, render: RenderContext) => toAgentError(e, { transport: render.transport, render });

describe('history refusal names the refusing side', () => {
  test('a PGLite brain moving to Postgres: ask the user, preview graduation or stay on PGLite and expose it', async () => {
    const e = await refusal(() => assertLegacyEngineMigration(engine, { side: 'source', from: 'pglite', to: 'postgres' }));
    expect(e.code).toBe('writer_coordinator_required');
    expect(e.why).toContain('fact_withdrawals');
    const env = envelope(e, cli);
    expect(env.code).toBe('writer_coordinator_required');
    expect(env.fix).toMatchObject({ next: 'ask_user', consent: ['egress'], verify: { argv: expect.arrayContaining(VERIFY) } });
    expect(env.fix?.argv?.slice(0, 4)).toEqual(['gbrain', 'config', 'unset', 'migrate.graduation']);
    expect(env.fix?.then?.argv?.slice(0, 8)).toEqual(['gbrain', 'migrate', '--to', 'postgres', '--url-env', 'GBRAIN_TARGET_URL', '--plan', '--json']);
    expect(env.fix?.then?.consent).toEqual([]);
    expect(env.fix?.user_message).toContain('preview the move to Postgres (nothing changes yet)');
    expect(env.fix?.user_message).toContain('gbrain mcp expose');
    expect(env.fix?.why).toContain('graduation copies it intact');
    expect(JSON.stringify(env)).not.toContain('not available yet');
    // Over MCP the CLI command is the user's to run; the choice they are asked about is unchanged.
    expect(envelope(e, stdio).fix).toMatchObject({ next: 'tell_user_to_run', user_message: env.fix?.user_message });
  });

  test('a Postgres brain moving to PGLite keeps its datastore', async () => {
    const e = await refusal(() => assertLegacyEngineMigration(engine, { side: 'source', from: 'postgres', to: 'pglite' }));
    const env = envelope(e, cli);
    expect(env.fix?.next).toBe('report');
    expect(env.fix?.argv).toBeUndefined();
    expect(env.fix?.user_message).toContain('stays on Postgres');
    expect(env.fix?.verify?.argv).toEqual(expect.arrayContaining(VERIFY));
  });

  test('a target that already holds history needs an empty database from the user', async () => {
    const e = await refusal(() => assertLegacyEngineMigration(engine, { side: 'target', from: 'pglite', to: 'postgres' }));
    const env = envelope(e, cli);
    expect(e.why).toContain('target datastore');
    expect(env.fix).toMatchObject({ next: 'tell_user_to_run', inputs: [{ name: 'empty_database_url' }] });
    expect(env.fix?.argv?.slice(0, 4)).toEqual(['gbrain', 'migrate', '--to', 'postgres']);
    expect(env.fix?.user_message).toContain('empty database');
  });

  test('runMigrateEngine refuses a PGLite brain with history before touching a target, with the filled fix', async () => {
    const e = await refusal(() => runMigrateEngine(engine, ['--to', 'postgres', '--url', 'postgresql://user@localhost:1/never']));
    expect(envelope(e, cli).fix?.next).toBe('ask_user');
  });
});

describe('page history refusal', () => {
  let bare: PGLiteEngine;
  beforeAll(async () => {
    bare = new PGLiteEngine();
    await bare.connect({});
    await bare.initSchema();
  }, 120_000);
  afterAll(async () => { await bare.disconnect(); });

  test('a brain with no journal but with page versions is refused, naming how many versions the copy would discard', async () => {
    await assertLegacyEngineMigration(bare, { side: 'source', from: 'pglite', to: 'postgres' });
    await bare.putPage('notes/history', { type: 'note', title: 'History', compiled_truth: 'first body' });
    const page = (await bare.getPage('notes/history'))!;
    await bare.createVersion('notes/history');
    await bare.createVersion('notes/history');
    expect(Number((await bare.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id = $1', [page.id]))[0]!.n)).toBe(2);
    const e = await refusal(() => assertLegacyEngineMigration(bare, { side: 'source', from: 'pglite', to: 'postgres' }));
    expect(e.code).toBe('writer_coordinator_required');
    expect(e.reason).toBe('page_history');
    expect(e.message).toBe('Engine migration would discard 2 page versions.');
    expect(e.why).toContain('copy would discard all 2');
    expect(envelope(e, cli).fix).toMatchObject({ next: 'ask_user', verify: { argv: expect.arrayContaining(VERIFY) } });
    const e2 = await refusal(() => runMigrateEngine(bare, ['--to', 'postgres', '--url', 'postgresql://user@localhost:1/never']));
    expect(e2.reason).toBe('page_history');
  });

  test('the target side is not refused for versions (an empty target is checked by the journal tables)', async () => {
    await assertLegacyEngineMigration(bare, { side: 'target', from: 'pglite', to: 'postgres' });
  });
});

describe('managed-brain refusal', () => {
  beforeAll(async () => { await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1'); });
  afterAll(async () => { await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1'); });

  test('engine migration of a managed brain gets the same graduate-or-expose choice', async () => {
    const e = await refusal(() => assertUnmanagedCanonicalWriter(engine, 'engine migration', { migration: { side: 'source', from: 'pglite', to: 'postgres' } }));
    expect(e.code).toBe('writer_coordinator_required');
    expect(e.why).toContain('managed');
    expect(envelope(e, cli).fix?.next).toBe('ask_user');
    expect(envelope(e, cli).fix?.then?.argv).toContain('--plan');
  });

  test('another legacy writer names the coordinated path and verifies read-only', async () => {
    const e = await refusal(() => assertUnmanagedCanonicalWriter(engine, 'sources archive'));
    const env = envelope(e, cli);
    expect(env.fix?.next).toBe('report');
    expect(env.fix?.why).toContain('coordinated path');
    expect(env.fix?.user_message).toContain('sources archive');
    expect(env.fix?.verify?.argv).toEqual(expect.arrayContaining(VERIFY));
  });
});

describe('gbrain migrate argument errors', () => {
  test('an unknown engine is an invalid_params opError whose fix names the accepted engines', async () => {
    const e = await refusal(() => runMigrateEngine(engine, ['--to', 'duckdb']));
    expect(e.code).toBe('invalid_params');
    expect(e.why).toContain('postgres and pglite');
    const env = envelope(e, cli);
    expect(env.fix?.inputs?.[0]?.how).toContain('postgres (alias supabase) or pglite');
  });

  test('the usage text lists every accepted --to value', async () => {
    const e = await refusal(() => runMigrateEngine(engine, []));
    for (const value of ['postgres', 'supabase', 'pglite']) expect(e.suggestion).toContain(value);
  });
});
