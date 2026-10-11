import { afterEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { registerPmbrainAdminRoutes, type PmbrainAdminRouteOptions } from '../src/commands/pmbrain-admin-routes.ts';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

async function request(engine: 'pglite' | 'postgres', connected: boolean | undefined, busy = false) {
  const app = express();
  registerPmbrainAdminRoutes({
    app,
    engine: { kind: engine } as PmbrainAdminRouteOptions['engine'],
    config: { engine, database_path: 'isolated-test-db' } as PmbrainAdminRouteOptions['config'],
    requireAdmin: (_req, _res, next) => next(),
    getPgliteBusy: () => busy,
    getPgliteConnected: connected === undefined ? undefined : () => connected,
    ensureAdminWorkerStarted: async () => {},
    productTasks: {} as PmbrainAdminRouteOptions['productTasks'],
  });
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP test server did not start');
  return fetch(`http://127.0.0.1:${address.port}/admin/api/pglite-owner/terminate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: process.pid }),
  });
}

test('正常连接的 PGLite 拒绝结束当前数据库执行进程', async () => {
  const response = await request('pglite', true);
  expect(response.status).toBe(409);
  expect((await response.json()).error).toBe('pglite_owner_is_current');
});

test('Postgres 保留不可用的 PGLite 恢复接口语义', async () => {
  const response = await request('postgres', true);
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe('pglite_owner_control_unavailable');
});

test('未知连接状态且仍忙碌时保留安全取消入口', async () => {
  const response = await request('pglite', undefined, true);
  expect(response.status).toBe(423);
  expect((await response.json()).code).toBe('pglite_busy');
});
