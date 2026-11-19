/**
 * Engine graduation versus every other client of the brain: older released
 * binaries, a `foresights serve` respawned mid-copy, a resident serve that must
 * hand the source over, and stale CLI or MCP configurations after cutover.
 *
 * Protects: §3.3 and §6.4 of the plan plus §13 CEO/DX (tombstone, marker
 * hand-off, split-brain detection, database fence, one-step stale-client fix).
 * - An older release pointed at the tombstoned path fails (EEXIST/ENOTDIR)
 *   and never creates a fresh empty brain there. This half runs before the
 *   orchestrator lands, against a tombstone written to the Tombstone contract.
 * - In the rename-to-tombstone window an older release can create a stray
 *   brain; the next `--resume` refuses with `graduation_split_brain` and the
 *   target stays non-authoritative.
 * - A write by an older release in a lock gap before the tombstone reaches
 *   the target on resume (source digests re-checked).
 * - An older release configured with the target URL cannot write while the
 *   target is fenced (copying, and between verify and cutover).
 * - A respawned stdio or HTTP serve exits with `graduation_in_progress`,
 *   writes nothing and takes no lock; a resident serve hands off within 30 s.
 * - A stale CLI config and a stale MCP config each recover by running the
 *   refusal's fix once.
 * Serve processes and stale clients run in graduation-clients-serve.test.ts
 * (shared steps: test/helpers/graduation-clients-cases.ts).
 * Not covered elsewhere: these are the only multi-process client tests.
 * Older binaries are built once per tag (test/helpers/graduation-e2e.ts
 * `olderReleaseBinary`, cached under GBRAIN_OLDER_RELEASE_DIR).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  codeOf, custodyPaths, DATABASE_URL, digestChanges, fixOf, gbrain, graduationTest, olderReleaseBinary,
  previousReleaseTags, release, startGbrain, stateDigest, waitForEvent, type GbrainResult,
} from '../helpers/graduation-e2e.ts';
import { closeCases, fresh, staleHome } from '../helpers/graduation-clients-cases.ts';
import { configuredEngine, expectGraduated, planAndRun, targetRowState, withTarget } from '../helpers/graduation-scenarios.ts';

let older: { tag: string; binary: string }[] = [];
let olderError: string | null = null;

beforeAll(() => {
  try { older = previousReleaseTags(2).map(tag => ({ tag, binary: olderReleaseBinary(tag) })); }
  catch (error) { olderError = String(error); }
}, 900_000);

afterAll(closeCases);

/** The Tombstone contract written by hand (O_EXCL, 0600, fsync file + parent), for the pre-integration half. */

async function olderRun(binary: string, home: string, argv: string[], stdin?: string): Promise<GbrainResult> {
  return gbrain(argv, { home, binary, stdin, timeoutMs: 120_000 });
}

