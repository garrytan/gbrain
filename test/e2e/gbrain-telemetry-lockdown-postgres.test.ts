/**
 * gbrain's telemetry SQL (supabase/gbrain-telemetry/migrations/G001, GST-3414)
 * on real Postgres, in a dedicated database, against Supabase-like defaults:
 * the anon and authenticated roles start with every table privilege the
 * hosted platform hands them, so only G001's own REVOKEs can make them fail.
 * service_role has BYPASSRLS, as on Supabase.
 *
 * Checks: anon and authenticated are refused select, insert, update and every
 * function; service_role can write; the daily ceiling stops at its limits;
 * forget clears an install; the pulse counts only known versions and hides a
 * size-band cell under 5 installs; prune keeps recent rows.
 * Role names carry a per-run suffix so parallel shards never share them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from '#postgres';
import { hasDatabase } from './helpers.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const dbName = `gbrain_test_telemetry_${suffix}`;
const ROLE = { anon: `anon_${suffix}`, authenticated: `authenticated_${suffix}`, service_role: `service_role_${suffix}` };
const adminUrl = process.env.GBRAIN_PGBOUNCER_DIRECT_URL ?? process.env.DATABASE_URL ?? '';
const G001 = readFileSync(join(import.meta.dir, '..', '..', 'supabase', 'gbrain-telemetry', 'migrations', 'G001_gbrain_telemetry.sql'), 'utf-8')
  .replace(/\b(anon|authenticated|service_role)\b/g, r => ROLE[r as keyof typeof ROLE]);

let admin: ReturnType<typeof postgres> | undefined;
let db: ReturnType<typeof postgres>;

async function asRole<T>(role: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await db.begin(async tx => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  })) as T;
}
async function deniedCode(role: string, sql: string): Promise<string | undefined> {
  try {
    await asRole(role, tx => tx.unsafe(sql));
    return 'allowed';
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

const EVENT = (over: Record<string, unknown> = {}) => ({
  schema_version: 1, event_type: 'setup', event_hour: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString(),
  gbrain_version: '0.60.760.0', os: 'linux', arch: 'x64', install_method: 'bun_global', deployment: 'local_pglite',
  source: 'live', tier: 'anonymous', harness: 'hermes', step: 'done', outcome: 'success', ...over,
});

(hasDatabase() ? describe : describe.skip)('gbrain telemetry G001 on Postgres (GST-3414)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    admin = postgres(adminUrl, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    for (const [name, r] of Object.entries(ROLE)) {
      await admin.unsafe(`CREATE ROLE ${r} NOLOGIN${name === 'service_role' ? ' BYPASSRLS' : ''}`);
    }
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    db = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
    const all = Object.values(ROLE).join(', ');
    await db.unsafe(`GRANT USAGE ON SCHEMA public TO ${all}`);
    await db.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${all}`);
    await db.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${all}`);
    await db.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${all}`);
    await db.unsafe(G001);
    await db.unsafe(G001);
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      for (const r of Object.values(ROLE)) await admin.unsafe(`DROP ROLE IF EXISTS ${r}`);
      await admin.end();
    }
  });

  const objects = ['gbrain_telemetry_events', 'gbrain_installations', 'gbrain_ingest_daily', 'gbrain_pulse_cache', 'gbrain_telemetry_live'];

  test('anon and authenticated are refused every table, the view and every function', async () => {
    for (const role of [ROLE.anon, ROLE.authenticated]) {
      for (const t of objects) {
        expect({ role, t, op: 'select', code: await deniedCode(role, `SELECT * FROM public.${t} LIMIT 1`) }).toEqual({ role, t, op: 'select', code: '42501' });
      }
      for (const t of objects.slice(0, 4)) {
        expect({ role, t, code: await deniedCode(role, `DELETE FROM public.${t}`) }).toEqual({ role, t, code: '42501' });
      }
      expect(await deniedCode(role, `INSERT INTO public.gbrain_installations (installation_id) VALUES (gen_random_uuid())`)).toBe('42501');
      expect(await deniedCode(role, `UPDATE public.gbrain_pulse_cache SET data = '{}'`)).toBe('42501');
      for (const call of ['gbrain_ingest_reserve(1, 10, 10)', 'gbrain_telemetry_forget(gen_random_uuid())', 'gbrain_telemetry_prune()', 'gbrain_pulse_summary(NULL)']) {
        expect({ role, call, code: await deniedCode(role, `SELECT public.${call}`) }).toEqual({ role, call, code: '42501' });
      }
    }
  });

  test('service_role writes a valid event, and a CHECK refuses free text', async () => {
    await asRole(ROLE.service_role, tx => tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT())}`);
    const bad = await deniedCode(ROLE.service_role, `INSERT INTO public.gbrain_telemetry_events (schema_version, event_type, event_hour, gbrain_version, os, arch, install_method, deployment, source, tier, harness)
      VALUES (1, 'setup', date_trunc('hour', now()), '0.60.760.0', 'linux', 'x64', 'bun_global', 'local_pglite', 'live', 'anonymous', 'my-private-harness')`);
    expect(bad).toBe('23514');
    const id = await deniedCode(ROLE.service_role, `INSERT INTO public.gbrain_telemetry_events (schema_version, event_type, event_hour, gbrain_version, os, arch, install_method, deployment, source, tier, installation_id)
      VALUES (1, 'setup', date_trunc('hour', now()), '0.60.760.0', 'linux', 'x64', 'bun_global', 'local_pglite', 'live', 'anonymous', gen_random_uuid())`);
    expect(id).toBe('23514');
  });

  test('the daily ceiling stops at its request and row limits', async () => {
    const reserve = (rows: number) => asRole(ROLE.service_role, async tx => (await tx`SELECT public.gbrain_ingest_reserve(${rows}, 3, 10) AS ok`)[0].ok);
    await asRole(ROLE.service_role, tx => tx`DELETE FROM public.gbrain_ingest_daily`);
    expect(await reserve(4)).toBe(true);
    expect(await reserve(4)).toBe(true);
    expect(await reserve(4)).toBe(false);
    expect(await reserve(2)).toBe(true);
    expect(await reserve(0)).toBe(false);
    const [day] = await asRole(ROLE.service_role, tx => tx`SELECT requests, rows_accepted FROM public.gbrain_ingest_daily`);
    expect(day).toEqual({ requests: 3, rows_accepted: 10 });
  });

  test('forget deletes the install and blanks its id on stored events', async () => {
    const id = randomUUID();
    await asRole(ROLE.service_role, async tx => {
      await tx`INSERT INTO public.gbrain_installations (installation_id) VALUES (${id})`;
      await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ tier: 'community', installation_id: id }))}`;
      await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ tier: 'community', installation_id: id, event_type: 'doctor', score_band: '90-100' }))}`;
    });
    const [{ n }] = await asRole(ROLE.service_role, tx => tx`SELECT public.gbrain_telemetry_forget(${id}) AS n`);
    expect(n).toBe(2);
    const left = await asRole(ROLE.service_role, tx => tx`SELECT
      (SELECT count(*)::int FROM public.gbrain_installations WHERE installation_id = ${id}) AS installs,
      (SELECT count(*)::int FROM public.gbrain_telemetry_events WHERE installation_id = ${id}) AS events`);
    expect(left[0]).toEqual({ installs: 0, events: 0 });
  });

  test('the pulse counts only known versions and hides a size-band cell under 5 installs', async () => {
    await asRole(ROLE.service_role, async tx => {
      await tx`DELETE FROM public.gbrain_telemetry_events`;
      for (let i = 0; i < 3; i++) await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ outcome: i === 0 ? 'error' : 'success', error_code: i === 0 ? 'mcp_register_failed' : null }))}`;
      await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ gbrain_version: '9.0.0.0' }))}`;
      await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ source: 'test' }))}`;
      for (let i = 0; i < 4; i++) {
        await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ event_type: 'doctor', harness: null, step: null, outcome: null, tier: 'community', installation_id: randomUUID(), score_band: '30-49', brain_size_band: '10k+' }))}`;
      }
      await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ event_type: 'daily_rollup', harness: null, step: null, outcome: null, command_counts: tx.json({ query: 7, doctor: 2 }), error_code_counts: tx.json({ no_brain: 3 }) }))}`;
    });
    const pulse = async () => (await asRole(ROLE.service_role, tx => tx`SELECT public.gbrain_pulse_summary('0.60.760.0') AS p`))[0].p;
    let p = await pulse();
    expect(p.setup).toEqual([{ harness: 'hermes', version: '0.60.760.0', attempts: 3, successes: 2, installs: 0 }]);
    expect(p.doctor_bands).toEqual([{ score_band: '30-49', count: 4 }]);
    expect(p.doctor_by_size).toEqual([]);
    expect(p.commands).toEqual([{ command: 'query', count: 7 }, { command: 'doctor', count: 2 }]);
    expect(p.error_codes).toEqual([{ version: '0.60.760.0', code: 'no_brain', count: 3 }, { version: '0.60.760.0', code: 'mcp_register_failed', count: 1 }]);
    await asRole(ROLE.service_role, tx => tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ event_type: 'doctor', harness: null, step: null, outcome: null, tier: 'community', installation_id: randomUUID(), score_band: '30-49', brain_size_band: '10k+' }))}`);
    p = await pulse();
    expect(p.doctor_by_size).toEqual([{ brain_size_band: '10k+', score_band: '30-49', count: 5 }]);
  });

  test('the pulse keeps 10 versions, drops upgrades to unreleased versions and reports ceiling refusals', async () => {
    await asRole(ROLE.service_role, async tx => {
      await tx`DELETE FROM public.gbrain_telemetry_events`;
      await tx`DELETE FROM public.gbrain_ingest_daily`;
      for (let k = 1; k <= 12; k++) await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ gbrain_version: `0.60.${k}.0` }))}`;
      for (let i = 0; i < 2; i++) await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ gbrain_version: '0.60.1.0' }))}`;
      for (const to of ['0.60.12.0', '9.0.0.0']) {
        await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ event_type: 'upgrade', harness: null, step: null, gbrain_version: '0.60.12.0', to_version: to }))}`;
      }
      await tx`SELECT public.gbrain_ingest_reserve(5, 1, 10)`;
      await tx`SELECT public.gbrain_ingest_reserve(5, 1, 10)`;
      await tx`SELECT public.gbrain_ingest_reserve(11, 5, 10)`;
    });
    const [{ p }] = await asRole(ROLE.service_role, tx => tx`SELECT public.gbrain_pulse_summary('0.60.760.0') AS p`);
    const versions = p.setup.map((c: { version: string }) => c.version);
    expect(versions.length).toBe(10);
    expect(versions).toContain('0.60.1.0');
    expect(versions).not.toContain('0.60.2.0');
    expect(versions).not.toContain('0.60.3.0');
    expect(p.upgrades.map((c: { to_version: string }) => c.to_version)).toEqual(['0.60.12.0']);
    expect(p.ceiling_refusals).toBe(2);
    const [day] = await asRole(ROLE.service_role, tx => tx`SELECT requests, rows_accepted, refused FROM public.gbrain_ingest_daily`);
    expect(day).toEqual({ requests: 1, rows_accepted: 5, refused: 2 });
  });

  test('the newest release always reaches the pulse and each version lists at most 5 upgrade targets', async () => {
    await asRole(ROLE.service_role, async tx => {
      await tx`DELETE FROM public.gbrain_telemetry_events`;
      for (let k = 1; k <= 11; k++) {
        for (let i = 0; i < 3; i++) await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ gbrain_version: `0.60.${k}.0` }))}`;
      }
      await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ gbrain_version: '0.60.760.0', outcome: 'error', error_code: 'mcp_register_failed' }))}`;
      for (let k = 1; k <= 7; k++) {
        await tx`INSERT INTO public.gbrain_telemetry_events ${tx(EVENT({ event_type: 'upgrade', harness: null, step: null, gbrain_version: '0.60.11.0', to_version: `0.60.${100 + k}.0` }))}`;
      }
    });
    const [{ p }] = await asRole(ROLE.service_role, tx => tx`SELECT public.gbrain_pulse_summary('0.60.760.0') AS p`);
    const versions = p.setup.map((c: { version: string }) => c.version);
    expect(new Set(versions).size).toBe(10);
    expect(versions).toContain('0.60.760.0');
    expect(p.error_codes).toContainEqual({ version: '0.60.760.0', code: 'mcp_register_failed', count: 1 });
    expect(p.upgrades.length).toBe(5);
  });

  test('a second run of G001 upgrades an older copy of its tables', async () => {
    await db.unsafe('ALTER TABLE public.gbrain_ingest_daily DROP COLUMN refused');
    await db.unsafe('ALTER TABLE public.gbrain_pulse_cache DROP COLUMN attempted_at');
    await db.unsafe(G001);
    const cols = await db`SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name, column_name) IN (('gbrain_ingest_daily', 'refused'), ('gbrain_pulse_cache', 'attempted_at'))`;
    expect(cols.length).toBe(2);
  });

  test('prune keeps recent rows and drops those past 400 days', async () => {
    await asRole(ROLE.service_role, tx => tx`INSERT INTO public.gbrain_telemetry_events ${tx({ ...EVENT(), received_at: new Date(Date.now() - 401 * 86_400_000).toISOString() })}`);
    const before = (await asRole(ROLE.service_role, tx => tx`SELECT count(*)::int AS n FROM public.gbrain_telemetry_events`))[0].n;
    const [{ r }] = await asRole(ROLE.service_role, tx => tx`SELECT public.gbrain_telemetry_prune() AS r`);
    expect(r.events).toBe(1);
    const after = (await asRole(ROLE.service_role, tx => tx`SELECT count(*)::int AS n FROM public.gbrain_telemetry_events`))[0].n;
    expect(after).toBe(before - 1);
  });
});
