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
import { nextGroupSize, resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { withEnv } from './helpers/with-env.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { claimedHeadOrder, windowPredecessor } from '../src/core/persistence/sync-window.ts';
import { waitFor } from './helpers/wait-for.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-bulk-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function fixture(e: BrainEngine, files: Record<string, string>) {
  const id = `bulk-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body); }
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}
const notes = (count: number, edit: (i: number) => string | null = () => null) => Object.fromEntries(Array.from({ length: count }, (_, i) =>
  [`notes/n${i}.md`, edit(i) ?? `---\ntitle: Note ${i}\n---\nA durable observation number ${i}.\n`]));

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

test('group sizing follows the transaction budget and bulk settings follow flag > env > config', async () => {
  const settings = { enabled: true, reason: null, size: 16, maxTxnMs: 10_000 };
  expect(nextGroupSize(settings, null)).toBe(4);
  expect(nextGroupSize(settings, 2000)).toBe(5);
  expect(nextGroupSize(settings, 100)).toBe(16);
  expect(nextGroupSize(settings, 60_000)).toBe(1);
  const laned = { ...settings, maxTxnMs: 15_000, lanes: 6 };
  expect(nextGroupSize(laned, 1400, { first: true })).toBe(2);
  expect(nextGroupSize(laned, null)).toBe(16);
  expect(nextGroupSize(laned, 400)).toBe(12);
  expect(nextGroupSize(laned, 400, { foreground: true })).toBe(5);
  expect(nextGroupSize({ ...laned, maxTxnMs: 1_000, maxTxnExplicit: true }, 400)).toBe(2);
  expect(nextGroupSize({ ...laned, maxTxnMs: 60_000, maxTxnExplicit: true }, 400)).toBe(12);
  if (!engine) return;
  expect(await resolveBulkSettings(engine, true)).toMatchObject({ enabled: false, reason: 'disabled by --no-bulk' });
  await withEnv({ GBRAIN_SYNC_BULK: '0' }, async () => expect(await resolveBulkSettings(engine!, false)).toMatchObject({ enabled: false, reason: 'disabled by GBRAIN_SYNC_BULK=0' }));
  await engine.setConfig('sync.bulk', 'false');
  try { expect(await resolveBulkSettings(engine, false)).toMatchObject({ enabled: false, reason: 'disabled by config sync.bulk=false' }); }
  finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.bulk'"); }
  expect(await resolveBulkSettings(engine, false)).toMatchObject({ enabled: true, reason: null, size: 16 });
});

test('a bulk drain publishes groups in one transaction while every page keeps its own request and receipt', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(14));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(result).toMatchObject({ status: 'first_sync', added: 14 });
  expect(result.drain).toMatchObject({ outcome: 'synced', written: 14, bulk: { enabled: true } });
  expect(result.drain!.bulk!.groups).toBeGreaterThan(0);
  const rows = await engine.executeRaw<{ slug: string; state: string; grp: string | null; published: string }>(
    `SELECT slug,state,intent->>'group' AS grp,published_at::text AS published FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(rows).toHaveLength(14);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
  expect(new Set(rows.map(row => row.slug)).size).toBe(14);
  const sharedTransaction = new Map<string, number>();
  for (const row of rows) sharedTransaction.set(row.published, (sharedTransaction.get(row.published) ?? 0) + 1);
  expect(Math.max(...sharedTransaction.values())).toBeGreaterThan(1);
  for (let i = 0; i < 14; i++) expect((await engine.getPage(`notes/n${i}`, { sourceId: f.id }))?.title).toBe(`Note ${i}`);
  // Every page revision is attributed to its own request, also inside a shared group transaction.
  const attributed = await engine.executeRaw<{ slug: string; mismatched: boolean }>(`SELECT p.slug, p.revision_write_request_id IS DISTINCT FROM r.id AS mismatched
    FROM pages p JOIN persistence_requests r ON r.source_id=p.source_id AND r.slug=p.slug AND r.intent->>'kind'='managed_sync_import' WHERE p.source_id=$1`, [f.id]);
  expect(attributed).toHaveLength(14);
  expect(attributed.filter(row => row.mismatched)).toEqual([]);
  const [cursor] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0 ? 'group'");
  expect(cursor!.n).toBe(0);
}), 300_000);

