/**
 * Shared by test/shadow-journal-bookkeeping-delegates.test.ts (PGLite) and test/e2e/shadow-journal-bookkeeping-delegates.test.ts
 * (Postgres): run the REAL engine delegates of the shadow follower's journal bookkeeping members, record every statement each one
 * sends, and compare what was sent with the census the follower trusts (JOURNAL_MEMBER_STATEMENTS in src/shadow/write-capture.ts,
 * turned into relation items by journalItems in src/shadow/follow.ts).
 *
 * The seam: `recordingEngine` returns an engine that behaves as the engine it wraps, except that the database handle every
 * engine-sql executor and every `executeRaw` reaches (PGLite `db`, Postgres `sql`) is a view that notes each statement before
 * it runs. Any statement a delegate sends through its own engine is therefore seen, including one a future edit adds.
 * A recorder that records nothing would pass vacuously, so every case also checks it saw the member's registered statements.
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WriteCompletion } from '../../src/core/engine-sql/persistence-journal.ts';
import { journalItems, journalWriteItems } from '../../src/shadow/follow.ts';
import { sqlWrites } from '../../src/shadow/sql-writes.ts';
import { JOURNAL_MEMBER_STATEMENTS } from '../../src/shadow/write-capture.ts';

export interface Recorded { sql: string; params: unknown }
export interface Recording<E extends BrainEngine = BrainEngine> { engine: E; statements: Recorded[] }

const squash = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

/**
 * The one statement the PGLite engine sends around an autocommit write that is not the member's own: the WAL checkpoint guard's read of
 * how far the log is past the last checkpoint (src/core/pglite-engine/checkpoint-guard.ts, #5449). It is a read, sent for every autocommit
 * write of any member, and it is still run through the write classifier below (it writes nothing).
 */
const ENGINE_CHECKPOINT_PROBE = squash('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::float8 AS since_redo FROM pg_control_checkpoint()');

/** An engine whose database handle notes every statement it is given. Works on a root engine and on a transaction engine. */
export function recordingEngine<E extends BrainEngine>(kind: 'pglite' | 'postgres', base: E): Recording<E> {
  const statements: Recorded[] = [];
  const note = (sql: unknown, params?: unknown): void => { statements.push({ sql: typeof sql === 'string' ? sql : Array.isArray(sql) ? (sql as string[]).join('?') : String(sql), params }); };
  const engine = Object.create(base) as E;
  if (kind === 'pglite') {
    const wrapDb = (db: object): object => new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key === 'query' || key === 'exec') return (sql: unknown, ...rest: unknown[]) => { note(sql, rest[0]); return (value as (...a: unknown[]) => unknown).call(target, sql, ...rest); };
        if (key === 'transaction') return (fn: (tx: object) => unknown, ...rest: unknown[]) => (value as (...a: unknown[]) => unknown).call(target, (tx: object) => fn(wrapDb(tx)), ...rest);
        return value.bind(target);
      },
    });
    const real = (base as unknown as { db: object }).db;
    Object.defineProperty(engine, 'db', { get: () => wrapDb(real), configurable: true });
  } else {
    const wrapSql = (sql: object): object => new Proxy(sql, {
      apply(target, thisArg, args) { note(args[0], args.slice(1)); return Reflect.apply(target as never, thisArg, args); },
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key === 'unsafe') return (query: unknown, ...rest: unknown[]) => { note(query, rest[0]); return (value as (...a: unknown[]) => unknown).call(target, query, ...rest); };
        if (key === 'begin' || key === 'savepoint') return (...args: unknown[]) => { const body = args.pop() as (tx: object) => unknown; return (value as (...a: unknown[]) => unknown).call(target, ...args, (tx: object) => body(wrapSql(tx))); };
        if (key === 'reserve') return async (...args: unknown[]) => wrapSql(await (value as (...a: unknown[]) => Promise<object>).call(target, ...args));
        return value.bind(target);
      },
    });
    const real = (base as unknown as { sql: object }).sql;
    Object.defineProperty(engine, 'sql', { get: () => wrapSql(real), configurable: true });
  }
  return { engine, statements };
}

