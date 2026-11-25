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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

describe('doctor also refuses a mounted brain whose folder is missing, and an empty mount point', () => {
  let edgeHome: string;
  let edgeStore: string;
  const mountsFile = () => join(edgeHome, '.gbrain', 'mounts.json');
  const writeMount = (databasePath: string) => {
    const clone = join(edgeHome, 'team-clone');
    mkdirSync(clone, { recursive: true });
    writeFileSync(mountsFile(), JSON.stringify({ version: 1, mounts: [{ id: 'team', path: clone, engine: 'pglite', database_path: databasePath }] }));
  };
  const tree = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        out.push(p);
        if (e.isDirectory() && !p.endsWith('.moved')) walk(p);
      }
    };
    walk(join(edgeHome, '.gbrain'));
    return out.sort();
  };

  beforeAll(async () => {
    edgeHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-missing-edge-'));
    const init = await runCli(['init', '--pglite', '--no-embedding'], { home: edgeHome, timeoutMs: 120_000 });
    expect(init.exitCode).toBe(0);
    edgeStore = join(edgeHome, '.gbrain', 'brain.pglite');
  }, 180_000);

  afterAll(() => {
    try { rmSync(edgeHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a mounted PGLite brain whose folder is missing: refused, and nothing is created at its database_path', async () => {
    const mountStore = join(edgeHome, 'team-brain.pglite');
    writeMount(mountStore);
    const before = tree();
    const r = await runCli(['doctor', '--brain', 'team', '--only', 'connection', '--json'], { home: edgeHome, timeoutMs: 120_000 });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout) as Record<string, any>;
    expect(out.status).not.toBe('healthy');
    expect(out.reason).toBe('missing_brain');
    expect(JSON.stringify(out)).toContain(mountStore);
    expect(existsSync(mountStore)).toBe(false);
    expect(tree()).toEqual(before);
  }, 180_000);

  test('an empty mount point where the brain should be (an unmounted drive): refused, left empty, for the host and for a mount', async () => {
    renameSync(edgeStore, `${edgeStore}.moved`);
    mkdirSync(edgeStore); // the mount point an unmounted drive leaves behind
    const mountPoint = join(edgeHome, 'team-mountpoint');
    mkdirSync(mountPoint);
    writeMount(mountPoint);
    try {
      const before = tree();
      for (const args of [['doctor', '--only', 'connection', '--json'], ['doctor', '--brain', 'team', '--only', 'connection', '--json']]) {
        const r = await runCli(args, { home: edgeHome, timeoutMs: 120_000 });
        expect(r.exitCode).toBe(1);
        const out = JSON.parse(r.stdout) as Record<string, any>;
        expect(out.reason).toBe('missing_brain');
        expect(out.health_score).toBeUndefined();
        expect(readdirSync(edgeStore)).toEqual([]);
        expect(readdirSync(mountPoint)).toEqual([]);
        expect(tree()).toEqual(before);
      }
    } finally {
      rmSync(edgeStore, { recursive: true, force: true });
      renameSync(`${edgeStore}.moved`, edgeStore);
    }
  }, 240_000);

  test('the refusal is the registered brain_missing error (exit 1) and tells an agent to ask the user, not to rerun doctor', async () => {
    renameSync(edgeStore, `${edgeStore}.moved`);
    try {
      const r = await runCli(['doctor', '--json'], { home: edgeHome, timeoutMs: 120_000 });
      expect(r.exitCode).toBe(1);
      const out = JSON.parse(r.stdout) as Record<string, any>;
      expect(out.code).toBe('brain_missing');
      expect(out.fix?.actor).toBe('user');
      expect(out.fix?.next).toBe('ask_user');
      // The plain (no --json) form refuses on stderr and prints no report on stdout.
      const plain = await runCli(['doctor'], { home: edgeHome, timeoutMs: 120_000 });
      expect(plain.exitCode).toBe(1);
      expect(plain.stdout).toBe('');
      expect(plain.stderr).toContain('brain_missing');
    } finally {
      renameSync(`${edgeStore}.moved`, edgeStore);
    }
  }, 240_000);

  test('a filesystem-only --only still runs with the datastore missing, and creates nothing', async () => {
    renameSync(edgeStore, `${edgeStore}.moved`);
    try {
      const before = tree();
      const r = await runCli(['doctor', '--only', 'agent_contract', '--json'], { home: edgeHome, timeoutMs: 120_000 });
      const out = JSON.parse(r.stdout) as Record<string, any>;
      expect(out.reason).toBeUndefined();
      expect(out.code).toBeUndefined();
      expect(out.checks.map((c: { name: string }) => c.name)).toContain('agent_contract');
      expect(existsSync(edgeStore)).toBe(false);
      expect(existsSync(edgeStore)).toBe(false);
      expect(tree().filter((p) => !before.includes(p) && !p.includes('/audit'))).toEqual([]);
    } finally {
      renameSync(`${edgeStore}.moved`, edgeStore);
    }
  }, 180_000);
});