/** #6712: the entries of a run (#6712 PR 4b: or a pass, whose intents carry passId and path, no runId or index) that were admitted more than once (a duplicate admission). */
const admittedTwice = (e: BrainEngine, id: string, except = '') => e.executeRaw<{ run: string; idx: string; n: number }>(`SELECT COALESCE(intent->>'runId',intent->>'passId') AS run,COALESCE(intent->>'index',intent->>'path') AS idx,count(*)::int AS n
  FROM persistence_requests WHERE source_id=$1 AND intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND slug<>$2 GROUP BY 1,2 HAVING count(*)>1`, [id, except]);
/** #6712 PR 4b: the import requests ever admitted for each path, in admission order; a page read on resume keeps the one request it had. */
async function requestsByPath(e: BrainEngine, id: string): Promise<Map<string, string[]>> {
  const rows = await e.executeRaw<{ path: string; request_id: string }>(`SELECT intent->>'path' AS path,request_id::text AS request_id FROM persistence_requests
    WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [id]);
  const byPath = new Map<string, string[]>();
  for (const row of rows) byPath.set(row.path, [...byPath.get(row.path) ?? [], row.request_id]);
  return byPath;
}
/** #6712: every admitted request of the source has settled (the consumer keeps publishing after the run returns). */
const settledAll = (e: BrainEngine, id: string) => waitFor(async () => (await e.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering') LIMIT 1", [id])).length === 0,
  { timeoutMs: 60_000, label: 'admitted requests settle' });

test('#6712: a failing member is attributed to its own page; the members before and after it commit on their own fate', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(10, i => i === 3 ? '---\ntitle: Conflict\nslug: notes/other\n---\nA conflicting identity must not be imported.\n' : null));
  // #5988 holds such a file by default; the fail-closed policy keeps it a publication failure inside the group.
  await engine.setConfig('sync.holds', 'fail');
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true })
    .finally(() => engine!.unsetConfig('sync.holds'));
  expect(result).toMatchObject({ status: 'blocked_by_failures', failedFiles: 1 });
  expect(result.drain).toMatchObject({ outcome: 'blocked', stop_reason: 'blocked_by_failures' });
  expect(result.managedWrite?.slug).toBe('notes/n3');
  await settledAll(engine, f.id);
  const states = await engine.executeRaw<{ slug: string; state: string }>(
    `SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(states.find(row => row.slug === 'notes/n3')?.state).toBe('failed');
  // Nothing is cancelled for another page's failure: every other admitted page commits.
  expect(states.filter(row => row.slug !== 'notes/n3').every(row => row.state === 'committed')).toBe(true);
  for (const row of states.filter(row => row.state === 'committed')) expect(await engine.getPage(row.slug, { sourceId: f.id })).not.toBeNull();
  expect(await engine.getPage('notes/n3', { sourceId: f.id })).toBeNull();
}), 300_000);

test('a held file ends the group before it: it is held without a request and every other page commits (#5988)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(10, i => i === 3 ? '---\ntitle: Conflict\nslug: notes/n1\n---\nA conflicting identity must not be imported.\n' : null));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(result.drain).toMatchObject({ outcome: 'synced' });
  expect(result).toMatchObject({ holds_outstanding: 1 });
  const states = await engine.executeRaw<{ slug: string; state: string }>(
    `SELECT slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(states.map(row => row.slug)).not.toContain('notes/n3');
  expect(states.every(row => row.state === 'committed')).toBe(true);
  expect(states).toHaveLength(9);
  expect(await engine.getPage('notes/n3', { sourceId: f.id })).toBeNull();
}), 300_000);

test('a draining sync admits the next group while the current one publishes; every page commits in manifest order', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(20));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
  expect(result.drain).toMatchObject({ outcome: 'synced' });
  const rows = await engine.executeRaw<{ slug: string; state: string; after: string | null; published: string; sequence: string }>(
    `SELECT slug,state,intent->>'after' AS after,published_at::text AS published,sequence::text FROM persistence_requests
     WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
  expect(rows).toHaveLength(20);
  expect(rows.every(row => row.state === 'committed')).toBe(true);
  // At least one group was admitted ahead, naming the request it waits for.
  const ahead = rows.filter(row => row.after);
  expect(ahead.length).toBeGreaterThan(0);
  const ids = await engine.executeRaw<{ request_id: string; slug: string }>(`SELECT request_id::text,slug FROM persistence_requests WHERE source_id=$1`, [f.id]);
  const slugOf = new Map(ids.map(row => [row.request_id, row.slug]));
  for (const row of ahead) expect(rows.findIndex(r => r.slug === slugOf.get(row.after!))).toBeLessThan(rows.findIndex(r => r.slug === row.slug));
  // Publication order follows manifest (admission) order.
  const published = rows.map(row => row.published);
  expect([...published].sort()).toEqual(published);
  const [cursor] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM op_checkpoints WHERE op='managed-sync' AND (completed_keys->0 ? 'window' OR completed_keys->0 ? 'group') AND completed_keys->0->>'sourceId'=$1", [f.id]);
  expect(cursor!.n).toBe(0);
}), 300_000);

