/**
 * Fix wave 5 cross-lane journeys on a mounted PGLite brain (ENG-O14), with
 * real `gbrain serve` and CLI subprocesses under a sandboxed HOME and a
 * non-default GBRAIN_HOME (so #5195 gives this brain its own autopilot job):
 *
 *   - #5237 + #5401 + #5195: a resident serve started in a `.gbrain-mount`
 *     project owns the mount; `gbrain projections drain` refuses with
 *     projection_owner_resident naming the mount and printing stop/drain/
 *     restart steps with this brain's autopilot names; a CLI write commits
 *     through the mounted owner; the printed manual-serve steps drain it.
 *   - #5157 + #5237: `POST /ingest` on `gbrain serve --http` in that project
 *     returns 409 with the hint for a legacy live row of the mount, and after
 *     the printed recovery commands it returns 202.
 *
 * Serial: real serve children bind sockets and hold PGLite locks; each is
 * stopped in afterEach. A real launchd/systemd job is not installed: the
 * install id is minted the way `gbrain autopilot --install` mints it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import { ensureAutopilotInstallId, resolveAutopilotJob } from '../src/core/autopilot-paths.ts';
import { argv } from './helpers/legacy-journey.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI = join(REPO_ROOT, 'src', 'cli.ts');
const MOUNT = 'example-mount';

let root: string, userHome: string, brainHome: string, hostDb: string, mountDb: string, project: string;
let serve: ReturnType<typeof Bun.spawn> | null = null;
let serveStderr = '';
let job: { launchdLabel: string; systemdUnit: string };

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'GBRAIN_AUTOPILOT_LABEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: userHome, GBRAIN_HOME: brainHome, GBRAIN_MOUNTS_PATH: join(brainHome, '.gbrain', 'mounts.json'),
    GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300' };
}

async function withBrain<T>(path: string, run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: path };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await engine.disconnect(); }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolvePort(port)); });
  });
}

/** Starts `gbrain serve [args]` in the project and waits until `ready` holds. */
async function startServe(args: string[], ready: () => Promise<boolean>) {
  serveStderr = '';
  serve = Bun.spawn(['bun', 'run', CLI, 'serve', ...args], { cwd: project, env: env(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  void (async () => {
    const reader = (serve!.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; serveStderr += decoder.decode(value, { stream: true }); } } catch { /* child gone */ }
  })();
  const deadline = Date.now() + 120_000;
  while (!(await ready())) {
    if (serve.exitCode !== null) throw new Error(`serve exited early (${serve.exitCode})\n${serveStderr}`);
    if (Date.now() > deadline) throw new Error(`serve never became ready\n${serveStderr}`);
    await Bun.sleep(150);
  }
}

async function stopServe() {
  if (!serve) return;
  if (serve.exitCode === null) { serve.kill('SIGTERM'); await Promise.race([serve.exited, Bun.sleep(15_000)]); }
  if (serve.exitCode === null) { serve.kill('SIGKILL'); await serve.exited; }
  serve = null;
}

async function cli(args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: project, env: { ...env(), ...extra }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
}

/** Runs a printed `gbrain …` command verbatim from the project. */
async function printed(command: string) {
  const args = argv(command);
  expect(args[0]).toBe('gbrain');
  return cli(args.slice(1));
}

const mountSocket = () => persistenceSocketPathForConfig({ engine: 'pglite', database_path: mountDb })!;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-w5m-'));
  userHome = join(root, 'u');
  brainHome = join(root, 'h');
  hostDb = join(root, 'hdb');
  mountDb = join(root, 'mdb');
  project = join(root, 'p');
  for (const dir of [userHome, join(brainHome, '.gbrain'), project, join(root, 'mount-clone')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(brainHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: hostDb }));
  writeFileSync(join(brainHome, '.gbrain', 'mounts.json'), JSON.stringify({ version: 1, mounts: [
    { id: MOUNT, path: join(root, 'mount-clone'), engine: 'pglite', database_path: mountDb, enabled: true },
  ] }), { mode: 0o600 });
  const dotfile = join(project, '.gbrain-mount');
  writeFileSync(dotfile, `${MOUNT}\n`);
  chmodSync(dotfile, 0o644);
  for (const path of [hostDb, mountDb]) await withBrain(path, engine => engine.initSchema());
  // #5195: this non-default home gets its own autopilot job once installed; mint its id as the installer does.
  job = await withEnv({ HOME: userHome, GBRAIN_HOME: brainHome, GBRAIN_AUTOPILOT_LABEL: undefined }, async () => {
    ensureAutopilotInstallId();
    const resolved = resolveAutopilotJob();
    expect(resolved.kind).toBe('suffixed');
    return resolved;
  });
}, 240_000);

