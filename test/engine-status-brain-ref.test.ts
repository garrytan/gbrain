/**
 * `gbrain engine status --json --probe` prints `brain_ref` (src/core/brain-ref.ts): a one-way reference to the brain
 * that the engine swap's dated readiness override binds. Real CLI children against a real PGLite brain in a temp
 * GBRAIN_HOME.
 *
 * Pins:
 *   - the probe prints the brain_ref brainRefFor(persistence_brain.brain_id) gives (the shared function the swap
 *     override uses), in JSON and human output;
 *   - the persistence identity never appears in stdout or stderr, in any spelling;
 *   - while `gbrain serve` holds the brain, the probe reads the reference that serve recorded (0600, no identity in it)
 *     and refuses a reference another holder wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { brainRefFor, readBrainRef } from '../src/core/brain-ref.ts';
import { brainRefSidecarPath } from '../src/commands/serve-brain-ref.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let home: string;
let dataDir: string;
let brainId: string;
/** The value the engine swap override reads for this brain, through the same shared function. */
let sharedRef: string | null;

function childEnv(): Record<string, string> {
  return keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_BRAIN_ID: undefined, GBRAIN_SOURCE: undefined,
    GBRAIN_NON_INTERACTIVE: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', NO_COLOR: '1',
  });
}

async function gbrain(args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
    cwd: home, env: childEnv(), stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 90_000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, status };
  } finally {
    clearTimeout(killer);
  }
}

/** Every spelling of the identity a leak could take: as stored, upper case, without hyphens. */
function expectNoIdentity(text: string): void {
  for (const spelling of [brainId, brainId.toUpperCase(), brainId.replace(/-/g, ''), brainId.replace(/-/g, '').toUpperCase()]) {
    expect(text.includes(spelling)).toBe(false);
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-brain-ref-'));
  const init = await gbrain(['init', '--pglite', '--no-embedding', '--json']);
  if (init.status !== 0) throw new Error(`init failed:\n${init.stdout}\n${init.stderr}`);
  dataDir = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8')).database_path;
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir });
  try {
    brainId = (await engine.readPersistenceBrainId())!;
    sharedRef = await readBrainRef(engine);
  } finally {
    await engine.disconnect();
  }
  expect(brainId).toMatch(/^[0-9a-f-]{36}$/);
}, 180_000);

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

describe('brainRefFor', () => {
  test('16 hex characters, one per brain, and not a bare SHA-256 prefix of the identity', () => {
    const ref = brainRefFor(brainId);
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    expect(brainRefFor(brainId)).toBe(ref);
    expect(brainRefFor('00000000-0000-4000-8000-000000000000')).not.toBe(ref);
    expect(new Bun.CryptoHasher('sha256').update(brainId).digest('hex').startsWith(ref)).toBe(false);
  });
});

