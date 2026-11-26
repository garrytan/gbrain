/**
 * Transactions, their settings and the page-key lock queue (core): transaction, transactionDirect, lockPageKeys,
 * readTransactionSettings and applyTransactionSettings. Built by the core store work; other families do not edit this
 * file. Contract: rust/docs/store/transactions.md.
 *
 * `transaction(fn)` on the engine opens the store's write transaction (RustEngine._openTransaction: writer gate,
 * re-entry guard, commit or roll back) and passes `fn` a transaction-bound clone of the engine: every served member of
 * the clone runs on the bound store handle, so it reads its own writes. `transaction(fn)` on a clone is a savepoint:
 * kept when `fn` resolves, dropped when it throws. `lockPageKeys` holds exact page keys until the transaction or
 * savepoint ends, with PGLite's checks and errors (page-state/guards.ts).
 *
 * Transaction-local settings (`set_config(name, value, true)`): the six write trust settings go to the store's write
 * trust context on the transaction's handle (`applyWriteTrust` / `readWriteTrust`), which the trust fence reads and
 * the stamp will read; the attribution, source-scope and quiescence settings stay on the transaction
 * (`RustTransactionScope.settings`), and so does the one planner setting the belief batch switches (`plan_cache_mode`;
 * the store has no planner, so it changes nothing else, and an unset one reads PGLite's default). Both end with the
 * transaction; a savepoint rollback restores both. Any other custom `gbrain.*` name Postgres accepts stays on the
 * transaction too, unless schema SQL reads it; any other name refuses.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { BrainEngine, TransactionOptions } from '../../engine.ts';
import { PageSourceMissingError, withHeldPageKeys, type HeldPageKeys } from '../../page-state/guards.ts';
import type { PageKey } from '../../page-state/types.ts';
import { transactionAborted } from '../../postgres-engine/transaction-abort.ts';
import { validateSlug } from '../../utils.ts';
import type { RustEngine, RustTransactionScope } from '../../rust-engine.ts';
import { opError } from '../../ops/contract.ts';
import { capabilityMissing } from '../errors.ts';
import { mapStoreError, storeErrorCode } from '../store-errors.ts';
import type { RustStore, StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

type TransactionFn<T> = (engine: BrainEngine) => Promise<T>;

/**
 * The nine settings the store's write context keeps (rust/docs/store/write_trust.md): the trust ones and the write
 * attribution ones its writers read there (the trust stamp, the fence reads, the timeline write receipt).
 */
const TRUST_SETTINGS: ReadonlySet<string> = new Set([
  'gbrain.write_trust_tier', 'gbrain.write_origin', 'gbrain.write_trust_promotion',
  'gbrain.write_trust_backfill', 'gbrain.write_trust_keep', 'gbrain.write_open_facts',
  'gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id',
]);
/**
 * The settings the transaction keeps in TypeScript (`RustTransactionScope.settings`): source scope, protocols and the
 * writer quiescence declaration skill activation sets (`gbrain.writer_quiesced`).
 */
const SCOPE_SETTINGS: ReadonlySet<string> = new Set([
  'gbrain.write_sources', 'gbrain.git_protocol', 'gbrain.persistence_protocol', 'gbrain.writer_quiesced',
]);
/**
 * Planner settings the transaction keeps in TypeScript, as PGLite reads them when unset and the values it accepts
 * (case-insensitive, kept in lower case). The belief batch (`readLedgerSource` with `batch`) sets `plan_cache_mode`.
 */
const PLANNER_SETTINGS: ReadonlyMap<string, { unset: string; values: ReadonlySet<string> }> = new Map([
  ['plan_cache_mode', { unset: 'auto', values: new Set(['auto', 'force_generic_plan', 'force_custom_plan']) }],
]);
/** engine-sql/transaction-settings.ts `SETTING_NAME`: the same check and the same error, before any work. */
const SETTING_NAME = /^[a-z_][a-z0-9_.]*$/;

/**
 * The names set on each engine's connection so far. Postgres keeps a placeholder for a setting once any statement on
 * the connection set it, so an unset name then reads '' instead of null; the engine is one connection, and keeps the set.
 */
