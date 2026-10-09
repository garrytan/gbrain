/**
 * #5984 round-trip diet: set-based group completion (one statement for every
 * member, short RETURNING rolls back to the single path with each member's own
 * code), the counter-hold bound, and the one preimage + one postimage read a
 * managed-sync page publication makes on create, update and delete. Runs on
 * PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { completeGroup } from '../src/core/persistence/group-publish.ts';
import { completeWrite, LOCK_COUNTERS_SQL } from '../src/core/persistence/journal.ts';
import { principalKey, requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-group-completion-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes'); };
const note = (i: number, body = `A durable observation number ${i}.`) => `---\ntitle: Note ${i}\n---\n${body}\n`;
async function fixture(engine: BrainEngine, count: number) {
  const id = `grp-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), note(i));
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
const sync = (engine: BrainEngine, sourceId: string) => performSync(engine, { sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true });

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
      await engine.disconnect();
    }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

/** Committed page requests of a synced source, put back into the running state with fresh claims and their counter reservations restored. */
async function reopen(engine: BrainEngine, sourceId: string): Promise<WriteRequest[]> {
  const rows = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='running',execution_token=gen_random_uuid(),completed_at=NULL,published_at=NULL,
    claim_expires_at=now()+interval '5 minutes' WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' RETURNING *`, [sourceId]);
  rows.sort((a, b) => Number(a.sequence) - Number(b.sequence));
  const bytes = rows.reduce((sum, row) => sum + Number(row.intent_bytes), 0);
  await engine.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count+$2,intent_bytes=intent_bytes+$3 WHERE key=ANY($1::text[])',
    [['brain', principalKey(requestPrincipal(rows[0]!))], rows.length, bytes]);
  return rows;
}
async function counters(engine: BrainEngine, row: WriteRequest): Promise<Record<string, string>> {
  const rows = await engine.executeRaw<{ key: string; outstanding_count: string; intent_bytes: string }>(
    'SELECT key,outstanding_count::text,intent_bytes::text FROM persistence_counters WHERE key=ANY($1::text[]) ORDER BY key', [['brain', principalKey(requestPrincipal(row))]]);
  return Object.fromEntries(rows.map(r => [r.key, `${r.outstanding_count}/${r.intent_bytes}`]));
}
const states = async (engine: BrainEngine, rows: WriteRequest[]) => (await engine.executeRaw<{ id: string; state: string; execution_token: string | null }>(
  'SELECT id,state,execution_token FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [rows.map(row => row.id)]));
const outcomes = (rows: WriteRequest[]) => rows.map(row => ({ status: 'created', slug: row.slug, source_id: row.source_id }));

test('set-based completion commits every member in one statement and releases their counter reservations', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 4);
    await sync(engine, f.id);
    await disposePersistenceConsumer(engine);
    const settled = await counters(engine, (await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' LIMIT 1", [f.id]))[0]!);
    const rows = await reopen(engine, f.id);
    expect(rows).toHaveLength(4);
    const done = await engine.transaction(tx => completeGroup(tx, rows, outcomes(rows)));
    expect(done.map(row => [row.id, row.state])).toEqual(rows.map(row => [row.id, 'committed']));
    expect(done.every(row => { const r = row as unknown as Record<string, unknown>; return r.published_at != null && r.consumer_version != null && row.outcome?.slug === row.slug; })).toBe(true);
    expect((done[0] as unknown as Record<string, unknown>).principal_key).toBeUndefined();
    expect(await counters(engine, rows[0]!)).toEqual(settled);
  }
}), 300_000);

for (const fault of ['claim lost', 'already terminal', 'terminal reservation exceeded'] as const) {
  test(`a short RETURNING (${fault}) rolls the group back and the single path gives each member its own outcome`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const f = await fixture(engine, 3);
      await sync(engine, f.id);
      await disposePersistenceConsumer(engine);
      const rows = await reopen(engine, f.id);
      const before = await counters(engine, rows[0]!);
      const victim = rows[1]!;
      if (fault === 'claim lost') await engine.executeRaw('UPDATE persistence_requests SET execution_token=gen_random_uuid() WHERE id=$1::uuid', [victim.id]);
      if (fault === 'already terminal') await engine.executeRaw("UPDATE persistence_requests SET state='failed',execution_token=NULL,error_code='storage_error' WHERE id=$1::uuid", [victim.id]);
      if (fault === 'terminal reservation exceeded') await engine.executeRaw('UPDATE persistence_requests SET terminal_reservation=1 WHERE id=$1::uuid', [victim.id]);
      const tampered = await states(engine, rows);
      await expect(engine.transaction(tx => completeGroup(tx, rows, outcomes(rows)))).rejects.toMatchObject({ code: 'write_claim_lost' });
      // Nothing committed and no counter moved: the whole group rolled back.
      expect(await states(engine, rows)).toEqual(tampered);
      expect(await counters(engine, rows[0]!)).toEqual(before);
      // The single path: the first member commits, the faulted member keeps completeWrite's exact outcome.
      expect((await engine.transaction(tx => completeWrite(tx, rows[0]!, 'committed', outcomes(rows)[0]!))).state).toBe('committed');
      const single = engine.transaction(tx => completeWrite(tx, victim, 'committed', outcomes(rows)[1]!));
      if (fault === 'claim lost') await expect(single).rejects.toMatchObject({ code: 'write_claim_lost' });
      if (fault === 'already terminal') expect(await single).toMatchObject({ state: 'failed', error_code: 'storage_error' });
      if (fault === 'terminal reservation exceeded') await expect(single).rejects.toMatchObject({ code: 'queue_capacity' });
    }
  }), 300_000);
}