test('#6712: a failed page leaves the groups admitted ahead of it in the cursor until their own receipts are read; nothing is admitted twice', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  if (!engine) return;
  const conflict = '---\ntitle: Conflict\nslug: notes/other\n---\nA conflicting identity must not be imported.\n';
  const f = await fixture(engine, notes(40, i => i === 2 ? conflict : null));
  await engine.setConfig('sync.holds', 'fail');
  try {
    const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
    expect(result.drain).toMatchObject({ outcome: 'blocked' });
    expect(result.managedWrite?.slug).toBe('notes/n2');
    await settledAll(engine, f.id);
    const rows = await engine.executeRaw<{ request_id: string; slug: string; state: string }>(
      `SELECT request_id::text AS request_id,slug,state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence`, [f.id]);
    const failedAt = rows.findIndex(row => row.slug === 'notes/n2');
    expect(rows[failedAt]!.state).toBe('failed');
    expect(rows.filter((_, i) => i !== failedAt).every(row => row.state === 'committed')).toBe(true);
    // Every request admitted after the failure has its receipt, so a resume reads it instead of freezing the page again.
    // #6712 PR 4b: a pass keeps no cursor row to name them; the source has not advanced, and the resume below must
    // leave each page with exactly the requests it has now.
    expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0]!.last_commit).toBeNull();
    expect(rows.length - failedAt - 1).toBeGreaterThan(0);
    const before = await requestsByPath(engine, f.id);
    // The file is fixed; the same plain sync finishes, every page committed exactly once.
    writeFileSync(join(f.root, 'notes/n2.md'), '---\ntitle: Note 2\n---\nA durable observation number 2.\n');
    execFileSync('git', ['-C', f.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qam', 'fix']);
    const resumed = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, retryFailed: true });
    expect(resumed.drain).toMatchObject({ outcome: 'synced' });
    // --retry-failed rediscovered the manifest under a new run; within each run every entry was admitted at most once.
    expect(await admittedTwice(engine, f.id)).toEqual([]);
    const after = await requestsByPath(engine, f.id);
    for (const [path, ids] of before) if (path !== 'notes/n2.md') expect(after.get(path)).toEqual(ids);
    for (let i = 0; i < 40; i++) expect(await engine.getPage(`notes/n${i}`, { sourceId: f.id })).not.toBeNull();
    const conflicts = await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND error_code='revision_conflict'", [f.id]);
    expect(conflicts).toHaveLength(0);
  } finally { await engine.unsetConfig('sync.holds'); }
}), 300_000);

