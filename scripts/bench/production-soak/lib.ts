/**
 * Shared helpers for the production-shaped scale soak (GBRA-174): the database
 * topology (Postgres, a session-mode PgBouncer capped like a session pooler, a
 * transaction-mode PgBouncer, and toxiproxy latency in front of both), the
 * gbrain CLI runner and the child environment. Every listener binds loopback.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import postgres from '#postgres';
import { PGBOUNCER_IMAGE } from '../managed-sync-catchup-lib.ts';

export const REPO = join(import.meta.dir, '..', '..', '..');
export const now = () => performance.timeOrigin + performance.now();
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const log = (tag: string, m: string) => console.error('[' + tag + ' ' + new Date().toISOString().slice(11, 19) + '] ' + m);

export interface Ports { pg: number; session: number; txn: number; sessionProxy: number; txnProxy: number; toxiproxyApi: number }
export const DEFAULT_PORTS: Ports = { pg: 5434, session: 6432, txn: 6543, sessionProxy: 15432, txnProxy: 16543, toxiproxyApi: 8475 };
/** The session lane mirrors a hosted session pooler: pool_size 25, and a 26th client is refused rather than queued. */
export interface LaneSizes { sessionPool: number; txnPool: number }
export const DEFAULT_LANES: LaneSizes = { sessionPool: 25, txnPool: 20 };
export const SESSION_ROLE = 'lane_session', TXN_ROLE = 'lane_txn';
const C = { pg: 'soak-pg', session: 'soak-bouncer-session', txn: 'soak-bouncer-txn', toxi: 'soak-toxiproxy' };

function docker(args: string[], allowFail = false): string {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error('docker ' + args.join(' ') + ' failed: ' + (r.stderr || r.stdout));
  return (r.stdout ?? '').trim();
}
const running = (name: string) => !!docker(['ps', '-q', '-f', 'name=^' + name + '$'], true);

export interface Topology {
  ports: Ports; lanes: LaneSizes;
  /** Direct (unproxied, unpooled) URL: the loader, the samplers and the probes use it. */
  direct(db: string): string;
  /** Session lane through toxiproxy: what GBRAIN_DIRECT_DATABASE_URL points at, like the session pooler port. */
  session(db: string): string;
  /** Transaction lane through toxiproxy: the brain's database_url, like the transaction pooler port. */
  txn(db: string): string;
  setRtt(ms: number): Promise<void>;
  /** Client connections each PgBouncer refused at its cap since it started. */
  refusals(): { session: number; txn: number };
  stop(): void;
}

function bouncerIni(dir: string, name: string, mode: 'session' | 'transaction', role: string, ports: Ports, listen: number, pool: number, maxClients: number): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pgbouncer.ini'), [
    '[databases]', '* = host=127.0.0.1 port=' + ports.pg + ' user=' + role + ' password=lane', '',
    '[pgbouncer]', 'listen_addr = 127.0.0.1', 'listen_port = ' + listen, 'auth_type = plain', 'auth_file = /etc/pgbouncer/userlist.txt',
    'pool_mode = ' + mode, 'default_pool_size = ' + pool, 'max_client_conn = ' + maxClients, 'max_db_connections = ' + pool, 'reserve_pool_size = 0',
    'ignore_startup_parameters = extra_float_digits,options,statement_timeout,idle_in_transaction_session_timeout,search_path,lock_timeout,maintenance_work_mem',
    'server_reset_query = DISCARD ALL', 'query_wait_timeout = 120', 'log_connections = 0', 'log_disconnections = 0', 'admin_users = postgres', '',
  ].join('\n'));
  writeFileSync(join(dir, 'userlist.txt'), '"postgres" "postgres"\n');
  return name;
}