function seen(engine: RustEngine): Set<string> {
  return (engine._txScope?.root ?? engine)._seenSettings;
}

/**
 * The `gbrain.*` settings schema triggers and functions read (`current_setting('gbrain.<name>'` in src) that no store
 * writer reads yet. Kept in the transaction's map, one would change what Postgres does and nothing on Rust, so each
 * refuses until the store reads it (`gbrain.writer_quiesced` is not here: SCOPE_SETTINGS keeps it on the transaction). test/rust-engine-shell.test.ts fails on a schema-read name outside the kept sets
 * and this one.
 */
const SCHEMA_READ_SETTINGS: ReadonlySet<string> = new Set([
  'gbrain.materializing_revision', 'gbrain.topology_change', 'gbrain.refresh_barrier',
  'gbrain.trust_generation_bumped', 'gbrain.guest_note', 'gbrain.graduation_run',
]);
/** Postgres's custom setting name: two or more simple identifiers separated by dots, here under `gbrain`. */
const CUSTOM_SETTING_NAME = /^gbrain(\.[a-z_][a-z0-9_]*)+$/;
/** A custom name no writer or schema SQL reads: the transaction keeps it in its own map, as Postgres keeps it. */
const keepsCustomSetting = (name: string) => CUSTOM_SETTING_NAME.test(name) && !TRUST_SETTINGS.has(name) && !SCHEMA_READ_SETTINGS.has(name);

/** Checks every name before any work: the alphabet first (PGLite's error), then the names this engine keeps. */
function checkSettingNames(member: string, names: readonly string[]): void {
  for (const name of names) if (!SETTING_NAME.test(name)) throw new Error(`Invalid transaction setting name: ${name}`);
  for (const name of names) {
    if (TRUST_SETTINGS.has(name) || SCOPE_SETTINGS.has(name) || keepsCustomSetting(name) || PLANNER_SETTINGS.has(name)) continue;
    throw opError('engine_capability_missing',
      `This brain's engine does not keep the transaction setting ${name} yet (${member} needs the transactions capability for it), so nothing ran.`,
      'Run it on a pglite or postgres brain, or wait for a gbrain release whose Rust engine keeps that setting.',
      { reason: 'transactions', detail: `member=${member} capability=transactions setting=${name} outcome=none written=nothing` });
  }
}

/**
 * `current_setting(name, true)` for each name. Inside a transaction a trust or attribution setting reads from the
 * store's write context and any other from the transaction's own map; a name never set reads null, or '' once it was set before on
 * this engine. Outside a transaction nothing is kept, so every name reads that way.
 */
export const readTransactionSettings = async function readTransactionSettings(this: RustEngine, brain: StoreBrain, names: readonly string[]): Promise<Array<string | null>> {
  checkSettingNames('readTransactionSettings', names);
  if (names.length === 0) return [];
  const scope = this._txScope;
  const known = seen(this);
  const unset = (name: string) => PLANNER_SETTINGS.get(name)?.unset ?? (known.has(name) ? '' : null);
  if (!scope) return names.map(unset);
  if (scope.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'readTransactionSettings' });
  const trustNames = names.filter((name) => TRUST_SETTINGS.has(name));
  const trust: Array<string | null> = trustNames.length
    ? await storeCall({ member: 'readTransactionSettings' }, () => brain.readWriteTrust(trustNames)) : [];
  const fromStore = new Map(trustNames.map((name, index) => [name, trust[index] ?? null]));
  return names.map((name) => (TRUST_SETTINGS.has(name) ? fromStore.get(name) : scope.settings.get(name)) ?? unset(name));
};

/**
 * `set_config(name, value, true)` for each name, for the rest of the transaction. Outside a transaction the setting
 * lasts one statement on PGLite, so nothing is kept. The store checks the trust values first (a tier that is no tier,
 * an origin that is not JSON refuse `invalid_argument`) and nothing changes when it refuses. A request that is not a
 * UUID is kept; the timeline write refuses it, as PGLite's attribution trigger does.
 */
