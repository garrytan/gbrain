/** Test harness for the shadow follow producer: a wrapped engine whose invalidation batches land in an array. */
import type { BrainEngine } from '../../src/core/engine.ts';
import { newMirrorCounters } from '../../src/shadow/mirror.ts';
import type { InvalidationBatch } from '../../src/shadow/invalidations.ts';
import { wrapShadowEngine, type ShadowSink } from '../../src/shadow/wrapper.ts';
import { createWriteSampler } from '../../src/shadow/write-capture.ts';
import { WRITE_MAP } from '../../src/shadow/write-map.ts';
import { withStoredSlug } from '../../src/core/utils.ts';

export interface FollowHarness<E extends BrainEngine> {
  engine: E;
  batches: InvalidationBatch[];
  /** The pre-read queries the producer ran on the primary (internal engine SQL is not counted). */
  rawCalls: string[];
  setShadowActive(on: boolean): void;
}

const PRE_READ_MARK = '/* shadow-follow pre-read */';
const restorers: Array<() => void> = [];
/** Undoes every probe the harness installed; call from beforeEach. */
export function restoreFollowProbes(): void { for (const undo of restorers.splice(0).reverse()) undo(); }

/** Wraps `primary` with follow on. `failRawWith` makes every pre-read query throw. */
export function followHarness<E extends BrainEngine>(primary: E, opts: { failRawWith?: Error; publish?: (batch: InvalidationBatch) => void; /** Sent in place of every pre-read query (a statement that fails on the database after a while). */ preReadSql?: string } = {}): FollowHarness<E> {
  const batches: InvalidationBatch[] = [];
  const rawCalls: string[] = [];
  let active = true;
  // Count (or fail) executeRaw on the primary itself; a Proxy or Object.create copy of a PGLite engine hangs its page lock.
  const original = primary.executeRaw;
  (primary as { executeRaw: unknown }).executeRaw = function (this: unknown, sql: string, ...rest: unknown[]) {
    if (!sql.startsWith(PRE_READ_MARK)) return (original as (...a: unknown[]) => Promise<unknown>).call(this, sql, ...rest);
    rawCalls.push(sql);
    if (opts.failRawWith) return Promise.reject(opts.failRawWith);
    if (opts.preReadSql) return (original as (...a: unknown[]) => Promise<unknown>).call(this, opts.preReadSql);
    return (original as (...a: unknown[]) => Promise<unknown>).call(this, sql, ...rest);
  };
  restorers.push(() => { (primary as { executeRaw: unknown }).executeRaw = original; });
  const sink: ShadowSink = { counters: newMirrorCounters(), offer: () => {}, active: () => active };
  const engine = wrapShadowEngine(primary, sink, {
    sampleRate: 0,
    follow: { sink: { publish: opts.publish ?? ((batch) => { batches.push(batch); }) } },
  });
  return { engine, batches, rawCalls, setShadowActive: (on) => { active = on; } };
}

export const PAGE = (title: string) => ({ type: 'person' as const, title, compiled_truth: `${title} body.`, timeline: '' });

/**
 * A write member whose pre-read selects a column that does not exist, so the pre-read query fails. Run it inside a
 * transaction after a real write: the transaction must still commit (the failed read must not abort it) and the batch
 * must carry a relation-level item for the member's table.
 */
export async function failedPreReadKeepsTransaction(primary: BrainEngine): Promise<void> {
  const proto = Object.getPrototypeOf(primary) as Record<string, unknown>;
  proto.testBadPreRead = async () => undefined;
  WRITE_MAP.testBadPreRead = { tables: ['pages'], plan: () => [{ relation: 'pages', sel: { no_such_column: '1' }, del: true }] };
  restorers.push(() => { delete proto.testBadPreRead; delete WRITE_MAP.testBadPreRead; });
  const h = followHarness(primary);
  await h.engine.transaction(async (tx) => {
    await tx.putPage('people/savepoint', PAGE('Savepoint'));
    await (tx as unknown as { testBadPreRead(): Promise<void> }).testBadPreRead();
    await tx.addTag('people/savepoint', 'after');
  });
  if (!(await primary.getPage('people/savepoint'))) throw new Error('the transaction did not commit');
  if (!(await primary.getTags('people/savepoint')).includes('after')) throw new Error('the write after the failed pre-read was lost');
  const items = h.batches.flatMap((b) => b.items);
  if (!items.some((i) => i.kind === 'relation' && i.relation === 'pages' && i.reason === 'pre_read_failed')) throw new Error(`no relation-level item: ${JSON.stringify(items)}`);
}