test('#6712 (#6565): a database refusal stops the run, and the next plain sync re-freezes every page the same refusal failed, so one run converges once it is lifted', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(24));
  const opts = { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true };
  expect((await performSync(engine, opts)).drain).toMatchObject({ outcome: 'synced' });
  for (let i = 0; i < 24; i++) writeFileSync(join(f.root, `notes/n${i}.md`), `---\ntitle: Note ${i}\n---\nA revised observation number ${i}.\n`);
  execFileSync('git', ['-C', f.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qam', 'revise']);
  const since = (await engine.executeRaw<{ at: string }>('SELECT now()::text AS at'))[0]!.at;
  await engine.executeRaw(`CREATE FUNCTION bulk_systemic_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'test: systemic refusal'; END $$`);
  await engine.executeRaw('CREATE TRIGGER bulk_systemic_refusal BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION bulk_systemic_refusal()');
  try {
    expect((await performSync(engine, opts)).drain).toMatchObject({ outcome: 'blocked' });
    await settledAll(engine, f.id);
  } finally { await engine.executeRaw('DROP TRIGGER bulk_systemic_refusal ON pages; DROP FUNCTION bulk_systemic_refusal()'); }
  const [refused] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1
    AND intent->>'kind'='managed_sync_import' AND state='failed' AND created_at > $2::timestamptz`, [f.id, since]);
  expect(refused!.n).toBeGreaterThan(1);
  expect((await performSync(engine, opts)).drain).toMatchObject({ outcome: 'synced' });
  for (let i = 0; i < 24; i++) expect((await engine.getPage(`notes/n${i}`, { sourceId: f.id }))?.compiled_truth).toContain(`revised observation number ${i}`);
}), 300_000);

/**
 * #6712 Eng finding ("followers that commit after the failure CAS"): the group admitted ahead of a failed page is
 * held back in preparation until the drain has saved the failure and is gone (under `sync.holds=fail` it stops blocked;
 * under the default policy it is killed right after the cursor step that holds the failed page); it then commits. The
 * cursor must still name every such request, so the resume reads their receipts: nothing is admitted twice, nothing
 * reads a false revision_conflict, and the checkpoint waits for them. #6712 PR 4b: a pass keeps its cursor in memory
 * and its intents carry no index, so the followers are the requests admitted after the failed page's group (by
 * sequence), a pass holds the failed page at the end of its round (the drainer is killed as its next round starts),
 * and "read on resume" is that every page keeps exactly the requests it had when the drainer died. The failed page is a content refusal under
 * `sync.holds=fail`, and a preparation that outlives its budget (`preparation_stalled`, held) under the default policy.
 */
for (const policy of ['fail', 'hold'] as const) test(`#6712: window followers that commit after the failure CAS and a drainer kill are read on resume, never re-admitted (sync.holds=${policy})`, async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  if (!engine) return;
  const e = engine;
  const conflict = '---\ntitle: Conflict\nslug: notes/other\n---\nA conflicting identity must not be imported.\n';
  const f = await fixture(e, notes(40, i => i === 2 && policy === 'fail' ? conflict : null));
  const config: Array<[string, string]> = policy === 'fail' ? [['sync.holds', 'fail']] : [];
  for (const [key, value] of config) await e.setConfig(key, value);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stalled = new Set<string>();
  let failedRequest: string | null = null, rounds = 0;
  installFaultHook(async (point, detail) => {
    // Default policy: the cursor step that holds or defers the failed page is the last thing the drainer does.
    if ((point === 'sync:held_settled' || point === 'sync:retry_deferred') && detail.sourceId === f.id) throw new Error('drainer killed after the failure CAS');
    // A pass settles the failed page with its round; the next round start is the drainer's next step.
    if (point === 'sync:round_start' && detail.sourceId === f.id && policy === 'hold' && rounds++ > 0 && failedRequest
      && (await e.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [failedRequest]))[0]?.state === 'conflict') throw new Error('drainer killed after the failure CAS');
    if (point !== 'consumer:preparing' || detail.sourceId !== f.id || !detail.requestId) return;
    const [row] = await e.executeRaw<{ slug: string; grp: string | null; idx: number }>("SELECT slug,intent->>'group' AS grp,sequence::int AS idx FROM persistence_requests WHERE request_id=$1::uuid", [detail.requestId]);
    if (row?.slug === 'notes/n2') {
      failedRequest ??= detail.requestId;
      // Default policy: the file changes under the admitted request (uncommitted bytes), so its publication refuses it.
      if (policy === 'hold') writeFileSync(join(f.root, 'notes/n2.md'), '---\ntitle: Note 2\n---\nEdited after admission, not committed.\n');
      return;
    }
    const [failed] = await e.executeRaw<{ grp: string | null; idx: number }>("SELECT intent->>'group' AS grp,sequence::int AS idx FROM persistence_requests WHERE source_id=$1 AND slug='notes/n2' ORDER BY sequence LIMIT 1", [f.id]);
    // Hold back every request admitted in a group after the failed page's group until the drain is gone.
    if (!row || !failed || row.grp === failed.grp || row.idx <= failed.idx) return;
    stalled.add(detail.requestId);
    await Promise.race([gate, new Promise(resolve => detail.signal?.addEventListener('abort', resolve))]);
  });
  try {
    const killed = await performSync(e, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true }).catch((error: Error) => error);
    if (policy === 'fail') expect((killed as { drain?: unknown }).drain).toMatchObject({ outcome: 'blocked' });
    else expect(String(killed)).toContain('drainer killed after the failure CAS');
    expect(failedRequest).not.toBeNull();
    expect(stalled.size).toBeGreaterThan(0);
    // The drain is gone; it saved the failure (or the hold). Every request admitted after it is recorded, so a resume reads it.
    const before = await requestsByPath(e, f.id);
    const recorded = new Set([...before.values()].flat());
    for (const id of stalled) expect(recorded.has(id)).toBe(true);
    // Now the held-back followers commit, after the failure CAS, with nobody observing them.
    release();
    await settledAll(e, f.id);
    for (const id of stalled) expect((await e.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [id]))[0]!.state).toBe('committed');
    // No premature checkpoint: the source did not advance.
    expect((await e.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0]!.last_commit).toBeNull();
    installFaultHook(undefined);
    if (policy === 'fail') {
      // A plain resume stays on the failed page and admits nothing again.
      const again = await performSync(e, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true });
      expect(again.drain).toMatchObject({ outcome: 'blocked' });
      // Only the failed page may be re-frozen, once for the same bytes (#5988 E6); no follower is admitted again.
      expect(await admittedTwice(e, f.id, 'notes/n2')).toEqual([]);
      writeFileSync(join(f.root, 'notes/n2.md'), '---\ntitle: Note 2\n---\nA durable observation number 2.\n');
      execFileSync('git', ['-C', f.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qam', 'fix']);
    }
    const resumed = await performSync(e, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, ...(policy === 'fail' ? { retryFailed: true } : {}) });
    expect(resumed.drain).toMatchObject({ outcome: 'synced' });
    await settledAll(e, f.id);
    expect(await admittedTwice(e, f.id, 'notes/n2')).toEqual([]);
    for (const id of stalled) expect((await e.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [id]))[0]!.state).toBe('committed');
    // Read on resume, never re-admitted: every page but the failed one keeps exactly the requests it had when the drainer died.
    const after = await requestsByPath(e, f.id);
    for (const [path, ids] of before) if (path !== 'notes/n2.md') expect(after.get(path)).toEqual(ids);
    expect(await e.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND error_code='revision_conflict'", [f.id])).toHaveLength(0);
    for (let i = 0; i < 40; i++) if (i !== 2 || policy === 'fail') expect(await e.getPage(`notes/n${i}`, { sourceId: f.id })).not.toBeNull();
  } finally {
    installFaultHook(undefined); release();
    for (const [key] of config) await e.unsetConfig(key);
  }
}), 300_000);

