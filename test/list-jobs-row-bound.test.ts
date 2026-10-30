/**
 * list_jobs row bound: a serve never loads and describes the whole job table for one call.
 *
 * 1. Protects: a remote list_jobs call returns at most 500 jobs whatever limit it names, keeps the bare-array
 *    result, marks the last job of a cut page with truncated: true and next_cursor, and carries the paging facts on
 *    _meta.pagination plus a listing_truncated notice whose fix is the next call. Paging with next_cursor returns
 *    every job exactly once, newest first, across created_at ties and under the agent ownership fence. The trusted
 *    local caller keeps the limit it named.
 * 2. Fails when: list_jobs passes a remote limit straight to SQL (a "jobs list --limit 100000" ran a serve out of
 *    memory), a page boundary repeats or skips a job, the fence is lost on a later page, or a bad cursor or limit
 *    reaches SQL.
 * 3. No new seam: the real handler over PGLite, and over Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const JOBS = 620;
const OWNED = 30;

interface Captured { notices: Notice[]; meta: Record<string, unknown> }
type Row = { id: number; truncated?: boolean; next_cursor?: string };

async function seed(engine: BrainEngine): Promise<number[]> {
  const queue = new MinionQueue(engine);
  const ids: number[] = [];
  for (let i = 0; i < JOBS; i++) {
    const data: Record<string, unknown> = { prompt: `job-${i}` };
    if (i < OWNED) data.__owner_client_id = 'agent-a';
    ids.push((await queue.add('subagent', data, { queue: 'default' }, { allowProtectedSubmit: true })).id);
  }
  // Ties: the first 300 jobs share one created_at, as jobs submitted in one transaction do.
  await engine.executeRaw(`UPDATE minion_jobs SET created_at = now() - interval '1 hour' WHERE id = ANY($1::bigint[])`, [ids.slice(0, 300)]);
  return ids;
}

function scenarios(name: 'PGLite' | 'Postgres'): void {
  describe(`list_jobs row bound (${name})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let newestFirst: number[];
    beforeAll(async () => {
      if (name === 'Postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      await seed(engine);
      const rows = await engine.executeRaw<{ id: number | string }>('SELECT id FROM minion_jobs ORDER BY created_at DESC, id DESC');
      newestFirst = rows.map(r => Number(r.id));
    }, 180_000);
    afterAll(async () => { await close(); });

    const ctx = (over: Partial<OperationContext>, captured?: Captured): OperationContext => ({
      engine, config: {} as OperationContext['config'], sourceId: 'default', remote: true, dryRun: false,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
      auth: { clientId: 'admin-tok', scopes: ['admin'] } as OperationContext['auth'],
      ...(captured ? { emitNotice: (n: Notice) => { captured.notices.push(n); }, emitResponseMeta: (k: string, v: unknown) => { captured.meta[k] = v; } } : {}),
      ...over,
    } as OperationContext);
    const list = async (c: OperationContext, params: Record<string, unknown>) => await operationsByName.list_jobs.handler(c, params) as Row[];

    test('a remote limit of 100000 returns 500 jobs, marks the cut, and the cursor reads the rest exactly once', async () => {
      const first: Captured = { notices: [], meta: {} };
      const page1 = await list(ctx({}, first), { limit: 100_000, fields: ['id'] });
      expect(page1).toHaveLength(500);
      const cursor = page1[499].next_cursor!;
      expect(page1[499]).toEqual({ id: newestFirst[499], truncated: true, next_cursor: cursor });
      expect(page1.slice(0, 499).every(r => r.truncated === undefined && r.next_cursor === undefined)).toBe(true);
      expect(first.meta.pagination).toEqual({ limit: 500, returned: 500, clamped_from: 100_000, next_cursor: cursor });
      expect(first.notices.map(n => n.code)).toEqual(['listing_truncated']);
      expect(first.notices[0].fix?.mcp).toEqual({ tool: 'list_jobs', arguments: { fields: ['id'], cursor, limit: 500 } });

      const rest: Captured = { notices: [], meta: {} };
      const page2 = await list(ctx({}, rest), { fields: ['id'], cursor, limit: 500 });
      expect(page2.map(r => r.id)).toEqual(newestFirst.slice(500));
      expect(page2.some(r => r.truncated !== undefined || r.next_cursor !== undefined)).toBe(false);
      expect(rest.meta.pagination).toEqual({ limit: 500, returned: JOBS - 500 });
      expect(rest.notices).toEqual([]);
    }, 60_000);

    test('small pages walk created_at ties without repeating or skipping a job', async () => {
      const seen: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await list(ctx({}), { limit: 7, fields: ['id'], ...(cursor ? { cursor } : {}) });
        seen.push(...page.map(r => r.id));
        cursor = page[page.length - 1]?.next_cursor;
      } while (cursor);
      expect(seen).toEqual(newestFirst);
    }, 120_000);

    test('the agent ownership fence holds on every page', async () => {
      const agent = ctx({ auth: { clientId: 'agent-a', scopes: ['agent'] } as OperationContext['auth'] });
      const page1 = await list(agent, { limit: 20, fields: ['id'] });
      const page2 = await list(agent, { limit: 20, fields: ['id'], cursor: page1[19].next_cursor });
      const owned = await engine.executeRaw<{ id: number | string }>(`SELECT id FROM minion_jobs WHERE data->>'__owner_client_id' = 'agent-a' ORDER BY created_at DESC, id DESC`);
      expect([...page1, ...page2].map(r => r.id)).toEqual(owned.map(r => Number(r.id)));
      expect(page2.some(r => r.next_cursor !== undefined)).toBe(false);
    }, 60_000);

    test('the trusted local caller keeps the limit it named', async () => {
      const page = await list(ctx({ remote: false }), { limit: 600, fields: ['id'] });
      expect(page).toHaveLength(600);
      expect(page[599]).toMatchObject({ id: newestFirst[599], truncated: true });
    }, 60_000);

    test('a bad cursor or limit is invalid_params and never reaches SQL', async () => {
      for (const params of [{ cursor: 'not-a-cursor' }, { cursor: "1'; DROP TABLE minion_jobs; --:1" }, { limit: 0 }, { limit: 2.5 }, { limit: '100000' }]) {
        await expect(list(ctx({}), params)).rejects.toMatchObject({ code: 'invalid_params' });
      }
      expect((await engine.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM minion_jobs'))[0].n.toString()).toBe(String(JOBS));
    }, 60_000);
  });
}

scenarios('PGLite');
if (process.env.DATABASE_URL) scenarios('Postgres');
