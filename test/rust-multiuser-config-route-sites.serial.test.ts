/**
 * One switch answer (I-0): a Rust brain that is multi-user only through its config row `engine.rust.multiuser` behaves
 * at every site after the store opens exactly as a brain with `GBRAIN_RUST_MULTIUSER=1`.
 *
 * Mode: two arms with the same assertions. The env arm turns the switch on in the owner and in this process. The config
 * arm seeds the brain with the switch off, sets its config row to `true`, and runs the owner and this process with
 * GBRAIN_RUST_MULTIUSER unset. Each arm asserts the switch's state here and the owner store's `multiuser: true`.
 *
 * 1. Protects: a client of a multi-user owner reads the brain's mode from the owner (its hello), so on both routes it
 *    sends registry writes whole (operation-load, whole-op), refuses a managed lock it cannot fence (managed-lock),
 *    marks remote frames (remote-check), runs a read lost at an owner crash again and answers a journaled put_page
 *    through the journal (client, whole-op), and lets `GBRAIN_RUST_SERVER_LISTEN` ask for a listener (serve-listen).
 *    After the crash this process owns the brain and its store is multi-user by the same route.
 * 2. Fails on: any of those sites reading only the environment switch (the config arm then gets a transactions refusal,
 *    a native lock, a lost read, an `outcome_unknown` put_page, or no listener).
 * 3. Existing coverage: rust-owner-whole-ops / rust-owner-handoff cover the env route only; rust-owner-ipc-remote-check
 *    and rust-serve-http-config-route cover the config route for the remote mark and the HTTP gate.
 * 4. Seam: none below the MCP dispatcher and the engine: real owner process, real socket, real store.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { RUST_MULTIUSER_CONFIG_KEY, rustMultiuserFromEnv } from '../src/core/rust-engine/multiuser-switch.ts';
import { remoteFrameMark } from '../src/core/rust-engine/owner-ipc/remote-check.ts';
import { rustListenRequested } from '../src/core/rust-engine/served/serve-listen.ts';
import { managedLock } from '../src/core/persistence/managed-lock.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

type Route = 'env' | 'config';
const saved = process.env.GBRAIN_RUST_MULTIUSER;
const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const engines: RustEngine[] = [];

const setSwitch = (route: Route) => { if (route === 'env') process.env.GBRAIN_RUST_MULTIUSER = '1'; else delete process.env.GBRAIN_RUST_MULTIUSER; };

async function open(dir: string): Promise<RustEngine> {
  const engine = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'rust', database_path: dir } as never);
  return engine;
}

/** The brain dir, seeded with the switch off; on the config route its config row turns multi-user mode on. */
async function seed(route: Route): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `gbrain-switch-${route}-`));
  dirs.push(dir);
  delete process.env.GBRAIN_RUST_MULTIUSER;
  const engine = await open(dir);
  expect(engine.multiuser).toBe(false);
  if (route === 'config') await engine.setConfig(RUST_MULTIUSER_CONFIG_KEY, 'true');
  await engine.disconnect();
  return dir;
}

async function startOwner(dir: string, route: Route): Promise<{ child: ChildProcessWithoutNullStreams; ready: Record<string, unknown>; exited: Promise<unknown> }> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.GBRAIN_RUST_MULTIUSER;
  const child = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'rust-owner-handoff-child.ts'), dir, rustArmAddonPath(), route, 'slow'], {
    env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr.on('data', () => {});
  const exited = new Promise(resolve => child.once('exit', resolve));
  let buffer = '';
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the owner child did not get ready')), 60_000);
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const msg = JSON.parse(line); if (msg.t === 'ready') { clearTimeout(timer); resolve(msg); } } catch { /* log line */ }
      }
    });
  });
  return { child, ready, exited };
}

const call = async (engine: RustEngine, name: string, params: Record<string, unknown>) => {
  const out = await dispatchToolCall(engine as unknown as BrainEngine, name, params, { remote: false } as never);
  const text = out.content.map(c => c.text ?? '').join('');
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return { isError: out.isError === true, code: (body.code ?? body.error) as string | undefined, text };
};

const outcome = (p: Promise<unknown>) => p.then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, code: (e as { code?: string }).code, reason: (e as { reason?: string }).reason }));

describeAddon('a brain multi-user by its config row behaves as one multi-user by the environment switch', () => {
  afterAll(async () => {
    for (const e of engines) await e.disconnect().catch(() => undefined);
    for (const c of children) c.kill('SIGKILL');
    for (const d of dirs) { rmSync(d, { recursive: true, force: true }); rmSync(`${d}.gbrain-owner.lock`, { force: true }); }
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  for (const route of ['env', 'config'] as const) {
    test(`${route} route: a client sends, refuses, marks, reruns and listens as multi-user, and the next owner is multi-user`, async () => {
      const dir = await seed(route);
      const owner = await startOwner(dir, route);
      expect(owner.ready).toMatchObject({ role: 'owner', multiuser: true });
      setSwitch(route);
      expect({ route, env: process.env.GBRAIN_RUST_MULTIUSER, fromEnv: rustMultiuserFromEnv() })
        .toEqual({ route, env: route === 'env' ? '1' : undefined, fromEnv: route === 'env' });
      const client = await open(dir);
      expect(client.ownerRole).toBe('client');
      expect(client.brainMultiuser).toBe(true);

      // operation-load + whole-op: a registry write goes to the owner whole, never the transactions refusal.
      const tag = await call(client, 'add_tag', { slug: 'notes/target', tag: 'alpha', request_id: randomUUID() });
      expect({ route, transactions: /cannot run from a second process|"transactions"/.test(tag.text), code: tag.code === 'engine_capability_missing' ? tag.code : null })
        .toEqual({ route, transactions: false, code: null });

      // managed-lock: a client holds no store, so it cannot fence a managed lock and refuses instead of a native lock alone.
      const lock = await outcome(managedLock(client, 'worktree', 'switch-check', { path: join(dir, 'switch-check.lock'), waitMs: 0 }) as Promise<unknown>);
      expect({ route, lock }).toEqual({ route, lock: { ok: false, code: 'lease_lost', reason: 'fence_missing' } });

      // remote-check: remote frames are marked by the owner's answer.
      const hello = (client as unknown as { _owner: { connection: { hello: { capabilities: string[] } } } })._owner.connection.hello;
      expect(remoteFrameMark(true, hello.capabilities)).toEqual({ remote: true });

      // serve-listen: the listen variable asks for a listener on a multi-user brain.
      expect(rustListenRequested([], { GBRAIN_RUST_SERVER_LISTEN: '127.0.0.1:0', GBRAIN_RUST_MULTIUSER: process.env.GBRAIN_RUST_MULTIUSER }, client)).toBe(true);

      // client + whole-op at an owner crash: a read in flight runs again on the next owner; a journaled put_page is
      // answered through the write journal, never `outcome_unknown`.
      const read = outcome(client.getIngestLog({ limit: 10 }));
      const put = call(client, 'put_page', { slug: 'notes/crash', content: '---\ntitle: Crash\n---\nBody.', request_id: randomUUID() });
      await Bun.sleep(100);
      owner.child.kill('SIGKILL');
      await owner.exited;
      expect({ route, read: await read }).toEqual({ route, read: { ok: true } });
      const written = await put;
      expect({ route, outcomeUnknown: /outcome_unknown/.test(written.text) }).toEqual({ route, outcomeUnknown: false });
      expect(client.ownerRole).toBe('owner');
      expect(client.openStore('switch-check').multiuser).toBe(true);
      expect(client.brainMultiuser).toBe(true);
      await client.disconnect();
    }, 120_000);
  }
});
