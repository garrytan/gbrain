/**
 * GBRA-133 PR 2a.3: a request to sync a source is never dropped. Every submitter (sync trigger, the GitHub push
 * webhook, sync_nudge, a busy delegated sync) records a wanted marker per source and intent; a drainer clears only the
 * generation it read, and the residents' durable marker scan drains anything left behind, with sync.on_commit off.
 *
 * Protects (each case fails on v0.60.309.0, where none of this exists: a push inside the webhook's 30 s idempotency
 * bucket, or a trigger that coalesced into a finishing job, left its commit unsynced until something else synced):
 *  - a marker re-recorded while a run was in flight survives that run's settle (generation check) and gets a follow-up;
 *  - a marker recorded after the handler's last check but before its job completed is drained by a resident's scan
 *    with sync.on_commit off and no later commits;
 *  - a submitter that crashed after its upsert (no job queued) is drained the same way after a resident starts;
 *  - a dry run stays read-only (no marker read, cleared or written);
 *  - the push webhook coalesces a second push into the waiting job and keeps the newer sha; a managed push answers
 *    refresh_required (409) with the gbrain sources refresh fix and queues nothing;
 *  - sync trigger --json reports queued then coalesced on either engine (stdout keeps job_id=N, exit 0), and with no
 *    resident watching the source adds resident: null and the no_resident notice with its fix.
 * Real git, real store, real handler, real delegated runner. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { makeSyncHandler } from '../../src/core/minions/handlers/sync.ts';
import { startServeHeadWatcher } from '../../src/core/serve-head-watcher.ts';
import { __resetDelegatedSyncForTests, getDelegatedSyncStatus, isDelegatedSyncRunning, startDelegatedSync } from '../../src/core/serve-sync-runner.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { readMarkers, upsertMarker } from '../../src/core/notifier/store.ts';
import { recordTriggerMarker } from '../../src/core/notifier/nudge.ts';
import { settleRunMarkers } from '../../src/core/notifier/handoff.ts';
import { submitGitHubPush as submitPush } from '../../src/commands/serve-http-webhooks.ts';
import { runSyncTrigger } from '../../src/commands/sync/trigger.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../../src/core/cli-force-exit.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { managedBrain, pathologicalArms } from './harness.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(root: string, file: string, body: string): string {
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, file), body);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', `add ${file}`);
  return git(root, 'rev-parse', 'HEAD');
}
async function until(what: string, fn: () => Promise<boolean>, lines: string[] = [], timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log: ${JSON.stringify(lines)}`);
    await Bun.sleep(100);
  }
}
const searchable = async (engine: BrainEngine, word: string, slug: string) => (await engine.searchKeyword(word, { limit: 20 })).some(r => r.slug === slug);
const lastCommit = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]?.last_commit ?? null;
const SOURCE = 'acme-example';

/** The push route's answer, captured from the response sink it writes. */
async function submitGitHubPush(engine: BrainEngine, sourceId: string, after: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  let answer: { status: number; body: Record<string, unknown> } | null = null;
  await submitPush(engine, sourceId, after, { status: (status: number) => ({ json: (body: unknown) => { answer = { status, body: body as Record<string, unknown> }; } }) });
  if (!answer) throw new Error('the push route wrote no answer');
  return answer;
}

async function classicBrain(databaseUrl: string | undefined, run: (b: { engine: BrainEngine; root: string }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-marker-handoff-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_NOTIFIER: undefined, GBRAIN_NOTIFIER_CLASSIC_SOURCES: undefined }, async () => {
      __resetDelegatedSyncForTests();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, SOURCE); mkdirSync(root); git(root, 'init', '-q');
        commit(root, 'notes/alice-example.md', '---\ntitle: Alice Example\n---\nAlice Example keeps the acme-example ledger.\n');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3)", [SOURCE, root, JSON.stringify({ github_repo: 'acme-example/notes' })]);
        await performSync(engine, { sourceId: SOURCE, repoPath: root, noPull: true, noEmbed: true });
        await engine.setConfig('sync.on_commit', 'false');
        await run({ engine, root });
      } finally {
        await until('the runner to idle', async () => !isDelegatedSyncRunning(), [], 60_000).catch(() => undefined);
        __resetDelegatedSyncForTests();
        await disposePersistenceConsumer(engine).catch(() => undefined);
        await close();
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; out: string[]; err: string[] }> {
  const out: string[] = []; const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
  try { return { value: await fn(), out, err }; } finally { console.log = log; console.error = error; }
}

