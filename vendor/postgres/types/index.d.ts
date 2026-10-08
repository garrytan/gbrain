import { Readable, Writable } from 'node:stream'

/**
 * Establish a connection to a PostgreSQL server.
 * @param options Connection options - default to the same as psql
 * @returns An utility function to make queries to the server
 */
declare function postgres<T extends Record<string, postgres.PostgresType> = {}>(options?: postgres.Options<T> | undefined): postgres.Sql<Record<string, postgres.PostgresType> extends T ? {} : { [type in keyof T]: T[type] extends {
  serialize: (value: infer R) => any,
  parse: (raw: any) => infer R
} ? R : never }>
/**
 * Establish a connection to a PostgreSQL server.
 * @param url Connection string used for authentication
 * @param options Connection options - default to the same as psql
 * @returns An utility function to make queries to the server
 */
declare function postgres<T extends Record<string, postgres.PostgresType> = {}>(url: string, options?: postgres.Options<T> | undefined): postgres.Sql<Record<string, postgres.PostgresType> extends T ? {} : { [type in keyof T]: T[type] extends {
  serialize: (value: infer R) => any,
  parse: (raw: any) => infer R
} ? R : never }>

/**
 * Connection options of Postgres.
 */
interface BaseOptions<T extends Record<string, postgres.PostgresType>> {
  /** Postgres ip address[s] or domain name[s] */
  host: string | string[] | undefined;
  /** Postgres server[s] port[s] */
  port: number | number[] | undefined;
  /** unix socket path (usually '/tmp') */
  path: string | undefined;
  /**
   * Name of database to connect to
   * @default process.env['PGDATABASE'] || options.user
   */
  database: string;
  /**
   * Username of database user
   * @default process.env['PGUSERNAME'] || process.env['PGUSER'] || require('os').userInfo().username
   */
  user: string;
  /**
   * How to deal with ssl (can be a tls.connect option object)
   * @default false
  */
  ssl: 'require' | 'allow' | 'prefer' | 'verify-full' | boolean | object;
  /**
   * Max number of connections
   * @default 10
   */
  max: number;
  /**
   * Idle connection timeout in seconds
   * @default process.env['PGIDLE_TIMEOUT']
   */
  idle_timeout: number | undefined;
  /**
   * Connect timeout in seconds
   * @default process.env['PGCONNECT_TIMEOUT']
   */
  connect_timeout: number;
  /** Array of custom types; see more in the README */
  types: T;
  /**
   * Enables prepare mode.
   * @default true
   */
  prepare: boolean;
  /**
   * Called when a notice is received
   * @default console.log
   */
  onnotice: (notice: postgres.Notice) => void;
  /** (key; value) when a server param change */
  onparameter: (key: string, value: any) => void;
  /** Is called with (connection; query; parameters) */
  debug: boolean | ((connection: number, query: string, parameters: any[], paramTypes: any[]) => void);
  /** Transform hooks */
  transform: {
    /** Transforms outcoming undefined values */
    undefined?: any

    /** Transforms incoming and outgoing column names */
    column?: ((column: string) => string) | {
      /** Transform function for column names in result rows */
      from?: ((column: string) => string) | undefined;
      /** Transform function for column names in interpolated values passed to tagged template literal */
      to?: ((column: string) => string) | undefined;
    } | undefined;
    /** Transforms incoming and outgoing row values */
    value?: ((value: any) => any) | {
      /** Transform function for values in result rows */
      from?: ((value: unknown, column: postgres.Column<string>) => any) | undefined;
      // to?: ((value: unknown) => any) | undefined; // unused
    } | undefined;
    /** Transforms entire rows */
    row?: ((row: postgres.Row) => any) | {
      /** Transform function for entire result rows */
      from?: ((row: postgres.Row) => any) | undefined;
      // to?: ((row: postgres.Row) => any) | undefined; // unused
    } | undefined;
  };
  /** Connection parameters */
  connection: Partial<postgres.ConnectionParameters>;
  /**
   * Use 'read-write' with multiple hosts to ensure only connecting to primary
   * @default process.env['PGTARGETSESSIONATTRS']
   */
  target_session_attrs: undefined | 'read-write' | 'read-only' | 'primary' | 'standby' | 'prefer-standby';
  /**
   * Automatically fetches types on connect
   * @default true
   */
  fetch_types: boolean;
  /**
   * Publications to subscribe to (only relevant when calling `sql.subscribe()`)
   * @default 'alltables'
   */
  publications: string
  onclose: (connId: number) => void;
  /**
   * Called when a pooled or released connection is terminated instead of
   * reused because its ReadyForQuery status was not idle ('T' or 'E').
   */
  onpoisoned: (status: string) => void;
  /**
   * GBrain: share the parameter types of a described statement across this pool's
   * connections, so a connection running it for the first time skips the describe
   * round trip and keeps pipelining. Only built-in types are shared.
   * @default true
   */
  shared_types: boolean;
  backoff: boolean | ((attemptNum: number) => number);
  max_lifetime: number | null;
  keep_alive: number | null;
}


