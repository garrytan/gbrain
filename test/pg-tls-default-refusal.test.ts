/**
 * The TLS default's refusal: a non-local Postgres server that answers the
 * SSLRequest with "no" fails `connect()` with the coded `postgres_tls_required`
 * error (naming the sslmode=disable opt-out and the secure modes) instead of the
 * driver's TLS handshake reset. A fake server on this machine's non-loopback
 * interface stands in for the remote host.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { createServer, type Server, type AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import * as db from '../src/core/db.ts';
import { toAgentError, cliRenderContext } from '../src/core/agent-output.ts';
import { classifyPgAccessError } from '../src/core/pg-access-classify.ts';
import { CODES } from '../src/core/error-registry.ts';

const ip = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
const servers: Server[] = [];

async function fakeServer(answer: 'N' | 'S'): Promise<number> {
  const srv = createServer(s => {
    s.on('error', () => {});
    s.once('data', () => { s.write(answer); s.once('data', () => s.destroy()); });
  });
  servers.push(srv);
  await new Promise<void>(r => srv.listen(0, '0.0.0.0', () => r()));
  return (srv.address() as AddressInfo).port;
}

async function connectError(url: string): Promise<unknown> {
  try { await db.connect({ database_url: url } as never); } catch (e) { return e; } finally { await db.disconnect(); }
  throw new Error('connect unexpectedly succeeded');
}

afterAll(() => { for (const s of servers) s.close(); });

describe.skipIf(!ip)('postgres_tls_required', () => {
  test('a non-local server without TLS fails with the coded error naming the opt-out and the secure modes', async () => {
    const port = await fakeServer('N');
    const e = await connectError(`postgres://u:p@${ip}:${port}/db?connect_timeout=3`);
    expect((e as { canonicalCode?: string }).canonicalCode).toBe('postgres_tls_required');
    const env = toAgentError(e, { transport: 'cli', command: 'doctor', render: cliRenderContext() });
    expect(env.code).toBe('postgres_tls_required');
    expect(env.message).toContain('TLS was required by default for a non-local Postgres host');
    expect(env.suggestion).toContain('sslmode=disable');
    expect(env.suggestion).toContain('sslmode=require');
    expect(env.suggestion).toContain('sslmode=verify-full');
    expect(env.why).toBeTruthy();
    expect(env.fix?.next).toBe('ask_user');
    expect(env.fix?.argv).toEqual(['gbrain', 'engine', 'status', '--probe', '--json']);
    expect(env.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'postgres_tls', '--json']);
    expect(classifyPgAccessError(e).reason).toBe('tls_required_default');
  }, 30_000);

  test('sslmode=disable in the URL opts out: no TLS is attempted, so the refusal never fires', async () => {
    const port = await fakeServer('N');
    const e = await connectError(`postgres://u:p@${ip}:${port}/db?connect_timeout=3&sslmode=disable`);
    expect((e as { canonicalCode?: string }).canonicalCode).toBeUndefined();
    expect(String((e as Error).message)).toContain('Cannot connect to database');
  }, 30_000);

  test('a server that does accept TLS but fails later keeps the original error', async () => {
    const port = await fakeServer('S');
    const e = await connectError(`postgres://u:p@${ip}:${port}/db?connect_timeout=3`);
    expect((e as { canonicalCode?: string }).canonicalCode).toBeUndefined();
  }, 30_000);
});

test('the registry explains postgres_tls_required', () => {
  const entry = (CODES as Record<string, { summary: string; suggestion?: string }>).postgres_tls_required;
  expect(entry).toBeDefined();
  expect(entry.suggestion).toContain('sslmode=disable');
});
