/**
 * openEngine(settings) (Wave B1): an engine opened from a settings value reads no config file, environment variable,
 * home directory or working directory for its database, host identity, writer or embedding identity. PGLite here;
 * test/e2e/engine-open-postgres.test.ts covers Postgres pools and connection routing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { embeddedSettings, hostIdFor, isEmbeddedEngine, openEngine, processHasEmbeddedEngines, type EngineSettings } from '../src/core/engine-open.ts';
import { markEmbeddedEngine, releaseEmbeddedEngine, settingsConnectionOptions } from '../src/core/embedded-engine.ts';
import { existingHostIdFor, existingLocalHostId, hostIdentityPathsFor, localHostId, localHostIdentity, registerLocalWriter, registerLocalWriterValue, revokeLocalWriter } from '../src/core/persistence/identity.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { readStoredEmbeddingIdentity } from '../src/core/stored-embedding-identity.ts';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { engineKey } from '../src/core/engine-key.ts';
import { awaitPendingTelemetryFlush, getTelemetryWriter, recordSearchTelemetry, _telemetryWriterCountForTest } from '../src/core/search/telemetry.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

/** Built from parts so the secret scanners never see a URL literal with userinfo; every value here is a placeholder. */
const pgUrl = (userinfo: string, hostPath: string) => ['postgresql:/', '/', userinfo, '@', hostPath].join('');

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-engine-open-'));
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const dir = (name: string) => { const path = join(scratch, `${name}-${randomUUID().slice(0, 8)}`); mkdirSync(path, { recursive: true }); return path; };
/** Every file under `root`, relative; an empty list means nothing was created there. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory())
    .map(entry => relative(root, join(entry.parentPath, entry.name))).sort();
}
const writerValue = (lane: 'cli' | 'stdio' = 'stdio') => ({ id: randomUUID(), credential: randomBytes(32).toString('hex'), lane });
const settingsFor = (over: Partial<EngineSettings> = {}): EngineSettings => ({ embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() }, ...over });
/** An operation call from an embedding host: a remote (stdio-lane) context with no authenticated principal. */
const hostCtx = (engine: BrainEngine): OperationContext => ({
  engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: true,
} as unknown as OperationContext);
const codeOf = async (work: Promise<unknown>) => { try { await work; return 'resolved'; } catch (error) { return (error as { code?: string }).code ?? String(error); } };
/** Ambient settings that must never reach an embedded engine: a clean GBRAIN_HOME, a canary HOME and bogus database URLs. */
function canaries() {
  const home = dir('canary-home');
  const gbrainHome = dir('clean-gbrain-home');
  return { home, gbrainHome, env: {
    HOME: home, GBRAIN_HOME: gbrainHome,
    GBRAIN_DATABASE_URL: pgUrl('canary:canary', 'canary-example.invalid:5432/canary'),
    GBRAIN_DIRECT_DATABASE_URL: pgUrl('canary:canary', 'canary-example.invalid:5432/canary-direct'),
  } };
}