declare const PRIVATE: unique symbol;

declare class NotAPromise {
  private [PRIVATE]: never; // prevent user-side interface implementation

  /**
   * @deprecated This object isn't an SQL query, and therefore not a Promise; use the tagged template string syntax instead: ```await sql\`...\`;```
   * @throws NOT_TAGGED_CALL
   */
  private then(): never;
  /**
   * @deprecated This object isn't an SQL query, and therefore not a Promise; use the tagged template string syntax instead: ```await sql\`...\`;```
   * @throws NOT_TAGGED_CALL
   */
  private catch(): never;
  /**
   * @deprecated This object isn't an SQL query, and therefore not a Promise; use the tagged template string syntax instead: ```await sql\`...\`;```
   * @throws NOT_TAGGED_CALL
   */
  private finally(): never;
}

type UnwrapPromiseArray<T> = T extends any[] ? {
  [k in keyof T]: T[k] extends Promise<infer R> ? R : T[k]
} : T;

type Keys = string

type SerializableObject<T, K extends readonly any[], TT> =
  number extends K['length'] ? {} :
  Partial<(Record<Keys & (keyof T) & (K['length'] extends 0 ? string : K[number]), postgres.ParameterOrJSON<TT> | undefined> & Record<string, any>)>

type First<T, K extends readonly any[], TT> =
  // Tagged template string call
  T extends TemplateStringsArray ? TemplateStringsArray :
  // Identifiers helper
  T extends string ? string :
  // Dynamic values helper (depth 2)
  T extends readonly any[][] ? readonly postgres.EscapableArray[] :
  // Insert/update helper (depth 2)
  T extends readonly (object & infer R)[] ? (R extends postgres.SerializableParameter<TT> ? readonly postgres.SerializableParameter<TT>[] : readonly SerializableObject<R, K, TT>[]) :
  // Dynamic values/ANY helper (depth 1)
  T extends readonly any[] ? (readonly postgres.SerializableParameter<TT>[]) :
  // Insert/update helper (depth 1)
  T extends object ? SerializableObject<T, K, TT> :
  // Unexpected type
  never

type Rest<T> =
  T extends TemplateStringsArray ? never : // force fallback to the tagged template function overload
  T extends string ? readonly string[] :
  T extends readonly any[][] ? readonly [] :
  T extends readonly (object & infer R)[] ? (
    readonly (Keys & keyof R)[]   // sql(data, "prop", "prop2") syntax
    |
    [readonly (Keys & keyof R)[]] // sql(data, ["prop", "prop2"]) syntax
  ) :
  T extends readonly any[] ? readonly [] :
  T extends object ? (
    readonly (Keys & keyof T)[]   // sql(data, "prop", "prop2") syntax
    |
    [readonly (Keys & keyof T)[]] // sql(data, ["prop", "prop2"]) syntax
  ) :
  any

type Return<T, K extends readonly any[]> =
  [T] extends [TemplateStringsArray] ?
  [unknown] extends [T] ? postgres.Helper<T, K> : // ensure no `PendingQuery` with `any` types
  [TemplateStringsArray] extends [T] ? postgres.PendingQuery<postgres.Row[]> :
  postgres.Helper<T, K> :
  postgres.Helper<T, K>

declare namespace postgres {
  class PostgresError extends Error {
    name: 'PostgresError';
    severity_local: string;
    severity: string;
    code: string;
    position: string;
    file: string;
    line: string;
    routine: string;

    detail?: string | undefined;
    hint?: string | undefined;
    internal_position?: string | undefined;
    internal_query?: string | undefined;
    where?: string | undefined;
    schema_name?: string | undefined;
    table_name?: string | undefined;
    column_name?: string | undefined;
    data?: string | undefined;
    type_name?: string | undefined;
    constraint_name?: string | undefined;

