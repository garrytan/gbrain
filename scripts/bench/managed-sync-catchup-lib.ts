/**
 * Helpers for scripts/bench/managed-sync-catchup.ts: the Docker Postgres
 * (pg_stat_statements) and toxiproxy latency harness, the stub OpenAI
 * embeddings server, the pg_locks sampler and the SQL-trace analysis.
 * Every helper binds loopback only.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import postgres from '#postgres';

export type Sql = ReturnType<typeof postgres>;
/** Prefix on every statement the bench itself sends to a measured database, so pg_stat_statements totals exclude it. */
export const BENCH_SQL = '/* gbrain-bench */';
export const round1 = (n: number) => Math.round(n * 10) / 10;
export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return round1(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
}
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function docker(args: string[], allowFail = false): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}

export interface Harness { adminUrl: string; proxyUrl: (db: string) => string; directUrl: (db: string) => string; setRtt: (ms: number) => Promise<void>; stop: () => void;
  /** The transaction-mode pooler between toxiproxy and Postgres, when one was asked for. */
  pooler: Record<string, unknown> | null }

/** PgBouncer for `--pooler pgbouncer`, pinned by digest (PgBouncer 1.26.0). */
export const PGBOUNCER_IMAGE = 'edoburu/pgbouncer@sha256:9c78945868a6a142c7fc40ccd843bbe5a606df163c7ffce4de70e0d628d696a2';
const PGBOUNCER_POOL = { POOL_MODE: 'transaction', DEFAULT_POOL_SIZE: '50', MAX_CLIENT_CONN: '2000', IGNORE_STARTUP_PARAMETERS: 'extra_float_digits,options,statement_timeout,idle_in_transaction_session_timeout' };

/**
 * Starts (or reuses) `gbrain-bench-pg` (pgvector + pg_stat_statements) and
 * `gbrain-bench-toxiproxy` (host network, loopback listeners). With an
 * explicit admin URL only toxiproxy is started, in front of that server.
 * With `poolerPort`, a transaction-mode `gbrain-bench-pgbouncer` (host network,
 * loopback, recreated each run) sits between toxiproxy and Postgres, so the
 * RTT stays on the client side of the pooler. It ignores the session-timeout
 * startup parameters gbrain sends, which stock PgBouncer refuses.
 */