/** A resident started with sync.on_commit off drains the recorded marker; returns its recorded decisions. */
async function drainWithResident(engine: BrainEngine, word: string, slug: string, head: string) {
  const lines: string[] = [];
  const watcher = startServeHeadWatcher(engine, { log: line => lines.push(line), pollMs: 1000, debounceMs: 100 });
  try {
    await until(`${slug} to become searchable`, async () => searchable(engine, word, slug), lines);
    await until('last_commit to reach the marker head', async () => (await lastCommit(engine, SOURCE)) === head && !isDelegatedSyncRunning(), lines);
    await until('the marker to clear', async () => (await readMarkers(engine, [SOURCE])).length === 0, lines);
    return { decisions: [...watcher.decisions], snapshot: watcher.snapshot(), lines };
  } finally { await watcher.stop(); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`wanted markers never drop a request (${backend})`, () => {
    test('a marker re-recorded while a run was in flight survives that run and gets one follow-up', async () => {
      await classicBrain(databaseUrl, async ({ engine, root }) => {
        const first = await upsertMarker(engine, { sourceId: SOURCE, intent: 'freshness', wantedHead: git(root, 'rev-parse', 'HEAD'), requestedBy: 'sync_trigger' });
        const read = [first];
        const newer = commit(root, 'notes/bob-example.md', '---\ntitle: Bob Example\n---\nBob Example files the quarterly heliotrope memo.\n');
        const second = await upsertMarker(engine, { sourceId: SOURCE, intent: 'freshness', wantedHead: newer, requestedBy: 'sync_trigger' });
        expect(second.generation).toBe(first.generation + 1);
        const followUp = await settleRunMarkers(engine, SOURCE, read, { pulled: false, full: false });
        const left = await readMarkers(engine, [SOURCE]);
        expect(left.map(m => [m.intent, m.generation, m.wanted_head])).toEqual([['freshness', second.generation, newer]]);
        expect(followUp?.markers).toBe(1);
        if (engine.kind === 'pglite') expect(followUp?.job_id).toBeNull();
        else {
          expect(typeof followUp?.job_id).toBe('number');
          expect(left[0]!.job_id).toBe(followUp!.job_id);
          const again = await settleRunMarkers(engine, SOURCE, [], { pulled: false, full: false });
          expect(again?.job_id).toBe(followUp!.job_id);
        }
      });
    }, 120_000);

    test('a marker recorded after the job handler\'s last check, before completion, is drained by a resident with sync.on_commit off', async () => {
      await classicBrain(databaseUrl, async ({ engine, root }) => {
        const head = commit(root, 'notes/carol-example.md', '---\ntitle: Carol Example\n---\nCarol Example audits the marmalade ledger.\n');
        const result = await quietly(() => makeSyncHandler(engine)({ id: 1, name: 'sync', data: { sourceId: SOURCE, repoPath: root, pull: false, auto_embed_backfill: false },
          signal: new AbortController().signal, updateProgress: async () => {}, log: async () => {} } as never));
        expect((result.value as { status?: string }).status).not.toBe('blocked_by_failures');
        expect(await lastCommit(engine, SOURCE)).toBe(head);
        const later = commit(root, 'notes/dave-example.md', '---\ntitle: Dave Example\n---\nDave Example tracks the cobalt shipment.\n');
        const recorded = await recordTriggerMarker(engine, { sourceId: SOURCE, intent: 'freshness', requestedBy: 'sync_trigger' });
        expect(recorded?.marker.wanted_head).toBe(later);
        const drained = await drainWithResident(engine, 'cobalt', 'notes/dave-example', later);
        expect(drained.snapshot.enabled).toBe(false);
        expect(drained.decisions.some(d => d.source === SOURCE && d.decision === 'start')).toBe(true);
      });
    }, 180_000);

    test('a submitter that crashed after its upsert (no job queued) is drained once a resident starts', async () => {
      await classicBrain(databaseUrl, async ({ engine, root }) => {
        const head = commit(root, 'notes/erin-example.md', '---\ntitle: Erin Example\n---\nErin Example signs the tangerine lease.\n');
        await upsertMarker(engine, { sourceId: SOURCE, intent: 'freshness', wantedHead: head, requestedBy: 'webhook' });
        expect(Number((await engine.executeRaw<{ n: unknown }>("SELECT count(*) AS n FROM minion_jobs WHERE name='sync'"))[0]!.n)).toBe(0);
        const drained = await drainWithResident(engine, 'tangerine', 'notes/erin-example', head);
        expect(drained.decisions.some(d => d.source === SOURCE && d.decision === 'start')).toBe(true);
      });
    }, 180_000);

    test('a dry run stays read-only: a pending pull marker is neither read for clearing nor changed', async () => {
      await classicBrain(databaseUrl, async ({ engine }) => {
        const marker = await upsertMarker(engine, { sourceId: SOURCE, intent: 'pull', wantedHead: null, requestedBy: 'sync_trigger' });
        const start = await startDelegatedSync(engine, { sourceId: SOURCE, noPull: false, dryRun: true, timeoutSeconds: 60 }, `test-${randomUUID()}`);
        expect(start.ok).toBe(true);
        await until('the dry run to finish', async () => !isDelegatedSyncRunning());
        expect(getDelegatedSyncStatus(String((start as { jobId: string }).jobId)).state).toBe('done');
        expect((await readMarkers(engine, [SOURCE])).map(m => [m.intent, m.generation])).toEqual([['pull', marker.generation]]);
      });
    }, 120_000);

    test('the push webhook records the pushed sha and coalesces a second push into the waiting job', async () => {
      await classicBrain(databaseUrl, async ({ engine }) => {
        const sha1 = 'a'.repeat(40); const sha2 = 'b'.repeat(40);
        const first = await submitGitHubPush(engine, SOURCE, sha1);
        const second = await submitGitHubPush(engine, SOURCE, sha2);
        expect(first.status).toBe(202); expect(second.status).toBe(202);
        expect(first.body).toMatchObject({ action: 'queued', source_id: SOURCE, wanted_head: sha1 });
        expect(second.body).toMatchObject({ action: 'coalesced', job_id: first.body.job_id, wanted_head: sha2 });
        const markers = await readMarkers(engine, [SOURCE]);
        expect(markers.map(m => [m.intent, m.wanted_head, m.generation, m.job_id])).toEqual([['pull', sha2, 2, first.body.job_id as number]]);
        const deleted = await submitGitHubPush(engine, SOURCE, '0'.repeat(40));
        expect(deleted.body).toMatchObject({ wanted_head: null });
      });
    }, 120_000);

    test('sync trigger --json: queued then coalesced, exit 0; with no resident it adds resident: null and the no_resident notice', async () => {
      await classicBrain(databaseUrl, async ({ engine }) => {
        _resetCliExitVerdictForTests();
        try {
          const one = await quietly(() => runSyncTrigger(engine, ['--source', SOURCE, '--json']));
          expect(one.out).toHaveLength(1);
          const a = JSON.parse(one.out.at(-1)!);
          expect(a.resident).toBeNull();
          expect(a.notice).toMatchObject({ code: 'no_resident' });
          expect(JSON.stringify(a.notice)).toContain('--no-pull');
          expect((await readMarkers(engine, [SOURCE])).map(m => [m.intent, m.job_id])).toEqual([['pull', a.job_id]]);
          const two = await quietly(() => runSyncTrigger(engine, ['--source', SOURCE, '--json']));
          const b = JSON.parse(two.out.at(-1)!);
          expect(a).toMatchObject({ action: 'queued', source_id: SOURCE, intent: 'pull' });
          expect(typeof a.job_id).toBe('number');
          expect(b).toMatchObject({ action: 'coalesced', job_id: a.job_id, marker_generation: a.marker_generation + 1 });
          expect(currentExitCode()).toBe(0);
          const text = await quietly(() => runSyncTrigger(engine, ['--source', SOURCE]));
          expect(text.out).toEqual([`job_id=${a.job_id}`]);
          expect(text.err.filter(l => l.startsWith('[gbrain notice no_resident]'))).toHaveLength(1);
        } finally { _resetCliExitVerdictForTests(); }
      });
    }, 120_000);

    test('a managed push answers refresh_required with the sources refresh fix and queues nothing', async () => {
      await managedBrain(async ({ engine }) => {
        await engine.executeRaw("UPDATE sources SET config = config || $1::jsonb WHERE id='default'", [JSON.stringify({ github_repo: 'acme-example/managed' })]);
        const sha = 'c'.repeat(40);
        const answer = await submitGitHubPush(engine, 'default', sha);
        expect(answer.status).toBe(409);
        expect(answer.body).toMatchObject({ status: 'refresh_required', source_id: 'default', wanted_head: sha });
        expect(JSON.stringify(answer.body)).toContain('"refresh_required"');
        expect(JSON.stringify(answer.body)).toContain('"sources","refresh","default"');
        expect((await readMarkers(engine, ['default'])).map(m => [m.intent, m.wanted_head])).toEqual([['pull', sha]]);
        const jobs = await engine.executeRaw<{ n: unknown }>("SELECT count(*) AS n FROM minion_jobs WHERE name='sync'");
        expect(Number(jobs[0]!.n)).toBe(0);
      }, { databaseUrl });
    }, 120_000);
  });
}