afterEach(stopServe, 30_000);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('#5237 + #5401 + #5195 on a mounted PGLite resident', () => {
  test('drain refuses naming the mount with per-brain stop steps; a CLI write commits through the owner; the printed steps drain it', async () => {
    // An upgraded mount with a queued projection backlog.
    await withBrain(mountDb, async engine => {
      for (let i = 0; i < 5; i++) await engine.putPage(`notes/backlog-${i}`, { type: 'note', title: `Backlog ${i}`, compiled_truth: `Backlog note ${i}.` }, { sourceId: 'default' });
      await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE source_id='default'");
      await engine.executeRaw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
        SELECT s.incarnation,p.slug,p.knowledge_revision,'protocol_activation' FROM pages p JOIN sources s ON s.id=p.source_id
        WHERE p.deleted_at IS NULL ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision`);
    });
    await startServe([], async () => existsSync(mountSocket()));

    const refused = await cli(['projections', 'drain', '--json']);
    expect(refused.exitCode).toBe(2);
    const body = JSON.parse(refused.stdout) as { error: string; message: string; suggestion: string };
    expect(body.error).toBe('projection_owner_resident');
    expect(body.message).toContain(`The PGLite brain at ${mountDb} is held by gbrain serve (pid ${serve!.pid})`);
    expect(body.suggestion).toContain(`gbrain doctor --brain ${MOUNT}`);
    expect(body.suggestion).toContain(`launchctl bootout gui/$(id -u)/${job.launchdLabel} && { gbrain projections drain --brain ${MOUNT};`);
    expect(body.suggestion).toContain(`systemctl --user stop ${job.systemdUnit} && { gbrain projections drain --brain ${MOUNT}; systemctl --user start ${job.systemdUnit}; }`);
    expect(body.suggestion).not.toMatch(/com\.gbrain\.autopilot[ .]plist|gbrain-autopilot\.service/);

    const put = await cli(['put', 'notes/mounted-example', '--content', '# Mounted example\n\nWritten through the resident owner.']);
    expect(put.stderr).not.toContain('owner_unavailable');
    expect(put.exitCode).toBe(0);

    // The printed manual-serve steps, verbatim: stop it, run the drain, start gbrain serve again.
    const manual = /a manual gbrain serve: stop it \(kill (\d+)\), run (gbrain projections drain --brain \S+), then start gbrain serve again/.exec(body.suggestion);
    expect(manual?.[1]).toBe(String(serve!.pid));
    await stopServe();
    const drained = await printed(`${manual![2]} --json`);
    expect(drained.exitCode).toBe(0);
    expect(JSON.parse(drained.stdout)).toMatchObject({ failed: [], remaining: 0 });
    await startServe([], async () => existsSync(mountSocket()));
    await stopServe();

    await withBrain(mountDb, async engine => {
      expect(await engine.getPage('notes/mounted-example', { sourceId: 'default' })).not.toBeNull();
      expect(await engine.executeRaw(`SELECT slug FROM pages WHERE deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision`)).toEqual([]);
    });
    await withBrain(hostDb, async engine => { expect(await engine.getPage('notes/mounted-example', { sourceId: 'default' })).toBeNull(); });
  }, 300_000);
});

describe('#5157 /ingest through a mounted serve owner', () => {
  test('a legacy live row of the mount gives 409 with the hint; after the printed recovery commands /ingest returns 202', async () => {
    // `gbrain auth` opens the host config's brain even inside a .gbrain-mount project, while the mounted serve verifies
    // tokens against the mount; so the token is minted with a config that names the mount's datastore.
    const tokenHome = join(root, 'token-home');
    mkdirSync(join(tokenHome, '.gbrain'), { recursive: true });
    writeFileSync(join(tokenHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: mountDb }));
    const created = await cli(['auth', 'create', 'w5-journey', '--scopes', 'read,write'], { GBRAIN_HOME: tokenHome });
    expect(created.exitCode).toBe(0);
    const token = (created.stdout.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    expect(token).not.toBe('');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const http = () => startServe(['--http', '--bind', '127.0.0.1', '--port', String(port)],
      async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } });
    const ingest = (content: string) => fetch(`${base}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/markdown' }, body: content });
    const content = '# Mounted capture\n\nThe mounted-ingest-marker note survives the v0.50 upgrade.';

    // The capture was queued before the upgrade; the upgrade left its row with SQL NULL authority.
    await http();
    const first = await ingest(content);
    expect(first.status).toBe(202);
    const jobId = (await first.json() as { job_id: number }).job_id;
    await stopServe();
    await withBrain(mountDb, engine => engine.executeRaw("UPDATE minion_jobs SET status='waiting', submission_authority=NULL WHERE id=$1", [jobId]));

    await http();
    const refused = await ingest(content);
    expect(refused.status).toBe(409);
    const body = await refused.json() as { error: string; message: string; hint: string; docs_url: string };
    expect(body).toMatchObject({ error: 'permission_denied', docs_url: 'docs/guides/repair.md#legacy-job-authority' });
    expect(body.message).toContain(`job ${jobId} (ingest_capture, waiting)`);
    expect(body.hint).toStartWith('Stop producers (gbrain serve, gbrain autopilot) and workers');

    const commands: string[] = [];
    await stopServe();
    commands.push('stop gbrain serve');
    const preview = /preview with (gbrain jobs authorize-legacy --select "[^"]+")/.exec(body.hint)?.[1];
    expect(preview).toBeDefined();
    const previewed = await printed(preview!);
    expect(previewed.exitCode).toBe(0);
    expect(previewed.stdout).toContain('(SQL NULL authority, authorizable): 1');
    commands.push(preview!);
    const apply = /Apply exactly this set: (.+)$/m.exec(previewed.stdout)?.[1];
    expect(apply).toMatch(/--expect [a-f0-9]{64} --yes$/);
    expect((await printed(apply!)).exitCode).toBe(0);
    commands.push(apply!);
    await http();
    commands.push('restart gbrain serve');
    const accepted = await ingest(content);
    expect(accepted.status).toBe(202);
    expect((await accepted.json() as { job_id: number }).job_id).toBe(jobId);
    expect(commands.length).toBeLessThanOrEqual(6);
    await stopServe();

    await withBrain(mountDb, async engine => {
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs WHERE submission_authority IS NULL'))[0].n).toBe(0);
    });
    await withBrain(hostDb, async engine => {
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs'))[0].n).toBe(0);
    });
  }, 300_000);
});