export async function startHarness(opts: { pgPort: number; proxyPort: number; apiPort: number; adminUrl?: string; keep: boolean; poolerPort?: number }): Promise<Harness> {
  const started: string[] = [];
  let upstreamHost = '127.0.0.1';
  let upstreamPort = opts.pgPort;
  let adminUrl = opts.adminUrl;
  if (!adminUrl) {
    if (!docker(['ps', '-q', '-f', 'name=^gbrain-bench-pg$'])) {
      docker(['rm', '-f', 'gbrain-bench-pg'], true);
      docker(['run', '-d', '--name', 'gbrain-bench-pg', '-p', `127.0.0.1:${opts.pgPort}:5432`, '-e', 'POSTGRES_PASSWORD=postgres',
        '--shm-size=1g', 'pgvector/pgvector:pg16', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'max_connections=400',
        '-c', 'pg_stat_statements.max=10000', '-c', 'fsync=on']);
      started.push('gbrain-bench-pg');
    }
    adminUrl = `postgresql://postgres:postgres@127.0.0.1:${opts.pgPort}/postgres`;
  } else {
    const u = new URL(adminUrl.replace(/^postgres(ql)?:/, 'http:'));
    upstreamHost = u.hostname; upstreamPort = Number(u.port || 5432);
  }
  if (!docker(['ps', '-q', '-f', 'name=^gbrain-bench-toxiproxy$'])) {
    docker(['rm', '-f', 'gbrain-bench-toxiproxy'], true);
    docker(['run', '-d', '--name', 'gbrain-bench-toxiproxy', '--network', 'host', 'ghcr.io/shopify/toxiproxy:2.12.0', '-host', '127.0.0.1', '-port', String(opts.apiPort)]);
    started.push('gbrain-bench-toxiproxy');
  }
  let pooler: Harness['pooler'] = null;
  if (opts.poolerPort) {
    const admin = new URL(adminUrl);
    docker(['rm', '-f', 'gbrain-bench-pgbouncer'], true);
    const env = { DB_HOST: upstreamHost, DB_PORT: String(upstreamPort), DB_USER: decodeURIComponent(admin.username), DB_PASSWORD: decodeURIComponent(admin.password),
      AUTH_TYPE: 'scram-sha-256', LISTEN_ADDR: '127.0.0.1', LISTEN_PORT: String(opts.poolerPort), ...PGBOUNCER_POOL };
    docker(['run', '-d', '--name', 'gbrain-bench-pgbouncer', '--network', 'host', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), PGBOUNCER_IMAGE]);
    started.push('gbrain-bench-pgbouncer');
    for (let i = 0; ; i++) {
      try {
        const viaPooler = new URL(adminUrl); viaPooler.hostname = '127.0.0.1'; viaPooler.port = String(opts.poolerPort);
        const probe = postgres(viaPooler.toString(), { max: 1, onnotice: () => {}, connect_timeout: 2, prepare: false });
        await probe`SELECT 1`; await probe.end();
        break;
      } catch (error) { if (i > 60) throw error; }
      await Bun.sleep(1000);
    }
    pooler = { kind: 'pgbouncer', image: PGBOUNCER_IMAGE, listen: `127.0.0.1:${opts.poolerPort}`, ...Object.fromEntries(Object.entries(PGBOUNCER_POOL).map(([k, v]) => [k.toLowerCase(), v])) };
    upstreamHost = '127.0.0.1'; upstreamPort = opts.poolerPort;
  }
  const api = `http://127.0.0.1:${opts.apiPort}`;
  for (let i = 0; ; i++) {
    try {
      const probe = postgres(adminUrl, { max: 1, onnotice: () => {}, connect_timeout: 2 });
      await probe`SELECT 1`; await probe.end();
      if ((await fetch(`${api}/version`)).ok) break;
    } catch (error) { if (i > 60) throw error; }
    await Bun.sleep(1000);
  }
  const proxy = `pg-${opts.proxyPort}`;
  await fetch(`${api}/proxies/${proxy}`, { method: 'DELETE' });
  const created = await fetch(`${api}/proxies`, { method: 'POST', body: JSON.stringify({ name: proxy, listen: `127.0.0.1:${opts.proxyPort}`, upstream: `${upstreamHost}:${upstreamPort}`, enabled: true }) });
  if (!created.ok) throw new Error(`toxiproxy proxy create failed: ${await created.text()}`);
  const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
  const proxied = new URL(adminUrl); proxied.hostname = '127.0.0.1'; proxied.port = String(opts.proxyPort);
  return {
    adminUrl, pooler,
    directUrl: db => withDb(adminUrl!, db),
    proxyUrl: db => withDb(proxied.toString(), db),
    async setRtt(ms: number) {
      for (const stream of ['upstream', 'downstream']) {
        await fetch(`${api}/proxies/${proxy}/toxics/lat_${stream}`, { method: 'DELETE' });
        if (ms <= 0) continue;
        const r = await fetch(`${api}/proxies/${proxy}/toxics`, { method: 'POST', body: JSON.stringify({ name: `lat_${stream}`, type: 'latency', stream,
          toxicity: 1, attributes: { latency: Math.round(ms / 2), jitter: 0 } }) });
        if (!r.ok) throw new Error(`toxiproxy toxic failed: ${await r.text()}`);
      }
    },
    stop() {
      void fetch(`${api}/proxies/${proxy}`, { method: 'DELETE' }).catch(() => undefined);
      if (!opts.keep) for (const name of started) docker(['rm', '-f', name], true);
    },
  };
}

/** Measures the harness round trip: median of 20 `SELECT 1` through the proxy on one connection (unprepared behind a transaction-mode pooler). */
export async function measureRtt(url: string, prepare = true): Promise<number> {
  const sql = postgres(url, { max: 1, onnotice: () => {}, prepare });
  try {
    await sql`SELECT 1`;
    const xs: number[] = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); await sql.unsafe(`${BENCH_SQL} SELECT 1`).simple(); xs.push(performance.now() - t); }
    return pct(xs, 50)!;
  } finally { await sql.end(); }
}

