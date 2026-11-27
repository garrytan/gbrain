/**
 * The write-request receipt tools over a real stdio `gbrain serve` on a Rust-engine brain, against the same serve on a
 * PGLite brain, for an installation that has no local writer registration yet.
 *
 * Each brain is new and its gbrain home holds no cli or stdio writer registration: the PGLite brain's database is
 * created by `gbrain stats --json`, and the Rust brain's store by opening the store directly (openRustStore, the same
 * open the engine makes), since a read command never creates a missing Rust store (it refuses with brain_missing). The test then starts `gbrain serve` (the real CLI entry, one child process per brain), sends the MCP initialize handshake, waits
 * until the serve has written its stdio writer registration (bounded), and then calls get_write_request,
 * list_write_requests and cancel_write_request. Nothing was ever written, so both brains must answer not_found, an
 * empty list and not_found.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: an agent's receipt reads on a Rust brain answer as on PGLite. The serve registers this installation's
 *    cli and stdio local writers at boot on every engine (persistence/provider.ts servePersistenceIpcProvider), and
 *    the receipt check runs under the stdio registration (ops/persistence.ts receiptAccess).
 * 2. Fails when: a Rust serve skips the registration (the serve path registered writers only inside the persistence
 *    provider, which a Rust brain does not get), so the three tools answer writer_registration_required where PGLite
 *    answers not_found or an empty list; or a receipt read on Rust stops on a refusal before its answer.
 * 3. Existing coverage: test/rust-engine-construct.test.ts and test/engine-parity/writer-registration.test.ts call
 *    the provider and the registration in process; nothing ran the three tools through a stdio serve on a Rust brain.
 * 4. Seams: none. It runs the real CLI and needs the addon `bun run rust:build` writes; it skips without it
 *    (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

type Backend = 'pglite' | 'rust';
interface Brain { backend: Backend; home: string; db: string }

const root = mkdtempSync(join(tmpdir(), 'gbrain-rust-mcp-receipts-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const REQUEST_ID = '00000000-0000-4000-8000-00000000c0de';
/** The registration wait: a serve that registers writes the file well inside it. */
const REGISTRATION_WAIT_MS = 30_000;
const CALL_TIMEOUT_MS = 60_000;

function makeBrain(backend: Backend): Brain {
  const home = join(root, backend, 'home');
  const db = join(root, backend, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: backend, database_path: db }));
  return { backend, home, db };
}

function childEnv(brain: Brain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key]; // keyless: no provider is ever called
  }
  return {
    ...out, HOME: brain.home, GBRAIN_HOME: brain.home, TZ: 'UTC',
    GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_NO_TELEMETRY: '1',
    // The onboarding refresher reads the brain beside the calls; nothing here needs it.
    GBRAIN_NO_ONBOARD_NUDGE: '1',
    ...(brain.backend === 'rust' ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
  };
}

/** True once the serve wrote this brain's stdio writer registration (persistence/identity.ts persistenceHome). */
function stdioRegistered(brain: Brain): boolean {
  const dir = join(brain.home, '.gbrain', 'persistence');
  return existsSync(dir) && readdirSync(dir).some((name) => name.endsWith('.stdio.json'));
}

/** What a tool call answered: the parsed JSON text, or the error code it refused with. */
function outcome(response: any): unknown {
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return { response };
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return { text }; }
  return response.result.isError ? { error: parsed.code ?? parsed.error } : parsed;
}

/** True once any local writer of this brain registered (a cli or stdio registration file). */
function anyWriterRegistered(brain: Brain): boolean {
  const dir = join(brain.home, '.gbrain', 'persistence');
  return existsSync(dir) && readdirSync(dir).some((name) => /\.(cli|stdio)\.json$/.test(name));
}

/**
 * Creates the brain's database and registers no local writer. PGLite: a read command (`gbrain stats --json`) creates
 * it. Rust: a read command refuses a missing store (brain_missing), so the store is created by opening it directly, the
 * open the engine makes, with no CLI and no gbrain home involved.
 */
async function createBrain(brain: Brain): Promise<Brain> {
  if (brain.backend === 'rust') {
    const { loadRustAddon } = await import('../src/core/rust-engine/addon-loader.ts');
    const { openRustStore } = await import('../src/core/rust-engine/store.ts');
    const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } });
    const store = await openRustStore(addon, brain.db);
    await store.close();
    expect(existsSync(join(brain.db, 'FORMAT'))).toBe(true);
  } else {
    const proc = Bun.spawn(['bun', CLI, 'stats', '--json'], { cwd: root, env: childEnv(brain), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`stats on ${brain.backend} exited ${exitCode}: ${stdout}${stderr}`);
  }
  expect(anyWriterRegistered(brain)).toBe(false);
  return brain;
}

/** Starts a stdio serve, waits for its stdio registration (bounded), then calls each tool in turn. */
async function serveCalls(brain: Brain, calls: Array<{ name: string; arguments: Record<string, unknown> }>): Promise<{ registered: boolean; answers: unknown[] }> {
  const proc = Bun.spawn(['bun', CLI, 'serve'], { cwd: root, env: childEnv(brain), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const pending = new Map<number, (msg: any) => void>();
  const send = (msg: unknown) => { proc.stdin.write(JSON.stringify(msg) + '\n'); proc.stdin.flush(); };
  const request = (id: number, method: string, params: unknown) => new Promise<any>((done) => { pending.set(id, done); send({ jsonrpc: '2.0', id, method, params }); });
  const killer = setTimeout(() => proc.kill('SIGKILL'), CALL_TIMEOUT_MS);
  const stderr = new Response(proc.stderr).text();
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg: any; try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === 'number') { pending.get(msg.id)?.(msg); pending.delete(msg.id); }
      }
    }
    for (const done of pending.values()) done(undefined);
  })();
  try {
    await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rust-mcp-receipts', version: '1' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const deadline = Date.now() + REGISTRATION_WAIT_MS;
    while (!stdioRegistered(brain) && Date.now() < deadline) await Bun.sleep(100);
    const registered = stdioRegistered(brain);
    const answers: unknown[] = [];
    let id = 2;
    for (const call of calls) answers.push(outcome(await request(id++, 'tools/call', call)));
    return { registered, answers };
  } catch (error) {
    throw new Error(`serve on ${brain.backend} failed: ${String(error)}\n${await stderr}`);
  } finally {
    clearTimeout(killer);
    proc.stdin.end();
    await proc.exited;
    await reading;
  }
}

const CALLS = [
  { name: 'get_write_request', arguments: { request_id: REQUEST_ID } },
  { name: 'list_write_requests', arguments: {} },
  { name: 'cancel_write_request', arguments: { request_id: REQUEST_ID } },
];
const EXPECTED = [{ error: 'not_found' }, { requests: [], next: null }, { error: 'not_found' }];

describe.skipIf(!HAVE_ADDON)('write-request receipt tools over a stdio serve, new installation', () => {
  test('a Rust serve registers its writers and answers not_found, an empty list and not_found, as PGLite does', async () => {
    const [pglite, rust] = await Promise.all((['pglite', 'rust'] as const).map(async (backend) =>
      serveCalls(await createBrain(makeBrain(backend)), CALLS)));
    expect(pglite).toEqual({ registered: true, answers: EXPECTED });
    expect(rust).toEqual(pglite);
  }, 150_000);
});
