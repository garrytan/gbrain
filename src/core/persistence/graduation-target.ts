/**
 * Engine graduation target side: the two routes to the target database (main
 * and DDL/direct), the password-free target identity, the read-only target
 * probes `--plan` reports, and the nonce cross-check that proves both routes
 * reach the same database before any DDL.
 *
 * Secrets: a target URL is read from `--url` or the variable named by
 * `--url-env`; every display form and every emitted command carries the
 * redacted URL or `--url-env <VAR>`, never the password. Only the 0600
 * manifest (written by the orchestrator) stores the full URLs.
 *
 * The DDL route is resolved here once (explicit `GBRAIN_DIRECT_DATABASE_URL`,
 * otherwise the Supabase derivation, otherwise the main URL) and handed to
 * the connection manager as an explicit override, which disables its
 * automatic session-pooler fallback for this operation.
 */
import postgres from '#postgres';
import { createHash, randomInt } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { PostgresEngine } from '../postgres-engine.ts';
import { normalizeDirectUrl, isNetworkUnreachableError } from '../connection-manager.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';
import type { EmbeddingColumn, GraduationBlocker, TargetIdentity, TargetProbe, TargetRoutes, TriggerBypass } from './engine-graduation.types.ts';
import { targetAuthFailedError, targetDdlUnreachableError, targetUnsupportedError } from './graduation-errors.ts';

export type ResolvedTargetRoutes = TargetRoutes & { mainUrl: string; ddlUrl: string };

/** The env var every emitted command names instead of a literal URL. */
export const DEFAULT_TARGET_URL_ENV = 'GBRAIN_TARGET_URL';
/** Oldest server the copy and the schema are tested against. */
export const MIN_TARGET_SERVER_VERSION_NUM = 140000;
/** pgvector release that added halfvec (facts.embedding, query_cache.embedding). */
export const MIN_VECTOR_HALFVEC_VERSION = '0.7.0';

export function targetPlanArgv(routes: Pick<TargetRoutes, 'urlEnv'>, to: 'postgres' | 'supabase' = 'postgres'): string[] {
  return ['gbrain', 'migrate', '--to', to, '--url-env', routes.urlEnv ?? DEFAULT_TARGET_URL_ENV, '--plan', '--json'];
}

