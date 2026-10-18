/**
 * #6574: a publish transaction locks the request rows it publishes, so a lease renewal from another connection waited on
 * that lock and the claim read lapsed ("owner missing") for a publish that was still working; `gbrain sync` then stopped
 * `drain_stalled`. The claim is now stamped once, committed, before the transaction opens, for the publication's whole
 * bound. This holds a put_pages group inside its open transaction and reads each member's claim from another connection:
 * still running, stamped `publishing`, and leased past the ceiling, not the 30 s renewal lease. Synthetic content only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

d('#6574 publication claim lease (Postgres)', () => {
  test('a group held inside its publish transaction keeps every member claimed, stamped publishing, past the renewal lease', async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'gbrain-publication-lease-pg-'));
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
    try {
      await withEnv({ GBRAIN_HOME: join(fixtureDir, 'home') }, async () => {
        await engine.setConfig('sync.repo_path', root);
        await claimWorktree(engine, 'default', root);
        registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] });
        try {
          const holder = await acquireWorktree((await getWorktreeBinding(engine, 'default'))!, 5000);
          try {
            const batch = await dispatch('put_pages', { request_id: randomUUID(), wait_ms: 0, pages: [
              page('notes/l-1', 'First body.'), page('notes/l-2', 'Second body.'), page('notes/l-3', 'Third body.')] });
            expect(batch.state).toBe('pending');
            await disposePersistenceConsumer(engine);
          } finally { await holder!.release(); }
          await engine.executeRaw("UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,blocked_reason=NULL WHERE state='running' AND recovery IS NULL");
          const head = (await claimNextWrite(engine, localHostId()))!;
          const followers = await claimGroupFollowers(engine, head, publicationGroupKey(head)!, 7);
          const members = [head, ...followers];
          expect(members.map(row => row.slug)).toEqual(['notes/l-1', 'notes/l-2', 'notes/l-3']);

          let release!: () => void;
          const released = new Promise<void>(resolve => { release = resolve; });
          let held = false;
          installFaultHook(async (point, detail) => {
            if (point !== 'publication:after_publication' || held) return;
            const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1::uuid', [detail.requestId]);
            if (row?.slug !== 'notes/l-3') return;
            held = true;
            await released;
          });
          const settled: WriteRequest[] = [];
          const ceilingMs = 120_000;
          const run = executeClaimedGroup(engine, members, {
            hostId: localHostId(), prepare: async row => preparePersistedMutation(engine, row, config as never),
            settled: row => settled.push(row), publication: { ceilingMs },
          });
          for (let i = 0; i < 100 && !held; i++) await tick(50);
          expect(held).toBe(true);
          // Read from another connection while the transaction holds the rows: what sync-drain and writer status see.
          const claims = await engine.executeRaw<{ slug: string; state: string; phase: string | null; lease_s: number }>(`SELECT slug, state,
            claim_phase->>'phase' AS phase, extract(epoch FROM claim_expires_at - now())::float8 AS lease_s
            FROM persistence_requests WHERE id = ANY($1::uuid[]) ORDER BY slug`, [members.map(row => row.id)]);
          release();
          await run;
          installFaultHook(undefined);
          expect(claims.map(c => [c.slug, c.state, c.phase])).toEqual([
            ['notes/l-1', 'running', 'publishing'], ['notes/l-2', 'running', 'publishing'], ['notes/l-3', 'running', 'publishing']]);
          for (const claim of claims) expect(Number(claim.lease_s)).toBeGreaterThan(ceilingMs / 1000);
          expect(settled.map(row => [row.slug, row.state])).toEqual([['notes/l-1', 'committed'], ['notes/l-2', 'committed'], ['notes/l-3', 'committed']]);
          const [after] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
            WHERE id = ANY($1::uuid[]) AND (state <> 'committed' OR claim_expires_at IS NOT NULL)`, [members.map(row => row.id)]);
          expect(Number(after!.n)).toBe(0);
        } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
      });
    } finally {
      _resetWriteThroughCacheForTest();
      await pg.close();
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 120_000);
});