/** Starts (or reuses) the four containers. Session clients beyond lanes.sessionPool are refused, the EMAXCONNSESSION shape. */
export async function startTopology(workDir: string, ports: Ports = DEFAULT_PORTS, lanes: LaneSizes = DEFAULT_LANES, keep = false): Promise<Topology> {
  if (!running(C.pg)) {
    docker(['rm', '-f', C.pg], true);
    docker(['run', '-d', '--name', C.pg, '--network', 'host', '-e', 'POSTGRES_PASSWORD=postgres', '--shm-size=4g', 'pgvector/pgvector:pg16',
      '-c', 'port=' + ports.pg, '-c', 'listen_addresses=127.0.0.1', '-c', 'max_connections=300', '-c', 'shared_preload_libraries=pg_stat_statements',
      '-c', 'shared_buffers=' + (process.env.SOAK_PG_SHARED_BUFFERS ?? '4GB'), '-c', 'maintenance_work_mem=1GB', '-c', 'max_wal_size=8GB', '-c', 'checkpoint_timeout=15min']);
  }
  const admin = 'postgresql://postgres:postgres@127.0.0.1:' + ports.pg + '/postgres';
  for (let i = 0; ; i++) {
    try { const s = postgres(admin, { max: 1, onnotice: () => {}, connect_timeout: 2 }); await s`SELECT 1`; await s.end(); break; } catch (e) { if (i > 90) throw e; await sleep(1000); }
  }
  {
    const s = postgres(admin, { max: 1, onnotice: () => {} });
    for (const role of [SESSION_ROLE, TXN_ROLE]) await s.unsafe("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '" + role + "') THEN CREATE ROLE " + role + " LOGIN SUPERUSER PASSWORD 'lane'; END IF; END $$");
    await s.end();
  }
  const bouncers: Array<[string, 'session' | 'transaction', string, number, number, number]> = [
    [C.session, 'session', SESSION_ROLE, ports.session, lanes.sessionPool, lanes.sessionPool],
    [C.txn, 'transaction', TXN_ROLE, ports.txn, lanes.txnPool, 2000],
  ];
  for (const [name, mode, role, listen, pool, maxClients] of bouncers) {
    const dir = join(workDir, 'pgbouncer', name);
    bouncerIni(dir, name, mode, role, ports, listen, pool, maxClients);
    docker(['rm', '-f', name], true);
    docker(['run', '-d', '--name', name, '--network', 'host', '-v', dir + ':/etc/pgbouncer:ro', PGBOUNCER_IMAGE]);
  }
  if (!running(C.toxi)) {
    docker(['rm', '-f', C.toxi], true);
    docker(['run', '-d', '--name', C.toxi, '--network', 'host', 'ghcr.io/shopify/toxiproxy:2.12.0', '-host', '127.0.0.1', '-port', String(ports.toxiproxyApi)]);
  }
  const api = 'http://127.0.0.1:' + ports.toxiproxyApi;
  for (let i = 0; ; i++) { try { if ((await fetch(api + '/version')).ok) break; } catch (e) { if (i > 60) throw e; } await sleep(500); }
  const proxies: Array<[string, number, number]> = [['session', ports.sessionProxy, ports.session], ['txn', ports.txnProxy, ports.txn]];
  for (const [name, listen, upstream] of proxies) {
    await fetch(api + '/proxies/' + name, { method: 'DELETE' });
    const r = await fetch(api + '/proxies', { method: 'POST', body: JSON.stringify({ name, listen: '127.0.0.1:' + listen, upstream: '127.0.0.1:' + upstream, enabled: true }) });
    if (!r.ok) throw new Error('toxiproxy proxy ' + name + ': ' + await r.text());
  }
  const url = (port: number, db: string, q = '') => 'postgresql://postgres:postgres@127.0.0.1:' + port + '/' + db + q;
  for (const port of [ports.sessionProxy, ports.txnProxy]) {
    for (let i = 0; ; i++) {
      try { const s = postgres(url(port, 'postgres'), { max: 1, onnotice: () => {}, connect_timeout: 3, prepare: false }); await s`SELECT 1`; await s.end(); break; } catch (e) { if (i > 60) throw e; await sleep(1000); }
    }
  }
  const countRefused = (name: string) => { const r = spawnSync('docker', ['logs', name], { encoding: 'utf8', maxBuffer: 1 << 28 }); return ((r.stdout ?? '') + (r.stderr ?? '')).split('\n').filter(l => /no more connections allowed/.test(l)).length; };
  return {
    ports, lanes,
    direct: db => url(ports.pg, db),
    session: db => url(ports.sessionProxy, db),
    txn: db => url(ports.txnProxy, db, '?prepare=false'),
    async setRtt(ms: number) {
      for (const [name] of proxies) for (const [stream, part] of [['upstream', Math.floor(ms / 2)], ['downstream', Math.ceil(ms / 2)]] as const) {
        await fetch(api + '/proxies/' + name + '/toxics/lat_' + stream, { method: 'DELETE' });
        if (part <= 0) continue;
        const r = await fetch(api + '/proxies/' + name + '/toxics', { method: 'POST', body: JSON.stringify({ name: 'lat_' + stream, type: 'latency', stream, toxicity: 1, attributes: { latency: part, jitter: 0 } }) });
        if (!r.ok) throw new Error('toxiproxy toxic: ' + await r.text());
      }
    },
    refusals: () => ({ session: countRefused(C.session), txn: countRefused(C.txn) }),
    stop() { if (!keep) for (const name of Object.values(C)) docker(['rm', '-f', name], true); },
  };
}

