/**
 * S-58/S-59 (GBRA-133): an upstream force-push under a classic clone that
 * syncs with pull. The fast-forward fails on every run; before this fix every
 * run returned partial/pull_failed, --skip-failed changed nothing and doctor
 * sync_failures said nothing.
 *
 * Protects: classic preflight records the upstream commit the checkout contains
 * before every fetch, classifies a pull that cannot fast-forward
 * (upstream_rewritten, upstream_unknown when nothing usable was recorded,
 * upstream_diverged for local commits beside a normally moving upstream) as a
 * non-blocking source observation (never a sync-failure ledger row), names it
 * in the sync result and doctor sync_failures with its typed fix, and clears it
 * on the next pull that fast-forwards or is up to date. Nothing is classified
 * while a merge is in progress. gbrain sources reset-upstream refuses a moved
 * HEAD or upstream, a dirty tree and never-pushed local commits (naming them),
 * and otherwise keeps the old HEAD under a backup ref, resets, verifies, and the
 * next sync catches up with the upstream.
 * Fails when: the pull failure stays an anonymous partial, the classification
 * lands in the ledger, the fix for a force-push is a merge, or the reset moves
 * a checkout it was not bound to. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { pullShared } from '../../src/core/git/commit-push.ts';
import { loadSyncFailures } from '../../src/core/sync-failure-ledger.ts';
import { checkSyncFailures } from '../../src/commands/doctor/checks/sync-failures.ts';
import { runSources } from '../../src/commands/sources.ts';
import { buildSingleSyncJsonEnvelope } from '../../src/core/sync-embed-backfill.ts';
import { pathologicalArms } from './harness.ts';
import { CASES } from './s-blockers-cases.ts';
import { gitIn, md, withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

interface UpstreamField { code: string; local: string; upstream: string; previous_upstream: string | null; message: string;
  fix: { ask_user?: boolean; argv?: string[]; consent: string[]; then?: { argv?: string[] } } }

const E = ['-c', 'user.name=E', '-c', 'user.email=e@example.invalid'];
const upOf = (r: ProbeRepo) => r.root.replace(/-clone$/, '');
const commitUp = (up: string, msg: string) => { gitIn(up, 'add', '-A'); gitIn(up, ...E, 'commit', '-qm', msg); };
const ledgerRows = (sourceId: string) => loadSyncFailures().filter(row => row.source_id === sourceId);
const page = async (r: ProbeRepo, slug: string) =>
  (await r.engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [r.sourceId, slug])).length > 0;
const doctor = (r: ProbeRepo) => checkSyncFailures(r.engine, { sourceIds: [r.sourceId], remote: false });
const upstreamOf = (result: unknown) => (result as { upstream?: UpstreamField }).upstream;
const resetModule = () => import('../../src/commands/sources-reset-upstream.ts');

/** A clone of a fresh upstream (seed.md, plus second.md for a non-root rewrite), registered as a classic source. */
function makeClone(home: string, opts: { second?: boolean } = {}): string {
  const up = join(home, 'up-' + Math.random().toString(36).slice(2, 8)); mkdirSync(up);
  gitIn(up, 'init', '-q', '-b', 'main'); gitIn(up, 'config', 'receive.denyCurrentBranch', 'ignore');
  writeFileSync(join(up, 'seed.md'), md('seed')); commitUp(up, 'seed');
  if (opts.second) { writeFileSync(join(up, 'second.md'), md('second')); commitUp(up, 'second'); }
  const root = up + '-clone';
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', 'file://' + up, root]);
  gitIn(root, 'config', 'user.name', 'Example'); gitIn(root, 'config', 'user.email', 'example@example.invalid');
  return root;
}

async function withClone(engine: BrainEngine, home: string, root: string, run: (r: ProbeRepo) => Promise<void>): Promise<void> {
  await withProbeRepo(engine, 'classic', home, run, { root, initRepo: false, seed: false });
}

/** The S-58/S-59 probe flow up to the rewritten upstream: first sync with pull, ok/healthy-1.md, then the case's force-push. */
async function rewrite(r: ProbeRepo, id: 'S-58' | 'S-59'): Promise<void> {
  const first = await r.sync({ pull: true });
  expect(first.status).toBe('first_sync');
  r.write('ok/healthy-1.md', md('healthy 1'));
  await CASES.find(c => c.id === id)!.mutate(r);
}