export const applyTransactionSettings = async function applyTransactionSettings(this: RustEngine, brain: StoreBrain, names: readonly string[], values: readonly string[]): Promise<void> {
  checkSettingNames('applyTransactionSettings', names);
  if (names.length === 0) return;
  const planner = names.map((name, index) => [name, (values[index] ?? '').toLowerCase()] as const).filter(([name]) => PLANNER_SETTINGS.has(name));
  for (const [name, value] of planner) {
    if (!PLANNER_SETTINGS.get(name)!.values.has(value)) throw new Error(`invalid value for parameter "${name}": "${values[names.indexOf(name)] ?? ''}"`);
  }
  const scope = this._txScope;
  if (scope) {
    if (scope.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'applyTransactionSettings' });
    const trust = names.map((name, index) => [name, values[index] ?? ''] as const).filter(([name]) => TRUST_SETTINGS.has(name));
    if (trust.length) {
      await storeCall({ member: 'applyTransactionSettings' }, () => brain.applyWriteTrust(trust.map(([n]) => n), trust.map(([, v]) => v)));
    }
    names.forEach((name, index) => { if (SCOPE_SETTINGS.has(name) || keepsCustomSetting(name)) scope.settings.set(name, values[index] ?? ''); });
    for (const [name, value] of planner) scope.settings.set(name, value);
  }
  const known = seen(this);
  for (const name of names) known.add(name);
};

/** What a transaction-bound clone carries on top of the engine it was made from. */
interface BoundEngine extends RustEngine {
  _heldPageKeys: HeldPageKeys | null;
  /** Serializes the savepoints opened on this clone, so sibling savepoints never interleave on the layer stack. */
  _savepoints: Promise<unknown>;
}

/** A clone of `parent` whose served members run on the transaction's store handle. */
function boundEngine(parent: RustEngine, scope: RustTransactionScope, held: HeldPageKeys): BoundEngine {
  // The shadow seed and the restore members (master's restore family) work on the engine's own store, never through a transaction's handle.
  const refuseSeed = (member: string) => async (): Promise<never> => { throw capabilityMissing('transactions', member); };
  const store: RustStore = {
    brain: scope.brain, close: async () => undefined,
    importRelation: refuseSeed('importRelation'), replaceRelationRows: refuseSeed('replaceRelationRows'), replaceInterval: refuseSeed('replaceInterval'),
    relationDigest: refuseSeed('relationDigest'), relationEntries: refuseSeed('relationEntries'), allocatorCheck: refuseSeed('allocatorCheck'),
    factFingerprints: refuseSeed('factFingerprints'), seedPlan: refuseSeed('seedPlan'),
    restoreCensus: refuseSeed('restoreCensus'), restoreQuarantine: refuseSeed('restoreQuarantine'),
    snapshotTo: refuseSeed('snapshotTo'), snapshotCancel: () => { throw capabilityMissing('transactions', 'snapshotCancel'); },
  };
  return Object.create(parent, {
    _txScope: { value: scope, writable: false, enumerable: false },
    _heldPageKeys: { value: held, writable: false, enumerable: false },
    _savepoints: { value: Promise.resolve(), writable: true, enumerable: false },
    openStore: {
      value(member: string): RustStore {
        if (scope.ended) throw mapStoreError({ code: 'store_closed' }, { member });
        return store;
      },
      enumerable: false,
    },
  }) as BoundEngine;
}

/** The clone as the BrainEngine `fn` takes (RustEngine leaves out `kind`, which the loader's engine type adds). */
function asEngine(engine: BoundEngine): BrainEngine {
  return engine as unknown as BrainEngine;
}

