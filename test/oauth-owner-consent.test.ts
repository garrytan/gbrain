import { afterAll, beforeAll, expect, test } from 'bun:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mountOAuthOwnerConsent } from '../src/commands/serve-http-consent.ts';
import type { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';

let server: Server;
let base: string;
let issued = 0;
const query = new URLSearchParams({ client_id: 'gbrain_cl_example', redirect_uri: 'https://client.example.com/callback', response_type: 'code', state: 'fixture-state', scope: 'read write', code_challenge: 'fixture-challenge', code_challenge_method: 'S256' });
const cookie = 'gbrain_admin=owner-session';
beforeAll(async () => {
  const app = express(); app.use(cookieParser());
  const provider = { clientsStore: { getClient: async (id: string) => id === 'gbrain_cl_example' ? { client_name: '<script>untrusted</script>', redirect_uris: ['https://client.example.com/callback'], scope: 'read write' } : undefined } } as unknown as GBrainOAuthProvider;
  // publicOrigin is known only after the ephemeral listener binds.
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mountOAuthOwnerConsent(app, { provider, publicOrigin: base, sessionValid: sid => sid === 'owner-session' });
  app.get('/authorize', (req, res) => { issued++; res.json({ approved: res.locals.gbrainOwnerApproved, query: req.query }); });
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
async function getConsent() {
  const r = await fetch(`${base}/authorize?${query}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  const body = await r.text();
  return { r, body, nonce: body.match(/name="nonce" value="([a-f0-9]+)"/)?.[1] ?? '' };
}
async function decide(nonce: string, decision: string, sid = cookie, origin = base) {
  return fetch(`${base}/authorize/consent`, { method: 'POST', redirect: 'manual', headers: { Cookie: sid, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce, decision }) });
}
test('anonymous authorization cannot mint a code and shows owner sign-in', async () => {
  const before = issued;
  const r = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
  expect(r.status).toBe(401); expect(await r.text()).toContain('Sign in to approve'); expect(issued).toBe(before);
});
test('owner reviews escaped client identity before a single-use approval', async () => {
  const { r, body, nonce } = await getConsent();
  expect(r.status).toBe(200); expect(nonce).not.toBe('');
  expect(body).toContain('&lt;script&gt;untrusted&lt;/script&gt;');
  expect(body).not.toContain('<script>untrusted</script>');
  const decision = await decide(nonce, 'approve'); expect(decision.status).toBe(303);
  const location = decision.headers.get('location')!;
  const approved = await fetch(`${base}${location}`, { headers: { Cookie: cookie }, redirect: 'manual' });
  expect(approved.status).toBe(200);
  const value = await approved.json() as any;
  expect(value.approved).toBe(true); expect(value.query._gbrain_approval).toBeUndefined();
  expect(value.query.code_challenge).toBe('fixture-challenge');
  expect((await fetch(`${base}${location}`, { headers: { Cookie: cookie }, redirect: 'manual' })).status).toBe(403);
});
test('approval is bound to the session, origin, and complete authorization request', async () => {
  const { nonce } = await getConsent();
  expect((await decide(nonce, 'approve', 'gbrain_admin=other-session')).status).toBe(403);
  expect((await decide(nonce, 'approve', cookie, 'https://other.example.com')).status).toBe(403);
  const d = await decide(nonce, 'approve');
  const modified = new URL(`${base}${d.headers.get('location')}`); modified.searchParams.set('scope', 'admin');
  expect((await fetch(modified, { headers: { Cookie: cookie }, redirect: 'manual' })).status).toBe(403);
});
test('denial returns only to a registered redirect with state; unregistered redirects are refused', async () => {
  const { nonce } = await getConsent();
  const r = await decide(nonce, 'deny'); const target = new URL(r.headers.get('location')!);
  expect(target.origin).toBe('https://client.example.com'); expect(target.searchParams.get('error')).toBe('access_denied');
  expect(target.searchParams.get('state')).toBe('fixture-state');
  const bad = new URLSearchParams(query); bad.set('redirect_uri', 'https://other.example.com/callback');
  expect((await fetch(`${base}/authorize?${bad}`, { headers: { Cookie: cookie }, redirect: 'manual' })).status).toBe(400);
});