/** Every observation names the code with its typed fix and is never a ledger row. */
async function expectObserved(r: ProbeRepo, result: unknown, code: string): Promise<UpstreamField> {
  const upstream = upstreamOf(result);
  expect({ code: upstream?.code }).toEqual({ code });
  expect(ledgerRows(r.sourceId)).toEqual([]);
  const check = await doctor(r);
  expect({ status: check?.status, code: (check?.details?.upstream as UpstreamField[] | undefined)?.[0]?.code }).toEqual({ status: 'warn', code });
  expect(check!.message).toContain(upstream!.fix.argv!.join(' '));
  expect(check!.fix).toEqual(upstream!.fix as never);
  return upstream!;
}

function expectResetFix(r: ProbeRepo, upstream: UpstreamField): void {
  const head = r.head(), tip = gitIn(r.root, 'rev-parse', '@{upstream}');
  expect(upstream.fix.ask_user).toBe(true);
  expect(upstream.fix.consent).toEqual(['destructive']);
  expect(upstream.fix.argv).toEqual(['gbrain', 'sources', 'reset-upstream', r.sourceId, '--expect-local', head, '--expect-upstream', tip]);
  expect(upstream.fix.argv!.join(' ')).not.toContain('commit-push');
  expect(upstream.fix.then?.argv).toEqual(['gbrain', 'sync', '--source', r.sourceId]);
}

async function stdoutOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return lines.join('\n');
}

async function refusal(run: () => Promise<unknown>): Promise<{ code?: string; reason?: string; message: string }> {
  try { await run(); } catch (e) { return { code: (e as { code?: string }).code, reason: (e as { reason?: string }).reason, message: (e as Error).message }; }
  throw new Error('expected a refusal');
}