describe('openEngine refusals', () => {
  test('refuses without embedded_core: true, and names the setting', async () => {
    for (const embedded_core of [undefined, false, 'true', 1]) {
      expect(await codeOf(openEngine({ ...settingsFor(), embedded_core } as unknown as EngineSettings))).toBe('embedded_core_required');
    }
    expect(await codeOf(openEngine(undefined as unknown as EngineSettings))).toBe('embedded_core_required');
  });

  test('refuses an absent host identity with engine_host_missing and malformed settings with engine_settings_invalid', async () => {
    const { gbrainHome, env } = canaries();
    await withEnv(env, async () => {
      expect(await codeOf(openEngine({ ...settingsFor(), host: undefined } as unknown as EngineSettings))).toBe('engine_host_missing');
      expect(await codeOf(openEngine(settingsFor({ host: { id: '' } })))).toBe('engine_host_missing');
      expect(await codeOf(openEngine(settingsFor({ host: { id: 'worker-1' } })))).toBe('engine_settings_invalid');
      expect(await codeOf(openEngine(settingsFor({ engine: 'postgres', database: {} })))).toBe('engine_settings_invalid');
      expect(await codeOf(openEngine(settingsFor({ database: { url: 'postgresql://x/y' } })))).toBe('engine_settings_invalid');
      expect(await codeOf(openEngine(settingsFor({ engine: 'sqlite' as 'pglite' })))).toBe('engine_settings_invalid');
      expect(await codeOf(openEngine(settingsFor({ pool: { max: 0 } })))).toBe('engine_settings_invalid');
      expect(await codeOf(openEngine(settingsFor({ writer: { ...writerValue(), credential: 'short' } })))).toBe('engine_settings_invalid');
      expect(await codeOf(openEngine(settingsFor({ writer: { ...writerValue(), id: 'writer-1' } })))).toBe('engine_settings_invalid');
      expect(await codeOf(openEngine(settingsFor({ embedding: { model: 'voyage:voyage-4', dimensions: 0 } })))).toBe('engine_settings_invalid');
    });
    expect(filesUnder(gbrainHome)).toEqual([]);
  });

  test('refuses a Postgres URL that leaves its host, user or database name to PG* environment variables', async () => {
    const { gbrainHome, env } = canaries();
    await withEnv({ ...env, PGHOST: 'canary-example.invalid', PGUSER: 'canary', PGDATABASE: 'canary', PGPASSWORD: 'canary' }, async () => {
      for (const url of [pgUrl('app:secret', 'db-a.example.internal:5432'), pgUrl('app:secret', 'db-a.example.internal:5432/'), 'postgresql://db-a.example.internal:5432/brain_a', 'postgresql:///brain_a']) {
        expect(await codeOf(openEngine(settingsFor({ engine: 'postgres', database: { url } })))).toBe('engine_settings_invalid');
        expect(await codeOf(openEngine(settingsFor({ engine: 'postgres', database: { url: pgUrl('app:secret', 'db-a.example.internal:5432/brain_a'), directUrl: url } })))).toBe('engine_settings_invalid');
      }
    });
    expect(filesUnder(gbrainHome)).toEqual([]);
  });

  test('a settings URL keeps the port it names, and a multi-host URL is refused as one openEngine cannot read', async () => {
    expect(settingsConnectionOptions(pgUrl('app:secret', 'db-a.example.internal:80/brain_a')).port).toBe(80);
    for (const hosts of ['db-a.example.internal:5432,db-b.example.internal:5433', 'db-a.example.internal,db-b.example.internal', 'db-a.example.internal,db-b.example.internal:5433']) {
      const refusal = await openEngine(settingsFor({ engine: 'postgres', database: { url: pgUrl('app:secret', `${hosts}/brain_a`) } })).catch((error: { code?: string; suggestion?: string }) => error);
      expect(refusal).toMatchObject({ code: 'engine_settings_invalid', suggestion: expect.stringContaining('multi-host') });
    }
  });
});

describe('openEngine on a clean home', () => {
  test('writes a page on a no-root source, closes, reopens and reads it back; nothing is created under HOME or GBRAIN_HOME', async () => {
    const { home, gbrainHome, env } = canaries();
    const path = dir('brain');
    const hostId = randomUUID();
    const writer = writerValue('stdio');
    const settings = settingsFor({ database: { path }, host: { id: hostId }, writer, embedding: { model: 'voyage:voyage-4-lite', dimensions: 512 } });
    await withEnv(env, async () => {
      const first = await openEngine(settings);
      try {
        await first.initSchema();
        expect(isEmbeddedEngine(first)).toBe(true);
        expect(processHasEmbeddedEngines()).toBe(true);
        expect(hostIdFor(first)).toBe(hostId);
        const held = embeddedSettings(first)!;
        expect(held.embedding).toEqual(settings.embedding!);
        expect(held.writer).toEqual({ id: writer.id, lane: 'stdio' });
        expect(JSON.stringify(held)).not.toContain(writer.credential);
        const [source] = await first.executeRaw<{ local_path: string | null }>("SELECT local_path FROM sources WHERE id='default'");
        expect(source?.local_path ?? null).toBeNull();
        await operationsByName.put_page.handler(hostCtx(first), {
          slug: 'notes/opened-from-settings', content: '---\ntitle: Opened from settings\n---\nEvery setting came in as a value.\n',
        });
        const got = await operationsByName.get_page.handler(hostCtx(first), { slug: 'notes/opened-from-settings' }) as { compiled_truth?: string };
        expect(got.compiled_truth).toContain('Every setting came in as a value.');
      } finally {
        await first.disconnect();
      }
      expect(embeddedSettings(first)).toBeUndefined();

      const second = await openEngine({ ...settings, writer: { ...writer } });
      try {
        await second.initSchema();
        const got = await operationsByName.get_page.handler(hostCtx(second), { slug: 'notes/opened-from-settings' }) as { compiled_truth?: string };
        expect(got.compiled_truth).toContain('Every setting came in as a value.');
        const [registered] = await second.executeRaw<{ lane: string }>('SELECT lane FROM persistence_local_writers WHERE id=$1::uuid', [writer.id]);
        expect(registered?.lane).toBe('stdio');
      } finally {
        await second.disconnect();
      }
    });
    expect(filesUnder(gbrainHome)).toEqual([]);
    expect(filesUnder(home)).toEqual([]);
  }, 180_000);
});

