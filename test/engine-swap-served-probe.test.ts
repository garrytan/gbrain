/**
 * The swap run's probe of the live brain server (src/core/engine-swap/served-probe.ts), against L3's real served server.
 *
 * 1. Protects: the swap run keeps a brain on the Rust server only when the address the plan bound answers as a served
 *    multi-user Rust brain for this brain; every other answer is a typed reason the run gives authority back on.
 * 2. Fails on: a probe that passes a server it cannot reach, a certificate it does not trust (and sends its token
 *    anyway), something on the port that is not a brain server, a credential the server refused, a server without
 *    multi_writer, or a server of another brain; a verdict that names the wrong reason.
 * 3. Existing coverage: none; the plan's config-only check is test/engine-swap-multi-host.test.ts.
 * 4. Seams: ok, unreachable, tls_failed, refused and wrong_brain run against the real `gbrain serve` with
 *    GBRAIN_RUST_SERVER_LISTEN on a non-loopback interface address and a self-signed certificate (test/helpers/two-host-brain.ts,
 *    real CLI, real addon). not_served runs against a real HTTPS server and a silent TCP server on that address.
 *    not_multi_writer cannot come from a real served Rust brain, since the listener starts only in multi-user mode,
 *    which always lists multi_writer: its row runs L3's real owner server and TLS listener over an engine whose
 *    capabilities omit it, beside a control row where the same engine lists it and passes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { probeServedDestination, probeUrl } from '../src/core/engine-swap/served-probe.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { OWNER_TOKEN_IDS_CONFIG_KEY } from '../src/core/rust-engine/served/auth.ts';
import { HAVE_TWO_HOST_ADDON, TWO_HOST_ADDON, interfaceAddress, selfSignedCert, startTwoHostBrain, type TwoHostBrain } from './helpers/two-host-brain.ts';

if (!HAVE_TWO_HOST_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${TWO_HOST_ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}
const ADDRESS = interfaceAddress();
const OTHER_BRAIN = '00000000-0000-4000-8000-000000000001';

describe('probeUrl', () => {
  test('a listen address becomes a TLS served URL (IPv6 in brackets)', () => {
    expect(probeUrl('10.0.0.5:7443')).toBe('gbrain+tls://10.0.0.5:7443');
    expect(probeUrl('[fd00::5]:7443')).toBe('gbrain+tls://[fd00::5]:7443');
  });
});

describe.skipIf(!HAVE_TWO_HOST_ADDON || !ADDRESS)('the probe against a real served multi-user Rust brain on a non-loopback address', () => {
  let brain: TwoHostBrain;
  beforeAll(async () => { brain = await startTwoHostBrain({ address: ADDRESS! }); }, 600_000);
  afterAll(async () => { await brain?.stop(); });

  const probe = (over: Partial<Parameters<typeof probeServedDestination>[0]> = {}) =>
    probeServedDestination({ listen: brain.listen, expectedBrainId: brain.brainId, token: brain.token, ca: brain.tls.certPem, timeoutMs: 5_000, ...over });

  test('ok: served, multi_writer and this brain', async () => {
    const v = await probe();
    expect(v).toMatchObject({ ok: true, url: `gbrain+tls://${ADDRESS}:${brain.port}`, brain_id: brain.brainId });
  });

  test('tls_failed: the self-signed certificate is not trusted, and the verdict carries no token', async () => {
    const v = await probe({ ca: undefined });
    expect(v).toMatchObject({ ok: false, reason: 'tls_failed' });
    expect(JSON.stringify(v)).not.toContain(brain.token);
  });

  test('tls_failed: a CA that is some other certificate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-probe-ca-'));
    try {
      const other = selfSignedCert(dir, ADDRESS!);
      expect(await probe({ ca: readFileSync(other.cert) })).toMatchObject({ ok: false, reason: 'tls_failed' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('refused: a credential the server does not accept', async () => {
    const v = await probe({ token: 'gbrain_not_a_real_owner_token' });
    expect(v).toMatchObject({ ok: false, reason: 'refused' });
    expect(JSON.stringify(v)).not.toContain('gbrain_not_a_real_owner_token');
  });

  test('wrong_brain: the server serves another brain than the one the plan swaps', async () => {
    const v = await probe({ expectedBrainId: OTHER_BRAIN });
    expect(v).toMatchObject({ ok: false, reason: 'wrong_brain', brain_id: brain.brainId });
  });

  test('unreachable: nothing listens on the address the plan bound', async () => {
    const port = await freePort(ADDRESS!);
    expect(await probe({ listen: `${ADDRESS}:${port}` })).toMatchObject({ ok: false, reason: 'unreachable' });
  });
});

describe.skipIf(!ADDRESS)('the probe against something on the address that is not a brain server', () => {
  let dir: string;
  let tls: { cert: Buffer; key: Buffer };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb-probe-other-'));
    const files = selfSignedCert(dir, ADDRESS!);
    tls = { cert: readFileSync(files.cert), key: readFileSync(files.key) };
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  test('not_served: an HTTPS server on the address', async () => {
    const https = Bun.serve({ hostname: ADDRESS!, port: 0, tls: { cert: tls.cert.toString(), key: tls.key.toString() }, fetch: () => new Response('not a brain') });
    try {
      const v = await probeServedDestination({ listen: `${ADDRESS}:${https.port}`, expectedBrainId: OTHER_BRAIN, token: 'gbrain_x', ca: tls.cert, timeoutMs: 2_000 });
      expect(v).toMatchObject({ ok: false, reason: 'not_served' });
    } finally { https.stop(true); }
  });

  test('not_served: a TLS server that never answers the hello', async () => {
    const tlsMod = await import('node:tls');
    const accepted: import('node:tls').TLSSocket[] = [];
    // Reads, never answers. Keep each socket: the server only closes once its own side of every socket is gone.
    const silent = tlsMod.createServer({ cert: tls.cert, key: tls.key }, s => { accepted.push(s); });
    await new Promise<void>(r => silent.listen(0, ADDRESS!, () => r()));
    try {
      const port = (silent.address() as net.AddressInfo).port;
      const v = await probeServedDestination({ listen: `${ADDRESS}:${port}`, expectedBrainId: OTHER_BRAIN, token: 'gbrain_x', ca: tls.cert, timeoutMs: 1_000 });
      expect(v).toMatchObject({ ok: false, reason: 'not_served' });
    } finally {
      for (const s of accepted) s.destroy();
      await new Promise<void>(r => silent.close(() => r()));
    }
  });
});

/**
 * not_multi_writer: L3's real owner server and TLS listener over an engine that omits multi_writer (no real served Rust
 * brain does), and the control where the same engine lists it.
 */