/** A loopback OpenAI `/v1/embeddings` stub: fixed latency, a concurrency cap answered with 429 + retry-after, deterministic vectors. */
export function startEmbeddingStub(opts: { latencyMs: number; maxConcurrent: number; dims: number }): Promise<{ url: string; stats: { calls: number; inputs: number; limited: number }; close: () => void }> {
  const stats = { calls: 0, inputs: 0, limited: 0 };
  let active = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      if (!req.url?.endsWith('/embeddings')) { res.writeHead(404).end(); return; }
      if (active >= opts.maxConcurrent) {
        stats.limited++;
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '500', 'retry-after': '1' })
          .end(JSON.stringify({ error: { message: 'Rate limit reached (bench stub)', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
        return;
      }
      active++;
      try {
        const parsed = JSON.parse(body || '{}') as { input?: string | string[]; dimensions?: number; model?: string };
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
        const dims = parsed.dimensions ?? opts.dims;
        stats.calls++; stats.inputs += inputs.length;
        await Bun.sleep(opts.latencyMs);
        const data = inputs.map((text, index) => {
          const v = new Array<number>(dims).fill(0);
          for (let i = 0; i < String(text).length; i++) v[(String(text).charCodeAt(i) * 31 + i) % dims] += 1;
          const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
          return { object: 'embedding', index, embedding: v.map(x => x / norm) };
        });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data, model: parsed.model ?? 'stub',
          usage: { prompt_tokens: inputs.length * 50, total_tokens: inputs.length * 50 } }));
      } finally { active--; }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    resolve({ url: `http://127.0.0.1:${port}/v1`, stats, close: () => server.close() });
  }));
}

export interface LockSample { t: number; waiting_app: string; waiting_query: string; wait_ms: number; blocker_app: string; blocker_state: string; blocker_query: string; blocker_xact_ms: number }

/** Samples lock waits in `db` every `everyMs` from an admin connection (not proxied, not traced). */
export function startLockSampler(adminUrl: string, db: string, everyMs = 100): { stop: () => Promise<LockSample[]> } {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const samples: LockSample[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const rows = await sql.unsafe(`${BENCH_SQL} SELECT w.application_name AS waiting_app, left(w.query, 400) AS waiting_query,
            (extract(epoch FROM clock_timestamp() - w.query_start) * 1000)::float8 AS wait_ms,
            coalesce(b.application_name,'') AS blocker_app, coalesce(b.state,'') AS blocker_state, left(coalesce(b.query,''), 400) AS blocker_query,
            coalesce((extract(epoch FROM clock_timestamp() - b.xact_start) * 1000)::float8, 0) AS blocker_xact_ms
          FROM pg_stat_activity w CROSS JOIN LATERAL unnest(pg_blocking_pids(w.pid)) AS bp(pid)
          LEFT JOIN pg_stat_activity b ON b.pid = bp.pid
          WHERE w.datname = $1 AND w.wait_event_type = 'Lock'`, [db]);
        const t = Date.now();
        for (const r of rows) samples.push({ t, ...(r as unknown as Omit<LockSample, 't'>) });
      } catch { /* sampling is best effort */ }
      await Bun.sleep(everyMs);
    }
  })();
  return { async stop() { running = false; await loop; await sql.end(); return samples; } };
}

/**
 * Effect kinds whose execution takes the native worktree lock (`acquireWorktree`
 * in src/core/persistence/effects.ts): git (also record-only, briefly, and its
 * group commit and push) and withdrawal-mirror, when the effect has a worktree.
 * embedding and facts-backstop never take it.
 */
export const WORKTREE_LOCK_KINDS = new Set(['git', 'withdrawal-mirror']);

/** Samples the queued + running effects backlog every `everyMs` (direct connection to the row's database, BENCH_SQL-tagged). */
export function startEffectsSampler(url: string, everyMs = 2000): { stop: () => Promise<number[]> } {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const samples: number[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try { samples.push(Number((await sql.unsafe(`${BENCH_SQL} SELECT count(*) FILTER (WHERE state IN ('queued','running'))::int AS n FROM persistence_effects`))[0]!.n)); }
      catch { /* sampling is best effort */ }
      await Bun.sleep(everyMs);
    }
  })();
  return { async stop() { running = false; await loop; await sql.end(); return samples; } };
}

/**
 * Effects of the managed-sync page requests admitted since `since` (all publish
 * database-only here) per group (`intent->>'group'`, else the request alone),
 * and every effect of the window's requests by kind (`sync_effects` = the
 * managed-sync share) with whether the kind needs the worktree lock.
 */
