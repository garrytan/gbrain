/**
 * #6007: a put_pages batch publishes on Postgres as grouped transactions
 * (group-publish.ts): one claim, one recovery-record transaction, one
 * publication transaction and one cleanup transaction for up to eight pages,
 * files included. Any member failure rolls the group back, restores every file
 * it published, and the members then publish one at a time so the failure is
 * attributed to its own page.
 */
import { describe, expect, test as bunTest } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter, withVerifiedLocalRegistration, type LocalRegistration } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer, preparePersistedMutation } from '../../src/core/persistence/service.ts';
import { claimGroupFollowers, claimNextWrite, publicationGroupKey } from '../../src/core/persistence/journal.ts';
import { executeClaimedGroup } from '../../src/core/persistence/group-publish.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';

const d = hasDatabase() ? describe : describe.skip;
const config = { engine: 'postgres' as const, embedding_disabled: true };
let engine: PostgresEngine;
let root: string;
let registration: LocalRegistration;
const page = (slug: string, body: string) => ({ slug, content: `---\ntitle: ${slug}\ntype: note\n---\n\n${body}\n` });

function test(name: string, run: () => Promise<void>) {
  bunTest(name, async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-group-pg-'));
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine;
    root = join(fixtureDir, 'brain'); mkdirSync(root);
    _resetWriteThroughCacheForTest();
    try {
      await withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
        await engine.setConfig('sync.repo_path', root);
        await claimWorktree(engine, 'default', root);
        registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] });
        try { await run(); } finally { await disposePersistenceConsumer(engine); }
      });
    } finally {
      _resetWriteThroughCacheForTest();
      await pg.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60_000);
}
async function dispatch(name: string, params: Record<string, unknown>) {
  const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params, {
    remote: true, config, sourceId: 'default',
    auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] },
    logger: { info() {}, warn() {}, error() {} },
  }));
  return JSON.parse((response.content[0] as { text: string }).text) as Record<string, any>;
}
const requests = () => engine.executeRaw<WriteRequest & { published: string | null }>(
  "SELECT *,published_at::text AS published FROM persistence_requests WHERE operation='put_page' ORDER BY sequence");
const recoveryBytes = async () => engine.executeRaw<{ key: string; n: number }>('SELECT key,recovery_bytes::int AS n FROM persistence_counters WHERE recovery_bytes<>0');

