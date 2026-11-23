/**
 * Shadow freshness token, blind role: a Postgres login that is neither a superuser nor in pg_read_all_stats makes the shadow's
 * freshness token blind (src/shadow/checks.ts), so the brain clears no privacy sample and no recall score. The status document,
 * the report, the swap plan's criterion 3 and `gbrain doctor` (shadow_freshness_token) name that reason with the fix
 * `GRANT pg_read_all_stats TO <role>` for the connected role (never a brain name), and drop it once the role is granted.
 *
 * Authoring gate (docs/TESTING.md): (1) protects an operator whose shadow never clears a sample and who is told nothing about
 * why. (2) Fails when the role has no pg_read_all_stats and the status, report, swap criterion 3 or doctor stay silent or name
 * no GRANT, when the fix names a brain instead of the role, when the finding outlives the grant, when a superuser, PGLite or a
 * brain with no shadow gets a finding. (3) The token's own blindness is pinned in test/shadow-evidence.test.ts; nothing named
 * its cause for the operator. (4) A real non-superuser role on the Postgres test database; the real status command, report
 * builder, swap reader and doctor check; the shadow's own state writer under a temporary GBRAIN_HOME. The Postgres arm runs
 * with DATABASE_URL (test/postgres-unit-arms.txt).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { evaluateReadiness, type ShadowStatus } from '../src/core/engine-swap/readiness.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { shadowFreshnessTokenCheck, shadowFreshnessTokenEntry } from '../src/commands/doctor/checks/shadow-freshness-token.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { probeConfiguredFreshness, probeFreshnessBlind } from '../src/shadow/freshness-role.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { buildProvisionalReport, renderProvisionalMarkdown } from '../src/shadow/report.ts';
import { SHADOW_STATE_VERSION, readShadowState, shadowBrainKey, shadowDirFor, writeShadowState } from '../src/shadow/state.ts';
import { readConfiguredShadowStatus } from '../src/shadow/status-document.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const REASON = 'freshness token blind: role lacks pg_read_all_stats';
const STATE = { version: SHADOW_STATE_VERSION, enabled: true, started_at: '2026-11-01T00:00:00.000Z', sample_rate: 0.1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'postgres' };
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const home = (): string => { const h = mkdtempSync(join(tmpdir(), 'gbrain-freshness-role-')); homes.push(h); return h; };
/** An engine the command may disconnect without closing the shared connection. */
const lend = (engine: BrainEngine): BrainEngine => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine;