describe.skipIf(!DATABASE_URL)('graduation: older released binaries', () => {
  test('older releases refuse a tombstoned path and never create a data dir there', async () => {
    expect(olderError).toBeNull();
    expect(older.length).toBe(2);
    const c = await fresh('older-tombstone');
    const { argv, env } = await planAndRun(c);
    expect((await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 })).code).toBe(0);
    const home = staleHome(c);
    const tombstoneBytes = readFileSync(c.fx.dataDir);
    const retained = custodyPaths(c.fx.dataDir).graduated;
    expect(retained.length).toBe(1);
    const retainedBefore = await stateDigest(retained[0]);
    for (const { tag, binary } of older) {
      for (const [argv, stdin] of [[['query', 'acme'], undefined], [['put', 'notes/older-write', '--source', 'default'], 'older binary write\n']] as const) {
        const r = await olderRun(binary, home, [...argv], stdin);
        expect({ tag, argv: argv[0], failed: r.code !== 0 }).toEqual({ tag, argv: argv[0], failed: true });
        expect(`${r.stdout}${r.stderr}`).toMatch(/EEXIST|ENOTDIR|engine_graduated/);
        expect(statSync(c.fx.dataDir).isFile()).toBe(true);
        expect(readFileSync(c.fx.dataDir).equals(tombstoneBytes)).toBe(true);
      }
    }
    expect(digestChanges(retainedBefore, await stateDigest(retained[0]))).toEqual([]);
  }, 900_000);

  graduationTest('an older release in the rename-to-tombstone window: a stray brain is reported as split brain and the target stays withheld', async () => {
    const c = await fresh('older-window');
    const { argv, env } = await planAndRun(c);
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['moved_aside'] } });
    await waitForEvent(c.events, e => e.event === 'paused', child);
    child.kill('SIGKILL');
    await child.exited;
    const home = staleHome(c);
    const stray = await olderRun(older[0].binary, home, ['put', 'notes/stray', '--source', 'default'], 'stray brain write\n');
    const createdStray = custodyPaths(c.fx.dataDir).dataDirIsDirectory;
    const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 });
    if (createdStray) {
      expect(resumed.code).toBe(1);
      expect(codeOf(resumed.json)).toBe('graduation_split_brain');
      expect(fixOf(resumed.json)?.next).toBe('ask_user');
      expect(await targetRowState(c.target.url)).not.toBe('authoritative');
      const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
      const text = JSON.stringify(status.json);
      expect(text).toContain(c.fx.dataDir);
      expect(text).toContain('.graduated-');
    } else {
      expect(stray.code).not.toBe(0);
      expect(resumed.code).toBe(0);
      await expectGraduated(c, 'window without a stray brain');
    }
  }, 900_000);

  graduationTest('an older release after the tombstone fails EEXIST; resume completes', async () => {
    const c = await fresh('older-after-tombstone');
    const { argv, env } = await planAndRun(c);
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['tombstoned'] } });
    await waitForEvent(c.events, e => e.event === 'paused', child);
    child.kill('SIGKILL');
    await child.exited;
    for (const { binary } of older) {
      const r = await olderRun(binary, staleHome(c), ['query', 'acme']);
      expect(r.code).not.toBe(0);
      expect(statSync(c.fx.dataDir).isFile()).toBe(true);
    }
    expect((await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 })).code).toBe(0);
    await expectGraduated(c, 'after tombstone kill');
  }, 900_000);

  for (const boundary of ['verified', 'source_closed'] as const) {
    graduationTest(`an older-release write to the source in the lock gap after ${boundary} reaches the target on resume`, async () => {
      const c = await fresh(`older-gap-${boundary}`);
      const { argv, env } = await planAndRun(c);
      const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: [boundary] } });
      await waitForEvent(c.events, e => e.event === 'paused', child);
      child.kill('SIGKILL');
      await child.exited;
      const aware = await gbrain(['put', 'notes/lock-gap-aware', '--source', 'default', '--json'], { home: c.fx.home, stdin: 'a graduation-aware binary must not write here\n', timeoutMs: 120_000 });
      if (boundary === 'source_closed') {
        expect({ code: aware.code, error: codeOf(aware.json) }).toEqual({ code: 1, error: 'graduation_interrupted' });
      }
      const write = await olderRun(older[0].binary, c.fx.home, ['put', 'notes/lock-gap-write', '--source', 'default'], 'written by an older release in the lock gap\n');
      expect({ code: write.code, stderr: write.code === 0 ? '' : write.stderr.slice(-1500) }).toEqual({ code: 0, stderr: '' });
      const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 900_000 });
      expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
      await withTarget(c.target.url, async t => {
        const [row] = await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND slug='notes/lock-gap-write'`);
        expect(Number(row.n)).toBe(1);
      });
      expect(configuredEngine(c.fx).engine).toBe('postgres');
    }, 900_000);
  }

  graduationTest('an older release configured with the target URL cannot write while the target is fenced', async () => {
    const c = await fresh('older-vs-fence');
    const { argv, env } = await planAndRun(c, { extra: ['--batch-size', '2'] });
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['batch_copied@pages', 'verified'] } });
    for (const ordinal of [1, 2]) {
      const paused = await waitForEvent(c.events, e => e.event === 'paused' && e.ordinal === ordinal, child);
      const before = await stateDigest(join(c.fx.dir, 'nonexistent'), c.target.url);
      const probeHome = join(c.fx.dir, `older-target-${ordinal}`);
      const r = await olderRun(older[0].binary, probeHome, ['put', 'notes/fenced', '--source', 'default'], 'must not land\n');
      expect({ boundary: paused.boundary, failed: r.code !== 0 }).toEqual({ boundary: paused.boundary, failed: true });
      expect(digestChanges(before, await stateDigest(join(c.fx.dir, 'nonexistent'), c.target.url))).toEqual([]);
      release(c.events, ordinal);
    }
    const done = await child.exited;
    expect(done.code).toBe(0);
    await expectGraduated(c, 'after fenced probes');
  }, 900_000);
});