    /** Only set when debug is enabled */
    query: string;
    /** Only set when debug is enabled */
    parameters: any[];
  }

  /**
   * Convert a snake_case string to PascalCase.
   * @param str The string from snake_case to convert
   * @returns The new string in PascalCase
   */
  function toPascal(str: string): string;
  namespace toPascal {
    namespace column { function from(str: string): string; }
    namespace value { function from(str: unknown, column: Column<string>): string }
  }
  /**
   * Convert a PascalCase string to snake_case.
   * @param str The string from snake_case to convert
   * @returns The new string in snake_case
   */
  function fromPascal(str: string): string;
  namespace fromPascal {
    namespace column { function to(str: string): string }
  }
  /**
   * Convert snake_case to and from PascalCase.
   */
   namespace pascal {
    namespace column {
      function from(str: string): string;
      function to(str: string): string;
    }
    namespace value { function from(str: unknown, column: Column<string>): string }
  }
  /**
   * Convert a snake_case string to camelCase.
   * @param str The string from snake_case to convert
   * @returns The new string in camelCase
   */
  function toCamel(str: string): string;
  namespace toCamel {
    namespace column { function from(str: string): string; }
    namespace value { function from(str: unknown, column: Column<string>): string }
  }
  /**
   * Convert a camelCase string to snake_case.
   * @param str The string from snake_case to convert
   * @returns The new string in snake_case
   */
  function fromCamel(str: string): string;
  namespace fromCamel {
    namespace column { function to(str: string): string }
  }
  /**
   * Convert snake_case to and from camelCase.
   */
  namespace camel {
    namespace column {
      function from(str: string): string;
      function to(str: string): string;
    }
    namespace value { function from(str: unknown, column: Column<string>): string }
  }
  /**
   * Convert a snake_case string to kebab-case.
   * @param str The string from snake_case to convert
   * @returns The new string in kebab-case
   */
  function toKebab(str: string): string;
  namespace toKebab {
    namespace column { function from(str: string): string; }
    namespace value { function from(str: unknown, column: Column<string>): string }
  }
  /**
   * Convert a kebab-case string to snake_case.
   * @param str The string from snake_case to convert
   * @returns The new string in snake_case
   */
  function fromKebab(str: string): string;
  namespace fromKebab {
    namespace column { function to(str: string): string }
  }
  /**
   * Convert snake_case to and from kebab-case.
   */
  namespace kebab {
    namespace column {
      function from(str: string): string;
      function to(str: string): string;
    }
    namespace value { function from(str: unknown, column: Column<string>): string }
  }

  const BigInt: PostgresType<bigint>;

  interface PostgresType<T = any> {
    to: number;
    from: number[];
    serialize: (value: T) => unknown;
    parse: (raw: any) => T;
  }

  interface ConnectionParameters {
    /**
     * Default application_name
     * @default 'postgres.js'
     */
    application_name: string;
    default_transaction_isolation: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable',
    default_transaction_read_only: boolean,
    default_transaction_deferrable: boolean,
    statement_timeout: number,
    lock_timeout: number,
    idle_in_transaction_session_timeout: number,
    idle_session_timeout: number,
    DateStyle: string,
    IntervalStyle: string,
    TimeZone: string,
    /** Other connection parameters */
    [name: string]: string | number | boolean;
  }

  interface Options<T extends Record<string, postgres.PostgresType>> extends Partial<BaseOptions<T>> {
    /** @inheritdoc */
    host?: string | undefined;
    /** @inheritdoc */
    port?: number | undefined;
    /** @inheritdoc */
    path?: string | undefined;
    /** Password of database user (an alias for `password`) */
    pass?: Options<T>['password'] | undefined;
    /**
     * Password of database user
     * @default process.env['PGPASSWORD']
     */
    password?: string | (() => string | Promise<string>) | undefined;
    /** Name of database to connect to (an alias for `database`) */
    db?: Options<T>['database'] | undefined;
    /** Username of database user (an alias for `user`) */
    username?: Options<T>['user'] | undefined;
    /** Postgres ip address or domain name (an alias for `host`) */
    hostname?: Options<T>['host'] | undefined;
    /**
     * Disable prepared mode
     * @deprecated use "prepare" option instead
     */
    no_prepare?: boolean | undefined;
    /**
     * Idle connection timeout in seconds
     * @deprecated use "idle_timeout" option instead
     */
    timeout?: Options<T>['idle_timeout'] | undefined;
  }