describe('the guard follows what the connector really opens', () => {
  let h: string;
  let store: string;
  const mountsFile = () => join(h, '.gbrain', 'mounts.json');
  const cfgFile = () => join(h, '.gbrain', 'config.json');
  const mountEntry = (id: string, databasePath: string, extra: Record<string, unknown> = {}) => {
    const clone = join(h, `clone-${id}`);
    mkdirSync(clone, { recursive: true });
    return { id, path: clone, engine: 'pglite', database_path: databasePath, ...extra };
  };
  const writeMounts = (...mounts: Array<Record<string, unknown>>) => writeFileSync(mountsFile(), JSON.stringify({ version: 1, mounts }));
  const tree = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        out.push(p);
        if (e.isDirectory() && !p.endsWith('.moved') && !p.endsWith('.healthy')) walk(p);
      }
    };
    walk(join(h, '.gbrain'));
    return out.sort();
  };
  const doctorJson = async (...extra: string[]) => {
    const r = await runCli(['doctor', ...extra, '--only', 'connection', '--json'], { home: h, timeoutMs: 120_000 });
    return { r, out: JSON.parse(r.stdout) as Record<string, any> };
  };

  beforeAll(async () => {
    h = mkdtempSync(join(tmpdir(), 'gbrain-doctor-missing-follow-'));
    expect((await runCli(['init', '--pglite', '--no-embedding'], { home: h, timeoutMs: 120_000 })).exitCode).toBe(0);
    store = join(h, '.gbrain', 'brain.pglite');
    cpSync(store, `${store}.healthy`, { recursive: true }); // an initialized datastore to point a healthy mount at
  }, 180_000);

  afterAll(() => {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a folder holding only stray files (no PG_VERSION) is not a brain: refused and left as it was, host and mount', async () => {
    const stray = join(h, 'stray-mount');
    mkdirSync(stray);
    writeFileSync(join(stray, '.DS_Store'), 'x');
    writeMounts(mountEntry('team', stray));
    renameSync(store, `${store}.moved`);
    mkdirSync(store);
    writeFileSync(join(store, '.DS_Store'), 'x');
    try {
      const before = tree();
      for (const extra of [[], ['--brain', 'team']]) {
        const { r, out } = await doctorJson(...extra);
        expect(r.exitCode).toBe(1);
        expect(out.reason).toBe('missing_brain');
        expect(existsSync(join(store, 'PG_VERSION'))).toBe(false);
        expect(existsSync(join(stray, 'PG_VERSION'))).toBe(false);
        expect(tree()).toEqual(before);
      }
    } finally {
      rmSync(store, { recursive: true, force: true });
      renameSync(`${store}.moved`, store);
    }
  }, 240_000);

  test('a mount alias equal to another mount id never stands in for it: the selected id is the one checked', async () => {
    const missing = join(h, 'alias-missing.pglite');
    const healthy = join(h, 'alias-healthy.pglite');
    cpSync(`${store}.healthy`, healthy, { recursive: true });
    // `alpha` carries the alias `team`; the registry opens the mount whose id is exactly `team`.
    writeMounts(mountEntry('alpha', healthy, { alias: 'team' }), mountEntry('team', missing));
    const refused = await doctorJson('--brain', 'team');
    expect(refused.r.exitCode).toBe(1);
    expect(refused.out.reason).toBe('missing_brain');
    expect(JSON.stringify(refused.out)).toContain(missing);
    expect(existsSync(missing)).toBe(false);
    // The other way round: the aliased mount is missing, the exact-id mount is healthy, so doctor must run on it.
    const healthyTeam = join(h, 'alias-healthy-team.pglite');
    cpSync(`${store}.healthy`, healthyTeam, { recursive: true });
    writeMounts(mountEntry('alpha', missing, { alias: 'team' }), mountEntry('team', healthyTeam));
    const ran = await doctorJson('--brain', 'team');
    expect(ran.out.reason).toBeUndefined();
    expect(ran.out.code).not.toBe('brain_missing');
    expect(existsSync(missing)).toBe(false);
  }, 240_000);

  test('an engine pglite config that also carries a database_url still opens its folder, so a missing folder is refused (host and mount)', async () => {
    const mountStore = join(h, 'url-mount.pglite');
    writeMounts(mountEntry('team', mountStore, { database_url: 'postgresql://127.0.0.1:1/none' }));
    const cfg = JSON.parse(readFileSync(cfgFile(), 'utf-8')) as Record<string, unknown>;
    const original = JSON.stringify(cfg);
    writeFileSync(cfgFile(), JSON.stringify({ ...cfg, database_url: 'postgresql://127.0.0.1:1/none' }));
    renameSync(store, `${store}.moved`);
    try {
      const before = tree();
      for (const extra of [[], ['--brain', 'team']]) {
        const { r, out } = await doctorJson(...extra);
        expect(r.exitCode).toBe(1);
        expect(out.reason).toBe('missing_brain');
        expect(existsSync(store)).toBe(false);
        expect(existsSync(mountStore)).toBe(false);
        expect(tree()).toEqual(before);
      }
    } finally {
      writeFileSync(cfgFile(), original);
      renameSync(`${store}.moved`, store);
    }
  }, 240_000);

  test('the refusal for a mount never offers `gbrain init --pglite` (it rewrites the host config); the host one still does', async () => {
    const mountStore = join(h, 'advice-mount.pglite');
    writeMounts(mountEntry('team', mountStore));
    const mount = await doctorJson('--brain', 'team');
    expect(mount.out.code).toBe('brain_missing');
    expect(JSON.stringify(mount.out)).not.toContain('gbrain init --pglite');
    expect(JSON.stringify(mount.out)).toContain('mount `team`');
    renameSync(store, `${store}.moved`);
    try {
      const host = await doctorJson();
      expect(host.out.code).toBe('brain_missing');
      expect(JSON.stringify(host.out)).toContain('gbrain init --pglite --no-embedding --path');
    } finally {
      renameSync(`${store}.moved`, store);
    }
  }, 240_000);

  test('an empty mount point that still holds a stale, unreadable .gbrain-lock beside the kernel-v1 owner marker: refused, nothing created', async () => {
    // The unmounted drive leaves its mount point; the sibling `<brain>.gbrain-owner.json` init wrote stays on the parent.
    // The leftover lock folder's metadata is unreadable, so the status probe calls the lock held, but no process holds it.
    expect(JSON.parse(readFileSync(`${store}.gbrain-owner.json`, 'utf8')).protocol).toBe('kernel-v1');
    renameSync(store, `${store}.moved`);
    mkdirSync(join(store, '.gbrain-lock'), { recursive: true });
    writeFileSync(join(store, '.gbrain-lock', 'lock'), '{not json');
    try {
      const before = tree();
      const { r, out } = await doctorJson();
      expect(r.exitCode).toBe(1);
      expect(out.code).toBe('brain_missing');
      expect(out.reason).toBe('missing_brain');
      expect(out.health_score).toBeUndefined();
      expect(existsSync(join(store, 'PG_VERSION'))).toBe(false);
      expect(readdirSync(store)).toEqual(['.gbrain-lock']);
      expect(readFileSync(join(store, '.gbrain-lock', 'lock'), 'utf8')).toBe('{not json');
      expect(tree()).toEqual(before);
    } finally {
      rmSync(store, { recursive: true, force: true });
      renameSync(`${store}.moved`, store);
    }
  }, 240_000);
});

