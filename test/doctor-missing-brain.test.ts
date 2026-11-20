/**
 * `gbrain doctor` on a brain whose configured PGLite datastore is not there
 * (unmounted drive, moved folder) must refuse BEFORE connecting, with the same
 * `missing_brain` reason `gbrain serve`'s status-only mode answers, and create
 * nothing: a health check never creates the thing it checks. Creating a new
 * empty brain is `gbrain init`, an explicit user decision.
 *
 * Spawns the real CLI against a temp GBRAIN_HOME with a keyless PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
let datastore: string;
let moved: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-missing-brain-'));
  const init = await runCli(['init', '--pglite', '--no-embedding'], { home, timeoutMs: 120_000 });
  expect(init.exitCode).toBe(0);
  datastore = join(home, '.gbrain', 'brain.pglite');
  expect(existsSync(datastore)).toBe(true);
  moved = `${datastore}.moved`;
  renameSync(datastore, moved); // the drive is unmounted / the folder moved
}, 180_000);

afterAll(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Everything under the gbrain home, so "creates nothing" is checked on the whole tree, not one path. */
function listing(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      out.push(p);
      if (e.isDirectory() && p !== moved) walk(p);
    }
  };
  walk(join(home, '.gbrain'));
  return out.sort();
}

const MODES: Array<[string, string[]]> = [
  ['doctor --json', ['doctor', '--json']],
  ['doctor --only connection --json', ['doctor', '--only', 'connection', '--json']],
  ['doctor --no-migrate --json', ['doctor', '--no-migrate', '--json']],
  ['doctor --tier ops --json', ['doctor', '--tier', 'ops', '--json']],
  ['doctor --remediation-plan --json', ['doctor', '--remediation-plan', '--json']],
  ['doctor --remediate --dry-run --json', ['doctor', '--remediate', '--dry-run', '--json']],
];

describe('doctor refuses a configured PGLite brain that is not there', () => {
  for (const [label, args] of MODES) {
    test(`${label}: exits non-zero with missing_brain and creates nothing`, async () => {
      const before = listing();
      const r = await runCli(args, { home, timeoutMs: 120_000 });
      expect(r.exitCode).not.toBe(0);
      const out = JSON.parse(r.stdout) as Record<string, any>;
      // The operator-protocol error envelope, never a health report.
      expect(out.status).not.toBe('healthy');
      expect(out.health_score).toBeUndefined();
      expect(out.reason).toBe('missing_brain');
      const text = JSON.stringify(out);
      expect(text).toContain('an unmounted drive or a moved folder?');
      expect(text).toContain('Nothing was created there.');
      expect(text).toContain('gbrain init');
      expect(out.fix?.actor).toBe('user');
      // Nothing was created: the configured path is still absent and the home tree is unchanged.
      expect(existsSync(datastore)).toBe(false);
      expect(listing()).toEqual(before);
    }, 180_000);
  }

  test('the datastore the user moved is untouched, and doctor works again once it is back', async () => {
    expect(existsSync(moved)).toBe(true);
    renameSync(moved, datastore);
    try {
      const r = await runCli(['doctor', '--only', 'connection', '--json'], { home, timeoutMs: 120_000 });
      const out = JSON.parse(r.stdout) as Record<string, any>;
      expect(out.reason).toBeUndefined();
      expect(out.checks.find((c: { name: string }) => c.name === 'connection')?.status).toBe('ok');
    } finally {
      renameSync(datastore, moved);
    }
  }, 180_000);

  test('--fast and filesystem-only --only never connect, so they still run and create nothing', async () => {
    const before = listing();
    const fast = await runCli(['doctor', '--fast', '--json'], { home, timeoutMs: 120_000 });
    expect(fast.stdout).toContain('"checks"');
    expect(existsSync(datastore)).toBe(false);
    expect(listing()).toEqual(before);
  }, 180_000);
});

describe('doctor --fast on a brain whose folder is missing runs exactly as before', () => {
  let fastHome: string;
  let fastStore: string;

  beforeAll(async () => {
    fastHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-missing-fast-'));
    const init = await runCli(['init', '--pglite', '--no-embedding'], { home: fastHome, timeoutMs: 120_000 });
    expect(init.exitCode).toBe(0);
    fastStore = join(fastHome, '.gbrain', 'brain.pglite');
    renameSync(fastStore, `${fastStore}.moved`);
  }, 180_000);

  afterAll(() => {
    try { rmSync(fastHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('exit 0, the usual fast report with the database checks skipped, no refusal, and no datastore created', async () => {
    const top = () => readdirSync(join(fastHome, '.gbrain')).sort();
    const before = top();
    const r = await runCli(['doctor', '--fast', '--json'], { home: fastHome, timeoutMs: 120_000 });
    // The same outcome master gives on this brain: --fast never opens the database, so the missing folder changes nothing.
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, any>;
    expect(out.reason).toBeUndefined();
    expect(out.code).toBeUndefined();
    expect(Array.isArray(out.checks)).toBe(true);
    const connection = out.checks.find((c: { name: string }) => c.name === 'connection');
    expect(connection?.status).toBe('warn');
    expect(connection?.message).toContain('Skipping DB checks (--fast mode');
    // Nothing is created where the brain should be. The only entry a fast run may add is doctor's own
    // audit folder (a skill snapshot, written on master too when the run has a skills dir); it holds no brain data.
    expect(existsSync(fastStore)).toBe(false);
    expect(top().filter((e) => !before.includes(e) && e !== 'audit')).toEqual([]);
  }, 180_000);
});