export async function readEffects(sql: Sql, since: Date): Promise<Record<string, unknown>> {
  const sync = "r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')";
  const groups = await sql.unsafe(`${BENCH_SQL} SELECT COALESCE(r.intent->>'group', r.id::text) AS grp, count(DISTINCT r.id)::int AS requests, count(e.id)::int AS effects
    FROM persistence_requests r LEFT JOIN persistence_effects e ON e.request_id=r.id WHERE r.created_at >= $1 AND ${sync} GROUP BY 1`, [since]) as unknown as Array<{ requests: number; effects: number }>;
  const kinds = await sql.unsafe(`${BENCH_SQL} SELECT e.kind, e.state, (e.worktree_id IS NOT NULL) AS worktree, (${sync}) AS sync, count(*)::int AS n
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.created_at >= $1 GROUP BY 1,2,3,4`, [since]) as unknown as Array<{ kind: string; state: string; worktree: boolean; sync: boolean; n: number }>;
  const compacted = Number((await sql.unsafe(`${BENCH_SQL} SELECT count(*)::int AS n FROM persistence_requests WHERE created_at >= $1 AND compacted`, [since]))[0]!.n);
  const byKind: Record<string, { effects: number; sync_effects: number; with_worktree: number; needs_worktree_lock: boolean; by_state: Record<string, number> }> = {};
  for (const k of kinds) {
    const entry = byKind[k.kind] ??= { effects: 0, sync_effects: 0, with_worktree: 0, needs_worktree_lock: false, by_state: {} };
    entry.effects += k.n;
    if (k.sync) entry.sync_effects += k.n;
    if (k.worktree) entry.with_worktree += k.n;
    entry.needs_worktree_lock ||= WORKTREE_LOCK_KINDS.has(k.kind) && k.worktree;
    entry.by_state[k.state] = (entry.by_state[k.state] ?? 0) + k.n;
  }
  const perGroup = groups.map(g => g.effects);
  return { groups: groups.length, requests: sum(groups.map(g => g.requests)), effects: sum(perGroup), compacted_requests: compacted,
    effects_per_group: { mean: groups.length ? round1(sum(perGroup) / groups.length) : null, p50: pct(perGroup, 50), max: pct(perGroup, 100) },
    effects_per_request: groups.length ? round1(sum(perGroup) / Math.max(1, sum(groups.map(g => g.requests)))) : null,
    by_kind: byKind };
}

export interface TraceRecord { t: number; ms: number; pid: number; label: string; pool: string; conn: number; backend: number; kind: string; sql: string; err?: string }

/** Reads a trace, interning statement text so a multi-million-record trace keeps one copy of each statement. */
export function readTrace(file: string, keep: (r: TraceRecord) => boolean = () => true): TraceRecord[] {
  if (!existsSync(file)) return [];
  const interned = new Map<string, string>();
  const out: TraceRecord[] = [];
  const text = readFileSync(file, 'utf8');
  for (let at = 0; at < text.length;) {
    const end = text.indexOf('\n', at);
    const line = text.slice(at, end < 0 ? text.length : end);
    at = end < 0 ? text.length : end + 1;
    if (!line) continue;
    const r = JSON.parse(line) as TraceRecord;
    if (!keep(r)) continue;
    const sql = interned.get(r.sql);
    if (sql === undefined) interned.set(r.sql, r.sql); else r.sql = sql;
    out.push(r);
  }
  return out;
}

const memo = <T>(fn: (s: string) => T): ((s: string) => T) => {
  const cache = new Map<string, T>();
  return s => { let v = cache.get(s); if (v === undefined) { v = fn(s); cache.set(s, v); } return v; };
};

/** Normalizes a statement for grouping: whitespace collapsed, literals and IN-lists folded, cut to 160 chars. */
export const normalizeSql = memo((sql: string): string => {
  return sql.replace(/\s+/g, ' ').replace(/'(?:[^']|'')*'/g, "'?'").replace(/\b\d+\b/g, 'N').replace(/\$\d+/g, '$n').trim().slice(0, 160);
});
/** Whitespace-collapsed statement text, memoized. */
export const flatSql = memo((sql: string) => sql.replace(/\s+/g, ' ').trim());

