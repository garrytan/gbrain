/**
 * #6075: a bulk drain groups a frozen head under its request ID (adding `group`, and `lane` under lanes)
 * while another owner loop that read the head before it was grouped admits it on the single path. The
 * drain admits a group with the cursor save that records it (#5984 Phase 1), so the race is between
 * that admission and the single path's: the drain must not wedge on `idempotency_conflict` when the
 * single path won, and the single-path guard must notice the grouped intent when the drain won.
 * Bulk groups are Postgres-only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-stale-head-'));
let engine: BrainEngine | undefined;
let databaseUrl = '';
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];

function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(e: BrainEngine, count: number) {
  const id = `head-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nObservation ${i} from acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
type StoredCursor = { pending?: { requestId: string; slug: string; pageId: number | null; intent: Record<string, unknown> }; group?: unknown[];
  incarnation: string; binding: { worktree_id: string; topology_generation: string | number }; authority: { writer: { principal: { kind: string; id: string } } & Record<string, unknown> } };
async function storedCursor(e: BrainEngine, sourceId: string): Promise<StoredCursor | null> {
  const [row] = await e.executeRaw<{ c: StoredCursor }>("SELECT completed_keys->0 AS c FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [sourceId]);
  return row?.c ?? null;
}
/** What an owner loop that read the head before it was grouped submits: the same request ID with the pre-group intent. */
async function admitAsStaleSinglePass(e: BrainEngine, sourceId: string, c: StoredCursor, intent: Record<string, unknown>) {
  const head = c.pending!;
  await admitWrite(e, { requestId: head.requestId, operation: 'submit_job', sourceId, sourceIncarnation: c.incarnation, slug: head.slug, pageId: head.pageId,
    worktreeId: c.binding.worktree_id, topologyGeneration: c.binding.topology_generation, principal: c.authority.writer.principal as never,
    authority: c.authority.writer as never, callerIntent: intent, intent });
}
const ungrouped = (intent: Record<string, unknown>) => { const { group: _g, lane: _l, ...rest } = intent; return rest; };
async function importedTitles(e: BrainEngine, sourceId: string, count: number) {
  const titles: Array<string | undefined> = [];
  for (let i = 0; i < count; i++) titles.push((await e.getPage(`notes/n${i}`, { sourceId }))?.title);
  return titles;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL, 'instance', 10);
  engine = pg.engine; closePostgres = pg.close; databaseUrl = pg.databaseUrl;
}, 120_000);
afterAll(async () => {
  installFaultHook(undefined);
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

for (const lanes of [1, 2]) {
  test(`a group whose head was already admitted on the single path is dropped and the drain finishes (lanes=${lanes})`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
    if (!engine) return;
    const e = engine, sourceId = await fixture(e, 10);
    let stale = false;
    // The drain has frozen the head's followers and is about to admit the group; the stored cursor still holds the ungrouped head.
    installFaultHook(async (point, detail) => {
      if (point !== 'sync:before_group_admission' || detail.sourceId !== sourceId || stale) return;
      const c = await storedCursor(e, sourceId);
      if (!c?.pending || c.group) return;
      stale = true;
      expect(c.pending.intent.group).toBeUndefined();
      await admitAsStaleSinglePass(e, sourceId, c, ungrouped(c.pending.intent));
    });
    try {
      const done = await performSync(e, { sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true, lanes });
      expect(stale).toBe(true);
      expect(done).toMatchObject({ status: 'first_sync', added: 10 });
    } finally { installFaultHook(undefined); }
    expect(await importedTitles(e, sourceId, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `Note ${i}`));
    const rows = await e.executeRaw<{ state: string }>(`SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import'`, [sourceId]);
    expect(rows).toHaveLength(10);
    expect(rows.every(row => row.state === 'committed')).toBe(true);
  }), 120_000);
}

test('a head admitted under its request ID with a different intent still refuses with idempotency_conflict', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const e = engine, sourceId = await fixture(e, 6);
  let stale = false;
  installFaultHook(async (point, detail) => {
    if (point !== 'sync:before_group_admission' || detail.sourceId !== sourceId || stale) return;
    const c = await storedCursor(e, sourceId);
    if (!c?.pending || c.group) return;
    stale = true;
    await admitAsStaleSinglePass(e, sourceId, c, { ...ungrouped(c.pending.intent), content: 'different bytes' });
  });
  try {
    await expect(performSync(e, { sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(stale).toBe(true);
  } finally { installFaultHook(undefined); }
}), 120_000);

test('a non-bulk pass that read the head before a drain grouped it does not admit the stale intent', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const e = engine, sourceId = await fixture(e, 10);
  // An independent connection holds the admission counters, so the non-bulk pass blocks inside its admission
  // transaction after reading the ungrouped head, and resumes only once the drain has grouped it.
  const blocker = postgres(databaseUrl, { max: 1, prepare: false });
  let stage = 0, single: Promise<unknown> | undefined, release: (() => void) | undefined;
  const lockHeld = new Promise<void>(resolve => { release = resolve; });
  let locked: Promise<unknown> | undefined;
  installFaultHook(async (point, detail) => {
    if (detail.sourceId !== sourceId) return;
    const c = await storedCursor(e, sourceId);
    if (point === 'sync:mid_checkpoint' && stage === 0 && c?.pending && !c.group) {
      stage = 1;
      let acquired!: () => void;
      const ready = new Promise<void>(resolve => { acquired = resolve; });
      locked = blocker.begin(async sql => {
        await sql`INSERT INTO persistence_counters(key) VALUES ('brain') ON CONFLICT DO NOTHING`;
        await sql`SELECT key FROM persistence_counters WHERE key='brain' FOR UPDATE`;
        acquired();
        await lockHeld;
      });
      await ready;
      single = performSync(e, { sourceId, noPull: true, noEmbed: true, noExtract: true }).then(value => ({ value }), error => ({ error }));
      for (let i = 0; i < 200; i++) {
        const [waiting] = await e.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND datname=current_database()");
        if (waiting!.n > 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } else if (point === 'sync:before_group_admission' && stage === 1) {
      // The drain grouped the head and its admission now races the blocked single pass's.
      stage = 2;
      release!();
      await locked;
    }
  });
  try {
    const drained = await performSync(e, { sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true }).then(value => ({ value }), error => ({ error }));
    const singled = await single;
    expect(stage).toBe(2);
    expect(singled).not.toHaveProperty('error');
    expect(drained).not.toHaveProperty('error');
  } finally { installFaultHook(undefined); release?.(); await locked?.catch(() => undefined); await blocker.end(); }
  const resumed = await performSync(e, { sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(['synced', 'first_sync', 'up_to_date']).toContain(resumed.status);
  expect(await importedTitles(e, sourceId, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `Note ${i}`));
  // Whichever admission won, the head was admitted once, under the intent its cursor held then: grouped, with its
  // followers in the same group, or ungrouped (the single path won), with no request naming the head as its group.
  const requests = await e.executeRaw<{ request_id: string; grp: string | null; state: string }>(`SELECT request_id,intent->>'group' AS grp,state
    FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [sourceId]);
  expect(requests).toHaveLength(10);
  expect(requests.every(row => row.state === 'committed')).toBe(true);
  const head = requests[0]!;
  const members = requests.filter(row => row.grp === head.request_id);
  if (head.grp === null) expect(members).toEqual([]);
  else { expect(head.grp).toBe(head.request_id); expect(members.length).toBeGreaterThan(1); }
}), 120_000);