/** Child environment: provider keys and database variables stripped, the bench home and the mock provider set. */
export function childEnv(home: string, mockUrl: string, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/_API_KEY$|_API_TOKEN$|^DATABASE_URL$|^GBRAIN_DATABASE_URL$|^GBRAIN_DIRECT_DATABASE_URL$|^OPENAI_BASE_URL$|^GBRAIN_HOME$/.test(k)) delete env[k];
  const out = { ...env, GBRAIN_HOME: home, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_NO_UPDATE_CHECK: '1', GBRAIN_TELEMETRY: '0', GBRAIN_SKILLS_DIR: join(home, 'skills'), NO_COLOR: '1',
    OPENAI_API_KEY: 'sk-soak-mock-not-a-key', OPENAI_BASE_URL: mockUrl + '/v1', VOYAGE_API_KEY: 'pa-soak-mock-not-a-key', ...extra };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

export function writeConfig(home: string, databaseUrl: string, mockUrl: string): void {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(join(home, 'skills'), { recursive: true });
  if (!existsSync(join(home, 'skills', 'RESOLVER.md'))) writeFileSync(join(home, 'skills', 'RESOLVER.md'), '# Soak fixture skills\n');
  const file = join(home, '.gbrain', 'config.json');
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, JSON.stringify({ ...prior, engine: 'postgres', database_url: databaseUrl, embedding_disabled: false, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
    provider_base_urls: { voyage: mockUrl + '/v1' }, self_upgrade: { mode: 'off' } }, null, 2) + '\n');
}

export interface GbResult { code: number; stdout: string; stderr: string; ms: number; json: any }
export async function gb(cli: string, home: string, env: Record<string, string>, args: string[], opts: { allowFail?: boolean; timeoutMs?: number } = {}): Promise<GbResult> {
  const t = now();
  const p = Bun.spawn([process.execPath, cli, ...args], { cwd: home, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: opts.timeoutMs ?? 4 * 3600_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let json: any = null;
  try { json = JSON.parse(stdout); } catch { const last = stdout.trim().split('\n').reverse().find(l => l.startsWith('{')); try { json = last ? JSON.parse(last) : null; } catch { json = null; } }
  if (code !== 0 && !opts.allowFail) throw new Error('gbrain ' + args.join(' ') + ' exited ' + code + '\n' + stdout.slice(-1500) + '\n' + stderr.slice(-1500));
  return { code: code ?? -1, stdout, stderr, ms: now() - t, json };
}

export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const rank = (p / 100) * (s.length - 1), lo = Math.floor(rank), hi = Math.ceil(rank);
  return Math.round((s[lo]! + (s[hi]! - s[lo]!) * (rank - lo)) * 10) / 10;
}
