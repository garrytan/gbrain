import { protocol, types, type PGlite, type Results, type Transaction } from '@electric-sql/pglite';

type Field = { name: string; dataTypeID: number };
type BackendMessage = { name: string; dataTypeIDs?: number[]; fields?: (Field | string | null)[]; text?: string };
type Parser = (value: string, typeId: number) => unknown;
type ExclusiveDatabase = PGlite & {
  _checkReady(): Promise<void>;
  _runExclusiveQuery<T>(fn: () => Promise<T>): Promise<T>;
  _runExclusiveTransaction<T>(fn: () => Promise<T>): Promise<T>;
};
interface Column { name: string; dataTypeID: number; parse: Parser | undefined }
interface Statement { name: string; paramTypes: number[]; columns: Column[] }

const { serialize } = protocol as unknown as {
  serialize: {
    parse(input: { name: string; text: string }): Uint8Array;
    describe(input: { type: 'S'; name: string }): Uint8Array;
    bind(input: { statement: string; values: (string | null)[] }): Uint8Array;
    execute(input: Record<string, never>): Uint8Array;
    close(input: { type: 'S'; name: string }): Uint8Array;
    sync(): Uint8Array;
  };
};
const defaultParsers = types.parsers as unknown as Record<number, Parser>;

/** Statements that can change a cached statement's result shape or drop session statements. */
const SHAPE_CHANGING = /^\s*(?:ALTER|CREATE|DROP|DO|DISCARD|DEALLOCATE)\b/i;
const TRANSACTION_CONTROL = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
/** Plan-cache errors that a fresh Parse resolves: changed result type, missing statement. */
const STALE_STATEMENT = new Set(['0A000', '26000']);