function parsePostgresUrl(url: string): URL {
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw targetUnsupportedError({ requirement: 'postgres_url', detail: 'the given target is not a postgres:// or postgresql:// URL', host: 'the given target' });
  }
  return new URL(url.replace(/^postgres(?:ql)?:\/\//i, 'http://'));
}

/** Display form: scheme, user, host, port and database; never the password or query parameters. */
export function redactTargetUrl(url: string): string {
  try {
    const parsed = parsePostgresUrl(url);
    const user = parsed.username ? `${decodeURIComponent(parsed.username)}@` : '';
    return `postgres://${user}${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname || '/'}`;
  } catch {
    return redactConnectionInfo(url);
  }
}

export function targetIdentity(url: string): TargetIdentity {
  const parsed = parsePostgresUrl(url);
  const host = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || '5432');
  const user = decodeURIComponent(parsed.username || '');
  const database = decodeURIComponent((parsed.pathname || '/').replace(/^\//, '')) || user;
  const id = createHash('sha256').update(JSON.stringify([host, port, database, user])).digest('hex');
  return { id, host, port, database, user };
}

export function resolveTargetRoutes(opts: { url?: string; urlEnv?: string; env?: NodeJS.ProcessEnv }): ResolvedTargetRoutes {
  const env = opts.env ?? process.env;
  if (opts.url && opts.urlEnv) {
    throw targetUnsupportedError({ requirement: 'one_target', detail: 'both --url and --url-env were given; pass the target once, preferably as --url-env <VAR>', host: 'the given target', spelling: { urlEnv: opts.urlEnv } });
  }
  const mainUrl = opts.urlEnv ? env[opts.urlEnv] : opts.url;
  if (!mainUrl) {
    const urlEnv = opts.urlEnv ?? DEFAULT_TARGET_URL_ENV;
    throw targetUnsupportedError({ requirement: 'target_url', detail: opts.urlEnv ? `${opts.urlEnv} is not set; it must hold the target Postgres URL` : `no target URL was given; set ${urlEnv} to it and pass --url-env ${urlEnv}`, host: 'the target', spelling: { urlEnv } });
  }
  parsePostgresUrl(mainUrl);
  const ddlUrl = normalizeDirectUrl(mainUrl, env.GBRAIN_DIRECT_DATABASE_URL || null) ?? mainUrl;
  parsePostgresUrl(ddlUrl);
  return { main: redactTargetUrl(mainUrl), ddl: redactTargetUrl(ddlUrl), ...(opts.urlEnv ? { urlEnv: opts.urlEnv } : {}), mainUrl, ddlUrl };
}

function classifyConnectError(error: unknown): { reachable: boolean; auth: boolean; error: { code: string; message: string } } {
  const code = String((error as { code?: unknown } | null)?.code ?? 'connect_failed');
  const message = redactConnectionInfo(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200);
  if (code === '28P01' || code === '28000') return { reachable: true, auth: false, error: { code, message } };
  if (isNetworkUnreachableError(error) || code === 'connect_failed') return { reachable: false, auth: false, error: { code, message } };
  return { reachable: true, auth: true, error: { code, message } };
}

function probeClient(url: string, timeoutSeconds: number) {
  return postgres(url, { max: 1, prepare: false, connect_timeout: timeoutSeconds, idle_timeout: 1, onnotice: () => {} });
}

function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map(n => Number.parseInt(n, 10) || 0);
  const b = min.split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Tables a fresh initSchema seeds, and the most rows the seed leaves in each. */
const SEED_ROW_LIMITS: Readonly<Record<string, number>> = {
  op_checkpoints: 1, page_generation_clock: 1, persistence_brain: 1, shared_skill_state: 1, sources: 1,
};
/** Each engine's own schema writes these; they never count against emptiness. */
const SCHEMA_OWNED_TABLES = new Set(['config', 'file_migration_ledger', 'persistence_graduation']);

/**
 * A target counts as empty when it has no public tables, or a gbrain schema whose
 * tables hold only the initSchema seed rows (config, the `default` source, the
 * disabled persistence identity and the singleton clocks). Read-only.
 */
export async function targetEmptiness(query: Query): Promise<{ empty: boolean; nonEmptyTables: string[]; gbrainSchema: boolean }> {
  const tables = await query<{ name: string; ident: string }>(`SELECT c.relname AS name, quote_ident(c.relname) AS ident
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`);
  const nonEmptyTables: string[] = [];
  for (const table of tables) {
    if (SCHEMA_OWNED_TABLES.has(table.name)) continue;
    const limit = SEED_ROW_LIMITS[table.name] ?? 0;
    const [row] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT 1 FROM ${table.ident} LIMIT ${limit + 1}) s`);
    if (Number(row?.n ?? 0) > limit) { nonEmptyTables.push(table.name); continue; }
    if (table.name === 'sources' && Number(row?.n) === 1) {
      const [seed] = await query<{ ok: boolean }>(`SELECT bool_and(id = 'default') AS ok FROM sources`);
      if (!seed?.ok) nonEmptyTables.push(table.name);
    }
    if (table.name === 'persistence_brain' && Number(row?.n) === 1) {
      const [seed] = await query<{ ok: boolean }>('SELECT bool_and(NOT enabled) AS ok FROM persistence_brain');
      if (!seed?.ok) nonEmptyTables.push(table.name);
    }
  }
  return { empty: nonEmptyTables.length === 0, nonEmptyTables, gbrainSchema: tables.some(t => t.name === 'config') };
}

/** Every vector/halfvec column in the public schema with its dimension. Read-only; works on both engines. */
export async function embeddingColumns(query: Query): Promise<EmbeddingColumn[]> {
  const rows = await query<{ relation: string; column: string; type: string; dims: number | null }>(`SELECT c.relname AS relation, a.attname AS column,
      format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.atttypmod > 0 THEN a.atttypmod ELSE NULL END AS dims
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND t.typname IN ('vector', 'halfvec')
    ORDER BY c.relname, a.attname`);
  return rows.map(r => ({ relation: r.relation, column: r.column, type: r.type, dims: r.dims === null ? null : Number(r.dims) }));
}

/**
 * The source's effective embedding layout, which sizes the target schema:
 * every vector/halfvec column with its typmod plus the embedding config rows
 * (model, dimensions and the embedding-column registry).
 */
export async function sourceEmbeddingLayout(source: BrainEngine): Promise<{ columns: EmbeddingColumn[]; config: Record<string, string> }> {
  const query: Query = (sql, params) => source.executeRaw(sql, params);
  const rows = await source.executeRaw<{ key: string; value: string }>(
    `SELECT key, value FROM config WHERE key IN ('embedding_model', 'embedding_dimensions', 'embedding_columns', 'search_embedding_column') ORDER BY key`);
  return { columns: await embeddingColumns(query), config: Object.fromEntries(rows.map(r => [r.key, r.value])) };
}

/** Columns whose type differs between the source layout and an existing target schema. */
export function embeddingLayoutMismatches(source: readonly EmbeddingColumn[], target: readonly EmbeddingColumn[]): Array<{ relation: string; column: string; source: string; target: string }> {
  const byKey = new Map(target.map(c => [`${c.relation}.${c.column}`, c]));
  return source.flatMap(c => {
    const other = byKey.get(`${c.relation}.${c.column}`);
    return other && other.type !== c.type ? [{ relation: c.relation, column: c.column, source: c.type, target: other.type }] : [];
  });
}

/**
 * Read-only probes of the target, through one session per route: reachability
 * and authentication on both routes, server version, the `vector` extension
 * (installed or available, with halfvec), CREATE privilege, whether
 * `session_replication_role = replica` is permitted (otherwise the copy needs
 * table ownership for DISABLE TRIGGER), emptiness and existing embedding
 * columns. Every query runs inside a READ ONLY transaction; nothing is created.
 */
export async function probeTarget(routes: ResolvedTargetRoutes, opts: { timeoutSeconds?: number } = {}): Promise<TargetProbe> {
  const timeout = opts.timeoutSeconds ?? 10;
  const probe: TargetProbe = {
    reachable: false, auth: false, ddl: { reachable: false, auth: false }, serverVersion: null, serverVersionNum: null,
    vector: { installed: null, available: null, halfvec: false }, createPrivilege: { database: false, schema: false },
    replicaRole: false, ownsTables: false, triggerBypass: null, gbrainSchema: false, empty: false, nonEmptyTables: [],
    embeddingColumns: [], otherSessions: 0,
  };
  const main = probeClient(routes.mainUrl, timeout);
  try {
    await main.begin('read only', async tx => {
      const query: Query = async <T>(sql: string, params: unknown[] = []) => await tx.unsafe(sql, params as never[]) as unknown as T[];
      probe.reachable = true; probe.auth = true;
      const [server] = await query<{ version: string; num: string; db_create: boolean; schema_create: boolean; sessions: number }>(`SELECT
          current_setting('server_version') AS version, current_setting('server_version_num') AS num,
          has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
          has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) AS sessions`);
      probe.serverVersion = server!.version;
      probe.serverVersionNum = Number(server!.num);
      probe.createPrivilege = { database: server!.db_create === true, schema: server!.schema_create === true };
      probe.otherSessions = Number(server!.sessions);
      const [vector] = await query<{ installed: string | null; available: string | null }>(`SELECT
          (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS installed,
          (SELECT default_version FROM pg_available_extensions WHERE name = 'vector') AS available`);
      probe.vector = { installed: vector?.installed ?? null, available: vector?.available ?? null,
        halfvec: versionAtLeast(vector?.installed ?? vector?.available ?? null, MIN_VECTOR_HALFVEC_VERSION) };
      const [owned] = await query<{ ok: boolean }>(`SELECT COALESCE(bool_and(pg_has_role(current_user, c.relowner, 'USAGE')), true) AS ok
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
      probe.ownsTables = owned?.ok === true;
      const [role] = await query<{ name: string; superuser: boolean; bypass: boolean; trigger: boolean; owner: string | null }>(`SELECT current_user AS name,
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
          EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) AS bypass,
          EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'auto_rls_on_create_table') AS trigger,
          (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'auto_enable_rls' LIMIT 1) AS owner`);
      probe.role = { name: role!.name, superuser: role!.superuser === true, bypassRls: role!.bypass === true };
      probe.autoRls = { eventTrigger: role!.trigger === true, functionOwner: role!.owner ?? null };
      Object.assign(probe, await targetEmptiness(query));
      probe.embeddingColumns = await embeddingColumns(query);
      await query('SAVEPOINT gbrain_replica_probe');
      try { await query('SET LOCAL session_replication_role = replica'); probe.replicaRole = true; }
      catch { probe.replicaRole = false; }
      await query('ROLLBACK TO SAVEPOINT gbrain_replica_probe');
    });
  } catch (error) {
    if (!probe.reachable) Object.assign(probe, classifyConnectError(error));
    else probe.error = classifyConnectError(error).error;
  } finally {
    await main.end({ timeout: 1 }).catch(() => {});
  }
  probe.triggerBypass = probe.replicaRole ? 'session_replication_role' : probe.ownsTables && probe.createPrivilege.schema ? 'disable_trigger' : null;
  if (routes.ddlUrl === routes.mainUrl) {
    probe.ddl = { reachable: probe.reachable, auth: probe.auth, ...(probe.error ? { error: probe.error } : {}) };
    return probe;
  }
  const ddl = probeClient(routes.ddlUrl, timeout);
  try {
    await ddl.begin('read only', async tx => { await tx.unsafe('SELECT 1'); });
    probe.ddl = { reachable: true, auth: true };
  } catch (error) {
    probe.ddl = classifyConnectError(error);
  } finally {
    await ddl.end({ timeout: 1 }).catch(() => {});
  }
  return probe;
}