/** A savepoint on the clone `engine`: one at a time per clone, kept when `fn` resolves, dropped when it throws. */
async function savepoint<T>(engine: BoundEngine, brain: StoreBrain, fn: TransactionFn<T>): Promise<T> {
  const scope = engine._txScope!;
  const previous = engine._savepoints;
  let finished!: () => void;
  engine._savepoints = new Promise<void>((resolve) => { finished = resolve; });
  await previous.catch(() => undefined);
  try {
    if (scope.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'transaction' });
    const settings = new Map(scope.settings);
    const trust: Array<string | null> = await storeCall({ member: 'transaction' }, () => brain.readWriteTrust([...TRUST_SETTINGS]));
    const depth: number = await storeCall({ member: 'transaction' }, () => brain.savepoint());
    return await withHeldPageKeys(engine._heldPageKeys, async (held) => {
      let value: T;
      try {
        value = await fn(asEngine(boundEngine(engine, scope, held)));
      } catch (error) {
        await brain.rollbackSavepoint(depth).catch(() => undefined);
        // ROLLBACK TO SAVEPOINT restores the settings too; a name first set inside reads '' (its placeholder stays).
        scope.settings.clear();
        for (const [name, kept] of settings) scope.settings.set(name, kept);
        await brain.applyWriteTrust([...TRUST_SETTINGS], trust.map((value) => value ?? '')).catch(() => undefined);
        throw error;
      }
      await storeCall({ member: 'transaction' }, () => brain.releaseSavepoint(depth));
      return value;
    });
  } finally {
    finished();
  }
}

export const transaction = async function transaction<T>(this: RustEngine, brain: StoreBrain, fn: TransactionFn<T>, opts?: TransactionOptions): Promise<T> {
  if (this._txScope) {
    if (opts?.signal?.aborted) throw transactionAborted(opts.signal);
    return savepoint(this as BoundEngine, brain, fn);
  }
  return this._openTransaction(opts, (scope) => withHeldPageKeys(null, (held) => fn(asEngine(boundEngine(this, scope, held)))));
};

/** The same transaction: the store has one route. */
export const transactionDirect = async function transactionDirect<T>(this: RustEngine, brain: StoreBrain, fn: TransactionFn<T>, opts?: TransactionOptions): Promise<T> {
  return transaction.call(this, brain, fn, opts) as Promise<T>;
};

/** guards.ts `pageGuardKey`: the identity a held key is recorded under, or null for a key its checks refuse. */
function guardKey(key: PageKey): string | null {
  if (!key.sourceId) return null;
  try { return JSON.stringify([key.sourceId, validateSlug(key.slug)]); } catch { return null; }
}

function holds(held: HeldPageKeys | null, id: string): boolean {
  for (; held; held = held.parent) if (held.keys.has(id)) return true;
  return false;
}

/** guards.ts `lockUnheldPageKeys` + `lockPageKeys`: the same checks and errors, the lock taken in the store. */
export const lockPageKeys = async function lockPageKeys(this: RustEngine, brain: StoreBrain, keys: readonly PageKey[]): Promise<void> {
  if (!this._txScope) throw new Error('lockPageKeys requires engine.transaction()');
  const held = (this as BoundEngine)._heldPageKeys!;
  const pending = keys.filter((key) => { const id = guardKey(key); return id === null || !holds(held, id); });
  if (!pending.length) return;
  const unique = new Map<string, PageKey>();
  for (const key of pending) {
    if (!key.sourceId) throw new TypeError('A page guard requires an exact sourceId');
    const slug = validateSlug(key.slug);
    unique.set(JSON.stringify([key.sourceId, slug]), { sourceId: key.sourceId, slug, ...(key.incarnation ? { incarnation: key.incarnation } : {}) });
  }
  const ordered = [...unique.values()].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const expected = new Map<string, string>();
  for (const { sourceId, incarnation } of ordered) if (incarnation && (expected.get(sourceId) ?? incarnation) === incarnation) expected.set(sourceId, incarnation);
  const hinted = ordered.every((key) => key.incarnation && expected.get(key.sourceId) === key.incarnation);
  try {
    await brain.holdPageKeys(ordered.map(({ sourceId, slug, incarnation }) => ({ sourceId, slug, incarnation: incarnation ?? null })), hinted);
  } catch (error) {
    const code = storeErrorCode(error);
    const message = error instanceof Error ? error.message : '';
    if (code === 'source_not_found') {
      const sourceId = /^Page source does not exist: (.*)$/s.exec(message)?.[1];
      if (sourceId !== undefined) throw new PageSourceMissingError(sourceId);
    }
    if (code === 'source_changed') throw new Error(message);
    throw mapStoreError(error, { member: 'lockPageKeys' });
  }
  for (const key of pending) held.keys.add(guardKey(key)!);
};