for (const arm of pathologicalArms()) {
  describe(`S-58/S-59 upstream rewrite under classic sync with pull (${arm.backend})`, () => {
    for (const id of ['S-58', 'S-59'] as const) {
      test(`${id}: upstream_rewritten is reported with the reset fix, local HEAD keeps syncing, and the reset catches up`, async () => {
        await withProbeEngine(arm.databaseUrl, async (engine, home) => {
          await withClone(engine, home, CASES.find(c => c.id === id)!.makeRoot!(home), async r => {
            await rewrite(r, id);
            const result = await r.sync({ pull: true });
            expect({ status: result.status, reason: result.reason }).toEqual({ status: 'partial', reason: 'pull_failed' });
            expect(await r.lastCommit()).toBe(r.head());
            expect(await page(r, 'seed')).toBe(true);
            const upstream = await expectObserved(r, result, 'upstream_rewritten');
            expectResetFix(r, upstream);
            expect(upstream.previous_upstream).toBe(r.head());
            const envelope = buildSingleSyncJsonEnvelope(r.sourceId, result) as { upstream?: { code: string; fix: { next: string; command?: string } } };
            expect({ code: envelope.upstream?.code, next: envelope.upstream?.fix.next }).toEqual({ code: 'upstream_rewritten', next: 'ask_user' });
            const status = JSON.parse(await stdoutOf(() => runSources(engine, ['status', r.sourceId, '--json']))) as { sources: Array<{ source_id: string; upstream?: { code: string; fix: { next: string } } }> };
            expect(status.sources.map(s => ({ id: s.source_id, code: s.upstream?.code, next: s.upstream?.fix.next })))
              .toEqual([{ id: r.sourceId, code: 'upstream_rewritten', next: 'ask_user' }]);

            const again = await r.sync({ pull: true, skipFailed: true });
            expect(upstreamOf(again)?.code).toBe('upstream_rewritten');
            expect(ledgerRows(r.sourceId)).toEqual([]);

            const { resetUpstream } = await resetModule();
            const head = r.head(), tip = gitIn(r.root, 'rev-parse', '@{upstream}');
            const preview = await resetUpstream(engine, { sourceId: r.sourceId, expectLocal: head, expectUpstream: tip, dryRun: true });
            expect({ status: preview.status, head: r.head() }).toEqual({ status: 'would_reset', head });
            expect(gitIn(r.root, 'for-each-ref', 'refs/gbrain/backup')).toBe('');
            const done = await resetUpstream(engine, { sourceId: r.sourceId, expectLocal: head, expectUpstream: tip });
            expect({ status: done.status, from: done.from, to: done.to, head: r.head() }).toEqual({ status: 'reset', from: head, to: tip, head: tip });
            expect(done.backup_ref).toMatch(/^refs\/gbrain\/backup\/\d{8}T\d{6}Z-[0-9a-f]{12}$/);
            expect(gitIn(r.root, 'rev-parse', done.backup_ref!)).toBe(head);
            expect(done.dropped).toContain(head);
            expect(await doctor(r)).toBeNull();

            const up = upOf(r);
            mkdirSync(join(up, 'ok'), { recursive: true });
            writeFileSync(join(up, 'ok/healthy-2.md'), md('healthy 2')); commitUp(up, 'healthy 2');
            const caughtUp = await r.sync({ pull: true });
            expect({ status: caughtUp.status, upstream: upstreamOf(caughtUp) ?? null }).toEqual({ status: 'synced', upstream: null });
            expect({ h1: await page(r, 'ok/healthy-1'), h2: await page(r, 'ok/healthy-2'), atHead: (await r.lastCommit()) === r.head() })
              .toEqual({ h1: true, h2: true, atHead: true });
            expect(r.head()).toBe(gitIn(up, 'rev-parse', 'HEAD'));
            expect(await doctor(r)).toBeNull();
          });
        });
      }, 180_000);
    }

    test('upstream_unknown: a rewrite already fetched before anything was recorded (an upgrade) asks for the reset, never a merge', async () => {
      await withProbeEngine(arm.databaseUrl, async (engine, home) => {
        await withClone(engine, home, CASES.find(c => c.id === 'S-58')!.makeRoot!(home), async r => {
          await rewrite(r, 'S-58');
          await engine.executeRaw("UPDATE sources SET config = config - 'upstream_baseline' WHERE id = $1", [r.sourceId]);
          gitIn(r.root, 'fetch', '-q');
          const result = await r.sync({ pull: true });
          expect(await r.lastCommit()).toBe(r.head());
          const upstream = await expectObserved(r, result, 'upstream_unknown');
          expectResetFix(r, upstream);
          expect(upstream.previous_upstream).toBeNull();
          const { resetUpstream } = await resetModule();
          const done = await resetUpstream(engine, { sourceId: r.sourceId, expectLocal: r.head(), expectUpstream: gitIn(r.root, 'rev-parse', '@{upstream}') });
          expect(done.status).toBe('reset');
          const caughtUp = await r.sync({ pull: true });
          expect({ upstream: upstreamOf(caughtUp) ?? null, h1: await page(r, 'ok/healthy-1') }).toEqual({ upstream: null, h1: true });
        });
      });
    }, 180_000);

    test('a rewrite on the first pull after an upgrade is still upstream_rewritten when the old upstream is the tracking ref', async () => {
      await withProbeEngine(arm.databaseUrl, async (engine, home) => {
        await withClone(engine, home, makeClone(home), async r => {
          expect((await r.sync()).status).toBe('first_sync');
          const up = upOf(r);
          writeFileSync(join(up, 'seed.md'), md('seed rewritten')); gitIn(up, 'add', '-A'); gitIn(up, ...E, 'commit', '-q', '--amend', '-m', 'seed rewritten');
          await expectObserved(r, await r.sync({ pull: true }), 'upstream_rewritten');
        });
      });
    }, 180_000);

    test('upstream_diverged: local commits beside a normally moving upstream get the commit-push --pull fix; the next advancing pull clears it', async () => {
      await withProbeEngine(arm.databaseUrl, async (engine, home) => {
        await withClone(engine, home, makeClone(home), async r => {
          expect((await r.sync({ pull: true })).status).toBe('first_sync');
          r.write('notes/local.md', md('local')); r.commitAll('local note');
          const up = upOf(r);
          mkdirSync(join(up, 'ok'), { recursive: true }); writeFileSync(join(up, 'ok/healthy-1.md'), md('healthy 1')); commitUp(up, 'healthy 1');
          const result = await r.sync({ pull: true });
          expect({ local: await page(r, 'notes/local'), atHead: (await r.lastCommit()) === r.head() }).toEqual({ local: true, atHead: true });
          const upstream = await expectObserved(r, result, 'upstream_diverged');
          expect(upstream.fix.ask_user).toBeUndefined();
          expect(upstream.fix.argv).toEqual(['gbrain', 'git', 'commit-push', '--pull', '--path', r.root]);
          expect(pullShared(r.root).status).toBe('advanced');
          const cleared = await r.sync({ pull: true });
          expect({ upstream: upstreamOf(cleared) ?? null, h1: await page(r, 'ok/healthy-1') }).toEqual({ upstream: null, h1: true });
          expect(await doctor(r)).toBeNull();
        });
      });
    }, 180_000);

    test('nothing is classified while a merge is in progress', async () => {
      await withProbeEngine(arm.databaseUrl, async (engine, home) => {
        await withClone(engine, home, makeClone(home), async r => {
          expect((await r.sync({ pull: true })).status).toBe('first_sync');
          r.write('seed.md', md('seed edited here')); r.commitAll('local edit');
          const up = upOf(r);
          writeFileSync(join(up, 'seed.md'), md('seed edited upstream')); commitUp(up, 'upstream edit');
          gitIn(r.root, 'fetch', '-q');
          expect(() => gitIn(r.root, 'merge', '--no-edit', '@{upstream}')).toThrow();
          expect(gitIn(r.root, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toBe('');
          const result = await r.sync({ pull: true });
          expect(upstreamOf(result) ?? null).toBeNull();
          expect(await doctor(r)).toBeNull();
          expect(ledgerRows(r.sourceId)).toEqual([]);
        });
      });
    }, 180_000);

    test('a merge in progress leaves a standing observation as it was (no re-classification)', async () => {
      await withProbeEngine(arm.databaseUrl, async (engine, home) => {
        await withClone(engine, home, makeClone(home), async r => {
          expect((await r.sync({ pull: true })).status).toBe('first_sync');
          r.write('seed.md', md('seed edited here')); r.commitAll('local edit');
          const up = upOf(r);
          writeFileSync(join(up, 'seed.md'), md('seed edited upstream')); commitUp(up, 'upstream edit');
          const first = await expectObserved(r, await r.sync({ pull: true }), 'upstream_diverged') as UpstreamField & { observed_at: string };
          expect(() => gitIn(r.root, 'merge', '--no-edit', '@{upstream}')).toThrow();
          const during = upstreamOf(await r.sync({ pull: true })) as (UpstreamField & { observed_at: string }) | undefined;
          expect({ code: during?.code, observed_at: during?.observed_at }).toEqual({ code: 'upstream_diverged', observed_at: first.observed_at });
          expect(ledgerRows(r.sourceId)).toEqual([]);
        });
      });
    }, 180_000);

    test('reset-upstream refuses a moved checkout, a dirty tree and never-pushed local commits, and changes nothing', async () => {
      await withProbeEngine(arm.databaseUrl, async (engine, home) => {
        await withClone(engine, home, makeClone(home), async r => {
          expect((await r.sync({ pull: true })).status).toBe('first_sync');
          r.write('notes/unpushed.md', md('unpushed')); r.commitAll('unpushed alice-example note');
          const up = upOf(r);
          writeFileSync(join(up, 'seed.md'), md('seed rewritten')); gitIn(up, 'add', '-A'); gitIn(up, ...E, 'commit', '-q', '--amend', '-m', 'seed rewritten');
          const upstream = await expectObserved(r, await r.sync({ pull: true }), 'upstream_rewritten');
          const { resetUpstream, runResetUpstream } = await resetModule();
          const head = r.head(), tip = gitIn(r.root, 'rev-parse', '@{upstream}');
          const reset = (o: { expectLocal?: string; expectUpstream?: string } = {}) =>
            resetUpstream(engine, { sourceId: r.sourceId, expectLocal: o.expectLocal ?? head, expectUpstream: o.expectUpstream ?? tip });

          const moved = await refusal(() => reset({ expectLocal: tip }));
          expect({ code: moved.code, reason: moved.reason }).toEqual({ code: 'reset_upstream_refused', reason: 'expect_mismatch' });

          writeFileSync(join(r.root, 'seed.md'), md('uncommitted'));
          const dirty = await refusal(() => reset());
          expect({ code: dirty.code, reason: dirty.reason }).toEqual({ code: 'reset_upstream_refused', reason: 'dirty_tree' });
          expect(dirty.message).toContain('seed.md');
          gitIn(r.root, 'checkout', '--', 'seed.md');

          const local = await refusal(() => reset());
          expect({ code: local.code, reason: local.reason }).toEqual({ code: 'reset_upstream_refused', reason: 'local_commits' });
          expect(local.message).toContain('unpushed alice-example note');
          expect(local.message).toMatch(/refs\/gbrain\/backup\/\d{8}T\d{6}Z-/);
          expect({ head: r.head(), backups: gitIn(r.root, 'for-each-ref', 'refs/gbrain/backup') }).toEqual({ head, backups: '' });
          expect(upstream.fix.argv).toContain(head);

          await expect(runResetUpstream(engine, [r.sourceId, '--expect-local', head, '--expect-upstream', tip, '--dry-run', '--json'])).rejects.toMatchObject({ code: 'reset_upstream_refused', reason: 'local_commits' });
          await expect(runResetUpstream(engine, [r.sourceId, '--expect-local', head])).rejects.toMatchObject({ code: 'invalid_params' });
          expect(r.head()).toBe(head);
        });
      });
    }, 180_000);
  });
}
