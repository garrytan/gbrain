/**
 * GBRA-133 doctor `session_lane_budget`: every gbrain process opens its own pools, and a pooler's per-role session limit
 * (Supavisor `pool_size`) is shared by all of them, so a host could exhaust it (`EMAXCONNSESSION`) with no warning before
 * the first refusal. The check counts this role's backends by `application_name`, attributes gbrain's to a process kind
 * and (through the live consumer row) a host, and warns at 80% of the limit. Pure census cases, plus real PGLite (not
 * applicable) and real Postgres (backends a second process holds are counted, attributed and warned about) when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sessionLaneBudgetEntry } from '../src/commands/doctor/checks/session-lane.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { readSessionLane, sessionLaneLimitFromEnv, summarizeSessionLane, SESSION_LANE_LIMIT_ENV } from '../src/core/session-lane.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

describe('GBRA-133: the session-lane census', () => {
  const owners = [{ pid: 101, nonce: 'aaaaaaaa-1111', host_id: 'host-a' }, { pid: 202, nonce: 'bbbbbbbb-2222', host_id: 'host-b' }];
  const rows = [
    { application_name: 'gbrain serve:101:aaaaaaaa', connections: 13 },
    { application_name: 'gbrain sync:202:bbbbbbbb', connections: 7 },
    { application_name: 'gbrain jobs:303:cccccccc', connections: 2 },
    { application_name: 'Supavisor', connections: 1 },
    { application_name: 'psql', connections: 1 },
    { application_name: null, connections: 1 },
  ];

  test('gbrain backends are attributed to a kind and, through the consumer row, a host; the rest are counted apart', () => {
    const census = summarizeSessionLane({ rows, owners, serverClients: 40, serverLimit: 97, envLimit: 25, pooledUrl: true });
    expect(census).toMatchObject({ total: 25, gbrain: 22, pooler: 1, other: 2, by_kind: { serve: 13, sync: 7, jobs: 2 }, limit: 25, limit_source: 'env', used: 25, behind_pooler: true });
    expect(census.processes.map(p => [p.kind, p.pid, p.host_id, p.connections])).toEqual([['serve', 101, 'host-a', 13], ['sync', 202, 'host-b', 7], ['jobs', 303, null, 2]]);
    expect(census.by_host).toEqual([{ host_id: 'host-a', connections: 13 }, { host_id: 'host-b', connections: 7 }, { host_id: null, connections: 2 }]);
  });

  test('a nonce that does not match the consumer row leaves the host unknown (a reused pid is not the same process)', () => {
    const census = summarizeSessionLane({ rows: [{ application_name: 'gbrain serve:101:deadbeef', connections: 3 }], owners, serverClients: 3, serverLimit: 97, envLimit: null, pooledUrl: false });
    expect(census.processes[0]!.host_id).toBeNull();
  });

  test('behind a pooler with no configured limit the limit is unknown; without one it is max_connections less reserved, against every client', () => {
    expect(summarizeSessionLane({ rows, owners, serverClients: 40, serverLimit: 97, envLimit: null, pooledUrl: true })).toMatchObject({ limit: null, limit_source: null });
    expect(summarizeSessionLane({ rows: rows.filter(r => r.application_name !== 'Supavisor'), owners, serverClients: 40, serverLimit: 97, envLimit: null, pooledUrl: false }))
      .toMatchObject({ limit: 97, limit_source: 'max_connections', used: 40, behind_pooler: false });
    expect(summarizeSessionLane({ rows, owners, serverClients: 40, serverLimit: 97, envLimit: null, pooledUrl: false })).toMatchObject({ limit: null, behind_pooler: true });
  });

  test('the limit env takes a positive integer only', () => {
    expect(sessionLaneLimitFromEnv({ [SESSION_LANE_LIMIT_ENV]: '25' })).toBe(25);
    for (const bad of ['', '0', '-3', '2.5', 'many', undefined]) expect(sessionLaneLimitFromEnv({ [SESSION_LANE_LIMIT_ENV]: bad })).toBeNull();
  });
});

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: doctor session_lane_budget`, () => {
  let engine: BrainEngine;
  let databaseUrl = '';
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'pglite') { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
    else { const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase()); engine = pg.engine; databaseUrl = pg.databaseUrl; close = pg.close; }
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });
  const run = async () => (await sessionLaneBudgetEntry.run({ engine } as DoctorContext)) as Array<{ name: string; status: string; message: string; readiness_state?: string; details?: Record<string, any> }>;

  if (backend === 'pglite') {
    test('PGLite has no shared pool: not applicable', async () => {
      const [check] = await run();
      expect(check).toMatchObject({ name: 'session_lane_budget', status: 'ok', readiness_state: 'not_applicable' });
    });
    return;
  }

  test('backends another process holds are counted, attributed to its kind and host, and warned about at 80% of the limit', async () => {
    const nonce = 'abcdef12' + randomUUID().slice(8);
    const host = randomUUID();
    await engine.executeRaw(
      `INSERT INTO persistence_consumers (host_id, pid, nonce, kind, mode, host_json_path, persistence_home, version) VALUES ($1, 4242, $2, 'gbra133probe', 'full', '/x', '/x', 'test')`, [host, nonce]);
    const other = postgres(databaseUrl, { max: 2, prepare: false, connection: { application_name: 'gbrain gbra133probe:4242:abcdef12' } });
    const held = [await other.reserve(), await other.reserve()];
    await Promise.all(held.map(c => c`SELECT 1`));
    try {
      const census = await readSessionLane(engine, [databaseUrl], {});
      expect(census.by_kind.gbra133probe).toBe(2);
      expect(census.processes).toContainEqual({ application_name: 'gbrain gbra133probe:4242:abcdef12', kind: 'gbra133probe', pid: 4242, host_id: host, connections: 2 });
      expect(census.limit_source).toBe('max_connections');

      const [warn] = await withEnv({ [SESSION_LANE_LIMIT_ENV]: String(census.total) }, run);
      expect(warn).toMatchObject({ name: 'session_lane_budget', status: 'warn' });
      expect(warn!.message).toContain(`limit ${SESSION_LANE_LIMIT_ENV}=${census.total}`);
      expect(warn!.message).toContain('gbra133probe 2');
      expect(warn!.message).toContain('EMAXCONNSESSION');
      expect(warn!.details).toMatchObject({ limit: census.total, limit_source: 'env' });

      const [ok] = await withEnv({ [SESSION_LANE_LIMIT_ENV]: String(census.total * 10) }, run);
      expect(ok).toMatchObject({ name: 'session_lane_budget', status: 'ok' });
      expect(ok!.message).toContain(`of ${census.total * 10} session connection(s) are in use`);
    } finally {
      for (const c of held) c.release();
      await other.end();
    }
  });
});