describe('gbrain engine status --probe prints brain_ref', () => {
  test('JSON: probe.brain_ref is the value the shared brainRefFor gives for this brain, and the identity never prints', async () => {
    const r = await gbrain(['engine', 'status', '--json', '--probe']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(report.probe.ok).toBe(true);
    expect(report.probe.brain_ref).toBe(brainRefFor(brainId));
    expect(sharedRef).toBe(report.probe.brain_ref);
    expectNoIdentity(r.stdout + r.stderr);
  }, 120_000);

  test('human output names the reference and never the identity', async () => {
    const r = await gbrain(['engine', 'status', '--probe']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Ref:     ${brainRefFor(brainId)}`);
    expectNoIdentity(r.stdout + r.stderr);
  }, 120_000);

  test('without --probe the brain is not opened and no brain_ref is printed', async () => {
    const r = await gbrain(['engine', 'status', '--json']);
    expect(r.stdout.includes('brain_ref')).toBe(false);
  }, 120_000);
});

describe('while gbrain serve holds the brain', () => {
  let serve: ChildProcess | null = null;
  let serveErr = '';

  beforeAll(async () => {
    serve = spawn(process.execPath, ['--no-env-file', CLI, 'serve'], { cwd: home, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    serve.stderr?.on('data', (d: Buffer) => { serveErr += d.toString(); });
    const sidecar = brainRefSidecarPath(dataDir);
    const deadline = Date.now() + 90_000;
    while (!existsSync(sidecar) && Date.now() < deadline) await Bun.sleep(200);
    if (!existsSync(sidecar)) throw new Error(`serve wrote no brain reference:\n${serveErr}`);
  }, 120_000);

  afterAll(async () => {
    if (!serve) return;
    const exited = new Promise(resolve => serve!.once('exit', resolve));
    serve.stdin?.end();
    serve.kill('SIGTERM');
    await Promise.race([exited, Bun.sleep(15_000)]);
    try { serve.kill('SIGKILL'); } catch { /* gone */ }
  });

  test('the probe reports locked_by_serve and the brain_ref the serve recorded', async () => {
    const r = await gbrain(['engine', 'status', '--json', '--probe']);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    expect(report.probe.note).toBe('locked_by_serve');
    expect(report.probe.brain_ref).toBe(brainRefFor(brainId));
    expectNoIdentity(r.stdout + r.stderr);
    // The serve's own brain_ref lines; its managed content path, which predates this field, is outside this pin.
    expectNoIdentity(serveErr.split('\n').filter(line => line.includes('brain_ref')).join('\n'));
  }, 120_000);

  test('the recorded file is 0600 and holds the reference, never the identity', () => {
    const path = brainRefSidecarPath(dataDir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(text).brain_ref).toBe(brainRefFor(brainId));
    expectNoIdentity(text);
  });

  test('a reference another lock holder wrote is refused as stale, not printed', async () => {
    const path = brainRefSidecarPath(dataDir);
    const kept = readFileSync(path, 'utf8');
    try {
      writeFileSync(path, JSON.stringify({ version: 1, brain_ref: 'ffffffffffffffff', holder: '0000000000000000' }));
      const r = await gbrain(['engine', 'status', '--json', '--probe']);
      const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      expect(report.probe.brain_ref).toBeNull();
      expect(report.probe.brain_ref_note).toBe('serve_brain_ref_stale');
    } finally {
      writeFileSync(path, kept, { mode: 0o600 });
    }
  }, 120_000);
});

describe('recordServeBrainRef', () => {
  test('writes nothing for a brain this process does not hold', async () => {
    const { recordServeBrainRef } = await import('../src/commands/serve-brain-ref.ts');
    const other = join(home, 'not-held.pglite');
    const read = { readPersistenceBrainId: async () => brainId };
    expect(await recordServeBrainRef(read, other)).toBeNull();
    expect(existsSync(brainRefSidecarPath(other))).toBe(false);
  });
});

describe('the served engine records its own datastore, and again after a reconnect', () => {
  let held: PGLiteEngine;
  let mount: PGLiteEngine;
  let mountDir: string;
  let mountId: string;

  beforeAll(async () => {
    held = new PGLiteEngine();
    await held.connect({ engine: 'pglite', database_path: dataDir });
    mountDir = join(home, 'mounted.pglite');
    mount = new PGLiteEngine();
    await mount.connect({ engine: 'pglite', database_path: mountDir });
    await mount.initSchema();
    mountId = (await mount.readPersistenceBrainId())!;
  }, 120_000);

  afterAll(async () => {
    await held?.disconnect();
    await mount?.disconnect();
  });

  test('a reconnect takes a fresh lock token, and the reference is recorded again under it', async () => {
    const { recordServeBrainRefAtStart, readServeBrainRef } = await import('../src/commands/serve-brain-ref.ts');
    await recordServeBrainRefAtStart(held, () => {});
    expect(readServeBrainRef(dataDir)).toEqual({ brain_ref: brainRefFor(brainId) });
    await held.reconnect();
    const deadline = Date.now() + 10_000;
    while (readServeBrainRef(dataDir).brain_ref === null && Date.now() < deadline) await Bun.sleep(50);
    expect(readServeBrainRef(dataDir)).toEqual({ brain_ref: brainRefFor(brainId) });
  }, 60_000);

  test('a served brain outside the host config (a mount) records under its own data directory', async () => {
    const { recordServeBrainRefAtStart, readServeBrainRef } = await import('../src/commands/serve-brain-ref.ts');
    await recordServeBrainRefAtStart(mount, () => {});
    expect(readServeBrainRef(mountDir)).toEqual({ brain_ref: brainRefFor(mountId) });
    expect(brainRefFor(mountId)).not.toBe(brainRefFor(brainId));
  }, 60_000);
});