describe.skipIf(!backends.includes('postgres'))('a Postgres role without pg_read_all_stats makes the shadow freshness token blind', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const PLAIN = `gbrain_blind_${suffix}`;
  const MIXED = `Gbrain-Blind-${suffix}`; // needs quoting in SQL
  let admin: ReturnType<typeof postgres>;
  let adminEngine: BrainEngine;
  const logins: Array<ReturnType<typeof postgres>> = [];

  /** A login as `role`: a connection of that role answering the engine's raw queries (the engine's own connect reads tables a bare login may not). */
  async function connectAs(role: string | null): Promise<{ engine: BrainEngine; config: { engine: 'postgres'; database_url: string } }> {
    const url = new URL(process.env.DATABASE_URL!);
    if (role) { url.username = role; url.password = 'blind-example'; } // null: the test database's own login
    const sql = postgres(url.toString(), { max: 1, prepare: false });
    logins.push(sql);
    const engine = { kind: 'postgres', capabilities: new Set(['postgres_admin']), executeRaw: async (query: string, params?: unknown[]) => [...(await sql.unsafe(query, params as never))], disconnect: async () => undefined } as unknown as BrainEngine;
    return { engine, config: { engine: 'postgres', database_url: url.toString() } };
  }
  const pg16 = async (): Promise<boolean> => Number((await admin`SHOW server_version_num`)[0]!.server_version_num) >= 160000;
  const quoted = (role: string): string => (role === role.toLowerCase() && /^[a-z_][a-z0-9_]*$/.test(role) ? role : `"${role}"`);

  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
    for (const role of [PLAIN, MIXED]) await admin.unsafe(`CREATE ROLE ${quoted(role)} LOGIN PASSWORD 'blind-example'`);
    adminEngine = (await connectAs(null)).engine; // the test database's own superuser login
  }, 60_000);

  afterAll(async () => {
    for (const sql of logins) await sql.end({ timeout: 1 }).catch(() => undefined);
    for (const role of [PLAIN, MIXED]) {
      await admin?.unsafe(`DROP ROLE IF EXISTS ${quoted(role)}`).catch(() => undefined);
    }
    await admin?.end();
  }, 60_000);

  /** Runs `body` with a shadow turned on for the login's brain, under a temporary gbrain home. */
  async function withShadow<T>(config: { engine: 'postgres'; database_url: string }, body: (dir: string) => Promise<T>): Promise<T> {
    return withEnv({ GBRAIN_HOME: home() }, async () => {
      const dir = shadowDirFor(shadowBrainKey(config)!);
      writeShadowState(dir, STATE);
      return body(dir);
    });
  }
  const statusJson = async (config: { engine: 'postgres'; database_url: string }, engine: BrainEngine): Promise<Record<string, any>> => {
    let printed = '';
    expect(await runEngineShadow(['status', '--json'], { config: () => config, openPrimary: async () => lend(engine), out: l => { printed += l; }, now: () => new Date('2026-11-23T00:00:00Z') })).toBe(0);
    return JSON.parse(printed);
  };

  test('status, report, swap criterion 3 and doctor name the reason and the GRANT; all drop it after the grant', async () => {
    const { engine, config } = await connectAs(PLAIN);
    await withShadow(config, async (dir) => {
      const now = new Date('2026-11-23T00:00:00Z');
      const grant = `GRANT pg_read_all_stats TO ${PLAIN}${await pg16() ? ' WITH INHERIT TRUE' : ''};`;
      const swapDoc = async () => (await readConfiguredShadowStatus(() => config, now, () => probeConfiguredFreshness(async () => lend(engine)))) as ShadowStatus | null;
      const criterion3 = async () => evaluateReadiness(await swapDoc(), now).criteria.find(c => c.n === 3)!;

      // Before the grant: every surface names the reason, the connected role and the fix.
      const doc = await statusJson(config, engine);
      expect(doc.freshness_token).toMatchObject({ code: 'freshness_token_blind', message: REASON, role: PLAIN });
      expect(doc.freshness_token.why).toContain(`Role ${PLAIN} is neither a superuser nor a member of pg_read_all_stats`);
      expect(doc.freshness_token.fix).toMatchObject({ next: 'tell_user_to_run', actor: 'host_admin', verify: { argv: ['gbrain', 'doctor', '--only', 'shadow_freshness_token', '--json'] } });
      expect(doc.freshness_token.fix.command).toContain(grant);
      expect(JSON.stringify(doc.freshness_token)).not.toContain(doc.brain); // the role, never the brain name

      let text = '';
      await runEngineShadow(['status'], { config: () => config, openPrimary: async () => lend(engine), out: l => { text += `${l}\n`; }, now: () => now });
      expect(text).toContain(REASON);
      expect(text).toContain(grant);

      const report = buildProvisionalReport(dir, 'b', readShadowState(dir), now, (await statusJson(config, engine)).freshness_token);
      expect(report.freshness_token?.role).toBe(PLAIN);
      expect(report.why_not_ready.join('\n')).toContain(REASON);
      expect(renderProvisionalMarkdown(report)).toContain(grant);

      const row = await criterion3();
      expect(row.state).toBe('fail');
      expect(row.detail).toContain(REASON);
      expect(row.detail).toContain(grant);

      const check = (await shadowFreshnessTokenCheck(config, engine))!;
      expect(check).toMatchObject({ name: 'shadow_freshness_token', status: 'warn', details: { code: 'freshness_token_blind', role: PLAIN, sql: grant } });
      expect(check.message).toContain(REASON);
      expect(check.fix).toMatchObject({ next: 'tell_user_to_run', verify: { argv: ['gbrain', 'doctor', '--only', 'shadow_freshness_token', '--json'] } });
      expect((check.fix as { command: string }).command).toContain(grant);
      expect(categorizeCheck('shadow_freshness_token')).toBe('ops');

      // The operator runs the fix; the next read of each surface no longer names it.
      await admin.unsafe(grant); // the operator runs exactly the statement the finding printed
      expect((await statusJson(config, engine)).freshness_token).toBeUndefined();
      expect(buildProvisionalReport(dir, 'b', readShadowState(dir), now, null).why_not_ready.join('\n')).not.toContain(REASON);
      expect((await criterion3()).detail).not.toContain(REASON);
      const ok = await shadowFreshnessTokenCheck(config, engine);
      expect(ok).toMatchObject({ name: 'shadow_freshness_token', status: 'ok' });
      expect(ok?.fix).toBeUndefined();
      await admin.unsafe(`REVOKE pg_read_all_stats FROM ${PLAIN}`);
    });
  }, 60_000);

  test('the emitted fix repairs a LOGIN NOINHERIT role (PostgreSQL 16 and later)', async () => {
    if (!(await pg16())) return;
    const role = `gbrain_noinh_${suffix}`;
    await admin.unsafe(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD 'blind-example'`);
    try {
      const { engine, config } = await connectAs(role);
      await withShadow(config, async () => {
        const before = (await shadowFreshnessTokenCheck(config, engine))!;
        expect(before.status).toBe('warn');
        expect(before.details?.sql).toBe(`GRANT pg_read_all_stats TO ${role} WITH INHERIT TRUE;`);
        expect((before.fix as { command: string }).command).toContain(`GRANT pg_read_all_stats TO ${role} WITH INHERIT TRUE;`);
        await admin.unsafe(String(before.details!.sql));
        expect(await shadowFreshnessTokenCheck(config, engine)).toMatchObject({ status: 'ok' });
      });
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
  }, 60_000);

  test('the emitted fix repairs a membership that was granted WITH INHERIT FALSE (PostgreSQL 16 and later)', async () => {
    if (!(await pg16())) return;
    const role = `gbrain_inhf_${suffix}`;
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'blind-example'`);
    await admin.unsafe(`GRANT pg_read_all_stats TO ${role} WITH INHERIT FALSE`);
    try {
      const { engine, config } = await connectAs(role);
      await withShadow(config, async () => {
        const before = (await shadowFreshnessTokenCheck(config, engine))!;
        expect(before.status).toBe('warn');
        await admin.unsafe(String(before.details!.sql));
        expect(await shadowFreshnessTokenCheck(config, engine)).toMatchObject({ status: 'ok' });
      });
    } finally {
      await admin.unsafe(`REVOKE pg_read_all_stats FROM ${role}`).catch(() => undefined);
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
  }, 60_000);

  test('doctor is silent for another brain: a different database, a mounted brain or a remote caller', async () => {
    const other = `gbrain_blind_db_${suffix}`;
    await admin.unsafe(`CREATE DATABASE ${other}`);
    try {
      const { engine, config } = await connectAs(PLAIN);
      const otherUrl = new URL(config.database_url);
      otherUrl.pathname = `/${other}`;
      const mounted = postgres(otherUrl.toString(), { max: 1, prepare: false });
      logins.push(mounted);
      const mountEngine = { kind: 'postgres', capabilities: new Set(['postgres_admin']), executeRaw: async (query: string, params?: unknown[]) => [...(await mounted.unsafe(query, params as never))], disconnect: async () => undefined } as unknown as BrainEngine;
      const ctx = (e: BrainEngine, extra: Partial<DoctorContext> = {}): DoctorContext => ({ engine: e, remote: undefined, progress: { heartbeat: () => undefined }, ...extra }) as unknown as DoctorContext;
      await withShadow(config, async () => {
        await withEnv({ GBRAIN_DATABASE_URL: config.database_url, DATABASE_URL: undefined, GBRAIN_BRAIN_ID: undefined }, async () => {
          // Positive control: the host's own engine, host brain, local caller.
          const host = (await shadowFreshnessTokenEntry.run(ctx(engine))) as Array<{ status: string }>;
          expect(host.map(c => c.status)).toEqual(['warn']);
          // The host's shadow is on, but this engine is another Postgres brain (a mount): no GRANT for its role.
          expect(await shadowFreshnessTokenCheck(config, mountEngine)).toBeNull();
          expect(await shadowFreshnessTokenEntry.run(ctx(mountEngine))).toEqual([]);
          // `doctor --brain <mount>` routes to the mount even when the engine happens to be the host's database.
          await withEnv({ GBRAIN_BRAIN_ID: 'some-mount' }, async () => {
            expect(await shadowFreshnessTokenEntry.run(ctx(engine))).toEqual([]);
          });
          // A remote caller never reads a role name or a cluster-wide GRANT.
          expect(await shadowFreshnessTokenEntry.run(ctx(engine, { remote: true }))).toEqual([]);
        });
      });
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${other} WITH (FORCE)`).catch(() => undefined);
    }
  }, 60_000);

  test('a host URL with no database path is read as the driver reads it: PGDATABASE first, then the login name', async () => {
    const { engine, config } = await connectAs(PLAIN);
    const dbName = decodeURIComponent(new URL(config.database_url).pathname.slice(1));
    const pathless = (url: string, user?: string): { engine: 'postgres'; database_url: string } => {
      const u = new URL(url); u.pathname = ''; if (user) u.username = user;
      return { engine: 'postgres', database_url: u.toString().replace(/\/$/, '') };
    };
    // PGDATABASE names the database.
    const viaEnv = pathless(config.database_url);
    await withEnv({ PGDATABASE: dbName }, async () => withShadow(viaEnv, async () => {
      const before = (await shadowFreshnessTokenCheck(viaEnv, engine))!;
      expect(before).toMatchObject({ name: 'shadow_freshness_token', status: 'warn' });
      await admin.unsafe(String(before.details!.sql));
      try { expect(await shadowFreshnessTokenCheck(viaEnv, engine)).toMatchObject({ status: 'ok' }); } finally { await admin.unsafe(`REVOKE pg_read_all_stats FROM ${PLAIN}`); }
      // A different PGDATABASE is another brain: silent.
      await withEnv({ PGDATABASE: `${dbName}_other` }, async () => { expect(await shadowFreshnessTokenCheck(viaEnv, engine)).toBeNull(); });
    }));
  }, 60_000);

  test('a host URL with no database path and no PGDATABASE names the login\'s database', async () => {
    const { config } = await connectAs(PLAIN);
    const pathless = (url: string, user?: string): { engine: 'postgres'; database_url: string } => {
      const u = new URL(url); u.pathname = ''; if (user) u.username = user;
      return { engine: 'postgres', database_url: u.toString().replace(/\/$/, '') };
    };
    const login = `gbrain_dbdef_${suffix}`;
    await admin.unsafe(`CREATE ROLE ${login} LOGIN PASSWORD 'blind-example'`);
    await admin.unsafe(`CREATE DATABASE ${login} OWNER ${login}`);
    try {
      const byLogin = pathless(config.database_url, login);
      byLogin.database_url = byLogin.database_url.replace(/^(postgres(?:ql)?:\/\/)[^@]*@/, `$1${login}:blind-example@`);
      const sql = postgres(byLogin.database_url, { max: 1, prepare: false });
      logins.push(sql);
      const loginEngine = { kind: 'postgres', capabilities: new Set(['postgres_admin']), executeRaw: async (query: string, params?: unknown[]) => [...(await sql.unsafe(query, params as never))], disconnect: async () => undefined } as unknown as BrainEngine;
      await withEnv({ PGDATABASE: undefined, PGUSER: undefined, PGUSERNAME: undefined }, async () => withShadow(byLogin, async () => {
        const before = (await shadowFreshnessTokenCheck(byLogin, loginEngine))!;
        expect(before).toMatchObject({ name: 'shadow_freshness_token', status: 'warn' });
        await admin.unsafe(String(before.details!.sql));
        expect(await shadowFreshnessTokenCheck(byLogin, loginEngine)).toMatchObject({ status: 'ok' });
      }));
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${login} WITH (FORCE)`).catch(() => undefined);
      await admin.unsafe(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
    }
  }, 60_000);

  test('a role name that needs quoting is written as the server quotes it', async () => {
    const { engine, config } = await connectAs(MIXED);
    await withShadow(config, async () => {
      const check = (await shadowFreshnessTokenCheck(config, engine))!;
      expect(check.details?.role).toBe(`"${MIXED}"`);
      expect((check.fix as { command: string }).command).toContain(`GRANT pg_read_all_stats TO "${MIXED}"`);
    });
  }, 60_000);

  test('a superuser and a brain with no shadow get no finding', async () => {
    const { engine, config } = await connectAs(PLAIN);
    // Superuser: sees every session.
    const url = process.env.DATABASE_URL!;
    const superConfig = { engine: 'postgres' as const, database_url: url };
    await withShadow(superConfig, async () => {
      expect(await shadowFreshnessTokenCheck(superConfig, adminEngine)).toMatchObject({ status: 'ok' });
      expect((await statusJson(superConfig, adminEngine)).freshness_token).toBeUndefined();
    });
    // No shadow on: the blind role is not reported, and nothing is asked of the database.
    await withEnv({ GBRAIN_HOME: home() }, async () => {
      expect(await shadowFreshnessTokenCheck(config, engine)).toBeNull();
      let asked = false;
      expect(await readConfiguredShadowStatus(() => config, new Date(), async () => { asked = true; return null; })).toBeNull();
      expect(asked).toBe(false);
    });
  }, 60_000);

  test('a database that cannot be opened leaves the status without a finding', async () => {
    const { config } = await connectAs(PLAIN);
    await withShadow(config, async () => {
      let printed = '';
      expect(await runEngineShadow(['status', '--json'], { config: () => config, openPrimary: async () => { throw new Error('connection refused'); }, out: l => { printed += l; } })).toBe(0);
      expect(JSON.parse(printed).freshness_token).toBeUndefined();
    });
  }, 60_000);
});