/** The relations a list of statements writes, by the parser the follower uses; throws when one writes something that is not a named relation. */
export function writtenRelations(statements: readonly string[]): string[] {
  const relations = new Set<string>();
  for (const sql of statements) for (const w of sqlWrites(sql)) {
    if (w.kind !== 'relation') throw new Error(`statement writes something that is not a named relation (${w.kind}): ${squash(sql).slice(0, 120)}`);
    relations.add(w.relation);
  }
  return [...relations].sort();
}

/** What each member's registered statements write, written out here so a change to the census is a decision made in two places. */
export const EXPECTED_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  declarePersistence: [],
  lockPersistenceCounters: ['persistence_counters'],
  completeWriteRow: ['config', 'persistence_counters', 'persistence_requests'],
  insertPublicationEffects: ['persistence_effects'],
  completeEffectRow: ['persistence_effects'],
  setEffectTransactionLimits: [],
  lockEffectGuard: [],
  lockEffectClaimRow: [],
};

/** Every case of `member` ran: what its calls sent is nothing but the census, and writes nothing the follower would not publish. */
export function assertWithinCensus(member: string, calls: Recorded[][]): void {
  const registered = JOURNAL_MEMBER_STATEMENTS.get(member);
  expect(registered).toBeDefined();
  const census = new Set(registered!.map(squash));
  const published = (journalItems(member) ?? []).map((i) => (i.kind === 'relation' ? i.relation : `${i.kind}`)).sort();
  expect(published).toEqual([...EXPECTED_RELATIONS[member]!]);
  // 1. What each call writes, classified by the follower's own parser, is a subset of what the follower publishes for this member.
  for (const call of calls) {
    const texts = call.map((s) => s.sql);
    expect(writtenRelations(texts).filter((r) => !published.includes(r))).toEqual([]);
    if (texts.length) {
      const items = journalWriteItems(texts);
      expect(items).not.toBeNull();
      expect((items ?? []).map((i) => (i.kind === 'relation' ? i.relation : `${i.kind}`)).filter((r) => !published.includes(r))).toEqual([]);
    }
  }
  // 2. Every statement sent is one the census registers (a read, a lock or a write that is not registered fails here), and the calls
  //    between them sent every registered statement: a recorder that sees nothing proves nothing.
  const sent = calls.flat().map((s) => squash(s.sql)).filter((sql) => sql !== ENGINE_CHECKPOINT_PROBE);
  expect(new Set(sent)).toEqual(census);
}

/** The request, effect and counter rows the cases act on, made through the real engine members (not recorded). */
export interface JournalSeed {
  incarnation: string;
  admit(tag: string): Promise<{ id: string; keys: string[] }>;
  /** A request with a running effect of each kind: effect ids by kind, and the claim token every one carries. */
  runningEffects(tag: string): Promise<{ ids: Record<string, string>; token: string; requestId: string }>;
}

