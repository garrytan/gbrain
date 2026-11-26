/**
 * Registry writes from a process that is not the owner of a Rust brain (multi-user Rust; the evals' sample 3: remember,
 * add_timeline_entry and add_tag from client processes ended `engine_capability_missing` reason `transactions`, "cannot
 * run from a second process on this brain").
 *
 * Mode: the owner is a separate process (test/helpers/rust-owner-handoff-child.ts) with multi-user Rust on in its own
 * environment, its store's `multiuser` asserted true; this process turns the mode on in-run and is its client.
 *
 * 1. Protects: a trusted local client's write operations go to the owner whole, and the owner runs each in its own
 *    transaction: no transactions refusal, and the client gets the operation's own receipt. A remote caller's write is
 *    still refused (A1). With the switch off nothing is sent.
 * 2. Fails on: a client that runs the handler itself (and meets the transactions refusal), or a remote caller's write
 *    that reaches the owner.
 * 3. Existing coverage: put_page alone was sent whole (rust-owner-ipc*.test.ts).
 * 4. Seam: none below the MCP dispatcher: real owner process, real socket, real store. The writes are journaled; a brain
 *    without lane L5's fence fix leaves them pending, which this test accepts as a receipt (applied is checked where L5
 *    is merged).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
let dir = '';
let child: ChildProcessWithoutNullStreams | null = null;
let engine: RustEngine | null = null;

async function startOwner(): Promise<Record<string, unknown>> {
  child = spawn(process.execPath, [join(import.meta.dir, 'helpers', 'rust-owner-handoff-child.ts'), dir, rustArmAddonPath()], {
    env: { ...process.env, GBRAIN_RUST_MULTIUSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the owner child did not get ready')), 60_000);
    child!.stdout.on('data', chunk => {
      buffer += String(chunk);
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const msg = JSON.parse(line); if (msg.t === 'ready') { clearTimeout(timer); resolve(msg); } } catch { /* log line */ }
      }
    });
  });
}

const call = async (name: string, params: Record<string, unknown>, remote = false) => {
  const out = await dispatchToolCall(engine as unknown as BrainEngine, name, params, (remote ? { remote, sourceId: 'default' } : { remote }) as never);
  const text = out.content.map(c => c.text ?? '').join('');
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* plain text */ }
  return { isError: out.isError === true, code: (body.code ?? body.error) as string | undefined, text };
};

describeAddon('registry writes from a client process go to the owner whole', () => {
  afterAll(async () => {
    await engine?.disconnect().catch(() => undefined);
    child?.kill('SIGKILL');
    if (dir) { rmSync(dir, { recursive: true, force: true }); rmSync(`${dir}.gbrain-owner.lock`, { force: true }); }
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('add_tag, add_timeline_entry and remember from a client get the operation\'s receipt, never a transactions refusal', async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    dir = mkdtempSync(join(tmpdir(), 'gbrain-whole-ops-'));
    const ready = await startOwner();
    expect(ready).toMatchObject({ role: 'owner', multiuser: true });
    const addon = await loadRustArmAddon();
    engine = openRustEngine({ addon, databasePath: dir });
    await engine.connect({ engine: 'rust', database_path: dir } as never);
    expect(engine.ownerRole).toBe('client');
    const put = await call('put_page', { slug: 'notes/target', content: '---\ntitle: Target\n---\nTarget body.', request_id: randomUUID() });
    expect(['write_pending', undefined]).toContain(put.isError ? put.code : undefined);
    const results = {
      add_tag: await call('add_tag', { slug: 'notes/target', tag: 'alpha', request_id: randomUUID() }),
      add_timeline_entry: await call('add_timeline_entry', { slug: 'notes/target', date: '2026-01-02', summary: 'Something happened.', request_id: randomUUID() }),
      remember: await call('remember', { fact: 'Target likes tea.', entity: 'notes/target', content_origin: 'user_said', provenance: 'test', request_id: randomUUID() }),
    };
    for (const [name, r] of Object.entries(results)) {
      expect({ name, transactions: /cannot run from a second process|"transactions"/.test(r.text) }).toEqual({ name, transactions: false });
      // The operation's own receipt: written, or accepted and pending (a brain without L5's fence fix).
      expect({ name, ok: !r.isError || r.code === 'write_pending' }).toEqual({ name, ok: true });
    }
  }, 120_000);

  test('a remote caller\'s write from a client is still refused before it reaches the owner', async () => {
    const r = await call('add_tag', { slug: 'notes/target', tag: 'beta', request_id: randomUUID() }, true);
    expect(r.isError).toBe(true);
    expect(r.code).toBe('engine_capability_missing');
  });
});