/**
 * The same failing pre-read, sent while sibling writes of the same transaction are in flight (how a pipelined import or put_page
 * sends its statements together): the failed shadow read must not undo any of them. Every sibling call resolves, so a sibling write
 * missing after the commit is a primary write the shadow rolled back.
 */
export async function failedPreReadKeepsSiblingWrites(primary: BrainEngine): Promise<void> {
  const proto = Object.getPrototypeOf(primary) as Record<string, unknown>;
  proto.testBadPreRead = async () => undefined;
  WRITE_MAP.testBadPreRead = { tables: ['pages'], plan: () => [{ relation: 'pages', sel: { slug: 'people/sibling' }, del: true }] };
  restorers.push(() => { delete proto.testBadPreRead; delete WRITE_MAP.testBadPreRead; });
  const h = followHarness(primary, { preReadSql: 'SELECT 1/(extract(epoch FROM clock_timestamp()) * 0)::int FROM pg_sleep(0.3)' }); // a pre-read that fails on the database once a while has passed (a statement timeout does the same)
  await primary.putPage('people/sibling', PAGE('Sibling'));
  await h.engine.transaction(async (tx) => {
    await Promise.all([
      tx.putPage('people/sibling-two', PAGE('Sibling Two')),
      tx.addTag('people/sibling', 'first'),
      (tx as unknown as { testBadPreRead(): Promise<void> }).testBadPreRead(),
      tx.addTag('people/sibling', 'second'),
      (async () => { // a sibling that sends its next statement once its first one answered, while the pre-read is open (how a pipelined import's chunk and seal statements arrive)
        await tx.executeRaw('SELECT 1');
        await new Promise((r) => setTimeout(r, 50));
        await tx.executeRaw("UPDATE pages SET title = 'Raw Sibling' WHERE slug = 'people/sibling'");
      })(),
    ]);
  });
  const tags = await primary.getTags('people/sibling');
  const lost = [...['first', 'second'].filter((t) => !tags.includes(t)), ...(await primary.getPage('people/sibling-two')) ? [] : ['people/sibling-two'],
    ...((await primary.getPage('people/sibling'))?.title === 'Raw Sibling' ? [] : ['the raw page update'])];
  if (lost.length) throw new Error(`the failed shadow pre-read rolled back sibling writes that reported success: ${lost.join(', ')}`);
  const items = h.batches.flatMap((b) => b.items);
  if (!items.some((i) => i.kind === 'relation' && i.relation === 'pages' && i.reason === 'pre_read_failed')) throw new Error(`no relation-level item: ${JSON.stringify(items)}`);
}

/**
 * A pre-read beside a running nested transaction waits for it, while a followed write inside that nested transaction never waits for the outer
 * pre-read (which is waiting for it): both writes commit, row by row, with no stall until the 2 second bound.
 */
export async function busyPreReadIsRelationLevel(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.putPage('people/busy', PAGE('Busy'));
  await primary.putPage('people/busy-gone', PAGE('Busy Gone'));
  const t0 = Date.now();
  await h.engine.transaction(async (tx) => {
    await Promise.all([
      tx.transaction(async (nested) => { await new Promise((r) => setTimeout(r, 30)); await nested.addTag('people/busy', 'nested'); }),
      tx.deletePage('people/busy-gone'), // a delete pre-reads the rows it removes: it waits for the nested transaction
    ]);
  });
  const ms = Date.now() - t0;
  if (!(await primary.getTags('people/busy')).includes('nested')) throw new Error('the nested write was lost');
  if (await primary.getPage('people/busy-gone')) throw new Error('the delete did not commit');
  if (ms > 1_500) throw new Error(`the nested write and the waiting delete stalled each other until the bound (${ms} ms)`);
  const items = h.batches.flatMap((b) => b.items);
  if (items.some((i) => i.kind === 'relation' && i.reason === 'pre_read_busy')) throw new Error(`a write was planned pre_read_busy: ${JSON.stringify(items)}`);
}

