/**
 * The two-host topology the swap's shadow-and-back test runs on (test/helpers/two-host-brain.ts): a server host that
 * owns a Rust brain and serves it with GBRAIN_RUST_SERVER_LISTEN on a non-loopback interface address over a self-signed
 * certificate, and a second writer host whose config names that server in rust_server.url.
 *
 * 1. Protects: the fixture is the real M1 topology: the second host writes through the server and the owner reads it,
 *    the owner host writes and the second host reads it, both hosts see one brain, and the swap's probe passes it.
 * 2. Fails on: a client that opens a brain of its own, a write that does not reach the owner's brain, a serve that
 *    listens on a loopback address or without TLS, a probe that refuses the real topology.
 * 3. Existing coverage: test/rust-served-cli.test.ts serves on loopback TCP to one reading client; nothing writes from
 *    two hosts over TLS on a non-loopback address.
 * 4. Seams: none. Real CLI, real addon, real TLS. The shadow-and-back steps are todo: the swap run and its failback reach
 *    the multi-user trunk with the main merge that takes in 2ed944aafd (rust-engine/swap-pg-run).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeServedDestination } from '../src/core/engine-swap/served-probe.ts';
import { HAVE_TWO_HOST_ADDON, TWO_HOST_ADDON, interfaceAddress, startTwoHostBrain, type TwoHostBrain } from './helpers/two-host-brain.ts';

if (!HAVE_TWO_HOST_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${TWO_HOST_ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}
const ADDRESS = interfaceAddress();

const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
/** `get --json` prints the get_page result: the page body is its compiled_truth. */
const bodyOf = (stdout: string): string => {
  const parsed = JSON.parse(stdout) as { compiled_truth?: unknown };
  expect(typeof parsed.compiled_truth).toBe('string');
  return parsed.compiled_truth as string;
};
/** Every file under a directory, so the client host can be shown to hold no brain store. */
const filesUnder = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => join(e.parentPath, e.name))
  : [];

describe.skipIf(!HAVE_TWO_HOST_ADDON || !ADDRESS)('two writer hosts on one served multi-user Rust brain', () => {
  let brain: TwoHostBrain;
  beforeAll(async () => { brain = await startTwoHostBrain({ address: ADDRESS! }); }, 600_000);
  afterAll(async () => { await brain?.stop(); });

  test('the server listens with TLS on the non-loopback address, and the client host has no brain of its own', () => {
    expect(brain.address.startsWith('127.')).toBe(false);
    expect(brain.serveLog()).toContain(`brain server listening on ${brain.address}:${brain.port} (TLS`);
    expect(brain.serveLog()).not.toContain(brain.token);
    const clientConfig = JSON.parse(readFileSync(join(brain.clientHome, '.gbrain', 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(clientConfig.database_path).toBeUndefined();
    expect(clientConfig.database_url).toBeUndefined();
    expect((clientConfig.rust_server as { url?: string }).url).toBe(brain.url);
    expect(filesUnder(brain.clientHome).filter(f => /\.(redb|db)$|pglite/i.test(f))).toEqual([]);
    expect(filesUnder(join(brain.root, 'server', 'db')).length).toBeGreaterThan(0);
  });

  test('the second host writes through rust_server.url and the owner host reads the write', async () => {
    const put = await brain.cli('client', ['put', 'notes/from-client', '--content', page('From client', 'Written on the second host.'), '--json']);
    expect(put.exitCode).toBe(0);
    const read = await brain.cli('server', ['get', 'notes/from-client', '--json']);
    expect(read.exitCode).toBe(0);
    expect(bodyOf(read.stdout)).toContain('Written on the second host.');
  }, 120_000);

  test('the owner host writes and the second host reads the write', async () => {
    const put = await brain.cli('server', ['put', 'notes/from-server', '--content', page('From server', 'Written on the owner host.'), '--json']);
    expect(put.exitCode).toBe(0);
    const read = await brain.cli('client', ['get', 'notes/from-server', '--json']);
    expect(read.exitCode).toBe(0);
    expect(bodyOf(read.stdout)).toContain('Written on the owner host.');
    const seed = await brain.cli('client', ['get', 'notes/two-host-seed', '--json']);
    expect(bodyOf(seed.stdout)).toContain('Written on the server host.');
  }, 120_000);

  test('the swap probe passes the topology: served, multi_writer and this brain', async () => {
    const v = await probeServedDestination({ listen: brain.listen, expectedBrainId: brain.brainId, token: brain.token, ca: brain.tls.certPem });
    expect(v).toMatchObject({ ok: true, brain_id: brain.brainId });
  });

  // Shadow and back: waits for the swap run on the multi-user trunk (the main merge that takes in 2ed944aafd).
  test.todo('both hosts write to a Postgres brain for the observation window; the plan on the serving host reads READY on config only', () => {});
  test.todo('engine swap --to rust --yes --expect <hash> runs shadow, switch and cutover; the probe passes and the second host keeps writing through rust_server.url', () => {});
  test.todo('a server that is down at cutover: the probe fails and the run gives authority back to Postgres (fail-first restore row)', () => {});
  test.todo('engine swap --to postgres fails back; every write from both hosts is on Postgres, none lost and none doubled', () => {});
});
