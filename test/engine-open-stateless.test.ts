import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { openEngine } from '../src/core/engine-open.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { hostIdFor, registerLocalWriterValue, withVerifiedLocalRegistration, type LocalRegistration } from '../src/core/persistence/identity.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * An engine opened from settings alone: no config file, no environment read for its inputs, no home directory
 * touched for its identity. The write it makes is durable: a second engine opened on the same datastore, in the
 * same process, reads it back. GBRAIN_HOME points at an empty directory for the whole run (the preloads give
 * every test a scratch home), so anything minted under it is a read of the world this test would catch.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-engine-open-'));
const hostId = randomUUID();
// The host holds the writer registration as a value (id, credential, lane) and runs each operation inside the verified
// registration, as the server does for a registration it verified. No credential file is written for it.
const writer: LocalRegistration = { id: randomUUID(), credential: randomBytes(32).toString('hex'), lane: 'stdio' };
const ctx = (engine: BrainEngine): OperationContext => ({
  engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: true,
} as unknown as OperationContext);
const asWriter = <T>(engine: BrainEngine, run: () => Promise<T>) => withVerifiedLocalRegistration(engine, writer, run);
const persistenceHome = () => join(process.env.GBRAIN_HOME!, '.gbrain', 'persistence');
const mintedUnderHome = () => existsSync(persistenceHome()) ? readdirSync(persistenceHome()) : [];

beforeAll(() => { configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} }); });
afterAll(() => { resetGateway(); rmSync(dataDir, { recursive: true, force: true }); });

describe('openEngine', () => {
  test('writes with the engine opened from settings, then reads it back from a second engine on the same datastore', async () => {
    expect(process.env.GBRAIN_HOME).toBeTruthy();
    const before = mintedUnderHome();

    const first = await openEngine({ engine: 'pglite', database: { path: dataDir }, host: { id: hostId } });
    try {
      await first.initSchema();
      expect(hostIdFor(first)).toBe(hostId);
      await registerLocalWriterValue(first, writer);
      const put = await asWriter(first, () => operationsByName.put_page.handler(ctx(first), {
        slug: 'notes/opened-from-settings', content: '---\ntitle: Opened from settings\n---\nThe engine took every setting as a parameter.\n',
      })) as Record<string, unknown>;
      expect(put).toBeTruthy();
      const got = await operationsByName.get_page.handler(ctx(first), { slug: 'notes/opened-from-settings', include_content: true }) as { content?: string } | null;
      expect(got?.content ?? '').toContain('every setting as a parameter');
    } finally {
      await first.disconnect();
    }

    const second = await openEngine({ engine: 'pglite', database: { path: dataDir }, host: { id: hostId } });
    try {
      const got = await operationsByName.get_page.handler(ctx(second), { slug: 'notes/opened-from-settings', include_content: true }) as { content?: string } | null;
      expect(got?.content ?? '').toContain('every setting as a parameter');
    } finally {
      await second.disconnect();
    }

    // The identity came from the settings, so nothing was minted under the home directory for it.
    expect(mintedUnderHome()).toEqual(before);
  }, 120_000);

  test('two engines in one process keep their own host identity', async () => {
    const a = await openEngine({ engine: 'pglite', database: {}, host: { id: hostId } });
    const otherId = randomUUID();
    const b = await openEngine({ engine: 'pglite', database: {}, host: { id: otherId } });
    try {
      expect(hostIdFor(a)).toBe(hostId);
      expect(hostIdFor(b)).toBe(otherId);
    } finally {
      await Promise.all([a.disconnect(), b.disconnect()]);
    }
  }, 120_000);

  test('refuses a Postgres engine with no URL, and a host id that is not a UUID', async () => {
    await expect(openEngine({ engine: 'postgres', database: {} })).rejects.toThrow(/database URL/);
    await expect(openEngine({ engine: 'pglite', database: {}, host: { id: 'worker-1' } })).rejects.toThrow(/UUID/);
  });

  test('a writer registered as a value is idempotent and refuses another credential under its id', async () => {
    const engine = await openEngine({ engine: 'pglite', database: {}, host: { id: hostId } });
    try {
      await engine.initSchema();
      await registerLocalWriterValue(engine, writer);
      await registerLocalWriterValue(engine, writer);
      await expect(registerLocalWriterValue(engine, { ...writer, credential: randomBytes(32).toString('hex') })).rejects.toThrow(/does not match/);
      await expect(registerLocalWriterValue(engine, { id: 'not-a-uuid', credential: writer.credential, lane: 'stdio' })).rejects.toThrow(/invalid/);
    } finally {
      await engine.disconnect();
    }
  }, 120_000);
});
