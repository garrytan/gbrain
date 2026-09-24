import { expect, test } from 'bun:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createAdminLimiters } from '../src/commands/serve-http-admin-limits.ts';

test('successful owner authentication, including expired continuation, leaves failed-login allowance intact', async () => {
  const app = express(); const limits = createAdminLimiters();
  app.get('/', limits.total, limits.failures, (req, res) => {
    res.locals.ownerAuthenticated = req.query.valid === 'yes';
    res.status(res.locals.ownerAuthenticated ? 410 : 401).end();
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
    for (let i = 0; i < 20; i++) expect((await fetch(`${base}/?valid=yes`)).status).toBe(410);
    for (let i = 0; i < 10; i++) expect((await fetch(base)).status).toBe(401);
    const failed = await fetch(base); expect(failed.status).toBe(429); expect(failed.headers.get('retry-after')).not.toBeNull();
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('total authentication traffic is capped at sixty even when every owner credential is valid', async () => {
  const app = express(); const limits = createAdminLimiters();
  let authenticated = 0;
  app.get('/', limits.total, limits.failures, (_req, res) => {
    authenticated++;
    res.locals.ownerAuthenticated = true;
    res.status(410).end();
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
    for (let i = 0; i < 60; i++) expect((await fetch(base)).status).toBe(410);
    const limited = await fetch(base);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(authenticated).toBe(60);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test('consent sessions have independent sixty-request allowances', async () => {
  const app = express(); const limits = createAdminLimiters(); app.use(cookieParser());
  app.get('/', (req, res, next) => { if (!req.cookies.gbrain_admin) res.status(401).end(); else next(); }, limits.consent, (_req, res) => res.end());
  const server = app.listen(0, '127.0.0.1');
  try {
    const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
    for (let i = 0; i < 60; i++) expect((await fetch(base, { headers: { Cookie: 'gbrain_admin=session-a' } })).status).toBe(200);
    expect((await fetch(base, { headers: { Cookie: 'gbrain_admin=session-a' } })).status).toBe(429);
    expect((await fetch(base, { headers: { Cookie: 'gbrain_admin=session-b' } })).status).toBe(200);
    expect((await fetch(base)).status).toBe(401);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