/** PGlite's parseResults for one statement, with parsers resolved once per prepared statement. */
function results(columns: Column[], messages: BackendMessage[]): Results {
  const rows: Record<string, unknown>[] = [];
  let affectedRows = 0;
  let completed = false;
  for (const message of messages) {
    if (message.name === 'dataRow') rows.push(Object.fromEntries(message.fields!.map((value, index) => {
      const column = columns[index];
      return [column.name, value === null || !column.parse ? value : column.parse(value as string, column.dataTypeID)];
    })));
    else if (message.name === 'commandComplete') {
      const [command, first, second] = message.text!.split(' ');
      affectedRows += command === 'INSERT' ? parseInt(second, 10)
        : ['UPDATE', 'DELETE', 'COPY', 'MERGE'].includes(command) ? parseInt(first, 10) : 0;
      completed = true;
    }
  }
  const fields = columns.map(({ name, dataTypeID }) => ({ name, dataTypeID }));
  return (completed ? { rows, fields, affectedRows } : { affectedRows: 0, rows: [], fields: [] }) as Results;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/**
 * Named server-side statements for PGLite, the plan cache postgres.js already
 * gives the Postgres engine. PGlite's query() parses, plans, and describes
 * every call as an unnamed statement over five protocol round trips; a
 * statement seen twice is prepared once and later runs as one Bind/Execute/Sync
 * batch. PostgreSQL still replans on invalidation and rejects a changed result
 * shape, which drops the entry. Shape-changing SQL clears the cache.
 */
export class PgliteStatementCache {
  private statements = new Map<string, Statement>();
  private seen = new Set<string>();
  private retired: string[] = [];
  private next = 0;

  constructor(private readonly db: PGlite, private readonly capacity = 256) {}

  /** Route a PGlite handle's query/exec through the cache; transaction handles skip the outer mutex. */
  attach<T extends PGlite | Transaction>(handle: T, inTransaction: boolean): T {
    const query = handle.query.bind(handle);
    const exec = handle.exec.bind(handle);
    return new Proxy(handle, {
      get: (target, key) => {
        // An instance override (test seams, wrappers) owns the call; the
        // cache still serves whatever it delegates to through this proxy.
        if (!inTransaction && (key === 'query' || key === 'exec') && Object.hasOwn(target, key)) {
          return (Reflect.get(target, key, target) as (...args: unknown[]) => unknown).bind(target);
        }
        if (key === 'query') return (sql: string, params?: unknown[], options?: unknown) =>
          options !== undefined || (inTransaction && (target as Transaction).closed)
            ? this.observe(sql, () => query(sql, params as never[], options as never))
            : this.query(sql, params ?? [], inTransaction, () => query(sql, params as never[]));
        if (key === 'exec') return (sql: string, options?: unknown) => {
          if (!TRANSACTION_CONTROL.test(sql)) this.clear();
          return exec(sql, options as never);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as T;
  }

  clear(): void {
    for (const statement of this.statements.values()) this.retired.push(statement.name);
    this.statements.clear();
    this.seen.clear();
  }

  private observe<R>(sql: string, run: () => Promise<R>): Promise<R> {
    if (SHAPE_CHANGING.test(sql)) this.clear();
    return run();
  }

  private async query(sql: string, params: unknown[], inTransaction: boolean, unnamed: () => Promise<Results>): Promise<Results> {
    if (SHAPE_CHANGING.test(sql)) { this.clear(); return unnamed(); }
    if (!this.statements.has(sql) && !this.seen.has(sql)) {
      if (this.seen.size >= this.capacity * 4) this.seen.clear();
      this.seen.add(sql);
      return unnamed();
    }
    const db = this.db as ExclusiveDatabase;
    const run = () => db._runExclusiveQuery(async () => {
      let result: Results;
      try { result = await this.execute(sql, params); }
      catch (error) {
        if (!STALE_STATEMENT.has(String((error as { code?: unknown }).code))) throw error;
        this.forget(sql);
        if (inTransaction) throw error;
        result = await this.execute(sql, params);
      }
      if (!inTransaction) await db.syncToFs();
      return result;
    });
    if (inTransaction) return run();
    await db._checkReady();
    return db._runExclusiveTransaction(run);
  }

  private forget(sql: string): void {
    const statement = this.statements.get(sql);
    if (!statement) return;
    this.statements.delete(sql);
    this.retired.push(statement.name);
  }

  private async prepare(sql: string): Promise<Statement> {
    const cached = this.statements.get(sql);
    if (cached) {
      this.statements.delete(sql);
      this.statements.set(sql, cached);
      return cached;
    }
    if (this.statements.size >= this.capacity) this.forget(this.statements.keys().next().value!);
    const name = `gbrain_s${++this.next}`;
    const parts = this.retired.splice(0).map(retired => serialize.close({ type: 'S', name: retired }));
    parts.push(serialize.parse({ name, text: sql }), serialize.describe({ type: 'S', name }), serialize.sync());
    const { messages } = await this.protocol(concat(parts), sql, []);
    const parsers = this.db.parsers as unknown as Record<number, Parser>;
    const fields = (messages.find(message => message.name === 'rowDescription')?.fields ?? []) as Field[];
    const statement = { name,
      paramTypes: messages.find(message => message.name === 'parameterDescription')?.dataTypeIDs ?? [],
      columns: fields.map(({ name: column, dataTypeID }) => ({ name: column, dataTypeID,
        parse: parsers[dataTypeID] ?? defaultParsers[dataTypeID] })) };
    this.statements.set(sql, statement);
    return statement;
  }

  private async execute(sql: string, params: unknown[]): Promise<Results> {
    const statement = await this.prepare(sql);
    const serializers = this.db.serializers;
    const values = params.map((param, index) => {
      if (param === null || param === undefined) return null;
      const serializeParam = serializers[statement.paramTypes[index]];
      return serializeParam ? serializeParam(param) : String(param);
    });
    const { messages } = await this.protocol(concat([serialize.bind({ statement: statement.name, values }),
      serialize.execute({}), serialize.sync()]), sql, params);
    return results(statement.columns, messages);
  }

  private async protocol(message: Uint8Array, sql: string, params: unknown[]): Promise<{ messages: BackendMessage[] }> {
    try { return await this.db.execProtocol(message, { syncToFs: false }) as { messages: BackendMessage[] }; }
    catch (error) {
      // Same diagnostic fields PGlite's own query() attaches to a DatabaseError.
      if (error && typeof error === 'object' && 'code' in error) Object.assign(error, { query: sql, params, queryOptions: undefined });
      throw error;
    }
  }
}

/**
 * PGlite copies `db.parsers` into a fresh object for every query result. Its
 * array-type init registers one parser per composite (table row) array type,
 * most of the map in a gbrain schema, and gbrain never selects those arrays;
 * the per-query copy then dominated short statements. Their values would only
 * have been split into unparsed strings, so drop them after connect.
 */
export async function dropRowTypeArrayParsers(db: PGlite): Promise<void> {
  const { rows } = await db.query<{ oid: number }>(`SELECT a.oid::int AS oid FROM pg_type a
    JOIN pg_type e ON e.oid=a.typelem WHERE a.typcategory='A' AND e.typtype='c'`);
  for (const { oid } of rows) delete db.parsers[oid];
}
