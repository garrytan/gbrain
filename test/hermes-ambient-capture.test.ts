/**
 * Protects automatic transcript capture's server-side opt-in and admission
 * boundary, explicit capture compatibility, and the schema Hermes negotiates.
 * Regresses if capture treats truthy values as automatic consent, the file
 * mirror or cached enablement authorizes a write, or journal admission skips
 * the off switch after preflight. Existing facts tests cover extracted facts,
 * not capture page requests. Uses production handlers/admission, no new seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { pagesOperations } from '../src/core/ops/pages.ts';
import { assertAmbientTranscriptCapture } from '../src/core/ops/ambient-capture.ts';
import { resolveWritebackConfig } from '../src/core/facts/writeback-config.ts';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, admitWriteInTransaction, admitWriteGroupInTransaction, getWriteRequest, type WriteAdmission } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const capture = pagesOperations.find(op => op.name === 'capture')!;
const engines: BrainEngine[] = [];
const sourceId = `hermes-capture-${randomUUID().slice(0, 8)}`;
let closePostgres: (() => Promise<void>) | undefined;
const context = (engine: BrainEngine): OperationContext => ({ engine, sourceId, remote: true,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: true,
  logger: { info() {}, warn() {}, error() {} } });

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      engines.push(engine);
    } else {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(isolated.engine);
      closePostgres = isolated.close;
    }
  }
  for (const engine of engines) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await registerLocalWriter(engine, 'stdio');
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

async function admission(engine: BrainEngine): Promise<WriteAdmission> {
  const slug = `inbox/hermes-${randomUUID()}`;
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
  const authority = await submissionAuthority(context(engine), 'capture', sourceId, source.incarnation, slug);
  authority.databaseOnlyReason = 'disabled_by_config';
  return { principal: authority.principal, operation: 'capture', sourceId, sourceIncarnation: source.incarnation,
    slug, requestId: randomUUID(), callerIntent: { content: 'Synthetic conversation turn.', ambient: true },
    intent: { content: 'Synthetic conversation turn.', ambient: true }, authority };
}

async function preservedState(engine: BrainEngine) {
  return {
    counters: await engine.executeRaw('SELECT * FROM persistence_counters ORDER BY key'),
    requests: await engine.executeRaw('SELECT id,request_id,state FROM persistence_requests WHERE source_id=$1 ORDER BY id', [sourceId]),
    pages: await engine.executeRaw('SELECT slug,content_hash FROM pages WHERE source_id=$1 ORDER BY slug', [sourceId]),
  };
}

describe('Hermes automatic capture server contract', () => {
  test('eager and lazy tools/list advertise the same optional boolean flag', () => {
    const live = buildToolDefs([capture])[0];
    const lazy = buildToolDefs(OPERATION_MANIFEST.filter(op => op.name === 'capture'))[0];
    expect(lazy).toEqual(live);
    expect(live.inputSchema.properties.ambient).toMatchObject({ type: 'boolean' });
    expect(live.inputSchema.required).not.toContain('ambient');
  });

  test('unset, invalid and off refuse before a write; salient/all allow automatic capture', async () => {
    for (const engine of engines) {
      for (const mode of [null, 'off', 'unexpected']) {
        if (mode === null) await engine.executeRaw('DELETE FROM config WHERE key=$1', ['memory.auto_writeback']);
        else await engine.setConfig('memory.auto_writeback', mode);
        const before = await preservedState(engine);
        await expect(capture.handler(context(engine), { content: 'Synthetic turn.', ambient: true })).rejects.toMatchObject({ code: 'ambient_capture_off' });
        expect(await preservedState(engine)).toEqual(before);
        for (const ambient of [undefined, false]) {
          expect(await capture.handler(context(engine), { content: 'Explicit note.', ...(ambient === undefined ? {} : { ambient }) })).toMatchObject({ dry_run: true });
        }
      }
      for (const mode of ['salient', 'all']) {
        await engine.setConfig('memory.auto_writeback', mode);
        expect(await capture.handler(context(engine), { content: 'Synthetic turn.', ambient: true })).toMatchObject({ dry_run: true });
      }
      for (const ambient of ['true', 1, null, {}]) {
        await expect(capture.handler(context(engine), { content: 'Synthetic turn.', ambient })).rejects.toMatchObject({ code: 'invalid_params' });
      }
    }
  });

  test('an enabled cache never authorizes capture when the authoritative read fails', async () => {
    for (const engine of engines) {
      await engine.setConfig('memory.auto_writeback', 'salient');
      let fail = false;
      const unavailable = new Proxy(engine, { get(target, key) {
        if (key === 'getConfig') return (name: string) => fail ? Promise.reject(new Error('synthetic read failure')) : target.getConfig(name);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      expect((await resolveWritebackConfig(unavailable)).enabled).toBe(true);
      fail = true;
      const before = await preservedState(engine);
      await expect(capture.handler(context(unavailable), { content: 'Synthetic turn.', ambient: true })).rejects.toMatchObject({ code: 'ambient_capture_off', reason: 'writeback_gate_unreadable' });
      expect(await preservedState(engine)).toEqual(before);
    }
  });

  test('off after preflight refuses every new journal admission and preserves rows and quotas', async () => {
    for (const engine of engines) {
      await engine.setConfig('memory.auto_writeback', 'salient');
      await assertAmbientTranscriptCapture(engine, true);
      const input = await admission(engine);
      await engine.setConfig('memory.auto_writeback', 'off');
      const before = await preservedState(engine);
      await expect(admitWrite(engine, input)).rejects.toMatchObject({ code: 'ambient_capture_off' });
      await expect(engine.transaction(tx => admitWriteInTransaction(tx, input))).rejects.toMatchObject({ code: 'ambient_capture_off' });
      await expect(engine.transaction(tx => admitWriteGroupInTransaction(tx, [input]))).rejects.toMatchObject({ code: 'ambient_capture_off' });
      expect(await getWriteRequest(engine, input.principal, input.requestId!)).toBeNull();
      expect(await preservedState(engine)).toEqual(before);
    }
  });

  test('accepted requests replay after off without a second quota reservation; explicit new captures still admit', async () => {
    for (const engine of engines) {
      await engine.setConfig('memory.auto_writeback', 'all');
      const input = await admission(engine);
      const accepted = await admitWrite(engine, input);
      await engine.setConfig('memory.auto_writeback', 'off');
      const before = await preservedState(engine);
      expect((await admitWrite(engine, input)).id).toBe(accepted.id);
      expect(await preservedState(engine)).toEqual(before);
      for (const ambient of [undefined, false]) {
        const explicit = await admission(engine);
        explicit.callerIntent = explicit.intent = { content: 'Explicit note.', ...(ambient === undefined ? {} : { ambient }) };
        const saved = await admitWrite(engine, explicit);
        expect(saved.state).toBe('queued');
        await cancelWriteRequest(engine, explicit.principal, explicit.requestId!);
      }
      await cancelWriteRequest(engine, input.principal, input.requestId!);
    }
  });

  test.skipIf(!process.env.DATABASE_URL)('Postgres keeps consent stable until the admitted request commits', async () => {
    const engine = engines.find(engine => engine.kind === 'postgres')!;
    await engine.setConfig('memory.auto_writeback', 'salient');
    const input = await admission(engine);
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const admitting = engine.transaction(async tx => {
      await assertAmbientTranscriptCapture(tx, true, true);
      locked();
      await released;
      return admitWriteInTransaction(tx, input);
    });
    try {
      await ready;
      await expect(engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('lock_timeout','50ms',true)");
        await tx.setConfig('memory.auto_writeback', 'off');
      })).rejects.toMatchObject({ code: '55P03' });
    } finally { release(); }
    const accepted = await admitting;
    expect(accepted.state).toBe('queued');
    await engine.setConfig('memory.auto_writeback', 'off');
    expect((await admitWrite(engine, input)).id).toBe(accepted.id);
    await cancelWriteRequest(engine, input.principal, input.requestId!);
  });
});