describe('doctor --alert on a brain whose folder is missing answers with the alert contract', () => {
  let h: string;
  let store: string;
  const tree = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        out.push(p);
        if (e.isDirectory() && !p.endsWith('.moved')) walk(p);
      }
    };
    walk(join(h, '.gbrain'));
    return out.sort();
  };
  /** The alert streak file is gbrain's own state, not a datastore; every other doctor --alert run writes it too. */
  const withoutAlertState = (paths: string[]) => paths.filter((p) => !p.endsWith('doctor-alert-state.json'));

  beforeAll(async () => {
    h = mkdtempSync(join(tmpdir(), 'gbrain-doctor-missing-alert-'));
    expect((await runCli(['init', '--pglite', '--no-embedding'], { home: h, timeoutMs: 120_000 })).exitCode).toBe(0);
    store = join(h, '.gbrain', 'brain.pglite');
    renameSync(store, `${store}.moved`);
  }, 180_000);

  afterAll(() => {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  for (const extra of [[], ['--tier', 'standard'], ['--only', 'connection']]) {
    test(`doctor --alert --json${extra.length ? ` ${extra.join(' ')}` : ''}: exit 17, alert.level act, alert.items names brain_missing, nothing created`, async () => {
      const before = withoutAlertState(tree());
      const r = await runCli(['doctor', '--alert', '--json', ...extra], { home: h, timeoutMs: 120_000 });
      expect(r.exitCode).toBe(17);
      const out = JSON.parse(r.stdout) as Record<string, any>;
      expect(out.alert.level).toBe('act');
      expect(out.alert.unknown).toEqual([]);
      expect(out.alert.consecutive_unknown).toBe(0);
      expect(out.alert.items).toHaveLength(1);
      expect(out.alert.items[0]).toMatchObject({ code: 'brain_missing', check: 'connection', status: 'fail' });
      expect(out.alert.items[0].message).toContain('Nothing was created there.');
      expect(out.alert.items[0].fix).toMatchObject({ actor: 'user', next: 'ask_user' });
      // The brain_missing envelope a caller already reads stays, and it is never a health report.
      expect(out.code).toBe('brain_missing');
      expect(out.reason).toBe('missing_brain');
      expect(out.health_score).toBeUndefined();
      expect(existsSync(store)).toBe(false);
      expect(withoutAlertState(tree())).toEqual(before);
    }, 180_000);
  }

  test('doctor --alert (text): exit 17, an [ACT] line naming brain_missing and the fix, nothing created', async () => {
    const before = withoutAlertState(tree());
    const r = await runCli(['doctor', '--alert'], { home: h, timeoutMs: 120_000 });
    expect(r.exitCode).toBe(17);
    expect(r.stdout).toContain('Alert: act');
    expect(r.stdout).toMatch(/\[ACT\] .*brain_missing/);
    expect(r.stdout).toContain('Nothing was created there.');
    expect(existsSync(store)).toBe(false);
    expect(withoutAlertState(tree())).toEqual(before);
  }, 180_000);

  test('without --alert the refusal is unchanged: exit 1, the brain_missing error envelope with no alert', async () => {
    const r = await runCli(['doctor', '--json'], { home: h, timeoutMs: 120_000 });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout) as Record<string, any>;
    expect(out.code).toBe('brain_missing');
    expect(out.alert).toBeUndefined();
    expect(existsSync(store)).toBe(false);
  }, 180_000);
});
