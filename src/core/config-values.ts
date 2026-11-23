/**
 * Config reads that ran their own `SELECT ... FROM config` through executeRaw, switched to the engine's typed keyed read
 * (`getConfigValues`), so an engine without raw SQL (Rust, D18) serves them too (docs/research/rust-cli-contract-map.md
 * group 29).
 *
 * `getConfigValues` reads the config table itself, as the SQL it replaces did. `getConfig` would answer from the
 * request's config snapshot instead (#6721), so these reads do not use it.
 *
 * Two bounds the replaced executeRaw carried are kept:
 *  - A statement deadline (statement-deadline.ts) bounds executeRaw calls only. The typed read runs under the same
 *    deadline as a read deadline (read-deadline.ts), which the Postgres engine applies to its typed reads; PGLite and
 *    Rust have no statement deadline either way. A read the deadline ends marks the scope expired, as executeRaw's
 *    deadline wrapper does.
 *  - An abort signal: a read whose signal already fired is not started, and the caller stops waiting when the signal
 *    fires during the read. The typed read takes no signal, so the read itself is not cancelled; a stalled round trip
 *    no longer holds the caller past its phase deadline (#6278), as the replaced executeRaw did not.
 *
 * A handle without the typed read (a narrow `executeRaw`-only wrapper) runs the typed read's own statement.
 */
import type { BrainEngine } from './engine.ts';
import { ReadDeadlineError, withReadDeadline } from './read-deadline.ts';
import { currentStatementDeadline, deadlineFailure, StatementDeadlineError } from './statement-deadline.ts';

/** The statement `getConfigValues` runs on PGLite and Postgres (engine-sql/config.ts), for a handle without it. */
const CONFIG_VALUES_SQL = 'SELECT key, value FROM config WHERE key = ANY($1::text[]) ORDER BY key COLLATE "C"';

export type ConfigReader = Pick<BrainEngine, 'executeRaw'> & Partial<Pick<BrainEngine, 'getConfigValues'>>;

/** The stored `{ key, value }` rows for `keys`, ordered by key; a key with no row is absent. */
export async function readConfigRows(engine: ConfigReader | Pick<BrainEngine, 'getConfigValues'>, keys: readonly string[],
  opts: { signal?: AbortSignal } = {}): Promise<Array<{ key: string; value: string }>> {
  return readKeyedConfig(engine, 'getConfigValues', CONFIG_VALUES_SQL, keys, opts);
}

/** The keyed config reads an engine serves as a typed member, each with the statement it runs on PGLite and Postgres. */
type KeyedConfigMember = 'getConfigValues';

/**
 * `keys` through the engine's typed keyed read `member`, under the bounds above; a handle without it runs `sql` (the
 * member's own statement) through executeRaw.
 */
export async function readKeyedConfig(engine: Pick<BrainEngine, 'executeRaw'> | Partial<Pick<BrainEngine, KeyedConfigMember>>,
  member: KeyedConfigMember, sql: string, keys: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<Array<{ key: string; value: string }>> {
  opts.signal?.throwIfAborted();
  // The typed read takes no signal, so an abort only stops the wait and a statement still queued for a connection stays
  // on the pool (#6278: a saturated pool then accumulates one per consumer tick). Where raw SQL serves, a signalled read
  // runs the statement through executeRaw with the signal, as master did, so the abort cancels the statement itself.
  const caps = (engine as { capabilities?: ReadonlySet<string> }).capabilities;
  const cancellable = !!opts.signal && typeof (engine as Partial<ConfigReader>).executeRaw === 'function' && (typeof caps?.has !== 'function' || caps.has('raw_sql'));
  const typed = cancellable ? undefined : (engine as Partial<Pick<BrainEngine, KeyedConfigMember>>)[member];
  const read = typed
    ? () => untilAborted(typed.call(engine, keys), opts.signal)
    : () => (engine as ConfigReader).executeRaw<{ key: string; value: string }>(sql, [[...keys]], { signal: opts.signal });
  const scope = currentStatementDeadline();
  if (!typed || !scope || scope.deadlineAt === null) return read();
  if (Date.now() >= scope.deadlineAt) return refuse(scope);
  try {
    return await withReadDeadline(scope.deadlineAt, read, opts.signal);
  } catch (error) {
    // Ended by the deadline: mark the scope expired, as executeRaw's deadline wrapper does. A read never sent (no
    // connection before the deadline) reports the wrapper's own refusal, since the wrapper would not have sent it either.
    if (error instanceof ReadDeadlineError) return refuse(scope);
    if (deadlineFailure(error) && Date.now() >= scope.deadlineAt - 100) scope.expired = true;
    throw error;
  }
}

/** `read`, or the signal's reason when the signal fires first. The read keeps running; only the wait ends. */
function untilAborted<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return read;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    read.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function refuse(scope: NonNullable<ReturnType<typeof currentStatementDeadline>>): never {
  scope.expired = true;
  throw new StatementDeadlineError(Date.now() - scope.startedAt);
}

/** `keys` as a key -> stored value map; a key with no row is absent. */
export async function readConfigMap(engine: ConfigReader | Pick<BrainEngine, 'getConfigValues'>, keys: readonly string[],
  opts: { signal?: AbortSignal } = {}): Promise<Map<string, string>> {
  return new Map((await readConfigRows(engine, keys, opts)).map(row => [row.key, row.value]));
}

/** The stored value of `key`, or undefined when it has no row. */
export async function readConfigValue(engine: ConfigReader | Pick<BrainEngine, 'getConfigValues'>, key: string,
  opts: { signal?: AbortSignal } = {}): Promise<string | undefined> {
  return (await readConfigRows(engine, [key], opts)).find(row => row.key === key)?.value;
}