/** Process family from a trace label: `cli-sync`, `serve`, `reentry`, `foreground`, ... */
export const family = memo((label: string) => label.replace(/[:#].*$/, ''));

export interface StatementGroup { sql: string; count: number; total_ms: number; per_page: number; by_process: Record<string, number> }
export function groupStatements(records: TraceRecord[], pages: number, top = 40): StatementGroup[] {
  const groups = new Map<string, StatementGroup>();
  for (const r of records) {
    const key = r.kind === 'describe' ? `[describe] ${normalizeSql(r.sql)}` : normalizeSql(r.sql);
    const g = groups.get(key) ?? { sql: key, count: 0, total_ms: 0, per_page: 0, by_process: {} };
    g.count++; g.total_ms += r.ms; g.by_process[family(r.label)] = (g.by_process[family(r.label)] ?? 0) + 1;
    groups.set(key, g);
  }
  return [...groups.values()].map(g => ({ ...g, total_ms: round1(g.total_ms), per_page: pages ? round1(g.count / pages) : 0 }))
    .sort((a, b) => b.count - a.count).slice(0, top);
}

const TXN_CONTROL = /^(begin|commit|rollback|savepoint|release|start transaction|end)\b/i;
/** pg_stat_statements for one database, without the bench's own statements; `calls_ex_txn` drops transaction control, which pg_stat_statements does not count reliably. */
export async function readPgStatStatements(sql: Sql, db: string): Promise<{ available: boolean; calls: number; calls_ex_txn: number; total_ms: number; top: Array<{ query: string; calls: number; total_ms: number }> }> {
  try {
    const rows = (await sql.unsafe(`${BENCH_SQL} SELECT left(regexp_replace(s.query, '\\s+', ' ', 'g'), 200) AS query, s.calls::float8 AS calls, s.total_exec_time::float8 AS total_ms
      FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1 ORDER BY s.calls DESC`, [db]) as unknown as Array<{ query: string; calls: number; total_ms: number }>)
      .filter(r => !r.query.startsWith(BENCH_SQL));
    return { available: true, calls: sum(rows.map(r => Number(r.calls))), calls_ex_txn: sum(rows.filter(r => !TXN_CONTROL.test(r.query.trim())).map(r => Number(r.calls))),
      total_ms: round1(sum(rows.map(r => Number(r.total_ms)))),
      top: rows.slice(0, 25).map(r => ({ query: r.query, calls: Number(r.calls), total_ms: round1(Number(r.total_ms)) })) };
  } catch { return { available: false, calls: 0, calls_ex_txn: 0, total_ms: 0, top: [] }; }
}
export const isTxnControl = memo((sql: string) => TXN_CONTROL.test(sql.trim()));

/**
 * Which part of the system issued a statement, from its text. `consumer-background`
 * is the in-process PersistenceConsumer's work that a publication-only consumer would
 * skip (effects drain, projection, topology recovery, root refresh, recovery and
 * expiry scans, idle probes, receipt maintenance); `wait-poll` is waitForWrite.
 */
export const classify = memo((sql: string): string => {
  const s = flatSql(sql);
  if (/^SELECT \* FROM persistence_requests WHERE id=\$1::uuid$/.test(s)) return 'wait-poll';
  if (/persistence_effects e (LEFT )?JOIN persistence_worktrees|page_projection_jobs|persistence_topology_changes c JOIN|DISTINCT ON \(local_path\)|shared_skill_packs|persistence_worktree_refreshes f JOIN|r\.recovery IS NOT NULL AND NOT\(r\.worktree_id|^WITH expired AS|writer_pool_capacity|^SELECT \( EXISTS|^SELECT EXISTS \(SELECT 1 FROM persistence_requests r LEFT JOIN|NOT compacted|brain_id,enabled,to_jsonb\(persistence_brain\)/.test(s)) return 'consumer-background';
  if (/^(begin|commit|rollback|savepoint|release)/i.test(s) || /^SELECT set_config\('(gbrain\.persistence_protocol|synchronous_commit)'/.test(s)) return 'txn-control';
  if (/page_write_guards|persistence_counters|FROM pages WHERE source_id=\$1 AND slug=\$2 FOR UPDATE/.test(s)) return 'guards+counters';
  if (/op_checkpoints/.test(s)) return 'cursor';
  if (/persistence_requests/.test(s)) return 'journal';
  if (/^<connect>$/.test(s) || /pg_catalog\.pg_type/.test(s)) return 'connection-setup';
  if (/\b(pages|content_chunks|page_versions|links|timeline_entries|tags|raw_data|facts|takes|slug_aliases|page_aliases)\b/.test(s)) return 'page-data';
  return 'other-control';
});
