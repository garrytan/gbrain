import { expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerPgliteEngine } from '../src/product/database/worker-engine';
import { PostgresEngine } from '../src/core/postgres-engine';
import { registerWorkbenchRoutes } from '../src/product/workbench/routes';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard';

test('真实数据库就绪与数据库暂不可用均独立于 HTTP 和模型状态', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-availability-engine-'));
  const url = process.env.PMBRAIN_AVAILABILITY_TEST_DATABASE_URL;
  if (url) assertSafeE2eDatabaseUrl(url);
  const engine = url ? new PostgresEngine() : new WorkerPgliteEngine();
  let server: ReturnType<express.Express['listen']> | undefined;
  let connected = true;
  try {
    await engine.connect(url ? { database_url: url, poolSize: 1 } : { database_path: join(root, 'test.pglite') });
    const app = express();
    registerWorkbenchRoutes(app, (_req, _res, next) => next(), engine as any,
      { engine: url ? 'postgres' : 'pglite', chat_model: 'service-test:chat' } as any,
      { readConfig: () => null, storageRoot: join(root, 'workbench'), databaseAvailable: () => connected });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}/admin/api/workbench`;
    const deadline = Date.now() + 5000;
    let state: any;
    do {
      state = await (await fetch(base + '/availability')).json();
      if (state.databaseReady) break;
      await Bun.sleep(20);
    } while (Date.now() < deadline);
    expect(state).toEqual({ serviceReady: true, databaseReady: true });
    connected = false;
    expect(await (await fetch(base + '/availability')).json()).toEqual({ serviceReady: true, databaseReady: false });
    expect((await (await fetch(base + '/models')).json() as any).defaultModel).toBe('service-test:chat');
    connected = true;
    await fetch(base + '/availability');
    await Bun.sleep(50);
    expect(await (await fetch(base + '/availability')).json()).toEqual({ serviceReady: true, databaseReady: true });
  } finally {
    server?.close();
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