  interface ParsedOptions<T extends Record<string, unknown> = {}> extends BaseOptions<{ [name in keyof T]: PostgresType<T[name]> }> {
    /** @inheritdoc */
    host: string[];
    /** @inheritdoc */
    port: number[];
    /** @inheritdoc */
    pass: null;
    /** @inheritdoc */
    transform: Transform;
    serializers: Record<number, (value: any) => unknown>;
    parsers: Record<number, (value: any) => unknown>;
  }

  interface Transform {
    /** Transforms outcoming undefined values */
    undefined: any

    column: {
      /** Transform function for column names in result rows */
      from: ((column: string) => string) | undefined;
      /** Transform function for column names in interpolated values passed to tagged template literal */
      to: ((column: string) => string) | undefined;
    };
    value: {
      /** Transform function for values in result rows */
      from: ((value: any, column?: Column<string>) => any) | undefined;
      /** Transform function for interpolated values passed to tagged template literal */
      to: undefined; // (value: any) => any
    };
    row: {
      /** Transform function for entire result rows */
      from: ((row: postgres.Row) => any) | undefined;
      to: undefined; // (row: postgres.Row) => any
    };
  }

  interface Notice {
    [field: string]: string;
  }

  interface Parameter<T = SerializableParameter> extends NotAPromise {
    /**
     * PostgreSQL OID of the type
     */
    type: number;
    /**
     * Serialized value
     */
    value: string | null;
    /**
     * Raw value to serialize
     */
    raw: T | null;
  }

  interface ArrayParameter<T extends readonly any[] = readonly any[]> extends Parameter<T | T[]> {
    array: true;
  }

  interface ConnectionError extends globalThis.Error {
    code:
    | 'CONNECTION_DESTROYED'
    | 'CONNECT_TIMEOUT'
    | 'CONNECTION_CLOSED'
    | 'CONNECTION_ENDED';
    errno: this['code'];
    address: string;
    port?: number | undefined;
  }

  interface NotSupportedError extends globalThis.Error {
    code: 'MESSAGE_NOT_SUPPORTED';
    name: string;
  }

  interface GenericError extends globalThis.Error {
    code:
    | '57014' // canceling statement due to user request
    | 'NOT_TAGGED_CALL'
    | 'UNDEFINED_VALUE'
    | 'MAX_PARAMETERS_EXCEEDED'
    | 'SASL_SIGNATURE_MISMATCH'
    | 'UNSAFE_TRANSACTION';
    message: string;
  }

  interface AuthNotImplementedError extends globalThis.Error {
    code: 'AUTH_TYPE_NOT_IMPLEMENTED';
    type: number | string;
    message: string;
  }

  type Error = never
    | PostgresError
    | ConnectionError
    | NotSupportedError
    | GenericError
    | AuthNotImplementedError;

  interface ColumnInfo {
    key: number;
    name: string;
    type: number;
    parser?(raw: string): unknown;
    atttypmod: number;
  }

  interface RelationInfo {
    schema: string;
    table: string;
    columns: ColumnInfo[];
    keys: ColumnInfo[];
  }

  type ReplicationEvent =
    | { command: 'insert', relation: RelationInfo }
    | { command: 'delete', relation: RelationInfo, key: boolean }
    | { command: 'update', relation: RelationInfo, key: boolean, old: Row | null };

  interface SubscriptionHandle {
    unsubscribe(): void;
  }

  interface LargeObject {
    writable(options?: {
      highWaterMark?: number | undefined,
      start?: number | undefined
    } | undefined): Promise<Writable>;
    readable(options?: {
      highWaterMark?: number | undefined,
      start?: number | undefined,
      end?: number | undefined
    } | undefined): Promise<Readable>;

    close(): Promise<void>;
    tell(): Promise<void>;
    read(size: number): Promise<void>;
    write(buffer: Uint8Array): Promise<[{ data: Uint8Array }]>;
    truncate(size: number): Promise<void>;
    seek(offset: number, whence?: number | undefined): Promise<void>;
    size(): Promise<[{ position: bigint, size: bigint }]>;
  }

  type EscapableArray = (string | number)[]