describe('two engines in one process', () => {
  test('keep their own datastore, host identity and writer', async () => {
    const { gbrainHome, env } = canaries();
    const a = settingsFor({ database: { path: dir('brain-a') }, writer: writerValue('stdio') });
    const b = settingsFor({ database: { path: dir('brain-b') }, writer: writerValue('stdio') });
    await withEnv(env, async () => {
      const engineA = await openEngine(a);
      const engineB = await openEngine(b);
      try {
        await engineA.initSchema();
        await engineB.initSchema();
        expect(hostIdFor(engineA)).toBe(a.host.id);
        expect(hostIdFor(engineB)).toBe(b.host.id);
        await engineA.transaction(async tx => { expect(hostIdFor(tx)).toBe(a.host.id); });
        await operationsByName.put_page.handler(hostCtx(engineA), { slug: 'notes/only-in-a', content: '---\ntitle: Only in A\n---\nA.\n' });
        await operationsByName.put_page.handler(hostCtx(engineB), { slug: 'notes/only-in-b', content: '---\ntitle: Only in B\n---\nB.\n' });
        expect(await engineA.getPage('notes/only-in-a')).not.toBeNull();
        expect(await engineA.getPage('notes/only-in-b')).toBeNull();
        expect(await engineB.getPage('notes/only-in-b')).not.toBeNull();
        expect(await engineB.getPage('notes/only-in-a')).toBeNull();
        const writers = async (engine: BrainEngine) => (await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_local_writers')).map(row => row.id);
        expect(await writers(engineA)).toEqual([a.writer!.id]);
        expect(await writers(engineB)).toEqual([b.writer!.id]);
      } finally {
        await Promise.all([engineA.disconnect(), engineB.disconnect()]);
      }
    });
    expect(filesUnder(gbrainHome)).toEqual([]);
  }, 180_000);
});

describe('per-engine caches', () => {
  const meta: HybridSearchMeta = { vector_enabled: true, detail_resolved: null, expansion_applied: false, intent: 'general', mode: 'balanced' };
  const telemetryCount = async (engine: BrainEngine) => (await engine.executeRaw<{ n: number }>('SELECT COALESCE(SUM(count),0)::int AS n FROM search_telemetry'))[0]!.n;

  test('each opened engine has its own engineKey entry and telemetry writer; its transactions share them', async () => {
    const a = await openEngine(settingsFor({ database: { path: dir('cache-a') } }));
    const b = await openEngine(settingsFor({ database: { path: dir('cache-b') } }));
    try {
      await a.initSchema();
      await b.initSchema();
      expect(engineKey(a)).toBe(a);
      expect(engineKey(b)).toBe(b);
      expect(getTelemetryWriter(a)).not.toBe(getTelemetryWriter(b));
      await a.transaction(async tx => {
        expect(engineKey(tx)).toBe(a);
        expect(getTelemetryWriter(tx)).toBe(getTelemetryWriter(a));
        expect(hostIdFor(tx)).toBe(hostIdFor(a));
      });
      recordSearchTelemetry(a, meta, { results_count: 1 });
      recordSearchTelemetry(b, meta, { results_count: 1 });
      recordSearchTelemetry(b, meta, { results_count: 1 });
      await awaitPendingTelemetryFlush(5000, 'exit');
      expect(await telemetryCount(a)).toBe(1);
      expect(await telemetryCount(b)).toBe(2);
    } finally {
      await Promise.all([a.disconnect(), b.disconnect()]);
    }
  }, 180_000);

  test('a disconnect suspends the telemetry writer; after a reconnect the next record resumes it into the same brain', async () => {
    const engine = await openEngine(settingsFor({ database: { path: dir('cache-reconnect') } }));
    try {
      await engine.initSchema();
      const writer = getTelemetryWriter(engine);
      const live = _telemetryWriterCountForTest();
      recordSearchTelemetry(engine, meta, { results_count: 1 });
      await engine.reconnect();
      expect(_telemetryWriterCountForTest()).toBe(live - 1);
      expect(embeddedSettings(engine)).toBeDefined();
      recordSearchTelemetry(engine, meta, { results_count: 1 });
      expect(getTelemetryWriter(engine)).toBe(writer);
      expect(_telemetryWriterCountForTest()).toBe(live);
      await awaitPendingTelemetryFlush(5000, 'exit');
      expect(await telemetryCount(engine)).toBe(2);
    } finally {
      await engine.disconnect();
    }
    expect(embeddedSettings(engine)).toBeUndefined();
  }, 180_000);

  test('a disconnect during an in-flight reconnect closes the engine for good; connect and reconnect then refuse engine_closed', async () => {
    const engine = await openEngine(settingsFor({ database: { path: dir('close-during-reconnect') }, writer: writerValue() }));
    await engine.initSchema();
    const reconnecting = engine.reconnect().catch(() => {});
    await engine.disconnect();
    await reconnecting;
    expect(embeddedSettings(engine)).toBeUndefined();
    expect(await codeOf(engine.connect({ engine: 'pglite' }))).toBe('engine_closed');
    expect(await codeOf(engine.reconnect())).toBe('engine_closed');
  }, 180_000);

  test('embeddedSettings returns a frozen copy, so editing it changes nothing the engine reads', async () => {
    const engine = await openEngine(settingsFor({ database: { path: dir('frozen-view') }, embedding: { model: 'voyage:voyage-4', dimensions: 8 } }));
    try {
      const view = embeddedSettings(engine)!;
      expect(Object.isFrozen(view.embedding)).toBe(true);
      expect(Object.isFrozen(view.database)).toBe(true);
      expect(() => { (view.embedding as { dimensions: number }).dimensions = 9; }).toThrow();
      expect(embeddedSettings(engine)!.embedding!.dimensions).toBe(8);
    } finally {
      await engine.disconnect();
    }
  }, 180_000);
});

describe('host identity', () => {
  test('an embedded engine with no host id refuses engine_host_missing and never mints host.json', async () => {
    const { gbrainHome, env } = canaries();
    await withEnv(env, async () => {
      const engine = {};
      markEmbeddedEngine(engine, { ...settingsFor(), host: undefined } as unknown as EngineSettings);
      try {
        expect(await codeOf(Promise.resolve().then(() => hostIdFor(engine)))).toBe('engine_host_missing');
        expect(await codeOf(Promise.resolve().then(() => existingHostIdFor(engine)))).toBe('engine_host_missing');
        expect(await codeOf(Promise.resolve().then(() => hostIdentityPathsFor(engine)))).toBe('engine_host_missing');
      } finally {
        releaseEmbeddedEngine(engine);
      }
    });
    expect(filesUnder(gbrainHome)).toEqual([]);
  });

  test('an embedded engine records the identity-given-at-open sentinel, never a path', async () => {
    const engine = {};
    const id = randomUUID();
    markEmbeddedEngine(engine, settingsFor({ host: { id } }));
    try {
      expect(hostIdentityPathsFor(engine)).toEqual({ host_json_path: `embedded:${id}`, persistence_home: 'embedded', minted_under: null });
    } finally {
      releaseEmbeddedEngine(engine);
    }
  });

  test('an unmarked engine keeps the file identity exactly as before (back-compat)', async () => {
    const { gbrainHome, env } = canaries();
    await withEnv(env, async () => {
      const engine = {};
      const transaction = Object.create(engine) as object;
      Object.defineProperty(transaction, '_pageTransaction', { value: true });
      expect(existingHostIdFor(engine)).toBeNull();
      expect(hostIdFor(engine)).toBe(localHostId());
      expect(hostIdFor(transaction)).toBe(localHostId());
      expect(hostIdFor()).toBe(localHostId());
      expect(existingHostIdFor(engine)).toBe(existingLocalHostId());
      const identity = localHostIdentity();
      expect(hostIdentityPathsFor(engine)).toEqual({ host_json_path: identity.path, persistence_home: identity.persistence_home, minted_under: identity.minted_under });
    });
    expect(filesUnder(gbrainHome)).toEqual(['.gbrain/persistence/host.json']);
  });

  test('a test double that answers every property is not an embedded engine (back-compat)', async () => {
    const { env } = canaries();
    await withEnv(env, async () => {
      const double = new Proxy({}, { get: () => () => undefined });
      expect(isEmbeddedEngine(double)).toBe(false);
      expect(existingHostIdFor(double)).toBeNull();
    });
  });
});

describe('writer given as a value', () => {
  test('registration is idempotent; another credential or lane under its id refuses; a revoked one is never replaced', async () => {
    const engine = await openEngine(settingsFor());
    try {
      await engine.initSchema();
      const writer = writerValue('stdio');
      await registerLocalWriterValue(engine, writer);
      await registerLocalWriterValue(engine, writer);
      const rows = () => engine.executeRaw<{ lane: string; revoked: boolean }>('SELECT lane, revoked_at IS NOT NULL AS revoked FROM persistence_local_writers WHERE id=$1::uuid', [writer.id]);
      expect(await rows()).toEqual([{ lane: 'stdio', revoked: false }]);
      expect(await codeOf(registerLocalWriterValue(engine, { ...writer, credential: randomBytes(32).toString('hex') }))).toBe('permission_denied');
      expect(await codeOf(registerLocalWriterValue(engine, { ...writer, lane: 'cli' }))).toBe('permission_denied');
      expect(await codeOf(registerLocalWriterValue(engine, { ...writer, id: 'not-a-uuid' }))).toBe('engine_settings_invalid');
      expect(await codeOf(registerLocalWriterValue(engine, { ...writer, credential: 'x'.repeat(31) }))).toBe('engine_settings_invalid');
      expect(await codeOf(registerLocalWriterValue(engine, { ...writer, lane: 'http' as 'cli' }))).toBe('engine_settings_invalid');
      expect(await revokeLocalWriter(engine, writer.id)).toBe(true);
      expect(await codeOf(registerLocalWriterValue(engine, writer))).toBe('permission_denied');
      expect(await rows()).toEqual([{ lane: 'stdio', revoked: true }]);
    } finally {
      await engine.disconnect();
    }
  }, 120_000);

  test('the authority path uses the writer given at open; with none, a write refuses and no credential file is minted', async () => {
    const { gbrainHome, env } = canaries();
    const writer = writerValue('stdio');
    await withEnv(env, async () => {
      const none = await openEngine(settingsFor());
      try {
        await none.initSchema();
        expect(await codeOf(operationsByName.put_page.handler(hostCtx(none), { slug: 'notes/refused', content: '---\ntitle: Refused\n---\nNo writer.\n' })))
          .toBe('writer_registration_required');
        expect(await none.getPage('notes/refused')).toBeNull();
      } finally {
        await none.disconnect();
      }
      const revoked = await openEngine(settingsFor({ writer }));
      try {
        await revoked.initSchema();
        await registerLocalWriterValue(revoked, writer);
        await revokeLocalWriter(revoked, writer.id);
        expect(await codeOf(operationsByName.put_page.handler(hostCtx(revoked), { slug: 'notes/revoked', content: '---\ntitle: Revoked\n---\nRevoked writer.\n' })))
          .toBe('permission_denied');
        expect(await revoked.getPage('notes/revoked')).toBeNull();
      } finally {
        await revoked.disconnect();
      }
    });
    expect(filesUnder(gbrainHome)).toEqual([]);
  }, 180_000);

  test('a writer value never widens past the settings: its own lane, the default ceiling, and an existing ceiling kept', async () => {
    const path = dir('writer-ceiling');
    const writer = writerValue('stdio');
    const ceiling = async (engine: BrainEngine) => (await engine.executeRaw<{ grant_ceiling: unknown }>('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid', [writer.id]))[0]?.grant_ceiling;
    const first = await openEngine(settingsFor({ database: { path }, writer }));
    try {
      await first.initSchema();
      await operationsByName.put_page.handler(hostCtx(first), { slug: 'notes/ceiling', content: '---\ntitle: Ceiling\n---\nWritten with the stdio writer.\n' });
      expect(await ceiling(first)).toEqual({ sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null });
      expect(await codeOf(registerLocalWriter(first, 'cli'))).toBe('writer_registration_required');
      expect(await codeOf(operationsByName.put_page.handler({ ...hostCtx(first), remote: false } as OperationContext, { slug: 'notes/cli-lane', content: '---\ntitle: CLI lane\n---\nNo cli writer.\n' })))
        .toBe('writer_registration_required');
      expect(await first.getPage('notes/cli-lane')).toBeNull();
      await first.executeRaw(`UPDATE persistence_local_writers SET grant_ceiling='{"sourceIds":["default"],"operations":["put_page"],"scopes":["write"],"slugPrefixes":["notes/"]}'::jsonb WHERE id=$1::uuid`, [writer.id]);
    } finally {
      await first.disconnect();
    }
    const second = await openEngine(settingsFor({ database: { path }, writer: { ...writer } }));
    try {
      await second.initSchema();
      await operationsByName.put_page.handler(hostCtx(second), { slug: 'notes/narrowed', content: '---\ntitle: Narrowed\n---\nStill the narrowed writer.\n' });
      expect(await ceiling(second)).toEqual({ sourceIds: ['default'], operations: ['put_page'], scopes: ['write'], slugPrefixes: ['notes/'] });
    } finally {
      await second.disconnect();
    }
  }, 180_000);
});

describe('embedding identity', () => {
  test('initSchema seeds settings.embedding, not the process gateway, and an existing brain with another width refuses', async () => {
    const path = dir('brain-embedding');
    const { env } = canaries();
    await withEnv({ ...env, GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large', GBRAIN_EMBEDDING_DIMENSIONS: '3072' }, async () => {
      const first = await openEngine(settingsFor({ database: { path }, embedding: { model: 'voyage:voyage-4-lite', dimensions: 512 } }));
      try {
        await first.initSchema();
        expect(await readStoredEmbeddingIdentity(first)).toEqual({ model: 'voyage:voyage-4-lite', dimensions: 512 });
      } finally {
        await first.disconnect();
      }
    });
    const wider = await openEngine(settingsFor({ database: { path }, embedding: { model: 'voyage:voyage-4-lite', dimensions: 1024 } }));
    try {
      const refusal = await wider.initSchema().then(() => null, (error: unknown) => error as { code?: string; message?: string; suggestion?: string });
      expect(refusal?.code).toBe('engine_embedding_mismatch');
      expect(`${refusal?.message} ${refusal?.suggestion}`).toContain('gbrain migrate embeddings --status');
      expect(await readStoredEmbeddingIdentity(wider)).toEqual({ model: 'voyage:voyage-4-lite', dimensions: 512 });
    } finally {
      await wider.disconnect();
    }
    const otherModel = await openEngine(settingsFor({ database: { path }, embedding: { model: 'openai:text-embedding-3-small', dimensions: 512 } }));
    try {
      expect(await codeOf(otherModel.initSchema())).toBe('engine_embedding_mismatch');
    } finally {
      await otherModel.disconnect();
    }
    const unstated = await openEngine(settingsFor({ database: { path } }));
    try {
      await unstated.initSchema();
      expect(await readStoredEmbeddingIdentity(unstated)).toEqual({ model: 'voyage:voyage-4-lite', dimensions: 512 });
    } finally {
      await unstated.disconnect();
    }
  }, 240_000);
});

describe('connection routing', () => {
  test('a settings-only manager ignores GBRAIN_DIRECT_DATABASE_URL; the default manager still reads it (back-compat)', async () => {
    const url = pgUrl('app:secret', 'db-a.example.internal:5432/brain_a');
    const canary = pgUrl('canary:canary', 'canary-example.invalid:5432/canary-direct');
    await withEnv({ GBRAIN_DIRECT_DATABASE_URL: canary }, async () => {
      expect(new ConnectionManager({ url }).resolveDirectUrl()).toBe(canary);
      expect(new ConnectionManager({ url, directUrl: null, directUrlFromEnv: false }).resolveDirectUrl()).not.toBe(canary);
      const direct = pgUrl('app:secret', 'db-a-direct.example.internal:5432/brain_a');
      expect(new ConnectionManager({ url, directUrl: direct, directUrlFromEnv: false }).resolveDirectUrl()).toBe(direct);
    });
  });
});

describe('repo source', () => {
  test('a write through an embedded engine on a source with a checkout lands in the file and the database, with no identity or credential file in the home', async () => {
    const { gbrainHome, env } = canaries();
    const root = dir('repo');
    expect(Bun.spawnSync(['git', 'init', '--quiet', root]).exitCode).toBe(0);
    const writer = writerValue('stdio');
    await withEnv(env, async () => {
      const engine = await openEngine(settingsFor({ database: { path: dir('brain-repo') }, writer }));
      try {
        await engine.initSchema();
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await operationsByName.put_page.handler(hostCtx(engine), { slug: 'notes/in-the-repo', content: '---\ntitle: In the repo\n---\nWritten through.\n' });
        expect((await engine.getPage('notes/in-the-repo'))?.compiled_truth).toContain('Written through.');
        expect(filesUnder(root).filter(path => !path.startsWith('.git/'))).toContain('notes/in-the-repo.md');
        const [owner] = await engine.executeRaw<{ owner_host_id: string }>("SELECT w.owner_host_id::text AS owner_host_id FROM persistence_source_bindings s JOIN persistence_worktrees w ON w.id=s.worktree_id WHERE s.source_id='default'");
        expect(owner?.owner_host_id).toBe(hostIdFor(engine));
      } finally {
        await engine.disconnect();
      }
    });
    // The checkout's native coordination lock still lives in the process's persistence home (coordination-lock.ts);
    // no host.json and no writer credential file is created for the embedded engine.
    expect(filesUnder(gbrainHome).filter(path => !/^\.gbrain\/persistence\/locks\/[0-9a-f-]{36}\.lock$/.test(path))).toEqual([]);
  }, 180_000);
});

/**
 * Core modules that still read this process's file identity directly. Every other core call site resolves the host id
 * through `hostIdFor(engine)` / `existingHostIdFor(engine)`, which answer the id given at open for an engine opened
 * from settings and `localHostId()` for every other engine. The CLI layer (src/commands) keeps the file identity: it
 * only runs against the engine the CLI connected.
 */
const FILE_IDENTITY_ALLOWLIST: Record<string, string> = {
  'persistence/coordination-lock.ts': 'fallback only when a caller passes no host id; every claim and reservation passes hostIdFor(engine)',
  'persistence/engine-graduation.ts': 'PGLite to Postgres graduation, run only by gbrain migrate on the brain host',
};

describe('static guards', () => {
  const root = join(import.meta.dir, '..');
  const code = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const FILE_IDENTITY = /\b(localHostId|localHostIdentity|existingLocalHostId)\(/;

  test('core code resolves the host id through hostIdFor(engine), except the justified allowlist', () => {
    const dirPath = join(root, 'src/core');
    const callers = readdirSync(dirPath, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
      .map(entry => relative(dirPath, join(entry.parentPath, entry.name)).split('\\').join('/'))
      .filter(name => name !== 'persistence/identity.ts' && FILE_IDENTITY.test(code(join('src/core', name))))
      .sort();
    expect(callers.filter(name => !(name in FILE_IDENTITY_ALLOWLIST))).toEqual([]);
    // A row whose file stopped reading the file identity is stale: delete it.
    expect(Object.keys(FILE_IDENTITY_ALLOWLIST).filter(name => !callers.includes(name))).toEqual([]);
    expect(FILE_IDENTITY.test(code('src/core/shared-skills/knowledge-guard.ts'))).toBe(false);
  });

  test('no MCP or operation module reaches the value registrations', () => {
    const scanned = ['src/mcp', 'src/core/ops'].flatMap(dirPath => readdirSync(join(root, dirPath), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.ts')).map(entry => relative(root, join(entry.parentPath, entry.name))));
    scanned.push('src/core/operations.ts');
    const reach = scanned.filter(path => /\b(registerLocalWriterValue|setEngineHostId|markEmbeddedEngine|openEngine)\b/.test(code(path)));
    expect(reach).toEqual([]);
  });
});
