import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPgliteSnapshot, parseSnapshotProfile, reclaimDeadSnapshotOwner, snapshotLockIdentity, snapshotProfile } from '../../scripts/build-pglite-snapshot.ts';
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL } from '../../src/core/ai/defaults.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'snapshot-builder-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const bytes = (value: string) => new TextEncoder().encode(value);
const quiet = () => {};
const owner = (pid: number, token: string) => ({ ...snapshotLockIdentity(), pid, token, protocol: 1 });
async function departedPid() {
  const child = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  return child.pid;
}

describe('snapshot profiles and freshness', () => {
  test('legacy stays the default; invalid arguments are rejected', () => {
    expect(parseSnapshotProfile([])).toBe('legacy');
    expect(parseSnapshotProfile(['--profile', 'default'])).toBe('default');
    expect(parseSnapshotProfile(['--profile', 'legacy'])).toBe('legacy');
    for (const args of [['--profile'], ['--profile', 'other'], ['--unknown'], ['--profile', 'default', 'extra']]) {
      expect(() => parseSnapshotProfile(args)).toThrow('Usage:');
    }
  });

  test('profiles use canonical shapes and independent artifacts, locks, and freshness', async () => {
    const legacy = snapshotProfile('legacy', dir);
    const shipped = snapshotProfile('default', dir);
    expect(legacy.shape).toEqual(LEGACY_EMBEDDING_CONFIG);
    expect(shipped.shape).toEqual({ embedding_model: DEFAULT_EMBEDDING_MODEL, embedding_dimensions: DEFAULT_EMBEDDING_DIMENSIONS });
    expect(shipped.tar).not.toBe(legacy.tar);
    expect(shipped.version).not.toBe(legacy.version);
    expect(shipped.lock).not.toBe(legacy.lock);
    let builds = 0;
    const buildData = async () => bytes(`complete-${++builds}`);
    const opts = { fixtureDir: dir, buildData, log: quiet };
    expect(await buildPgliteSnapshot('legacy', opts)).toBe('built');
    expect(await buildPgliteSnapshot('default', opts)).toBe('built');
    expect(await buildPgliteSnapshot('legacy', opts)).toBe('fresh');
    expect(await buildPgliteSnapshot('default', opts)).toBe('fresh');
    expect(builds).toBe(2);
    const version = readFileSync(shipped.version, 'utf8');
    expect(version).toContain(`dims=${DEFAULT_EMBEDDING_DIMENSIONS}\nmodel=${DEFAULT_EMBEDDING_MODEL}\n`);
    writeFileSync(shipped.version, version.replace(/^dims=\d+$/m, 'dims=99999'));
    expect(await buildPgliteSnapshot('default', opts)).toBe('built');
    expect(readFileSync(shipped.tar, 'utf8')).toBe('complete-3');
    expect(readFileSync(legacy.tar, 'utf8')).toBe('complete-1');
    expect(readdirSync(dir).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
  });
});

describe('snapshot lock ownership and atomic publication', () => {
  test.each([false, true])('two subprocess builders publish one complete artifact (departed owner: %s)', async (departed) => {
    const paths = snapshotProfile('default', dir);
    if (departed) {
      mkdirSync(paths.lock);
      writeFileSync(join(paths.lock, 'owner.json'), JSON.stringify(owner(await departedPid(), 'departed-before-two-builders')));
    }
    const code = `
      import { appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { buildPgliteSnapshot } from './scripts/build-pglite-snapshot.ts';
      const dir = process.argv[1];
      const result = await buildPgliteSnapshot('default', { fixtureDir: dir, log: () => {}, buildData: async () => {
        appendFileSync(join(dir, 'builds'), 'build\\n');
        await Bun.sleep(100);
        return new TextEncoder().encode('complete artifact');
      }});
      console.log(result);
    `;
    const children = Array.from({ length: 2 }, () => Bun.spawn([process.execPath, '-e', code, dir], {
      cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe',
    }));
    const results = await Promise.all(children.map(async child => {
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(err).toBe('');
      expect(code).toBe(0);
      return out.trim();
    }));
    expect(results.sort()).toEqual(['built', 'fresh']);
    expect(readFileSync(join(dir, 'builds'), 'utf8')).toBe('build\n');
    expect(readFileSync(snapshotProfile('default', dir).tar, 'utf8')).toBe('complete artifact');
    expect(existsSync(snapshotProfile('default', dir).lock)).toBe(false);
  });

  test('a live owner times out without building, deleting its lock, or changing existing files', async () => {
    const paths = snapshotProfile('default', dir);
    mkdirSync(paths.lock);
    const record = JSON.stringify(owner(process.pid, 'live-owner'));
    writeFileSync(join(paths.lock, 'owner.json'), record);
    writeFileSync(paths.tar, 'old tar');
    writeFileSync(paths.version, 'old version');
    let built = false;
    await expect(buildPgliteSnapshot('default', {
      fixtureDir: dir, lockTimeoutMs: 0, log: quiet,
      buildData: async () => { built = true; return bytes('wrong'); },
    })).rejects.toThrow('refusing to build without ownership');
    expect(built).toBe(false);
    expect(readFileSync(join(paths.lock, 'owner.json'), 'utf8')).toBe(record);
    expect(readFileSync(paths.tar, 'utf8')).toBe('old tar');
    expect(readFileSync(paths.version, 'utf8')).toBe('old version');
  });

  test('a departed owner is reclaimed, while an ownerless lock fails closed', async () => {
    const paths = snapshotProfile('legacy', dir);
    mkdirSync(paths.lock);
    const record = JSON.stringify(owner(await departedPid(), '../../dead-owner/with-unsafe-path-characters'));
    writeFileSync(join(paths.lock, 'owner.json'), record);
    // An orphaned guard from the old implementation cannot wedge recovery.
    mkdirSync(`${paths.lock}.reclaim`);
    expect(await buildPgliteSnapshot('legacy', { fixtureDir: dir, log: quiet, buildData: async () => bytes('recovered') })).toBe('built');
    expect(existsSync(paths.lock)).toBe(false);
    const tombstones = readdirSync(dir).filter(name => /\.dead-[0-9a-f]{64}$/.test(name));
    expect(tombstones).toHaveLength(2);
    expect(tombstones.map(name => readFileSync(join(dir, name, 'owner.json'), 'utf8'))).toContain(record);
    const other = snapshotProfile('default', dir);
    mkdirSync(other.lock);
    await expect(buildPgliteSnapshot('default', { fixtureDir: dir, lockTimeoutMs: 0, log: quiet })).rejects.toThrow('lock timeout');
    expect(existsSync(other.lock)).toBe(true);
  });

  test('two stale reapers cannot rename a replacement live lock', async () => {
    const paths = snapshotProfile('default', dir);
    mkdirSync(paths.lock);
    const departed = owner(await departedPid(), 'departed-observed-twice');
    writeFileSync(join(paths.lock, 'owner.json'), JSON.stringify(departed));
    // Both reapers read the departed owner before either acts. The first
    // wins; a new live builder acquires before the second observer resumes.
    const first = JSON.parse(readFileSync(join(paths.lock, 'owner.json'), 'utf8'));
    const second = JSON.parse(readFileSync(join(paths.lock, 'owner.json'), 'utf8'));
    expect(reclaimDeadSnapshotOwner(paths.lock, first)).toBe(true);
    mkdirSync(paths.lock);
    const replacement = JSON.stringify(owner(process.pid, 'replacement-live-owner'));
    writeFileSync(join(paths.lock, 'owner.json'), replacement);
    expect(reclaimDeadSnapshotOwner(paths.lock, second)).toBe(false);
    expect(readFileSync(join(paths.lock, 'owner.json'), 'utf8')).toBe(replacement);
    expect(readdirSync(dir).filter(name => name.includes('.dead-'))).toHaveLength(1);
  });

  test.each([false, true])('an observer delayed past normal release cannot reclaim the next owner (build failed: %s)', async (failed) => {
    const paths = snapshotProfile('default', dir);
    const observedPath = join(dir, 'observed.json');
    const releasePath = join(dir, 'release');
    const code = `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { buildPgliteSnapshot, snapshotProfile } from './scripts/build-pglite-snapshot.ts';
      const dir = process.argv[1];
      try {
        await buildPgliteSnapshot('default', { fixtureDir: dir, log: () => {}, buildData: async () => {
          writeFileSync(join(dir, 'observed.json'), readFileSync(join(snapshotProfile('default', dir).lock, 'owner.json')));
          while (!existsSync(join(dir, 'release'))) await Bun.sleep(5);
          if (process.argv[2] === 'true') throw new Error('expected build failure');
          return new TextEncoder().encode('complete artifact');
        }});
      } catch { process.exit(1); }
    `;
    const child = Bun.spawn([process.execPath, '-e', code, dir, String(failed)], {
      cwd: resolve(import.meta.dir, '../..'), stdout: 'ignore', stderr: 'ignore',
    });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(observedPath) && Date.now() < deadline) await Bun.sleep(5);
      const observed = JSON.parse(readFileSync(observedPath, 'utf8'));
      writeFileSync(releasePath, 'continue');
      expect(await child.exited).toBe(failed ? 1 : 0);
      expect(existsSync(paths.lock)).toBe(false);
      mkdirSync(paths.lock);
      const replacement = JSON.stringify(owner(process.pid, 'live-after-normal-release'));
      writeFileSync(join(paths.lock, 'owner.json'), replacement);
      expect(reclaimDeadSnapshotOwner(paths.lock, observed)).toBe(false);
      expect(readFileSync(join(paths.lock, 'owner.json'), 'utf8')).toBe(replacement);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test('foreign and missing process identities cannot be reclaimed even when their PID is absent locally', async () => {
    const pid = await departedPid();
    const local = owner(pid, 'foreign-owner');
    const identities = [
      { ...local, platform: 'other-platform' },
      { ...local, hostname: `${local.hostname}-other-host` },
      { ...local, pidNamespace: `${local.pidNamespace}-other-namespace` },
      { ...local, pid: process.pid, pidNamespace: `${local.pidNamespace}-live-foreign-namespace` },
      { ...local, protocol: undefined },
      { pid, token: 'legacy-record-without-identity' },
    ];
    for (let index = 0; index < identities.length; index++) {
      const fixtureDir = join(dir, String(index));
      const paths = snapshotProfile('default', fixtureDir);
      mkdirSync(paths.lock, { recursive: true });
      const record = JSON.stringify(identities[index]);
      writeFileSync(join(paths.lock, 'owner.json'), record);
      let builds = 0;
      await expect(buildPgliteSnapshot('default', {
        fixtureDir, lockTimeoutMs: 0, log: quiet,
        buildData: async () => { builds++; return bytes('must not build'); },
      })).rejects.toThrow('lock timeout');
      expect(builds).toBe(0);
      expect(readFileSync(join(paths.lock, 'owner.json'), 'utf8')).toBe(record);
      expect(readdirSync(fixtureDir).some(name => name.includes('.dead-'))).toBe(false);
    }
  });

  test('failed byte generation leaves existing artifacts unchanged and releases ownership', async () => {
    const paths = snapshotProfile('legacy', dir);
    writeFileSync(paths.tar, 'old tar');
    writeFileSync(paths.version, 'old version');
    await expect(buildPgliteSnapshot('legacy', {
      fixtureDir: dir, log: quiet, buildData: async () => { throw new Error('simulated build failure'); },
    })).rejects.toThrow('simulated build failure');
    expect(readFileSync(paths.tar, 'utf8')).toBe('old tar');
    expect(readFileSync(paths.version, 'utf8')).toBe('old version');
    expect(existsSync(paths.lock)).toBe(false);
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  test('a process killed between publication renames leaves a stale version and can be recovered', async () => {
    const paths = snapshotProfile('default', dir);
    writeFileSync(paths.tar, 'old tar');
    writeFileSync(paths.version, 'old version');
    // Fault injection lives only in this subprocess. The real first rename
    // completes, then SIGKILL prevents the second rename and all finally code.
    const fixture = resolve(import.meta.dir, '../fixtures/snapshot-publication-crash.ts');
    const child = Bun.spawn([process.execPath, fixture, dir, paths.tar], {
      cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe('');
    expect(exitCode).not.toBe(0);
    expect(child.signalCode).toBe('SIGKILL');
    expect(readFileSync(paths.tar, 'utf8')).toBe('complete new tar');
    expect(readFileSync(paths.version, 'utf8')).toBe('old version');
    expect(existsSync(paths.lock)).toBe(true);
    let builds = 0;
    expect(await buildPgliteSnapshot('default', { fixtureDir: dir, log: quiet, buildData: async () => {
      builds++;
      return bytes('recovered tar');
    }})).toBe('built');
    expect(builds).toBe(1);
    expect(readFileSync(paths.tar, 'utf8')).toBe('recovered tar');
    expect(readFileSync(paths.version, 'utf8')).toContain(`dims=${DEFAULT_EMBEDDING_DIMENSIONS}\n`);
    expect(existsSync(paths.lock)).toBe(false);
  });

  test('lost ownership refuses publication and leaves the replacement owner intact', async () => {
    const paths = snapshotProfile('legacy', dir);
    const replacement = JSON.stringify(owner(process.pid, 'replacement-owner'));
    await expect(buildPgliteSnapshot('legacy', {
      fixtureDir: dir, log: quiet, buildData: async () => {
        writeFileSync(join(paths.lock, 'owner.json'), replacement);
        return bytes('must not publish');
      },
    })).rejects.toThrow('ownership lost');
    expect(existsSync(paths.tar)).toBe(false);
    expect(existsSync(paths.version)).toBe(false);
    expect(readFileSync(join(paths.lock, 'owner.json'), 'utf8')).toBe(replacement);
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('snapshot shell helper contracts', () => {
  function run(body: string, env: NodeJS.ProcessEnv = {}) {
    return Bun.spawnSync(['bash', '-c', '. "$1"\n' + body, 'snapshot-test', resolve(import.meta.dir, '../../scripts/lib/test-env.sh')], {
      cwd: dir,
      env: { ...process.env, GBRAIN_NO_SNAPSHOT: '', GBRAIN_TEST_DEFAULT_SNAPSHOT: '', GBRAIN_PGLITE_SNAPSHOT: 'legacy.tar', ...env },
      stdout: 'pipe', stderr: 'pipe',
    });
  }

  test('default build preserves the legacy parent and publishes an absolute child path', () => {
    const result = run('bun() { [ "$*" = "run build:pglite-snapshot --profile default" ]; }\nensure_default_pglite_snapshot test\nprintf "%s\\n%s\\n" "$GBRAIN_PGLITE_SNAPSHOT" "$GBRAIN_TEST_DEFAULT_SNAPSHOT"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split('\n')).toEqual(['legacy.tar', join(realpathSync(dir), 'test/fixtures/pglite-snapshot-default.tar')]);
  });

  test('build failure is nonfatal and leaves no default snapshot activated', () => {
    const result = run('bun() { return 1; }\nensure_default_pglite_snapshot test\nprintf "%s\\n" "${GBRAIN_TEST_DEFAULT_SNAPSHOT-unset}"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe('unset');
    expect(result.stderr.toString()).toContain('non-fatal');
  });

  test.each(['ensure_pglite_snapshot', 'ensure_default_pglite_snapshot'])('%s clears both inherited paths under the cold opt-out', (helper) => {
    const result = run(`${helper} test\nprintf "%s\\n%s\\n" "\${GBRAIN_PGLITE_SNAPSHOT-unset}" "\${GBRAIN_TEST_DEFAULT_SNAPSHOT-unset}"`, {
      GBRAIN_NO_SNAPSHOT: '1', GBRAIN_TEST_DEFAULT_SNAPSHOT: 'default.tar',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split('\n')).toEqual(['unset', 'unset']);
  });
});