test('the counters are held for the lock and one completion statement, pipelined on Postgres', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const f = await fixture(engine, 5);
    await sync(engine, f.id);
    await disposePersistenceConsumer(engine);
    const rows = await reopen(engine, f.id);
    const issued: Array<{ sql: string; earlierPending: boolean }> = [];
    let pending = 0;
    await engine.transaction(async tx => {
      const recording = new Proxy(tx, { get(target, key, receiver) {
        if (key !== 'executeRaw') return Reflect.get(target, key, receiver);
        return (sql: string, params?: unknown[]) => {
          issued.push({ sql, earlierPending: pending > 0 });
          pending++;
          return target.executeRaw(sql, params).finally(() => { pending--; });
        };
      } });
      await completeGroup(recording, rows, outcomes(rows));
    });
    const lock = issued.findIndex(s => s.sql === LOCK_COUNTERS_SQL);
    // Missing counter rows are created first; the effect sizes are read inside the completing UPDATE.
    expect(lock).toBe(1);
    // Under the counter lock: the lock itself and one UPDATE, whatever the group size; COMMIT follows.
    expect(issued.slice(lock)).toHaveLength(2);
    expect(issued[lock + 1]!.sql).toContain('UPDATE persistence_requests r SET');
    if (engine.kind === 'postgres') expect(issued[lock + 1]!.earlierPending).toBe(true);
  }
}), 300_000);

test('a page publication reads the page once before and once after apply, on create, update and delete', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const engine of engines) {
    const reads = new Map<string, number>();
    const original = engine.readPageSnapshot;
    const counted = function (this: BrainEngine & { _pageTransaction?: boolean }, ...args: Parameters<BrainEngine['readPageSnapshot']>) {
      if (this._pageTransaction && args[1]?.sourceId?.startsWith('grp-') && args[0].startsWith('notes/')) reads.set(args[0], (reads.get(args[0]) ?? 0) + 1);
      return original.apply(this, args);
    };
    (engine as { readPageSnapshot: unknown }).readPageSnapshot = counted;
    try {
      const f = await fixture(engine, 3);
      await sync(engine, f.id);
      expect(Object.fromEntries(reads)).toEqual({ 'notes/n0': 2, 'notes/n1': 2, 'notes/n2': 2 });
      reads.clear();
      writeFileSync(join(f.root, 'notes', 'n1.md'), note(1, 'An updated observation.'));
      rmSync(join(f.root, 'notes', 'n2.md'));
      commit(f.root);
      await sync(engine, f.id);
      expect(Object.fromEntries(reads)).toEqual({ 'notes/n1': 2, 'notes/n2': 2 });
      const receipts = await engine.executeRaw<{ slug: string; kind: string; revision: string | null; status: string }>(
        `SELECT slug,intent->>'kind' AS kind,outcome->>'revision' AS revision,outcome->>'status' AS status FROM persistence_requests
         WHERE source_id=$1 AND state='committed' AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') ORDER BY sequence`, [f.id]);
      const pages = new Map((await engine.executeRaw<{ slug: string; revision: string; deleted: boolean }>(
        'SELECT slug,knowledge_revision::text AS revision,deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1', [f.id])).map(p => [p.slug, p]));
      const last = new Map(receipts.map(r => [`${r.slug}:${r.kind}`, r]));
      // Each receipt carries the revision the page holds after its publication.
      expect(last.get('notes/n0:managed_sync_import')).toMatchObject({ status: 'created', revision: pages.get('notes/n0')!.revision });
      expect(last.get('notes/n1:managed_sync_import')).toMatchObject({ status: 'updated', revision: pages.get('notes/n1')!.revision });
      expect(last.get('notes/n2:managed_sync_delete')).toMatchObject({ status: 'soft_deleted', revision: pages.get('notes/n2')!.revision });
      expect(pages.get('notes/n2')!.deleted).toBe(true);
      expect((await engine.getPage('notes/n1', { sourceId: f.id }))?.compiled_truth).toContain('An updated observation.');
      // The text projection is sealed at the published revision.
      const [sealed] = await engine.executeRaw<{ ok: boolean }>("SELECT text_projection_revision=knowledge_revision AS ok FROM pages WHERE source_id=$1 AND slug='notes/n1'", [f.id]);
      expect(sealed!.ok).toBe(true);
    } finally {
      (engine as { readPageSnapshot: unknown }).readPageSnapshot = original;
    }
  }
}), 300_000);