/**
 * A callback that throws at once, after starting a slow statement and a followed delete (whose pre-read waits for the statement): the delete is held
 * by the lane, and the transaction's ROLLBACK must wait until it has been sent, so the delete is rolled back with everything else.
 */
export async function syncThrowRollsBackHeldWrite(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.putPage('people/held', PAGE('Held'));
  let pending: Promise<unknown> | undefined;
  let threw = false;
  try {
    await h.engine.transaction(((tx: BrainEngine) => {
      void tx.executeRaw('SELECT pg_sleep(0.2)').catch(() => undefined);
      pending = tx.deletePage('people/held');
      throw new Error('abort');
    }) as never);
  } catch (error) { threw = (error as Error).message === 'abort'; }
  await pending?.catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  if (!threw) throw new Error('the transaction did not report the callback error');
  if (!(await primary.getPage('people/held'))) throw new Error('the held delete committed after the transaction rolled back');
}

/**
 * Follow and write sampling wired together, as production wires them: a sampled page write holds the sampler's gate, and a tag write sent beside it
 * waits there. When it is let go, its own pre-read must not wait for itself: it is planned row by row, at once, not relation-level after a timeout.
 */
export async function sampledSiblingDoesNotWaitForItself(primary: BrainEngine): Promise<void> {
  const batches: InvalidationBatch[] = [];
  const sampler = createWriteSampler({ rate: 1, active: () => true, send: () => true });
  const engine = wrapShadowEngine(primary, { counters: newMirrorCounters(), offer: () => {}, active: () => true }, { sampleRate: 0, writes: sampler, follow: { sink: { publish: (b) => { batches.push(b); } } } });
  await primary.putPage('notes/gate', PAGE('Gate'));
  const t0 = Date.now();
  await engine.transaction(async (tx) => { await Promise.all([tx.putPage('notes/gate', PAGE('Gate Updated'), { sourceId: 'default', inline: true } as never), tx.addTag('notes/gate', 'tagged')]); });
  const ms = Date.now() - t0;
  await sampler.settle(2_000);
  const items = batches.flatMap((b) => b.items);
  if (items.some((i) => i.kind === 'relation' && i.reason === 'pre_read_busy')) throw new Error(`a call waited for itself and was planned relation-level (${ms} ms): ${JSON.stringify(items)}`);
  if (!(await primary.getTags('notes/gate')).includes('tagged')) throw new Error('the tag write was lost');
}

/**
 * A followed write the callback starts and does not await (its pre-read runs first): the transaction's COMMIT waits until it has been sent, so
 * it commits as it would without the shadow, never failing on a connection the transaction already gave back.
 */
export async function unawaitedFollowedWriteCommits(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.putPage('people/unawaited', PAGE('Unawaited'));
  const failures: unknown[] = [];
  let pending: Promise<unknown> | undefined;
  await h.engine.transaction(async (tx) => { pending = tx.deletePage('people/unawaited').catch((e) => { failures.push(e); }); });
  await pending;
  if (failures.length) throw new Error(`the followed write failed after the COMMIT: ${String((failures[0] as Error)?.message ?? failures[0])}`);
  if (await primary.getPage('people/unawaited')) throw new Error('the followed delete did not commit');
}

/** A call held behind a slow pre-read, when the callback then fails: the held call is sent before the ROLLBACK, so it is rolled back with the rest. */
export async function heldCallRollsBackWithItsTransaction(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary, { preReadSql: 'SELECT pg_sleep(0.3)' }); // a slow pre-read holds the lane
  await primary.putPage('people/held-delete', PAGE('Held Delete'));
  let pending: Promise<unknown> | undefined;
  let threw = false;
  try {
    await h.engine.transaction(async (tx) => {
      void tx.deletePage('people/held-delete').catch(() => undefined);
      pending = tx.putPage('people/queued', PAGE('Queued')).catch(() => undefined); // held while the pre-read runs
      await new Promise((r) => setTimeout(r, 50));
      throw new Error('abort');
    });
  } catch (error) { threw = (error as Error).message === 'abort'; }
  await pending;
  await new Promise((r) => setTimeout(r, 300));
  if (!threw) throw new Error('the transaction did not report the callback error');
  if (await primary.getPage('people/queued')) throw new Error('the held page write committed after the transaction rolled back');
  if (!(await primary.getPage('people/held-delete'))) throw new Error('the delete committed after the transaction rolled back');
}

