/** Test harness for the shadow follow producer: a wrapped engine whose invalidation batches land in an array. */
import type { BrainEngine } from '../../src/core/engine.ts';
import { newMirrorCounters } from '../../src/shadow/mirror.ts';
import type { InvalidationBatch } from '../../src/shadow/invalidations.ts';
import { wrapShadowEngine, type ShadowSink } from '../../src/shadow/wrapper.ts';
import { WRITE_MAP } from '../../src/shadow/write-map.ts';

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
 * A pre-read never waits for a call that runs a callback (a nested transaction may itself be waiting for a call held behind the pre-read):
 * the write is planned relation-level (`pre_read_busy`), and every write commits.
 */
export async function busyPreReadIsRelationLevel(primary: BrainEngine): Promise<void> {
  const h = followHarness(primary);
  await primary.putPage('people/busy', PAGE('Busy'));
  await h.engine.transaction(async (tx) => {
    await Promise.all([
      tx.transaction(async (nested) => { await new Promise((r) => setTimeout(r, 30)); await nested.addTag('people/busy', 'nested'); }),
      tx.deletePage('people/busy-gone'), // a delete pre-reads the rows it removes
    ]);
  });
  if (!(await primary.getTags('people/busy')).includes('nested')) throw new Error('the nested write was lost');
  const items = h.batches.flatMap((b) => b.items);
  if (!items.some((i) => i.kind === 'relation' && i.reason === 'pre_read_busy')) throw new Error(`no pre_read_busy item: ${JSON.stringify(items)}`);
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
