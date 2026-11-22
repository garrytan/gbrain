import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pglite-yield-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});

test('a PGLite managed pass gives the event loop a turn between pages it holds without a write, so timers and signal handlers are not held until the pass ends', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const id = `yield-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id), pages = 12;
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { stdio: 'ignore' });
  const write = (suffix: string) => { for (let i = 0; i < pages; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nAn observation number ${i}${suffix}.\n`); };
  mkdirSync(join(root, 'notes'), { recursive: true }); git('init', '-q');
  write(''); git('add', '-A'); git('commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true })).status).toBe('first_sync');
  // Every page changes in the database and its file changes upstream, so the pass holds each page, one step per page, with no write to wait on.
  await engine.transaction(tx => withCoordinatedWrite(tx, [id], () =>
    tx.executeRaw("UPDATE pages SET compiled_truth=compiled_truth||' edited in the database', knowledge_revision=gen_random_uuid() WHERE source_id=$1", [id]), TEST_WRITE_ATTRIBUTION));
  write(', rewritten upstream'); git('commit', '-qam', 'rewrite notes');
  // Each held page queues a macrotask; the next one finds it still queued only if the pass never left the microtask queue in between.
  let held = 0, queued = false, starved = 0;
  const result = await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, onProgress: event => {
    if (event.phase !== 'managed_sync.page_committed') return;
    held++;
    if (queued) starved++;
    queued = true; setImmediate(() => { queued = false; });
  } });
  expect(result.held).toHaveLength(pages);
  expect(held).toBe(pages);
  expect(starved).toBe(0);
}), 120_000);
