/**
 * GBRA-133 PR 2a.1 (latency finding 6.6): a resident serve watched managed sources only (serve-head-watcher.ts:98 on
 * v0.60.309.0 returned no sources unless the brain was managed), so a commit in a classic brain's checkout was never
 * synced by the serve: measured "never" on both engines.
 *
 * Protects: a classic source last synced on this host (sync_notifier_sources.syncer_host_id, recorded where
 * last_commit advances) is watched by the host's notifier, and a new commit becomes searchable without a manual sync;
 * a classic source whose recorded syncer is another host is skipped with the reason, never synced from here.
 * Real git, real delegated runner, real store. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync.ts';
import { startServeHeadWatcher } from '../../src/core/serve-head-watcher.ts';
import { __resetDelegatedSyncForTests, isDelegatedSyncRunning } from '../../src/core/serve-sync-runner.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(root: string, file: string, body: string): string {
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, file), body);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', `add ${file}`);
  return git(root, 'rev-parse', 'HEAD');
}
async function until(what: string, fn: () => Promise<boolean>, lines: string[], timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; notifier log: ${JSON.stringify(lines)}`);
    await Bun.sleep(100);
  }
}
const searchable = async (engine: BrainEngine, word: string, slug: string) => (await engine.searchKeyword(word, { limit: 20 })).some(r => r.slug === slug);
const lastCommit = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [id]))[0]?.last_commit ?? null;

async function classicBrain(databaseUrl: string | undefined, run: (b: { engine: BrainEngine; root: string; other: string }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-notifier-classic-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_NOTIFIER: undefined, GBRAIN_NOTIFIER_CLASSIC_SOURCES: undefined }, async () => {
      __resetDelegatedSyncForTests();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, 'acme-example'); mkdirSync(root); git(root, 'init', '-q');
        commit(root, 'notes/alice-example.md', '---\ntitle: Alice Example\n---\nAlice Example keeps the acme-example ledger.\n');
        const other = join(home, 'other-example'); mkdirSync(other); git(other, 'init', '-q');
        commit(other, 'notes/bob-example.md', '---\ntitle: Bob Example\n---\nBob Example keeps a ledger.\n');
        await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('acme-example','acme-example',$1,'{}'), ('other-example','other-example',$2,'{}')", [root, other]);
        await performSync(engine, { sourceId: 'acme-example', repoPath: root, noPull: true, noEmbed: true });
        await performSync(engine, { sourceId: 'other-example', repoPath: other, noPull: true, noEmbed: true });
        await run({ engine, root, other });
      } finally {
        await until('the runner to idle', async () => !isDelegatedSyncRunning(), [], 60_000).catch(() => undefined);
        await disposePersistenceConsumer(engine).catch(() => undefined);
        await close();
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`classic source with a resident serve (${backend})`, () => {
    test('a commit in a classic checkout synced on this host becomes searchable without a manual sync', async () => {
      await classicBrain(databaseUrl, async ({ engine, root }) => {
        // The other source was last synced by another host: it is skipped with the reason, never synced here.
        await engine.executeRaw("UPDATE sync_notifier_sources SET syncer_host_id='00000000-0000-4000-8000-000000000001' WHERE source_id='other-example'").catch(() => undefined);
        await engine.setConfig('sync.on_commit', 'true');
        const lines: string[] = [];
        const watcher = startServeHeadWatcher(engine, { log: line => lines.push(line), pollMs: 1000, debounceMs: 100 });
        try {
          const head = commit(root, 'notes/acme-example.md', '---\ntitle: Acme Example\n---\nAcme Example ships the quarterly zeppelin report.\n');
          await until('the classic commit to become searchable', async () => searchable(engine, 'zeppelin', 'notes/acme-example'), lines);
          await until('last_commit to reach HEAD', async () => (await lastCommit(engine, 'acme-example')) === head && !isDelegatedSyncRunning(), lines);
          await watcher.tick();
          const snap = watcher.snapshot();
          expect(snap.sources.map(s => [s.source_id, s.kind])).toEqual([['acme-example', 'classic']]);
          expect(snap.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ sourceId: 'other-example', reason: expect.stringContaining('last synced on host 00000000') })]));
          expect(snap.skipped.map(s => s.sourceId)).not.toContain('acme-example');
          expect(watcher.decisions.filter(d => d.decision === 'start').map(d => d.source)).toContain('acme-example');
          expect(lines.some(l => l.includes('started classic sync job'))).toBe(true);
          expect(git(root, 'status', '--porcelain')).toBe('');
        } finally { await watcher.stop(); await engine.setConfig('sync.on_commit', 'false'); }
      });
    }, 180_000);
  });
}