/** A write sent while a nested transaction runs waits for it, so the nested rollback cannot undo the outer write. */
export async function outerWriteSurvivesNestedRollback(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.setConfig('test.follow.nested', 'set');
  await h.engine.transaction(async (tx) => {
    await Promise.all([
      tx.transaction(async (nested) => { await nested.getConfig('test.follow.nested'); await new Promise((r) => setTimeout(r, 50)); throw new Error('nested abort'); }).catch(() => undefined),
      tx.unsetConfig('test.follow.nested'),
    ]);
  });
  const [row] = await primary.executeRaw<{ value: string }>("SELECT value FROM config WHERE key = 'test.follow.nested'");
  const left = row?.value;
  if (left !== null && left !== undefined) throw new Error(`the outer unsetConfig was undone by the nested rollback (value ${JSON.stringify(left)})`);
}

/** A call held behind a pre-read keeps its own caller's context: a write scoped to a page's stored legacy spelling updates that page, never a twin. */
export async function heldCallKeepsItsContext(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary, { preReadSql: 'SELECT pg_sleep(0.1)' });
  await primary.putPage('people/legacy-seed', PAGE('Legacy'));
  await primary.executeRaw("UPDATE pages SET slug='People/Legacy' WHERE slug='people/legacy-seed'");
  await primary.putPage('people/gone', PAGE('Gone'));
  await h.engine.transaction(async (tx) => {
    await Promise.all([
      tx.deletePage('people/gone'), // its pre-read holds the lane
      withStoredSlug('People/Legacy', () => tx.putPage('People/Legacy', PAGE('Legacy Updated'))), // held behind it
    ]);
  });
  const rows = await primary.executeRaw<{ slug: string; title: string }>("SELECT slug, title FROM pages WHERE lower(slug) = 'people/legacy' ORDER BY slug");
  if (JSON.stringify(rows.map((r) => [r.slug, r.title])) !== JSON.stringify([['People/Legacy', 'Legacy Updated']])) throw new Error(`the held write lost its caller's context: ${JSON.stringify(rows)}`);
}

/** A nested transaction the callback already awaited no longer counts as running: the next followed write is planned row by row. */
export async function finishedNestedIsNotBusy(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.putPage('people/after-nested', PAGE('After Nested'));
  await h.engine.transaction(async (tx) => {
    await tx.transaction(async (nested) => { await nested.getPage('people/after-nested'); });
    await tx.addTag('people/after-nested', 'next');
  });
  const items = h.batches.flatMap((b) => b.items);
  if (items.some((i) => i.kind === 'relation' && i.reason === 'pre_read_busy')) throw new Error(`a finished nested transaction made the next write busy: ${JSON.stringify(items)}`);
}

/** An unawaited followed write inside a nested transaction that then throws stays rolled back with it, and an awaited one inside a nested transaction never waits on that transaction. */
export async function nestedFollowedWritesStayInTheirSavepoint(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.setConfig('test.follow.rollback', 'keep');
  await primary.setConfig('test.follow.awaited', 'drop');
  let pending: Promise<unknown> | undefined;
  const t0 = Date.now();
  await h.engine.transaction(async (tx) => {
    await tx.transaction(async (inner) => { pending = inner.unsetConfig('test.follow.rollback').catch(() => undefined); throw new Error('abort'); }).catch(() => undefined);
    await pending;
    await tx.transaction(async (inner) => { await inner.unsetConfig('test.follow.awaited'); });
  });
  const ms = Date.now() - t0;
  const value = async (key: string) => (await primary.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [key]))[0]?.value;
  if ((await value('test.follow.rollback')) !== 'keep') throw new Error('the unawaited write escaped its nested rollback');
  if ((await value('test.follow.awaited')) !== undefined) throw new Error('the awaited nested write did not commit');
  if (ms > 1_500) throw new Error(`a write inside a nested transaction waited on that transaction (${ms} ms)`);
  if (h.batches.flatMap((b) => b.items).some((i) => i.kind === 'relation' && i.reason === 'pre_read_busy')) throw new Error('a nested write was planned pre_read_busy');
}