describe('PGLite and no shadow', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('doctor says nothing on PGLite even with a shadow on, and the entry is registered under its name', async () => {
    await withEnv({ GBRAIN_HOME: home() }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(home(), 'brain.pglite') };
      writeShadowState(shadowDirFor(shadowBrainKey(config)!), { ...STATE, primary_engine: 'pglite' });
      expect(await shadowFreshnessTokenCheck(config, engine)).toBeNull();
    });
    expect(shadowFreshnessTokenEntry.emits).toEqual(['shadow_freshness_token']);
  }, 60_000);
});

describe('the fix statement follows the server version and the inheritance of the role', () => {
  const stub = (row: Record<string, unknown>): Pick<BrainEngine, 'capabilities' | 'executeRaw'> => ({ capabilities: new Set(['postgres_admin']), executeRaw: async () => [row] }) as unknown as Pick<BrainEngine, 'capabilities' | 'executeRaw'>;
  const blind = { role: 'r', sees_all: false };

  test('PostgreSQL 16 and later: WITH INHERIT TRUE, for the role and no other membership', async () => {
    const f = (await probeFreshnessBlind(stub({ ...blind, version: 170000, inherits: false })))!;
    expect(f.sql).toBe('GRANT pg_read_all_stats TO r WITH INHERIT TRUE;');
    expect(f.fix.command).toContain('GRANT pg_read_all_stats TO r WITH INHERIT TRUE;');
  });

  test('before 16 the bare GRANT stays, and a NOINHERIT role is told it also needs ALTER ROLE ... INHERIT', async () => {
    const noinherit = (await probeFreshnessBlind(stub({ ...blind, version: 150000, inherits: false })))!;
    expect(noinherit.sql).toBe('GRANT pg_read_all_stats TO r;');
    expect(noinherit.why).toContain('ALTER ROLE r INHERIT');
    expect(noinherit.fix.why).toContain('ALTER ROLE r INHERIT');
    const inherits = (await probeFreshnessBlind(stub({ ...blind, version: 150000, inherits: true })))!;
    expect(inherits.sql).toBe('GRANT pg_read_all_stats TO r;');
    expect(inherits.why).not.toContain('ALTER ROLE');
  });
});
