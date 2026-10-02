/**
 * #5237: a resident `gbrain serve` started in a `.gbrain-mount` project opens the
 * mounted brain, so its persistence owner socket must follow that brain. A CLI
 * write from the same project then reaches the owner and commits instead of
 * failing `owner_unavailable`; a serve on the host brain is unchanged.
 *
 * Serial: real `gbrain serve` and CLI subprocesses on PGLite under a sandboxed
 * HOME/GBRAIN_HOME; every serve child is stopped in afterEach.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import { resolveSocketPath } from '../src/core/context/resolve-ipc.ts';
import { persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const MOUNT = 'example-mount';

let root: string, home: string, hostDb: string, mountDb: string, project: string, neutral: string;
let serve: ReturnType<typeof Bun.spawn> | null = null;
let serveStderr = '';

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_MOUNTS_PATH: join(home, '.gbrain', 'mounts.json'),
    GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300' };
}

async function initBrain(path: string) {
  const config = { engine: 'pglite' as const, database_path: path };
  const engine = await createEngine(config);
  await engine.connect(config);
  await engine.initSchema();
  await engine.disconnect();
}

async function pageExists(path: string, slug: string): Promise<boolean> {
  const config = { engine: 'pglite' as const, database_path: path };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return (await engine.executeRaw('SELECT slug FROM pages WHERE slug=$1', [slug])).length === 1; }
  finally { await engine.disconnect(); }
}

async function startServe(cwd: string, readyDb: string) {
  serveStderr = '';
  serve = Bun.spawn(['bun', 'run', CLI, 'serve'], { cwd, env: env(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  void (async () => {
    const reader = (serve!.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; serveStderr += decoder.decode(value, { stream: true }); } } catch { /* child gone */ }
  })();
  // The persistence listener binds before the resolve listener in the same helper.
  const socket = resolveSocketPath(readyDb);
  const deadline = Date.now() + 120_000;
  while (!existsSync(socket)) {
    if (serve.exitCode !== null) throw new Error(`serve exited early (${serve.exitCode})\n${serveStderr}`);
    if (Date.now() > deadline) throw new Error(`serve never bound ${socket}\n${serveStderr}`);
    await Bun.sleep(150);
  }
}

async function stopServe() {
  if (!serve) return;
  if (serve.exitCode === null) { serve.kill('SIGTERM'); await Promise.race([serve.exited, Bun.sleep(15_000)]); }
  if (serve.exitCode === null) { serve.kill('SIGKILL'); await serve.exited; }
  serve = null;
}

async function cli(args: string[], cwd: string) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd, env: env(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-5237-'));
  home = join(root, 'h');
  hostDb = join(root, 'hdb');
  mountDb = join(root, 'mdb');
  project = join(root, 'p');
  neutral = join(root, 'n');
  for (const dir of [join(home, '.gbrain'), project, neutral, join(root, 'mount-clone')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: hostDb }));
  writeFileSync(join(home, '.gbrain', 'mounts.json'), JSON.stringify({ version: 1, mounts: [
    { id: MOUNT, path: join(root, 'mount-clone'), engine: 'pglite', database_path: mountDb, enabled: true },
  ] }), { mode: 0o600 });
  const dotfile = join(project, '.gbrain-mount');
  writeFileSync(dotfile, `${MOUNT}\n`);
  chmodSync(dotfile, 0o644);
  await initBrain(hostDb);
  await initBrain(mountDb);
}, 240_000);

afterEach(stopServe, 30_000);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('resident serve owner on a mounted brain (#5237)', () => {
  test('a CLI write from a .gbrain-mount project commits through the mounted serve owner', async () => {
    await startServe(project, hostDb);
    expect(existsSync(persistenceSocketPathForConfig({ engine: 'pglite', database_path: mountDb })!)).toBe(true);
    const put = await cli(['put', 'notes/mounted-example', '--content', '# Mounted example\n\nWritten through the resident owner.'], project);
    expect(put.stderr).not.toContain('owner_unavailable');
    expect(put.exitCode).toBe(0);
    await stopServe();
    expect(await pageExists(mountDb, 'notes/mounted-example')).toBe(true);
    expect(await pageExists(hostDb, 'notes/mounted-example')).toBe(false);
  }, 240_000);

  test('a serve on the host brain still owns the host socket and commits host writes', async () => {
    await startServe(neutral, hostDb);
    expect(existsSync(persistenceSocketPathForConfig({ engine: 'pglite', database_path: hostDb })!)).toBe(true);
    expect(existsSync(persistenceSocketPathForConfig({ engine: 'pglite', database_path: mountDb })!)).toBe(false);
    const put = await cli(['put', 'notes/host-example', '--content', '# Host example\n\nWritten through the host owner.'], neutral);
    expect(put.exitCode).toBe(0);
    await stopServe();
    expect(await pageExists(hostDb, 'notes/host-example')).toBe(true);
    expect(await pageExists(mountDb, 'notes/host-example')).toBe(false);
  }, 240_000);
});