d('#6007 grouped put_pages publication on Postgres', () => {
  test('a batch publishes its file-bearing pages in one transaction with per-page receipts, files, effects and re-armed links', async () => {
    const slugs = ['notes/g-1', 'notes/g-2', 'notes/g-3', 'notes/g-4'];
    const result = await dispatch('put_pages', { request_id: randomUUID(), pages: slugs.map((slug, i) => page(slug, `Grouped body ${i} links [[${slugs[(i + 1) % 4]}]].`)), wait_ms: 20_000 });
    expect(result).toMatchObject({ state: 'committed', counts: { total: 4, committed: 4 } });
    const rows = await requests();
    expect(rows.map(row => row.state)).toEqual(['committed', 'committed', 'committed', 'committed']);
    expect(rows.every(row => publicationGroupKey(row) === publicationGroupKey(rows[0]!))).toBe(true);
    // now() is the transaction start: one shared publication timestamp proves one transaction.
    expect(new Set(rows.map(row => row.published)).size).toBe(1);
    expect(rows.every(row => row.recovery === null && row.publication_started)).toBe(true);
    expect(await recoveryBytes()).toEqual([]);
    for (const [i, slug] of slugs.entries()) {
      expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain(`Grouped body ${i}`);
      expect((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.compiled_truth).toContain(`Grouped body ${i}`);
    }
    const effects = await engine.executeRaw<{ kind: string; n: number; reconciled: number }>(`SELECT kind,count(*)::int AS n,
      count(*) FILTER (WHERE data ? 'batch_reconciled')::int AS reconciled FROM persistence_effects GROUP BY kind ORDER BY kind`);
    expect(Object.fromEntries(effects.map(e => [e.kind, e.n]))).toMatchObject({ git: 4, embedding: 4, links: 4 });
    expect(effects.find(e => e.kind === 'links')!.reconciled).toBe(4);
    const attributed = await engine.executeRaw<{ slug: string; request: string }>(`SELECT slug,revision_write_request_id::text AS request FROM pages WHERE slug=ANY($1) ORDER BY slug`, [slugs]);
    expect(attributed.map(row => row.request)).toEqual(rows.map(row => row.id));
  });

  test('a member failure rolls the group back, restores its published files and publishes the members one at a time', async () => {
    const existing = join(root, 'notes', 'f-1.md');
    mkdirSync(join(root, 'notes'), { recursive: true });
    // The first page replaces an existing file so restoration has original bytes to bring back.
    expect((await dispatch('put_page', { ...page('notes/f-1', 'Original canonical body.'), request_id: randomUUID() })).state).toBe('committed');
    const original = readFileSync(existing, 'utf8');
    const [current] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE slug='notes/f-1'");
    await disposePersistenceConsumer(engine);
    // Hold the worktree so the admission's consumer cannot publish; the test drives the claim itself.
    const holder = await acquireWorktree((await getWorktreeBinding(engine, 'default'))!, 5000);
    expect(holder).not.toBeNull();
    let batch: Record<string, any>;
    try {
      batch = await dispatch('put_pages', { request_id: randomUUID(), wait_ms: 0, pages: [
        { ...page('notes/f-1', 'Replacement body.'), expected_revision: current!.revision },
        page('notes/f-2', 'Refused body.'), page('notes/f-3', 'Third body.')] });
      expect(batch.state).toBe('pending');
      await disposePersistenceConsumer(engine);
    } finally { await holder!.release(); }
    await engine.executeRaw("UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,blocked_reason=NULL WHERE state='running' AND recovery IS NULL");
    const head = (await claimNextWrite(engine, localHostId()))!;
    expect(head.slug).toBe('notes/f-1');
    const followers = await claimGroupFollowers(engine, head, publicationGroupKey(head)!, 7);
    expect(followers.map(row => row.slug)).toEqual(['notes/f-2', 'notes/f-3']);
    const settled: WriteRequest[] = [];
    let restoredBytes: string | undefined;
    let stagingLeft = true;
    const progressed = await executeClaimedGroup(engine, [head, ...followers], {
      hostId: localHostId(),
      prepare: async row => {
        const prepared = await preparePersistedMutation(engine, row, config as never);
        if (row.slug !== 'notes/f-2') return prepared;
        return { ...prepared, validate: async () => { throw new OperationError('revision_conflict', 'The page changed during preparation.', 'Fixture refusal.'); } };
      },
      settled: row => settled.push(row),
      hooks: { rolledBack: async () => {
        restoredBytes = readFileSync(existing, 'utf8');
        stagingLeft = (await engine.executeRaw('SELECT id FROM persistence_requests WHERE recovery IS NOT NULL')).length > 0;
      } },
    });
    expect(progressed).toBe(true);
    // The group had replaced f-1's file before f-2 failed; the rollback put the original bytes back first.
    expect(restoredBytes).toBe(original);
    expect(stagingLeft).toBe(false);
    expect(existsSync(join(root, 'notes', 'f-2.md'))).toBe(false);
    const rows = await requests();
    const bySlug = Object.fromEntries(rows.filter(row => row.intent?.page_batch).map(row => [row.slug, row]));
    expect(bySlug['notes/f-1']!.state).toBe('committed');
    expect(bySlug['notes/f-2']!.state).toBe('conflict');
    expect(bySlug['notes/f-2']!.error_code).toBe('revision_conflict');
    expect(bySlug['notes/f-3']!.state).toBe('committed');
    expect(new Set([bySlug['notes/f-1']!.published, bySlug['notes/f-3']!.published]).size).toBe(2);
    expect(settled.map(row => [row.slug, row.state])).toEqual([['notes/f-1', 'committed'], ['notes/f-2', 'conflict'], ['notes/f-3', 'committed']]);
    expect(readFileSync(existing, 'utf8')).toContain('Replacement body.');
    expect(readFileSync(join(root, 'notes', 'f-3.md'), 'utf8')).toContain('Third body.');
    expect(await engine.executeRaw("SELECT slug FROM pages WHERE slug='notes/f-2'")).toEqual([]);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE recovery IS NOT NULL')).toEqual([]);
    expect(await recoveryBytes()).toEqual([]);
    const effects = await engine.executeRaw<{ slug: string; kind: string }>(`SELECT r.slug,e.kind FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      WHERE r.intent ? 'page_batch' AND e.kind IN ('git','embedding') ORDER BY r.slug,e.kind`);
    expect(effects.map(e => `${e.slug}:${e.kind}`)).toEqual(['notes/f-1:embedding', 'notes/f-1:git', 'notes/f-3:embedding', 'notes/f-3:git']);
    const attributed = await engine.executeRaw<{ slug: string; request: string }>("SELECT slug,revision_write_request_id::text AS request FROM pages WHERE slug IN ('notes/f-1','notes/f-3') ORDER BY slug");
    expect(attributed.map(row => row.request)).toEqual([bySlug['notes/f-1']!.id, bySlug['notes/f-3']!.id]);
    // The receipt reads the per-page outcomes back.
    const status = await dispatch('put_pages', { request_id: batch!.batch_request_id });
    expect(status).toMatchObject({ state: 'partial', counts: { committed: 2, failed: 1 } });
  });

  test('claiming a group\'s followers locks only the members, never the write queued after them (#5984 G6)', async () => {
    await disposePersistenceConsumer(engine);
    const holder = await acquireWorktree((await getWorktreeBinding(engine, 'default'))!, 5000);
    expect(holder).not.toBeNull();
    try {
      expect((await dispatch('put_pages', { request_id: randomUUID(), wait_ms: 0, pages: [page('notes/l-1', 'One.'), page('notes/l-2', 'Two.'), page('notes/l-3', 'Three.')] })).state).toBe('pending');
      const single = await dispatch('put_page', { ...page('notes/l-after', 'Foreground after the batch.'), request_id: randomUUID(), wait_ms: 0 });
      expect(JSON.stringify(single)).toContain('pending');
      await disposePersistenceConsumer(engine);
    } finally { await holder!.release(); }
    await engine.executeRaw("UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,blocked_reason=NULL WHERE state='running' AND recovery IS NULL");
    const rows = await requests();
    const after = rows.find(row => row.slug === 'notes/l-after')!;
    const member = rows.find(row => row.slug === 'notes/l-3')!;
    const head = (await claimNextWrite(engine, localHostId()))!;
    expect(head.slug).toBe('notes/l-1');
    const update = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    // Holds the claim transaction open between its locking read and its update, as a slow round trip would.
    const held = new Proxy(engine, { get(target, key) {
      if (key === 'transactionDirect') return <T>(fn: (tx: typeof engine) => Promise<T>) => target.transactionDirect(tx => fn(new Proxy(tx, { get(inner, name) {
        if (name === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          if (sql.startsWith('UPDATE persistence_requests r SET state=')) { update.resolve(); await release.promise; }
          return inner.executeRaw(sql, params as never);
        };
        const value = Reflect.get(inner, name);
        return typeof value === 'function' ? value.bind(inner) : value;
      } }) as typeof engine));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof engine;
    const claiming = claimGroupFollowers(held, head, publicationGroupKey(head)!, 7);
    await update.promise;
    const lockable = (id: string) => engine.transaction(tx => tx.executeRaw('SELECT id FROM persistence_requests WHERE id=$1::uuid FOR UPDATE NOWAIT', [id]))
      .then(() => true, (error: { code?: string }) => { if (error.code === '55P03') return false; throw error; });
    try {
      expect(await lockable(after.id)).toBe(true);
      expect(await lockable(member.id)).toBe(false);
    } finally { release.resolve(); }
    expect((await claiming).map(row => row.slug)).toEqual(['notes/l-2', 'notes/l-3']);
  });
});
