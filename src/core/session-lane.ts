/**
 * GBRA-133: the session-lane census behind doctor `session_lane_budget`. A Supabase-style pooler gives each database role a
 * fixed number of session-mode server connections (Supavisor `pool_size`), and every gbrain process on a host opens its own
 * pools: serve's ordinary pool, each process's direct pool, a sync's import workers. Nothing counted them together, so one
 * host could exhaust the lane (`EMAXCONNSESSION`) with no warning before the first refusal.
 *
 * One read-only statement over `pg_stat_activity` (no query text) counts this role's client backends in this database by
 * `application_name`. Every gbrain pool names its connections `gbrain <kind>:<pid>:<nonce8>` (db.ts), so those backends
 * are attributed to a process kind and, through the live `persistence_consumers` row of the same pid and nonce, to a host.
 * A transaction-mode pooler's server connections carry the pooler's own name, so they are counted apart (`pooler`), never
 * attributed. The limit is `GBRAIN_SESSION_LANE_LIMIT` (the pooler's per-role session limit, which Postgres cannot read)
 * or, with no pooler in front, the server's `max_connections` minus its reserved slots. Behind a pooler the count is an
 * upper bound: this role's connections that bypass the pooler (a direct `db.<ref>` host) are counted too.
 */
import type { BrainEngine } from './engine.ts';
import { isSupabasePoolerUrl } from './connection-manager.ts';

export const SESSION_LANE_LIMIT_ENV = 'GBRAIN_SESSION_LANE_LIMIT';
/** At or above this share of the limit the check warns: one more process of the usual size passes it. */
export const SESSION_LANE_WARN_RATIO = 0.8;
const POOLER_NAMES = /^(supavisor|pgbouncer|odyssey|pgcat)\b/i;
const GBRAIN_NAME = /^gbrain ([^:]+):(\d+):([0-9a-f]{0,8})$/i;

export interface SessionLaneProcess { application_name: string; kind: string; pid: number; host_id: string | null; connections: number }
export interface SessionLaneCensus {
  /** This role's client backends in this database. */
  total: number;
  /** Named by a gbrain pool, a pooler, or anything else. */
  gbrain: number; pooler: number; other: number;
  by_kind: Record<string, number>;
  by_host: Array<{ host_id: string | null; connections: number }>;
  processes: SessionLaneProcess[];
  limit: number | null;
  limit_source: 'env' | 'max_connections' | null;
  /** The backends the limit is compared with: this role's against a per-role limit (a pooler's, or the env limit), every client backend against max_connections. */
  used: number;
  behind_pooler: boolean;
}

export function sessionLaneLimitFromEnv(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[SESSION_LANE_LIMIT_ENV]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** The census from the read rows (pure: the doctor test drives it with fixed rows). */
export function summarizeSessionLane(input: { rows: Array<{ application_name: string | null; connections: number }>; owners: Array<{ pid: number; nonce: string; host_id: string }>;
  serverClients: number; serverLimit: number | null; envLimit: number | null; pooledUrl: boolean }): SessionLaneCensus {
  let gbrain = 0, pooler = 0, other = 0;
  const byKind: Record<string, number> = {};
  const processes: SessionLaneProcess[] = [];
  for (const row of input.rows) {
    const name = row.application_name ?? '';
    const match = GBRAIN_NAME.exec(name);
    if (match) {
      gbrain += row.connections;
      const kind = match[1]!, pid = Number(match[2]);
      byKind[kind] = (byKind[kind] ?? 0) + row.connections;
      const owner = input.owners.find(o => o.pid === pid && o.nonce.slice(0, 8).toLowerCase() === match[3]!.toLowerCase());
      processes.push({ application_name: name, kind, pid, host_id: owner?.host_id ?? null, connections: row.connections });
    } else if (POOLER_NAMES.test(name)) pooler += row.connections;
    else other += row.connections;
  }
  processes.sort((a, b) => b.connections - a.connections || a.application_name.localeCompare(b.application_name));
  const hosts = new Map<string | null, number>();
  for (const p of processes) hosts.set(p.host_id, (hosts.get(p.host_id) ?? 0) + p.connections);
  const total = gbrain + pooler + other;
  const behindPooler = input.pooledUrl || pooler > 0;
  const limit = input.envLimit ?? (behindPooler ? null : input.serverLimit);
  return { total, gbrain, pooler, other, by_kind: byKind,
    by_host: [...hosts].map(([host_id, connections]) => ({ host_id, connections })).sort((a, b) => b.connections - a.connections),
    processes, limit, limit_source: input.envLimit !== null ? 'env' : limit !== null ? 'max_connections' : null,
    used: behindPooler || input.envLimit !== null ? total : input.serverClients, behind_pooler: behindPooler };
}

/** Reads the census on a Postgres engine (read-only; no query text leaves the server). `urls`: the configured database URLs (a Supabase pooler among them means the limit is the pooler's). */
export async function readSessionLane(engine: BrainEngine, urls: readonly string[], env: Record<string, string | undefined> = process.env): Promise<SessionLaneCensus> {
  const rows = await engine.executeRaw<{ application_name: string | null; connections: number | string }>(
    `SELECT application_name, count(*)::int AS connections FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user AND backend_type = 'client backend' GROUP BY application_name`);
  const [server] = await engine.executeRaw<{ clients: number | string; max_connections: number | string; reserved: number | string }>(
    `SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend')::int AS clients,
      current_setting('max_connections')::int AS max_connections,
      (current_setting('superuser_reserved_connections')::int + COALESCE(NULLIF(current_setting('reserved_connections', true), '')::int, 0)) AS reserved`);
  const owners = await engine.executeRaw<{ pid: number; nonce: string; host_id: string }>(
    `SELECT pid, nonce, host_id::text AS host_id FROM persistence_consumers WHERE renewed_at > now() - interval '10 minutes'`).catch(() => []);
  return summarizeSessionLane({ rows: rows.map(row => ({ application_name: row.application_name, connections: Number(row.connections) })),
    owners: owners.map(o => ({ pid: Number(o.pid), nonce: String(o.nonce ?? ''), host_id: o.host_id })),
    serverClients: Number(server?.clients ?? 0), serverLimit: server ? Number(server.max_connections) - Number(server.reserved) : null,
    envLimit: sessionLaneLimitFromEnv(env), pooledUrl: urls.some(isSupabasePoolerUrl) });
}