  type Serializable = never
    | null
    | boolean
    | number
    | string
    | Date
    | Uint8Array;

  type SerializableParameter<T = never> = never
    | T
    | Serializable
    | Helper<any>
    | Parameter<any>
    | ArrayParameter
    | readonly SerializableParameter<T>[];

  type JSONValue = // using a dedicated type to detect symbols, bigints, and other non serializable types
    | null
    | string
    | number
    | boolean
    | Date // serialized as `string`
    | readonly JSONValue[]
    | { toJSON(): any } // `toJSON` called by `JSON.stringify`; not typing the return type, types definition is strict enough anyway
    | {
      readonly [prop: string | number]:
      | undefined
      | JSONValue
      | ((...args: any) => any) // serialized as `undefined`
    };

  interface Row {
    [column: string]: any;
  }

  type MaybeRow = Row | undefined;

  interface Column<T extends string> {
    name: T;
    type: number;
    table: number;
    number: number;
    parser?: ((raw: string) => unknown) | undefined;
  }

  type ColumnList<T> = (T extends string ? Column<T> : never)[];

  interface State {
    status: string;
    pid: number;
    secret: number;
  }

  interface Statement {
    /** statement unique name */
    name: string;
    /** sql query */
    string: string;
    /** parameters types */
    types: number[];
    columns: ColumnList<string>;
  }

  interface ResultMeta<T extends number | null> {
    count: T; // For tuples
    command: string;
    statement: Statement;
    state: State;
  }

  interface ResultQueryMeta<T extends number | null, U> extends ResultMeta<T> {
    columns: ColumnList<U>;
  }

  type ExecutionResult<T> = [] & ResultQueryMeta<number, keyof NonNullable<T>>;
  type ValuesRowList<T extends readonly any[]> = T[number][keyof T[number]][][] & ResultQueryMeta<T['length'], keyof T[number]>;
  type RawRowList<T extends readonly any[]> = Buffer[][] & Iterable<Buffer[][]> & ResultQueryMeta<T['length'], keyof T[number]>;
  type RowList<T extends readonly any[]> = T & Iterable<NonNullable<T[number]>> & ResultQueryMeta<T['length'], keyof T[number]>;

  interface PendingQueryModifiers<TRow extends readonly any[]> {
    simple(): this;
    readable(): Promise<Readable>;
    writable(): Promise<Writable>;

    execute(): this;
    cancel(): Promise<void>;

    /**
     * @deprecated `.stream` has been renamed to `.forEach`
     * @throws
     */
    stream(cb: (row: NonNullable<TRow[number]>, result: ExecutionResult<TRow[number]>) => void): never;
    forEach(cb: (row: NonNullable<TRow[number]>, result: ExecutionResult<TRow[number]>) => void): Promise<ExecutionResult<TRow[number]>>;

    cursor(rows?: number | undefined): AsyncIterable<NonNullable<TRow[number]>[]>;
    cursor(cb: (row: [NonNullable<TRow[number]>]) => void): Promise<ExecutionResult<TRow[number]>>;
    cursor(rows: number, cb: (rows: NonNullable<TRow[number]>[]) => void): Promise<ExecutionResult<TRow[number]>>;
  }

  interface PendingDescribeQuery extends Promise<Statement> {
  }

  interface PendingValuesQuery<TRow extends readonly MaybeRow[]> extends Promise<ValuesRowList<TRow>>, PendingQueryModifiers<TRow[number][keyof TRow[number]][][]> {
    describe(): PendingDescribeQuery;
  }

  interface PendingRawQuery<TRow extends readonly MaybeRow[]> extends Promise<RawRowList<TRow>>, PendingQueryModifiers<Buffer[][]> {
  }

  interface PendingQuery<TRow extends readonly MaybeRow[]> extends Promise<RowList<TRow>>, PendingQueryModifiers<TRow> {
    describe(): PendingDescribeQuery;
    values(): PendingValuesQuery<TRow>;
    raw(): PendingRawQuery<TRow>;
  }

  interface PendingRequest extends Promise<[] & ResultMeta<null>> { }

  interface ListenRequest extends Promise<ListenMeta> { }
  interface ListenMeta extends ResultMeta<null> {
    unlisten(): Promise<void>
  }

  interface Helper<T, U extends readonly any[] = T[]> extends NotAPromise {
    first: T;
    rest: U;
  }

  type Fragment = PendingQuery<any>