/** Writes keep their submission order while a sibling nested transaction runs: an unset sent before a set of the same key never lands after it. */
export async function writesKeepOrderBesideNestedTransaction(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.setConfig('test.follow.order', 'first');
  let release!: () => void; const latch = new Promise<void>((r) => { release = r; });
  await h.engine.transaction(async (tx) => {
    const sibling = tx.transaction(async (nested) => { await latch; await nested.getConfig('test.follow.order'); });
    const unset = tx.unsetConfig('test.follow.order');
    await new Promise((r) => setTimeout(r, 20));
    const set = tx.setConfig('test.follow.order', 'replacement');
    setTimeout(release, 50);
    await Promise.all([sibling, unset, set]);
  });
  const [row] = await primary.executeRaw<{ value: string }>("SELECT value FROM config WHERE key = 'test.follow.order'");
  if (row?.value !== 'replacement') throw new Error(`the unset landed after the later set (value ${JSON.stringify(row?.value)})`);
}

/**
 * A statement sent straight to the transaction's driver handle (`tx.sql` on Postgres, `tx.db` on PGLite) while a sibling's shadow pre-read fails:
 * the failed read must not undo it, and the follower must see its table, as it does for the same statement sent through `executeRaw`.
 */
export async function driverWriteSurvivesFailedPreRead(primary: BrainEngine): Promise<void> {
  const proto = Object.getPrototypeOf(primary) as Record<string, unknown>;
  proto.testBadPreRead = async () => undefined;
  // The failing pre-read is on another table, so the follower's pages item can only come from the driver writes (items on one table merge).
  WRITE_MAP.testBadPreRead = { tables: ['tags'], plan: () => [{ relation: 'tags', sel: { tag: 'driver' }, del: true }] };
  restorers.push(() => { delete proto.testBadPreRead; delete WRITE_MAP.testBadPreRead; });
  const h = followHarness(primary, { preReadSql: 'SELECT 1/(extract(epoch FROM clock_timestamp()) * 0)::int FROM pg_sleep(0.3)' });
  await primary.putPage('people/driver', PAGE('Driver'));
  await primary.putPage('people/driver-two', PAGE('Driver Two'));
  await h.engine.transaction(async (tx) => {
    const driver = (tx as unknown as { sql?: any; db?: any });
    const send = (text: string): Promise<unknown> => (primary.kind === 'postgres' ? driver.sql.unsafe(text) : driver.db.query(text));
    await Promise.all([
      (tx as unknown as { testBadPreRead(): Promise<void> }).testBadPreRead(),
      (async () => { // sent once the pre-read has opened its savepoint
        await new Promise((r) => setTimeout(r, 50));
        await send("UPDATE pages SET title = 'Driver Write' WHERE slug = 'people/driver'");
      })(),
      (async () => {
        await new Promise((r) => setTimeout(r, 60));
        if (primary.kind === 'postgres') await driver.sql`UPDATE pages SET title = ${'Tagged Write'} WHERE slug = ${'people/driver-two'}`;
        else await driver.db.query('UPDATE pages SET title = $1 WHERE slug = $2', ['Tagged Write', 'people/driver-two']);
      })(),
    ]);
  });
  const lost = [
    ...((await primary.getPage('people/driver'))?.title === 'Driver Write' ? [] : ['the driver page update']),
    ...((await primary.getPage('people/driver-two'))?.title === 'Tagged Write' ? [] : ['the parameterized driver update']),
  ];
  if (lost.length) throw new Error(`the failed shadow pre-read rolled back driver writes that reported success: ${lost.join(', ')}`);
  const items = h.batches.flatMap((b) => b.items);
  if (!items.some((i) => i.kind === 'relation' && i.relation === 'pages' && i.reason === 'raw_sql')) throw new Error(`the follower did not see the driver writes: ${JSON.stringify(items)}`);
}
