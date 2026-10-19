/**
 * #6907 (GBRA-133): `gbrain backup check` on a large or slow repository.
 *  - A dirty tree whose `git status --porcelain` passed 1 MiB overflowed the
 *    probe's buffer (ENOBUFS) and read `unknown / probe_failed` instead of
 *    `dirty`; the whole listing was read before anything was decided.
 *  - The remote probe had a hard-coded two-second timeout, so a remote that
 *    answers in three seconds could never be verified, and a timed-out probe
 *    looked like any other unverified (not backed up) repository in totals and
 *    in the human output.
 *
 * Protects: the dirtiness read stops at the first line that is not
 * physical-root metadata (a 1.3 MB listing reads dirty); the remote slot is
 * `backup.remote_timeout_ms` (env GBRAIN_BACKUP_REMOTE_TIMEOUT_MS wins),
 * clamped to 0.5-30 s, and scales the sweep budget; a timed-out probe is
 * counted in totals.remote_timeouts and named as a timeout, never as a missing
 * backup. Engine arms read the brain's config row: PGLite always, Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessBackupRepository, resolveBackupRemoteTimeoutMs } from '../../src/core/backup/repository.ts';
import { computeBackupCoverage } from '../../src/core/backup/coverage.ts';
import { blockingAssetReasons } from '../../src/core/backup/status-file.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

/** A repository pushed to a local bare origin. */
function pushedRepo(): { root: string; bare: string } {
  const bare = tmp('gbrain-6907-bare-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const root = join(tmp('gbrain-6907-'), 'brain'); mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.md'), '# a\n');
  git(root, 'add', '-A'); git(root, '-c', 'user.email=example@example.invalid', '-c', 'user.name=Example', 'commit', '-qm', 'a');
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { root, bare };
}

/** An HTTP smart remote for `bare` that answers after `delayMs`. */
function slowRemote(bare: string, delayMs: number) {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      await Bun.sleep(delayMs);
      if (!new URL(request.url).pathname.endsWith('/info/refs')) return new Response('not found', { status: 404 });
      const refs = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bare]);
      return new Response(Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), refs]), { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
    },
  });
}

describe('#6907 backup check on a large or slow repository', () => {
  test('#6907 dirty: more than 1 MiB of porcelain output reads dirty, not probe_failed', async () => {
    const { root } = pushedRepo();
    const name = 'x'.repeat(90);
    for (let d = 0; d < 120; d++) {
      mkdirSync(join(root, `inbox-${d}`));
      for (let i = 0; i < 100; i++) writeFileSync(join(root, `inbox-${d}`, `${name}-${i}.md`), 'v1\n');
    }
    git(root, 'add', '-A'); git(root, '-c', 'user.email=example@example.invalid', '-c', 'user.name=Example', 'commit', '-qm', 'bulk');
    git(root, 'push', '-q', 'origin', 'main');
    for (let d = 0; d < 120; d++) for (let i = 0; i < 100; i++) writeFileSync(join(root, `inbox-${d}`, `${name}-${i}.md`), 'v2\n');
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { maxBuffer: 64 << 20 }).length).toBeGreaterThan(1024 * 1024);
    const verdict = await assessBackupRepository(root, 'source_repo', 'example', new Date());
    expect({ state: verdict.state, detail: verdict.detail }).toEqual({ state: 'dirty', detail: 'uncommitted changes' });
  }, 120_000);

  test('#6907 timeout: backup.remote_timeout_ms is bounded and the environment wins', () => {
    expect(resolveBackupRemoteTimeoutMs(null, undefined)).toBe(2_000);
    expect(resolveBackupRemoteTimeoutMs('5000', undefined)).toBe(5_000);
    expect(resolveBackupRemoteTimeoutMs('5000', '7000')).toBe(7_000);
    expect(resolveBackupRemoteTimeoutMs('1', undefined)).toBe(500);
    expect(resolveBackupRemoteTimeoutMs('999999', undefined)).toBe(30_000);
    expect(resolveBackupRemoteTimeoutMs('soon', ' ')).toBe(2_000);
  });
});

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#6907 remote timeout from the brain's config (${backend})`, () => {
    test('#6907 timeout: a 3 s remote is verified with backup.remote_timeout_ms 6000; at the default it times out and is reported as a timeout, not a missing backup', async () => {
      const home = tmp('gbrain-6907-home-');
      await withEnv({ GBRAIN_HOME: home, GBRAIN_BACKUP_REMOTE_TIMEOUT_MS: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        const { root, bare } = pushedRepo();
        const server = slowRemote(bare, 3_000);
        try {
          git(root, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.port}/repo.git`);
          await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('backup-example','backup-example',$1,'{}')", [root]);
          const check = () => computeBackupCoverage(engine, { localGitProbes: true, verifyRemoteRefs: true });
          const asset = (status: Awaited<ReturnType<typeof check>>) => status.assets.find(a => a.id === 'backup-example')!;

          const timedOut = await check();
          expect(asset(timedOut).verification).toMatchObject({ state: 'unavailable', cause: 'timeout' });
          expect(timedOut.totals).toMatchObject({ remote_timeouts: 1, no_remote: 0, unpushed: 0, failing: 0 });
          expect(blockingAssetReasons(timedOut, 'aggregate').map(r => r.reason)).toEqual(['remote check timed out']);

          await engine.setConfig('backup.remote_timeout_ms', '6000');
          const verified = await check();
          expect(asset(verified)).toMatchObject({ state: 'ok', verification: { state: 'verified' } });
          expect(verified.totals).toMatchObject({ remote_timeouts: 0, recoverable_repos: 1 });
        } finally { server.stop(true); await close(); }
      });
    }, 120_000);
  });
}
