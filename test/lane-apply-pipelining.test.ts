/**
 * #5984 lane apply diet (Postgres only: PGLite runs pipelines one statement at
 * a time). Forced probes for the orderings the pipelined group publication and
 * import apply rely on.
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
import { publishGroup } from '../src/core/persistence/group-publish.ts';
import { principalKey, requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';
import type { PreparedMutation } from '../src/core/persistence/coordinator.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-lane-apply-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(e: BrainEngine, count: number) {
  const id = `lane-apply-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`);
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL, 'instance', 6); engine = pg.engine; closePostgres = pg.close;
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('a page lock with the expected source incarnation locks in one pipeline and refuses a recreated or missing source', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, 2);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
  const keys = (inc: string) => [{ sourceId: f.id, slug: 'notes/a', incarnation: inc }, { sourceId: f.id, slug: 'notes/b', incarnation: inc }];
  await engine.transaction(tx => tx.lockPageKeys(keys(incarnation!)));
  const guards = await engine.executeRaw<{ slug: string }>('SELECT slug FROM page_write_guards WHERE source_incarnation=$1::uuid AND slug=ANY($2::text[]) ORDER BY slug', [incarnation, ['notes/a', 'notes/b']]);
  expect(guards.map(g => g.slug)).toEqual(['notes/a', 'notes/b']);
  await expect(engine.transaction(tx => tx.lockPageKeys(keys(randomUUID())))).rejects.toThrow(`Page source was recreated: ${f.id}`);
  await expect(engine.transaction(tx => tx.lockPageKeys([{ sourceId: 'lane-apply-missing', slug: 'notes/a', incarnation: randomUUID() }])))
    .rejects.toThrow('Page source does not exist: lane-apply-missing');
}), 120_000);

test('a lane group whose page lock times out reports lock_timeout, not the abort its later statements see', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, 3);
  await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  await disposePersistenceConsumer(engine);
  // The committed page requests, put back into the running state with fresh claims, as a group publication would see them.
  const rows = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),completed_at=NULL,published_at=NULL,
    claim_expires_at=now()+interval '5 minutes' WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' RETURNING *`, [f.id]);
  rows.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  await engine.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count+$2,intent_bytes=intent_bytes+$3 WHERE key=ANY($1::text[])',
    [['brain', principalKey(requestPrincipal(rows[0]!))], rows.length, rows.reduce((sum, row) => sum + Number(row.intent_bytes), 0)]);
  const pages = new Map((await engine.executeRaw<{ slug: string; id: number; revision: string }>('SELECT slug,id,knowledge_revision::text AS revision FROM pages WHERE source_id=$1', [f.id]))
    .map(p => [p.slug, p]));
  for (const row of rows) row.page_id = Number(pages.get(row.slug)!.id);
  const prepared: PreparedMutation[] = rows.map(row => ({ observedRevision: pages.get(row.slug)!.revision, validate: async () => {}, apply: async () => ({ status: 'skipped', slug: row.slug }) }));
  // Another writer holds the second page's row lock past the group's 1 s lock_timeout.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let locked!: () => void;
  const holding = new Promise<void>(resolve => { locked = resolve; });
  const holder = engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [f.id, rows[1]!.slug]);
    locked();
    await held;
  });
  await holding;
  try {
    const result = await publishGroup(engine, rows, prepared);
    expect(result.done).toBeNull();
    expect(result.reason).toBe('lock_timeout');
  } finally { release(); await holder; }
  // Nothing was published: every member is still running under its claim.
  const states = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=ANY($1::uuid[])', [rows.map(row => row.id)]);
  expect(states.every(s => s.state === 'running')).toBe(true);
}), 120_000);

test('re-importing a page without a publisher preimage versions the page as it was before the write', async () => {
  if (!engine) return;
  const sourceId = `lane-apply-plain-${randomUUID().replace(/-/g, '').slice(0, 12)}`; sources.push(sourceId);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,config) VALUES($1,$1,\'{}\')', [sourceId]);
  await importFromContent(engine, 'notes/versioned', '---\ntitle: Versioned\n---\nThe first body of this page.\n', { sourceId, noEmbed: true });
  await importFromContent(engine, 'notes/versioned', '---\ntitle: Versioned\n---\nThe second body of this page.\n', { sourceId, noEmbed: true });
  const versions = await engine.getVersions('notes/versioned', { sourceId });
  expect(versions.map(v => v.compiled_truth.trim())).toEqual(['The first body of this page.']);
  expect((await engine.getPage('notes/versioned', { sourceId }))?.compiled_truth.trim()).toBe('The second body of this page.');
}, 120_000);