  type ParameterOrJSON<T> =
  | SerializableParameter<T>
  | JSONValue

  type ParameterOrFragment<T> =
  | SerializableParameter<T>
  | Fragment
  | Fragment[]

  interface UnsafeQueryOptions {
    cancelFence?: boolean;
    /**
     * When executes query as prepared statement.
     * @default false
     */
    prepare?: boolean | undefined;
  }

  interface ISql<TTypes extends Record<string, unknown> = {}> {
        /**
     * Query helper
     * @param first Define how the helper behave
     * @param rest Other optional arguments, depending on the helper type
     * @returns An helper object usable as tagged template parameter in sql queries
     */
    <T, K extends Rest<T>>(first: T & First<T, K, TTypes[keyof TTypes]>, ...rest: K): Return<T, K>;

    /**
     * Execute the SQL query passed as a template string. Can only be used as template string tag.
     * @param template The template generated from the template string
     * @param parameters Interpoled values of the template string
     * @returns A promise resolving to the result of your query
     */
    <T extends readonly (object | undefined)[] = Row[]>(template: TemplateStringsArray, ...parameters: readonly (ParameterOrFragment<TTypes[keyof TTypes]>)[]): PendingQuery<T>;

    types: this['typed'];
    typed: (<T>(value: T, oid: number) => Parameter<T>) & {
      [name in keyof TTypes]: (value: TTypes[name]) => postgres.Parameter<TTypes[name]>
    };

    unsafe<T extends any[] = (Row & Iterable<Row>)[]>(query: string, parameters?: (ParameterOrJSON<TTypes[keyof TTypes]>)[] | undefined, queryOptions?: UnsafeQueryOptions | undefined): PendingQuery<T>;

    notify(channel: string, payload: string): PendingRequest;

    array<T extends SerializableParameter<TTypes[keyof TTypes]>[] = SerializableParameter<TTypes[keyof TTypes]>[]>(value: T, type?: number | undefined): ArrayParameter<T>;
    file<T extends readonly any[] = Row[]>(path: string | Buffer | URL | number, options?: { cache?: boolean | undefined } | undefined): PendingQuery<T>;
    file<T extends readonly any[] = Row[]>(path: string | Buffer | URL | number, args: (ParameterOrJSON<TTypes[keyof TTypes]>)[], options?: { cache?: boolean | undefined } | undefined): PendingQuery<T>;
    json(value: JSONValue): Parameter;
  }

  interface Sql<TTypes extends Record<string, unknown> = {}> extends ISql<TTypes> {
    CLOSE: {};
    END: this['CLOSE'];
    PostgresError: typeof PostgresError;

    options: ParsedOptions<TTypes>;
    parameters: ConnectionParameters;

    end(options?: { timeout?: number | undefined } | undefined): Promise<void>;

    listen(channel: string, onnotify: (value: string) => void, onlisten?: (() => void) | undefined): ListenRequest;

    subscribe(event: string, cb: (row: Row | null, info: ReplicationEvent) => void, onsubscribe?: (() => void), onerror?: (() => any)): Promise<SubscriptionHandle>;

    largeObject(oid?: number | undefined, /** @default 0x00020000 | 0x00040000 */ mode?: number | undefined): Promise<LargeObject>;

    begin<T>(cb: (sql: TransactionSql<TTypes>) => T | Promise<T>): Promise<UnwrapPromiseArray<T>>;
    begin<T>(options: string, cb: (sql: TransactionSql<TTypes>) => T | Promise<T>): Promise<UnwrapPromiseArray<T>>;

    reserve(options?: { signal?: AbortSignal }): Promise<ReservedSql<TTypes>>
  }

  interface TransactionSql<TTypes extends Record<string, unknown> = {}> extends ISql<TTypes>  {
    discard(): void;
    savepoint<T>(cb: (sql: TransactionSql<TTypes>) => T | Promise<T>): Promise<UnwrapPromiseArray<T>>;
    savepoint<T>(name: string, cb: (sql: TransactionSql<TTypes>) => T | Promise<T>): Promise<UnwrapPromiseArray<T>>;

    prepare<T>(name: string): Promise<UnwrapPromiseArray<T>>;
  }

  interface ReservedSql<TTypes extends Record<string, unknown> = {}> extends Sql<TTypes> {
    discard(): void;
    release(): void;
  }
}

export = postgres;
