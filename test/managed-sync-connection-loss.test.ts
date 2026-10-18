/**
 * #6712 PR 2 (convergence mode f): a pooled connection that dies while a bulk group publishes.
 *
 * Protects: the owner that claimed the group releases every claim of the pass that never committed as soon as the
 * database answers again, so the drain re-claims them at once. Before, the error escaped the pass with each member
 * still `running` under the publication lease, and nothing freed them until that lease lapsed (about six minutes,
 * "claim lapsed: owner missing").
 *
 * Postgres only (bulk groups publish on Postgres).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-connection-loss-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (i: number, word: string) => `---\ntitle: Note ${i}\n---\nA ${word} observation number ${i}.\n`;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engine = pg.engine; closePostgres = pg.close;
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('a connection lost while a bulk group publishes frees the group\'s claims at once; the drain finishes without waiting out the publication lease', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '8' }, async () => {
  const e = engine;
  if (!e) return;
  const id = `loss-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < 40; i++) writeFileSync(join(root, `notes/n${i}.md`), note(i, 'first'));
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes: 1 };
  expect((await performSync(e, opts)).drain).toMatchObject({ outcome: 'synced' });
  for (let i = 0; i < 40; i++) writeFileSync(join(root, `notes/n${i}.md`), note(i, 'revised'));
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qam', 'revise');

  // The pooler drops: from the publication's commit boundary on, every statement fails CONNECTION_CLOSED for two seconds.
  const connectionClosed = () => Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6543'), { code: 'CONNECTION_CLOSED' });
  let downUntil = 0, dropped = false;
  const executeRaw = e.executeRaw;
  e.executeRaw = (async function (this: BrainEngine, ...args: Parameters<BrainEngine['executeRaw']>) {
    if (Date.now() < downUntil) throw connectionClosed();
    return executeRaw.apply(this, args);
  }) as BrainEngine['executeRaw'];
  installFaultHook(async (point, detail) => {
    if (dropped || point !== 'publication:before_commit' || detail.sourceId !== id) return;
    dropped = true; downUntil = Date.now() + 2000;
    throw connectionClosed();
  });
  const started = Date.now();
  let result;
  try { result = await performSync(e, opts); }
  finally { installFaultHook(undefined); e.executeRaw = executeRaw; }
  expect(dropped).toBe(true);
  expect(result.drain).toMatchObject({ outcome: 'synced' });
  // The owner-kill bound the convergence gate holds a pooler drop to (mode f), far below the publication lease.
  expect(Date.now() - started).toBeLessThan(70_000);
  const stuck = await e.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running')", [id]);
  expect(stuck).toHaveLength(0);
  for (let i = 0; i < 40; i++) expect((await e.getPage(`notes/n${i}`, { sourceId: id }))?.compiled_truth).toContain(`revised observation number ${i}`);
}), 600_000);