/**
 * Plan blockers from a probe: every unmet target prerequisite, a non-empty
 * target, and embedding columns whose existing type differs from the source
 * layout. Unreachable routes and failed authentication are raised by
 * `assertTargetReachable` instead, because nothing else can be measured then.
 */
export function targetProbeBlockers(probe: TargetProbe, routes: Pick<TargetRoutes, 'urlEnv' | 'main'>, sourceColumns: readonly EmbeddingColumn[] = []): GraduationBlocker[] {
  const argv = targetPlanArgv(routes);
  const unsupported = (id: string, detail: string): GraduationBlocker => ({ kind: 'target_unsupported', id, detail, argv, needsUser: true });
  const blockers: GraduationBlocker[] = [];
  if (probe.serverVersionNum !== null && probe.serverVersionNum < MIN_TARGET_SERVER_VERSION_NUM) {
    blockers.push(unsupported('server_version', `server ${probe.serverVersion} is older than PostgreSQL 14`));
  }
  if (!probe.vector.installed && !probe.vector.available) blockers.push(unsupported('vector_extension', 'the vector extension is neither installed nor available'));
  else if (!probe.vector.halfvec) blockers.push(unsupported('vector_halfvec', `vector ${probe.vector.installed ?? probe.vector.available} predates halfvec (needs ${MIN_VECTOR_HALFVEC_VERSION} or newer)`));
  if (!probe.createPrivilege.schema) blockers.push(unsupported('create_privilege', `role cannot CREATE in schema public on ${routes.main}`));
  const superuser = probe.role?.superuser === true;
  const role = probe.role ? `"${probe.role.name.replace(/"/g, '""')}"` : 'CURRENT_USER';
  if (!probe.vector.installed && (!probe.createPrivilege.database || (probe.role && !superuser))) {
    blockers.push(unsupported('vector_extension', 'the vector extension is not installed and only a superuser can install it; a DBA runs in the target database: CREATE EXTENSION IF NOT EXISTS vector;'));
  }
  if (probe.role && !superuser && !probe.role.bypassRls) {
    blockers.push(unsupported('bypassrls', `role ${probe.role.name} lacks BYPASSRLS, which the schema's RLS backfill needs; a DBA runs: ALTER ROLE ${role} BYPASSRLS;`));
  }
  if (probe.autoRls && !superuser && !probe.autoRls.eventTrigger) {
    blockers.push(unsupported('auto_rls_event_trigger', `the auto-RLS event trigger is missing and only a superuser can create it; a DBA runs in the target database: ${AUTO_RLS_DBA_SQL(role)}`));
  } else if (probe.autoRls && !superuser && probe.autoRls.functionOwner && probe.role && probe.autoRls.functionOwner !== probe.role.name) {
    blockers.push(unsupported('auto_rls_owner', `public.auto_enable_rls() is owned by ${probe.autoRls.functionOwner}, so schema setup fails with "must be owner of function"; a DBA runs: ALTER FUNCTION public.auto_enable_rls() OWNER TO ${role};`));
  }
  if (!probe.triggerBypass) blockers.push(unsupported('trigger_bypass', 'the role may neither set session_replication_role = replica nor owns the existing tables (needed for DISABLE TRIGGER)'));
  if (!probe.empty) blockers.push({ kind: 'target_not_empty', id: 'target', detail: `target already holds rows in ${probe.nonEmptyTables.slice(0, 10).join(', ')}`, argv, needsUser: true });
  for (const m of embeddingLayoutMismatches(sourceColumns, probe.embeddingColumns)) {
    blockers.push({ kind: 'embedding_dimension', id: `${m.relation}.${m.column}`, detail: `source ${m.source}, target ${m.target}`, argv, needsUser: true });
  }
  return blockers;
}