test('#6712: a claimed window head publishes whatever its predecessor became; it is never cancelled for it', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(1));
  const [worktree] = await engine.executeRaw<{ worktree_id: string }>('SELECT worktree_id FROM persistence_source_bindings WHERE source_id=$1', [f.id]);
  const missing = randomUUID();
  const head = { id: randomUUID(), request_id: randomUUID(), worktree_id: worktree!.worktree_id, principal_kind: 'local_cli', principal_id: randomUUID(), sequence: 1,
    execution_token: null, state: 'queued', intent: { kind: 'managed_sync_import', after: missing } } as unknown as WriteRequest;
  expect(windowPredecessor(head)).toBe(missing);
  expect(await claimedHeadOrder(engine, head, false)).toBeNull();
  expect(await claimedHeadOrder(engine, head, true)).toBeNull();
}), 300_000);

test('--no-bulk publishes one page per transaction', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  if (!engine) return;
  const f = await fixture(engine, notes(5));
  const result = await performSync(engine, { sourceId: f.id, noPull: true, noEmbed: true, noExtract: true, drain: true, noBulk: true });
  expect(result.drain).toMatchObject({ outcome: 'synced', bulk: { enabled: false, reason: 'disabled by --no-bulk', groups: 0 } });
  const grouped = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent ? 'group'", [f.id]);
  expect(grouped[0]!.n).toBe(0);
}), 300_000);