describe.skipIf(!ADDRESS)('the probe against a brain server without multi_writer', () => {
  const TOKEN = 'gbrain_owner_probe_test_token';
  const BRAIN = '00000000-0000-4000-8000-0000000000aa';
  let dir: string;
  let tls: { cert: Buffer; key: Buffer };
  const owners: OwnerEngineServer[] = [];
  const listeners: ServedListener[] = [];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gb-probe-mw-'));
    const files = selfSignedCert(dir, ADDRESS!);
    tls = { cert: readFileSync(files.cert), key: readFileSync(files.key) };
  });
  afterAll(async () => {
    for (const l of listeners.splice(0)) await l.close();
    for (const s of owners.splice(0)) await s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function host(capabilities: string[]): Promise<ServedListener> {
    const engine = {
      kind: 'rust', capabilities: new Set<string>(capabilities),
      getConfig: async (key: string) => key === OWNER_TOKEN_IDS_CONFIG_KEY ? JSON.stringify(['tok-1']) : null,
      readPersistenceBrainId: async () => BRAIN,
    } as unknown as BrainEngine;
    const info = { principal: { kind: 'legacy_token', id: 'tok-1' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false,
      member: null, mayActFor: null, attest: null, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    const server = (await serveOwnerEngine(engine, join(dir, `owner-${owners.length}.sock`), {
      served: {
        verify: { verify: async (_e, token) => { if (token === TOKEN) return { ...info }; throw new Error('Invalid token'); } },
        positions: async () => ({ sequence: 1, index: 0, exact: true }),
        helloTimeoutMs: 2_000,
        log: () => {},
      },
    }))!;
    owners.push(server);
    const listener = await listenServed(server, { host: ADDRESS!, port: 0, tls });
    listeners.push(listener);
    return listener;
  }

  test('not_multi_writer: the hello lists no multi_writer', async () => {
    const l = await host(['persistence_journal']);
    const v = await probeServedDestination({ listen: `${ADDRESS}:${l.port}`, expectedBrainId: BRAIN, token: TOKEN, ca: tls.cert });
    expect(v).toMatchObject({ ok: false, reason: 'not_multi_writer' });
  });

  test('control: the same server listing multi_writer passes', async () => {
    const l = await host(['persistence_journal', 'multi_writer']);
    const v = await probeServedDestination({ listen: `${ADDRESS}:${l.port}`, expectedBrainId: BRAIN, token: TOKEN, ca: tls.cert });
    expect(v).toMatchObject({ ok: true, brain_id: BRAIN });
  });
});

/** A port on `address` that nothing listens on (bound, read, then closed). */
async function freePort(address: string): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, address, () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}