/** What a DBA runs once on a target whose gbrain role is not a superuser (the v35 objects, owned by that role). */
function AUTO_RLS_DBA_SQL(role: string): string {
  return `CREATE OR REPLACE FUNCTION public.auto_enable_rls() RETURNS event_trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $f$ DECLARE obj record; BEGIN FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE object_type = 'table' AND schema_name = 'public' LOOP EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity); END LOOP; END; $f$; `
    + `ALTER FUNCTION public.auto_enable_rls() OWNER TO ${role}; `
    + `CREATE EVENT TRIGGER auto_rls_on_create_table ON ddl_command_end WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') EXECUTE FUNCTION public.auto_enable_rls();`;
}

/** Throws the typed refusal when either route is unreachable or refuses authentication. */
export function assertTargetReachable(probe: TargetProbe, routes: Pick<TargetRoutes, 'urlEnv' | 'main' | 'ddl'>): void {
  const spelling = routes.urlEnv ? { urlEnv: routes.urlEnv } : {};
  if (probe.reachable && !probe.auth) throw targetAuthFailedError({ host: routes.main, ...(routes.urlEnv ? { urlEnv: routes.urlEnv } : {}) });
  if (!probe.reachable) {
    throw targetUnsupportedError({ requirement: 'reachable', detail: `the server is unreachable (${probe.error?.code ?? 'unreachable'}: ${probe.error?.message ?? 'no detail'})`, host: routes.main, spelling });
  }
  if (probe.serverVersion === null) {
    throw targetUnsupportedError({ requirement: 'probe', detail: `the probe session failed (${probe.error?.code ?? 'unknown'}: ${probe.error?.message ?? 'no detail'})`, host: routes.main, spelling });
  }
  if (!probe.ddl.reachable || !probe.ddl.auth) throw targetDdlUnreachableError({ host: routes.main, ddlHost: routes.ddl, spelling });
}

