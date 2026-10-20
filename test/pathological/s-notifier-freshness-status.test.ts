/**
 * GBRA-133 PR 2a.2 / 2a.5: the user and the agent can see who syncs a source and how fresh a search answer is.
 *
 * Protects:
 *  - search results carry a per-source freshness entry from the notifier's cached coverage record: not_monitored when
 *    no resident watches the source (never current), current once a live resident observed HEAD = last_commit;
 *  - the sync-status notifier block names the resident (kind, pid) or says none is running with the fix
 *    gbrain sync --source <id> --no-pull;
 *  - a stalled notifier (notifier_stalled) is reported with the fix and the trace path to a local caller, and a remote
 *    projection carries no trace path, pid or host id.
 * On v0.60.309.0 search carried no freshness and nothing recorded the notifier. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { performSync } from '../../src/commands/sync.ts';
import { startServeHeadWatcher } from '../../src/core/serve-head-watcher.ts';
import { __resetDelegatedSyncForTests, isDelegatedSyncRunning } from '../../src/core/serve-sync-runner.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { writeState } from '../../src/core/notifier/store.ts';
import { formatNotifierBlock, readNotifierBlock } from '../../src/core/notifier/status.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const SOURCE = 'acme-example';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function until(what: string, fn: () => Promise<boolean>, lines: string[] = [], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log: ${JSON.stringify(lines)}`);
    await Bun.sleep(100);
  }
}

async function classicBrain(databaseUrl: string | undefined, run: (b: { engine: BrainEngine; root: string }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-notifier-freshness-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_NOTIFIER: undefined, GBRAIN_NOTIFIER_CLASSIC_SOURCES: undefined }, async () => {
      __resetDelegatedSyncForTests();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, SOURCE); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
        writeFileSync(join(root, 'notes/alice-example.md'), '---\ntitle: Alice Example\n---\nAlice Example keeps the acme-example juniper ledger.\n');
        git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [SOURCE, root]);
        await performSync(engine, { sourceId: SOURCE, repoPath: root, noPull: true, noEmbed: true });
        await engine.setConfig('search.mcp_keyword_only', 'true');
        await run({ engine, root });
      } finally {
        await until('the runner to idle', async () => !isDelegatedSyncRunning()).catch(() => undefined);
        __resetDelegatedSyncForTests();
        await disposePersistenceConsumer(engine).catch(() => undefined);
        await close();
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function printed(run: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}

/** The search response's freshness entries; undefined when the response carries no freshness key at all. */
async function searchFreshnessKey(engine: BrainEngine, remote: boolean): Promise<Array<Record<string, unknown>> | undefined> {
  const meta: Array<{ key: string; value: unknown }> = [];
  const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: SOURCE,
    emitResponseMeta: (key: string, value: unknown) => { meta.push({ key, value }); } } as unknown as OperationContext;
  const rows = await operations.find(o => o.name === 'search')!.handler(ctx, { query: 'juniper' }) as Array<{ slug: string }>;
  expect(rows.map(r => r.slug)).toContain('notes/alice-example');
  const retrieval = meta.find(m => m.key === 'retrieval')?.value as { freshness?: Array<Record<string, unknown>> } | undefined;
  expect(retrieval).toBeDefined();
  return retrieval!.freshness;
}
const searchFreshness = async (engine: BrainEngine, remote: boolean) => (await searchFreshnessKey(engine, remote)) ?? [];

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`notifier status and search freshness (${backend})`, () => {
    test('the freshness gate: absent until the brain opts in or a resident records coverage, then not_monitored for an unwatched source', async () => {
      await classicBrain(databaseUrl, async ({ engine }) => {
        await engine.setConfig('sync.on_commit', 'false');
        expect(await searchFreshnessKey(engine, false)).toBeUndefined();
        // The classic sync above recorded this host as the syncer (a row with no coverage); a resident's observation adds it.
        await engine.executeRaw('UPDATE sync_notifier_sources SET observed_at = now(), detection_mode = $2, owner_host_id = $3, owner_kind = $4, owner_pid = $5 WHERE source_id = $1',
          [SOURCE, 'poll', '00000000-0000-4000-8000-0000000000bb', 'serve', 1]);
        expect(await searchFreshnessKey(engine, false)).toEqual([expect.objectContaining({ source_id: SOURCE, state: 'not_monitored' })]);
        await engine.executeRaw('UPDATE sync_notifier_sources SET observed_at = NULL, detection_mode = NULL, owner_host_id = NULL, owner_kind = NULL, owner_pid = NULL WHERE source_id = $1', [SOURCE]);
        expect(await searchFreshnessKey(engine, false)).toBeUndefined();
        await engine.setConfig('sync.on_commit', 'true');
        expect(await searchFreshnessKey(engine, false)).toEqual([expect.objectContaining({ source_id: SOURCE, state: 'not_monitored', held_count: 0 })]);
      });
    }, 120_000);

    test('no resident: with sync.on_commit on, search reads not_monitored and the notifier block names no resident with the fix', async () => {
      await classicBrain(databaseUrl, async ({ engine }) => {
        await engine.setConfig('sync.on_commit', 'true');
        const fresh = await searchFreshness(engine, false);
        expect(fresh).toEqual([expect.objectContaining({ source_id: SOURCE, state: 'not_monitored', held_count: 0 })]);
        const block = await readNotifierBlock(engine, SOURCE);
        expect(block?.resident).toBeNull();
        expect(block?.fix?.argv).toEqual(['gbrain', 'sync', '--source', SOURCE, '--no-pull']);
        expect(formatNotifierBlock(SOURCE, block!)).toContain('none running');
      });
    }, 120_000);

    test('a live resident: search reads current; a stalled notifier names the fix and trace locally, never remotely', async () => {
      await classicBrain(databaseUrl, async ({ engine }) => {
        await engine.setConfig('sync.on_commit', 'true');
        const lines: string[] = [];
        const watcher = startServeHeadWatcher(engine, { log: line => lines.push(line), pollMs: 1000, debounceMs: 100 });
        try {
          await until('the coverage record', async () => (await searchFreshness(engine, false))[0]?.state === 'current', lines);
          const [current] = await searchFreshness(engine, false);
          expect(current).toMatchObject({ source_id: SOURCE, state: 'current', observed_head: git(join(process.env.GBRAIN_HOME!, SOURCE), 'rev-parse', 'HEAD') });
          expect(['watch', 'poll']).toContain(current!.mode as string);
          const live = await readNotifierBlock(engine, SOURCE);
          expect(live?.resident).toMatchObject({ kind: 'serve', pid: process.pid, live: true });
          expect(live?.fix).toBeNull();

          await writeState(engine, SOURCE, { state: 'retry', reason: 'notifier_stalled', firstDue: 'keep', attempts: 6, nextRetryInMs: 300_000,
            error: { code: 'notifier_stalled', message: 'sync_failed: example failure', tracePath: '/tmp/example-trace.jsonl' } });
          const local = await readNotifierBlock(engine, SOURCE);
          expect(local).toMatchObject({ state: 'retry', reason: 'notifier_stalled', stalled: true, attempts: 6 });
          expect(local?.next_retry_at).not.toBeNull();
          expect(local?.last_error?.trace_path).toBe('/tmp/example-trace.jsonl');
          expect(local?.fix?.why).toContain('/tmp/example-trace.jsonl');
          expect(formatNotifierBlock(SOURCE, local!)).toContain('notifier_stalled');
          const remote = await readNotifierBlock(engine, SOURCE, { remote: true });
          expect(remote?.resident).toMatchObject({ kind: 'serve', pid: null, host_id: null });
          expect(JSON.stringify(remote)).not.toContain('/tmp/example-trace.jsonl');
          const [behind] = await searchFreshness(engine, true);
          expect(behind).toMatchObject({ state: 'behind' });
          expect(JSON.stringify(behind)).not.toContain('/tmp/');
        } finally { await watcher.stop(); await engine.setConfig('sync.on_commit', 'false'); }
        expect((await searchFreshness(engine, false))[0]?.state).toBe('not_monitored');
      });
    }, 180_000);

    test('sync status --json carries the notifier block and prints it; doctor commit_notifier names the resident or warns with the fix', async () => {
      await classicBrain(databaseUrl, async ({ engine }) => {
        const { runSyncStatus } = await import('../../src/commands/sync/operator.ts');
        const { commitNotifierEntry } = await import('../../src/commands/doctor/checks/commit-notifier.ts');
        const doctor = async () => (await commitNotifierEntry.run({ engine, args: [], orphanRatioSourceId: undefined } as never)) as Array<{ name: string; status: string; message: string; fix?: { argv?: string[] } }>;
        const json = JSON.parse(await printed(() => runSyncStatus(engine, ['--source', SOURCE, '--json']))) as { notifier?: { resident: unknown; fix: { argv?: string[] } | null } };
        expect(json.notifier).toMatchObject({ resident: null, fix: { argv: ['gbrain', 'sync', '--source', SOURCE, '--no-pull'] } });
        expect(await printed(() => runSyncStatus(engine, ['--source', SOURCE]))).toContain(`notifier for ${SOURCE}: none running`);
        const [off] = await doctor();
        expect(off).toMatchObject({ name: 'commit_notifier', status: 'ok' });
        expect(off!.message).toContain('sync.on_commit is off');

        await engine.setConfig('sync.on_commit', 'true');
        const [unwatched] = await doctor();
        expect(unwatched).toMatchObject({ name: 'commit_notifier', status: 'warn', fix: { argv: ['gbrain', 'sync', '--source', SOURCE, '--no-pull'] } });
        expect(unwatched!.message).toContain('none running');
        const lines: string[] = [];
        const watcher = startServeHeadWatcher(engine, { log: line => lines.push(line), pollMs: 1000, debounceMs: 100 });
        try {
          await until('a live resident', async () => (await readNotifierBlock(engine, SOURCE))?.resident?.live === true, lines);
          const [watched] = await doctor();
          expect(watched).toMatchObject({ name: 'commit_notifier', status: 'ok' });
          expect(watched!.message).toContain(`notifier for ${SOURCE}: serve`);
          const live = JSON.parse(await printed(() => runSyncStatus(engine, ['--source', SOURCE, '--json']))) as { notifier?: { resident: { kind: string } | null; fix: unknown } };
          expect(live.notifier).toMatchObject({ resident: { kind: 'serve' }, fix: null });
        } finally { await watcher.stop(); await engine.setConfig('sync.on_commit', 'false'); }
      });
    }, 180_000);
  });
}