export async function seedJournal(engine: BrainEngine): Promise<JournalSeed> {
  const incarnation = (await engine.readSourceMembership('default'))!.incarnation;
  const admit = async (tag: string) => {
    const keys = [`principal:local_cli:${tag}`, `brain:${tag}`];
    await engine.lockPersistenceCounters(keys);
    const { id } = await engine.insertWriteRequest({
      principalKind: 'local_cli', principalId: tag, requestId: randomUUID(), operation: 'remember', sourceId: 'default',
      sourceIncarnation: incarnation, pageId: null, slug: `notes/${tag}`, worktreeId: null,
      topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'remember', text: 'hello' }, authority: { scopes: ['write'] },
      intentBytes: 100, terminalReservation: 8192, targetKind: 'page', protocolVersion: 1, admitterVersion: 'landing',
      admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
    return { id, keys };
  };
  return {
    incarnation,
    admit,
    async runningEffects(tag) {
      const { id } = await admit(tag);
      await engine.insertPublicationEffects({
        requestId: id, revision: null, sourceId: 'default', sourceIncarnation: incarnation, worktreeId: null,
        effects: [{ kind: 'git', data: {} }, { kind: 'links', data: { parked: ['people/a'] } }, { kind: 'embedding', data: {} }],
      });
      const token = randomUUID();
      await engine.executeRaw("UPDATE persistence_effects SET state = 'running', execution_token = $2::uuid WHERE request_id = $1::uuid", [id, token]);
      const rows = await engine.executeRaw<{ id: string; kind: string }>('SELECT id::text AS id, kind FROM persistence_effects WHERE request_id = $1::uuid', [id]);
      return { ids: Object.fromEntries(rows.map((r) => [r.kind, r.id])), token, requestId: id };
    },
  };
}

/** One way of calling a member: `run` gets the recording engine (a root engine or the engine of an open transaction). */
export interface DelegateCase { member: string; variant: string; run: (e: BrainEngine) => Promise<unknown> }

/** Every member, in every conditional variant its code has, as calls the follower's wrapper would see. */
export async function delegateCases(seed: JournalSeed, where: string): Promise<DelegateCase[]> {
  const completion = (over: Partial<WriteCompletion> & Pick<WriteCompletion, 'id' | 'counterKeys'>): WriteCompletion => ({
    state: 'committed', outcome: { status: 'committed' }, errorCode: null, errorMessage: null, consumerVersion: 'landing',
    consumerHostId: null, errorDetail: null, resultBytes: 1200, intentBytes: 100, retainedBytes: 1500, terminalReservation: 8192, probePurges: false, ...over,
  });
  const done = await seed.admit(`bk-complete-plain-${where}`);
  const purge = await seed.admit(`bk-complete-probe-${where}`);
  const failed = await seed.admit(`bk-complete-failed-${where}`);
  const big = await seed.admit(`bk-complete-big-${where}`);
  const publication = await seed.admit(`bk-publication-${where}`);
  const effects = await seed.runningEffects(`bk-effects-${where}`);
  return [
    { member: 'declarePersistence', variant: 'protocol only', run: (e) => e.declarePersistence() },
    { member: 'declarePersistence', variant: 'durable', run: (e) => e.declarePersistence({ durable: { lockTimeout: '1s', statementTimeout: '1s' } }) },
    { member: 'declarePersistence', variant: 'durable with the idle bound', run: (e) => e.declarePersistence({ durable: { lockTimeout: '1s', statementTimeout: '1s', idleInTransaction: '1s' } }) },
    { member: 'lockPersistenceCounters', variant: 'new and repeated keys', run: (e) => e.lockPersistenceCounters([`principal:local_cli:bk-new-${where}`, `brain:bk-new-${where}`, `brain:bk-new-${where}`]) },
    { member: 'lockPersistenceCounters', variant: 'existing keys', run: (e) => e.lockPersistenceCounters(done.keys) },
    { member: 'completeWriteRow', variant: 'committed, no purge probe', run: (e) => e.completeWriteRow(completion({ id: done.id, counterKeys: done.keys })) },
    { member: 'completeWriteRow', variant: 'committed, purge probe', run: (e) => e.completeWriteRow(completion({ id: purge.id, counterKeys: purge.keys, probePurges: true })) },
    { member: 'completeWriteRow', variant: 'failed with an error detail', run: (e) => e.completeWriteRow(completion({ id: failed.id, counterKeys: failed.keys, state: 'failed', outcome: null, errorCode: 'publish_failed', errorMessage: 'boom', errorDetail: { at: 'publish' } })) },
    { member: 'completeWriteRow', variant: 'a result over the reservation (no row changes)', run: (e) => e.completeWriteRow(completion({ id: big.id, counterKeys: big.keys, resultBytes: 20_000 })) },
    { member: 'completeWriteRow', variant: 'an unknown request', run: (e) => e.completeWriteRow(completion({ id: randomUUID(), counterKeys: done.keys })) },
    { member: 'insertPublicationEffects', variant: 'a gated and an ungated effect', run: (e) => e.insertPublicationEffects({
      requestId: publication.id, revision: randomUUID(), sourceId: 'default', sourceIncarnation: seed.incarnation, worktreeId: null,
      effects: [{ kind: 'links', data: { slugs: ['a'] }, gated: true }, { kind: 'git', data: {} }] }) },
    { member: 'insertPublicationEffects', variant: 'the same effects again (already queued)', run: (e) => e.insertPublicationEffects({
      requestId: publication.id, revision: null, sourceId: 'default', sourceIncarnation: seed.incarnation, worktreeId: null,
      effects: [{ kind: 'links', data: { slugs: ['a'] }, gated: true }, { kind: 'git', data: {} }] }) },
    { member: 'completeEffectRow', variant: 'the claim token (committed)', run: (e) => e.completeEffectRow({ id: effects.ids.git!, token: effects.token, outcomeJson: '{"sha":"abc123"}' }) },
    { member: 'completeEffectRow', variant: 'parked targets (failed)', run: (e) => e.completeEffectRow({ id: effects.ids.links!, token: effects.token, outcomeJson: '{"linked":0}' }) },
    { member: 'completeEffectRow', variant: 'a wrong token (nothing changes)', run: (e) => e.completeEffectRow({ id: effects.ids.embedding!, token: randomUUID(), outcomeJson: '{}' }) },
    { member: 'setEffectTransactionLimits', variant: 'the links effect settings', run: (e) => e.setEffectTransactionLimits() },
    { member: 'lockEffectGuard', variant: 'an effect with no worktree', run: (e) => e.lockEffectGuard(null) },
    { member: 'lockEffectGuard', variant: 'an effect bound to a worktree', run: (e) => e.lockEffectGuard(randomUUID()) },
    { member: 'lockEffectClaimRow', variant: 'a known effect', run: (e) => e.lockEffectClaimRow(effects.ids.embedding!) },
    { member: 'lockEffectClaimRow', variant: 'an unknown effect', run: (e) => e.lockEffectClaimRow(999_999_999) },
  ];
}

export const MEMBERS = Object.keys(EXPECTED_RELATIONS);

/**
 * Calls every case on `engine` twice, as the follower's wrapper sees a journal member called: on the engine itself (an autocommit
 * call; on Postgres lockPersistenceCounters then opens its own transaction) and inside an open transaction. Returns the statements
 * each call sent, per member.
 */
export async function runDelegates(kind: 'pglite' | 'postgres', engine: BrainEngine): Promise<Map<string, { variant: string; where: string; statements: Recorded[] }[]>> {
  const out = new Map<string, { variant: string; where: string; statements: Recorded[] }[]>();
  const seed = await seedJournal(engine);
  const record = (c: DelegateCase, where: string, statements: Recorded[]) => {
    const calls = out.get(c.member) ?? [];
    out.set(c.member, calls);
    calls.push({ variant: c.variant, where, statements });
  };
  // Rows are made fresh for each way of calling: a completed request cannot be completed twice (its counters are released once).
  for (const c of await delegateCases(seed, 'autocommit')) {
    const root = recordingEngine(kind, engine);
    await c.run(root.engine);
    record(c, 'autocommit', root.statements);
  }
  for (const c of await delegateCases(seed, 'transaction')) {
    await engine.transaction(async (tx) => {
      const inside = recordingEngine(kind, tx);
      await c.run(inside.engine);
      record(c, 'transaction', inside.statements);
    });
  }
  return out;
}
