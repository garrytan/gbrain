/**
 * Engine graduation over the connection topologies a hosted brain uses:
 * transaction-mode PgBouncer with DDL on the direct route, and a hosted-style
 * NOSUPERUSER role (`disable_trigger` bypass recorded in the receipt, every
 * user trigger re-enabled), plus a forced bypass on a superuser target.
 * Split from graduation-cli.test.ts (test/helpers/graduation-cli-cases.ts).
 */
import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { DATABASE_URL, emptyTarget, gbrain, graduationTest, graduationTestIf, hostedRoleTarget, passwordOf, pooledUrl } from '../helpers/graduation-e2e.ts';
import { useGraduationCases } from '../helpers/graduation-cli-cases.ts';
import { expectGraduated, planAndRun } from '../helpers/graduation-scenarios.ts';

const { cleanups, fresh } = useGraduationCases();

describe.skipIf(!DATABASE_URL)('graduation: connection topologies', () => {
  graduationTestIf(!process.env.GBRAIN_PGBOUNCER_URL)('through transaction-mode PgBouncer with DDL on the direct route', async () => {
    // #10430: the pooler may front another server than DATABASE_URL (ci-local shards 2-4), so the target lives behind
    // it: created on its direct route, reached pooled for traffic and direct for DDL.
    const target = await emptyTarget(process.env.GBRAIN_PGBOUNCER_DIRECT_URL || DATABASE_URL);
    cleanups.push(() => target.close());
    const c = await fresh('pgbouncer', target);
    const pooled = pooledUrl(c.target)!;
    const { argv, env } = await planAndRun(c, { url: pooled, env: { GBRAIN_DIRECT_DATABASE_URL: c.target.url } });
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'pgbouncer');
  }, 900_000);

  test('the hosted-style role is a real constraint: no session_replication_role, but it owns what it creates', async () => {
    const hosted = await hostedRoleTarget();
    cleanups.push(() => hosted.close());
    const sql = postgres(hosted.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const replica = await sql.begin(tx => tx.unsafe('SET LOCAL session_replication_role = replica')).then(() => 'allowed', e => String((e as { code?: string }).code));
      expect(replica).toBe('42501');
      await sql.unsafe('CREATE TABLE probe(id int primary key); ALTER TABLE probe DISABLE TRIGGER USER; DROP TABLE probe');
      const [ext] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_extension WHERE extname='vector'`);
      expect(Number(ext.n)).toBe(1);
    } finally { await sql.end(); }
    const oldUrl = hosted.url;
    const rotated = await hosted.rotatePassword();
    expect(passwordOf(rotated)).not.toBe(passwordOf(oldUrl));
    const stale = postgres(oldUrl, { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 5 });
    expect(await stale.unsafe('SELECT 1').then(() => 'connected', e => String((e as { code?: string }).code))).toBe('28P01');
    await stale.end();
    const fresh = postgres(rotated, { max: 1, prepare: false, onnotice: () => {} });
    expect((await fresh.unsafe<{ n: number }[]>('SELECT 1 AS n'))[0].n).toBe(1);
    await fresh.end();
  });

  graduationTest('as a hosted-style NOSUPERUSER role: the disable-trigger fallback, every user trigger re-enabled', async () => {
    const hosted = await hostedRoleTarget();
    const c = await fresh('hosted-role', hosted);
    const { argv, env } = await planAndRun(c, { url: hosted.url });
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    expect(JSON.stringify(run.json)).toContain('disable_trigger');
    await expectGraduated(c, 'hosted role');
    const sql = postgres(hosted.url, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const disabled = await sql.unsafe<{ t: string }[]>(`SELECT c.relname || '.' || t.tgname AS t FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled <> 'O'`);
      expect(disabled.map(r => r.t)).toEqual([]);
    } finally { await sql.end(); }
  }, 900_000);

  graduationTest('--trigger-bypass disable-trigger is honoured on a superuser target and recorded', async () => {
    const c = await fresh('forced-bypass');
    const { argv, env } = await planAndRun(c, { extra: ['--trigger-bypass', 'disable-trigger'] });
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect(run.code).toBe(0);
    expect(JSON.stringify(run.json)).toContain('disable_trigger');
    await expectGraduated(c, 'forced disable-trigger');
  }, 900_000);
});