/**
 * Proves the main and DDL engines reach the same database before any DDL: the
 * DDL route takes a transaction-scoped advisory lock keyed by a fresh nonce
 * for this run, and the main route must read that exact lock row (same
 * backend pid, same database) from pg_locks while it is held. A transaction
 * lock works through any pooler mode and leaves nothing behind.
 */
export async function crossCheckRoutes(main: BrainEngine, ddl: BrainEngine, runId: string): Promise<void> {
  const keys = [randomInt(1, 2 ** 31 - 1), randomInt(1, 2 ** 31 - 1)];
  const refuse = (detail: string) => {
    const error = targetDdlUnreachableError({ host: 'the main connection', ddlHost: 'the DDL connection' });
    error.detail = `Run ${runId}: ${detail}`;
    error.why = `Run ${runId}: ${detail}. ${error.why ?? ''}`.trim();
    return error;
  };
  let seen: boolean;
  try {
    seen = await ddl.transaction(async tx => {
      await tx.executeRaw('SELECT 1 FROM (SELECT pg_advisory_xact_lock($1::int4, $2::int4)) AS nonce', keys);
      const [held] = await tx.executeRaw<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const [row] = await main.executeRaw<{ seen: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted AND l.pid = $1::int AND l.classid = $2::oid AND l.objid = $3::oid AND l.objsubid = 2
            AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS seen`, [held!.pid, keys[0], keys[1]]);
      return row?.seen === true;
    });
  } catch (error) {
    throw refuse(`the cross-check failed (${redactConnectionInfo(error instanceof Error ? error.message : String(error)).slice(0, 160)})`);
  }
  if (!seen) throw refuse('the nonce lock taken through the DDL route is not visible through the main route');
}

/**
 * Connects the main and DDL target engines with the DDL route as an explicit
 * override, so the connection manager never derives another route or falls
 * back to the session pooler on its own. The override is read when each
 * engine's connection manager is built inside `connect()`.
 */
export async function connectTargetEngines(routes: ResolvedTargetRoutes, opts: { poolSize?: number } = {}): Promise<{ main: PostgresEngine; ddl: PostgresEngine; close(): Promise<void> }> {
  const prior = process.env.GBRAIN_DIRECT_DATABASE_URL;
  const main = new PostgresEngine();
  const ddl = new PostgresEngine();
  process.env.GBRAIN_DIRECT_DATABASE_URL = routes.ddlUrl;
  try {
    await main.connect({ database_url: routes.mainUrl, poolSize: opts.poolSize ?? 4 });
    await ddl.connect({ database_url: routes.ddlUrl, poolSize: 2 });
  } catch (error) {
    await Promise.allSettled([main.disconnect(), ddl.disconnect()]);
    throw error;
  } finally {
    if (prior === undefined) delete process.env.GBRAIN_DIRECT_DATABASE_URL; else process.env.GBRAIN_DIRECT_DATABASE_URL = prior;
  }
  return { main, ddl, close: async () => { await Promise.allSettled([main.disconnect(), ddl.disconnect()]); } };
}

/** Which bypass a probe allows; `forced` is the `--trigger-bypass` escape hatch and must be permitted. */
export function chooseTriggerBypass(probe: Pick<TargetProbe, 'replicaRole' | 'triggerBypass'>, forced?: TriggerBypass): TriggerBypass | null {
  if (forced === 'session_replication_role') return probe.replicaRole ? forced : null;
  if (forced === 'disable_trigger') return forced;
  return probe.triggerBypass;
}
