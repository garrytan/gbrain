/**
 * #6276: two statements whose correlated visibility subplans cross Postgres' JIT cost thresholds on larger
 * brains run with JIT off: the remote alias-resolving page read (`get_page`/`fetch`) and put_page's
 * similar-pages advisory, which is not issued at all while `put_page.similar_pages` is off (the default).
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { managedBrain } from '../helpers/managed-brain.ts';

const url = process.env.DATABASE_URL;
const put = (ctx: Parameters<typeof submitPageMutation>[0], slug: string, title: string) => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${title}\n---\n\nBody of ${slug}.\n` } });

/** Records `current_setting('jit')` on the statement's own connection just before each statement matching `match` runs. */
function watchJit(match: RegExp): { seen: string[]; restore: () => void } {
  const seen: string[] = [];
  const proto = PostgresEngine.prototype as unknown as { executeRaw: BrainEngine['executeRaw']; transaction: BrainEngine['transaction'] };
  const execute = proto.executeRaw, transaction = proto.transaction;
  proto.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[], opts?: unknown) {
    if (match.test(sql)) seen.push(((await execute.call(this, "SELECT current_setting('jit') AS jit", [])) as Array<{ jit: string }>)[0]!.jit);
    return execute.call(this, sql, params, opts as never);
  } as BrainEngine['executeRaw'];
  // The page read runs through the transaction handle's `unsafe`, not executeRaw: watch it there.
  proto.transaction = async function (this: BrainEngine, fn: (tx: BrainEngine) => Promise<unknown>) {
    return transaction.call(this, async (tx: BrainEngine) => {
      const sql = (tx as unknown as { sql: { unsafe: (q: string, p?: unknown, o?: unknown) => Promise<unknown> } & Record<string, unknown> }).sql;
      const unsafe = sql.unsafe;
      sql.unsafe = async (q: string, p?: unknown, o?: unknown) => {
        if (match.test(q)) seen.push(((await unsafe.call(sql, "SELECT current_setting('jit') AS jit")) as Array<{ jit: string }>)[0]!.jit);
        return unsafe.call(sql, q, p, o);
      };
      try { return await fn(tx); } finally { sql.unsafe = unsafe; }
    });
  } as BrainEngine['transaction'];
  return { seen, restore: () => { proto.executeRaw = execute; proto.transaction = transaction; } };
}

describe.skipIf(!url)('JIT off for statements past the JIT cost thresholds (#6276)', () => {
  test('the similar-pages advisory is not issued while off, and runs with JIT off when on', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      const watch = watchJit(/WITH hits AS/);
      try {
        await put(ctx, 'companies/acme-example', 'Acme Example');
        expect(watch.seen).toEqual([]);
        await engine.setConfig('put_page.similar_pages', 'true');
        const written = await put(ctx, 'companies/acme-example-2', 'Acme Example') as Record<string, any>;
        expect((written.outcome ?? written).similar_pages.candidates).toContainEqual(expect.objectContaining({ slug: 'companies/acme-example' }));
        expect(watch.seen.length).toBeGreaterThan(0);
        expect(watch.seen.every(jit => jit === 'off')).toBe(true);
      } finally { watch.restore(); }
    }, { databaseUrl: url });
  }, 180_000);

  test('the remote alias-resolving page read runs with JIT off; other reads keep the server setting', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await put(ctx, 'notes/jit-example', 'JIT example');
      const watch = watchJit(/WITH chosen AS/);
      try {
        expect((await engine.readPageSnapshot('notes/jit-example', { sourceId: 'default', resolveAlias: true, excludePrivate: true }))?.page.slug).toBe('notes/jit-example');
        expect(watch.seen).toEqual(['off']);
        expect(((await engine.executeRaw("SELECT current_setting('jit') AS jit", [])) as Array<{ jit: string }>)[0]!.jit).toBe('on');
      } finally { watch.restore(); }
    }, { databaseUrl: url });
  }, 180_000);

  test('search backlink counts run with JIT off, alone and inside a caller transaction that keeps its setting', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await put(ctx, 'notes/jit-target', 'JIT target');
      const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug='notes/jit-target'", []);
      const watch = watchJit(/COUNT\(DISTINCT l\.from_page_id\)/);
      try {
        expect((await engine.getBacklinkCounts([page!.id])).get(page!.id)).toBe(0);
        expect(watch.seen).toEqual(['off']);
        const after = await engine.transaction(async tx => {
          await tx.getBacklinkCounts([page!.id]);
          return ((await tx.executeRaw("SELECT current_setting('jit') AS jit", [])) as Array<{ jit: string }>)[0]!.jit;
        });
        expect(watch.seen).toEqual(['off', 'off']);
        expect(after).toBe('on');
        expect(((await engine.executeRaw("SELECT current_setting('jit') AS jit", [])) as Array<{ jit: string }>)[0]!.jit).toBe('on');
      } finally { watch.restore(); }
    }, { databaseUrl: url });
  }, 180_000);

  test('getHealth runs its aggregate, linkable-scope and most-connected statements with JIT off', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await put(ctx, 'people/jit-person', 'JIT person');
      const watch = watchJit(/WITH entity_pages AS|WITH linkable_pages AS MATERIALIZED|AS link_count/);
      try {
        expect((await engine.getHealth()).page_count).toBeGreaterThan(0);
        expect(watch.seen.length).toBeGreaterThanOrEqual(3);
        expect(watch.seen.every(jit => jit === 'off')).toBe(true);
        expect(((await engine.executeRaw("SELECT current_setting('jit') AS jit", [])) as Array<{ jit: string }>)[0]!.jit).toBe('on');
      } finally { watch.restore(); }
    }, { databaseUrl: url });
  }, 180_000);
});
