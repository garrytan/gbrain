/**
 * #7941: a freshness marker whose wanted_head the source has already passed (an ancestor of last_commit, recorded by
 * a run that found the source busy before more commits landed) stayed due forever. Settlement was exact equality, so
 * every completed sync settled nothing and the sync handler queued one more priority -10 follow-up, ahead of every
 * default-priority job, with no end. A completed run now also settles a marker it read when the source's checkout has
 * nothing left to import (its HEAD equals last_commit after the run): no ancestry assumption, and a marker re-recorded
 * during the run (new generation) or a checkout with commits still to import keeps its follow-up.
 *
 * Real git, real store, real sync. PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { readDueMarkers, readMarkers, settleMarkers, upsertMarker } from '../src/core/notifier/store.ts';
import { settleRunMarkers } from '../src/core/notifier/handoff.ts';
import { sqlNotifierStore } from '../src/core/notifier/resident.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'source-a';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(root: string, file: string, body: string): string {
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, file), body);
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', `add ${file}`);
  return git(root, 'rev-parse', 'HEAD');
}
const page = (n: number) => `---\ntitle: Note ${n}\n---\nAlice Example wrote note ${n} for the acme-example ledger.\n`;
const lastCommit = async (engine: BrainEngine) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [SOURCE]))[0]?.last_commit ?? null;
const sync = (engine: BrainEngine, root: string) => performSync(engine, { sourceId: SOURCE, repoPath: root, noPull: true, noEmbed: true });

const arms: Array<[string, string | undefined]> = [['pglite', undefined], ...(process.env.DATABASE_URL ? [['postgres', process.env.DATABASE_URL] as [string, string]] : [])];

async function brain(databaseUrl: string | undefined, run: (b: { engine: BrainEngine; root: string; stale: string }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-7941-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_NOTIFIER: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        const root = join(home, SOURCE); mkdirSync(root); git(root, 'init', '-q');
        const stale = commit(root, 'notes/one.md', page(1));
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3)', [SOURCE, root, '{}']);
        await sync(engine, root);
        await engine.setConfig('sync.on_commit', 'false');
        await run({ engine, root, stale });
      } finally { await disposePersistenceConsumer(engine); await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** The #7941 state: a freshness marker at `stale`, then more commits synced, so last_commit is a descendant of it. */
async function passedMarker(engine: BrainEngine, root: string, stale: string) {
  const marker = await upsertMarker(engine, { sourceId: SOURCE, intent: 'freshness', wantedHead: stale, requestedBy: 'lock_busy' });
  commit(root, 'notes/two.md', page(2));
  const head = commit(root, 'notes/three.md', page(3));
  await sync(engine, root);
  expect(await lastCommit(engine)).toBe(head);
  expect((await readDueMarkers(engine, [SOURCE])).map(m => m.wanted_head)).toEqual([stale]);
  return marker;
}

describe.each(arms)('#7941 a freshness marker the source already passed (%s)', (_arm, databaseUrl) => {
  test('the sync handler path: a completed run settles it and queues no follow-up', async () => {
    await brain(databaseUrl, async ({ engine, root, stale }) => {
      const marker = await passedMarker(engine, root, stale);
      expect(await settleRunMarkers(engine, SOURCE, [marker], { pulled: false, full: false })).toBeNull();
      expect(await readMarkers(engine, [SOURCE])).toEqual([]);
      expect((await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='sync'")).length).toBe(0);
    });
  }, 120_000);

  test('the resident notifier path: its store settles it', async () => {
    await brain(databaseUrl, async ({ engine, root, stale }) => {
      const marker = await passedMarker(engine, root, stale);
      expect(await sqlNotifierStore(engine).settleMarkers(SOURCE, [marker], { pulled: false, full: false })).toEqual([]);
      expect(await readMarkers(engine, [SOURCE])).toEqual([]);
    });
  }, 120_000);

  test('commits still to import keep the marker due and the follow-up queued', async () => {
    await brain(databaseUrl, async ({ engine, root, stale }) => {
      const marker = await passedMarker(engine, root, stale);
      commit(root, 'notes/four.md', page(4));
      const followUp = await settleRunMarkers(engine, SOURCE, [marker], { pulled: false, full: false });
      expect(followUp?.markers).toBe(1);
      expect((await readMarkers(engine, [SOURCE])).map(m => m.wanted_head)).toEqual([stale]);
    });
  }, 120_000);

  test('a marker re-recorded while the run was in flight (new generation) survives the settle', async () => {
    await brain(databaseUrl, async ({ engine, root, stale }) => {
      const read = await passedMarker(engine, root, stale);
      await upsertMarker(engine, { sourceId: SOURCE, intent: 'freshness', wantedHead: stale, requestedBy: 'lock_busy' });
      const remaining = await settleMarkers(engine, SOURCE, [read], { pulled: false, full: false, checkoutHead: await lastCommit(engine) });
      expect(remaining.map(m => [m.generation, m.wanted_head])).toEqual([[read.generation + 1, stale]]);
    });
  }, 120_000);

  test('without a checkout head the store keeps exact settlement (no ancestry assumption)', async () => {
    await brain(databaseUrl, async ({ engine, root, stale }) => {
      const marker = await passedMarker(engine, root, stale);
      expect((await settleMarkers(engine, SOURCE, [marker], { pulled: false, full: false })).map(m => m.wanted_head)).toEqual([stale]);
      expect((await settleMarkers(engine, SOURCE, [marker], { pulled: false, full: false, checkoutHead: stale })).map(m => m.wanted_head)).toEqual([stale]);
    });
  }, 120_000);
});
