/**
 * #6288 (P2.3) with #6443's transaction signal, grouped route: a put_pages group held at `after_publication` (its files
 * already renamed, its transaction still open) past the ceiling and its grace is cancelled: Postgres discards the
 * connection, the rejection waits for the parked body, then surfaces as CONNECTION_CLOSED. Nothing from that attempt
 * commits, the group's restoration puts the original file bytes back, and the retry commits every member exactly once
 * with one set of effects, each file matching its committed row, no member left running. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';

const d = hasDatabase() ? describe : describe.skip;
const config = { engine: 'postgres' as const, embedding_disabled: true };
const page = (slug: string, body: string) => ({ slug, content: `---\ntitle: ${slug}\ntype: note\n---\n\n${body}\n` });
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

d('publication deadline on a grouped publish (Postgres)', () => {
  test('a group cancelled after its files were renamed commits nothing, restores the files, and its retry commits every member once', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-group-deadline-pg-'));
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    const engine: PostgresEngine = pg.engine;
    const root = join(fixtureDir, 'brain'); mkdirSync(join(root, 'notes'), { recursive: true });
    _resetWriteThroughCacheForTest();
    let registration: LocalRegistration;
    const dispatch = async (name: string, params: Record<string, unknown>) => {
      const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params, {
        remote: true, config, sourceId: 'default',
        auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] },
        logger: { info() {}, warn() {}, error() {} },
      }));
      return JSON.parse((response.content[0] as { text: string }).text) as Record<string, any>;
    };
    const batchRows = () => engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE operation='put_page' AND intent ? 'page_batch' ORDER BY sequence");
    try {
      await withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
        await engine.setConfig('sync.repo_path', root);
        await claimWorktree(engine, 'default', root);
        registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] });
        try {
          // h-1 replaces an existing file, so the restoration has original bytes to bring back.
          expect((await dispatch('put_page', { ...page('notes/h-1', 'Original body.'), request_id: randomUUID() })).state).toBe('committed');
          const existing = join(root, 'notes', 'h-1.md');
          const original = readFileSync(existing, 'utf8');
          const [current] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE slug='notes/h-1'");
          await disposePersistenceConsumer(engine);
          const holder = await acquireWorktree((await getWorktreeBinding(engine, 'default'))!, 5000);
          try {
            const batch = await dispatch('put_pages', { request_id: randomUUID(), wait_ms: 0, pages: [
              { ...page('notes/h-1', 'Replacement body.'), expected_revision: current!.revision }, page('notes/h-2', 'Second body.'), page('notes/h-3', 'Third body.')] });
            expect(batch.state).toBe('pending');
            await disposePersistenceConsumer(engine);
          } finally { await holder!.release(); }
          await engine.executeRaw("UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,blocked_reason=NULL WHERE state='running' AND recovery IS NULL");
          const head = (await claimNextWrite(engine, localHostId()))!;
          const followers = await claimGroupFollowers(engine, head, publicationGroupKey(head)!, 7);
          expect([head, ...followers].map(row => row.slug)).toEqual(['notes/h-1', 'notes/h-2', 'notes/h-3']);

          // Hold the first attempt after its last member's file rename (every file renamed, nothing committed).
          let release!: () => void;
          const released = new Promise<void>(resolve => { release = resolve; });
          let held = false, renamedWhileHeld: string | undefined;
          installFaultHook(async (point, detail) => {
            if (point !== 'publication:after_publication' || held) return;
            const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1::uuid', [detail.requestId]);
            if (row?.slug !== 'notes/h-3') return;
            held = true;
            renamedWhileHeld = readFileSync(existing, 'utf8');
            await released;
          });
          const events: string[] = [];
          let rolledBackBytes: string | undefined;
          const settled: WriteRequest[] = [];
          const run = executeClaimedGroup(engine, [head, ...followers], {
            hostId: localHostId(), prepare: async row => preparePersistedMutation(engine, row, config as never),
            settled: row => settled.push(row),
            publication: { ceilingMs: 1500, graceMs: 100, settleMs: 100, onOverdue: () => events.push('overdue'), onStuck: () => events.push('stuck') },
            hooks: { rolledBack: async () => { rolledBackBytes ??= readFileSync(existing, 'utf8'); } },
          });
          for (let i = 0; i < 100 && !held; i++) await tick(50);
          expect(held).toBe(true);
          expect(renamedWhileHeld).toContain('Replacement body.');
          await tick(2000);
          expect(events).toEqual(['overdue', 'stuck']);
          // The cancelled attempt committed nothing while its body is parked.
          expect((await batchRows()).filter(row => row.state === 'committed')).toEqual([]);
          release();
          await run;
          installFaultHook(undefined);
          // Restoration ran after the parked body settled: the original bytes were back before any retry.
          expect(rolledBackBytes).toBe(original);

          // Whatever the group left queued, the ordinary route publishes it.
          for (let i = 0; i < 10; i++) {
            const next = await claimNextWrite(engine, localHostId());
            if (!next) break;
            const more = publicationGroupKey(next) ? await claimGroupFollowers(engine, next, publicationGroupKey(next)!, 7) : [];
            await executeClaimedGroup(engine, [next, ...more], { hostId: localHostId(), prepare: async row => preparePersistedMutation(engine, row, config as never), settled: row => settled.push(row) });
          }
          const rows = await batchRows();
          expect(rows.map(row => [row.slug, row.state])).toEqual([['notes/h-1', 'committed'], ['notes/h-2', 'committed'], ['notes/h-3', 'committed']]);
          expect(rows.every(row => row.execution_token === null || row.state !== 'running')).toBe(true);
          expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE state='running' OR recovery IS NOT NULL")).toEqual([]);
          const [dupes] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM (SELECT request_id FROM persistence_requests GROUP BY request_id HAVING count(*)>1) d");
          expect(Number(dupes!.n)).toBe(0);
          const effects = await engine.executeRaw<{ slug: string; kind: string; n: number }>(`SELECT r.slug,e.kind,count(*)::int AS n FROM persistence_effects e
            JOIN persistence_requests r ON r.id=e.request_id WHERE r.intent ? 'page_batch' GROUP BY r.slug,e.kind HAVING count(*)>1`);
          expect(effects).toEqual([]);
          for (const [slug, body] of [['notes/h-1', 'Replacement body.'], ['notes/h-2', 'Second body.'], ['notes/h-3', 'Third body.']] as const) {
            const file = readFileSync(join(root, `${slug}.md`), 'utf8');
            expect(file).toContain(body);
            const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
            expect(snapshot.page.compiled_truth).toContain(body);
          }
        } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
      });
    } finally {
      _resetWriteThroughCacheForTest();
      await pg.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 120_000);
});
