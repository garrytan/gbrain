/**
 * #9190 and #9191: gbrain creates its OAuth tables with CREATE TABLE IF NOT EXISTS, so a same-named table another
 * application created in the brain's schema used to be adopted silently, altered by later migrations, and then break
 * v210 (clamp_oauth_token_ttl) with "operator does not exist: timestamp with time zone > bigint", midway through an
 * upgrade and without naming the table. Rerunning `gbrain apply-migrations --force-schema` then ran the pending
 * migrations without replaying the schema blob, so a blob-owned table that was missing stayed missing.
 * Both engines: PGLite always, Postgres with DATABASE_URL (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { collect, makeHome, spawnDriver } from './helpers/apply-migrations-lock-driver.ts';
import { writeSchemaDriver } from './helpers/apply-migrations-schema-driver.ts';
import { testBackends } from './helpers/test-backends.ts';

const FOREIGN_TOKENS = `CREATE TABLE oauth_tokens (
  id uuid PRIMARY KEY, token_hash text, token_type text, client_id text, scopes text[],
  expires_at timestamptz, resource text, refresh_token_hash text, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now())`;
const FOREIGN_ROW = `INSERT INTO oauth_tokens (id, token_hash, token_type, client_id, expires_at)
  VALUES ('00000000-0000-4000-8000-000000000001', 'hash-example', 'Bearer', 'other-app-example', now() + interval '1 hour')`;
const FORCE_SCHEMA = ['--force-schema', '--yes', '--non-interactive', '--no-autopilot-install'];
/** The columns gbrain's first OAuth release (v32) gave each table, and those later migrations added after v209. */
const V32_COLUMNS: Record<string, readonly string[]> = {
  oauth_clients: ['client_id', 'client_secret_hash', 'client_name', 'redirect_uris', 'grant_types', 'scope', 'token_endpoint_auth_method',
    'client_id_issued_at', 'client_secret_expires_at', 'created_at'],
  oauth_tokens: ['token_hash', 'token_type', 'client_id', 'scopes', 'expires_at', 'resource', 'created_at'],
  oauth_codes: ['code_hash', 'client_id', 'scopes', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'state', 'resource',
    'expires_at', 'created_at'],
};
const ADDED_AFTER_V209: Record<string, readonly string[]> = {
  oauth_clients: ['registered_via', 'private_pages', 'member_id', 'may_act_for', 'attest_actor', 'attest_ops', 'attest_sources', 'attest_read'],
  oauth_tokens: ['grant_type'],
  oauth_codes: [],
};

interface Brain { config: Record<string, string>; open: () => Promise<BrainEngine> }

for (const kind of testBackends()) {
  describe(`a table gbrain did not create in the brain's schema (${kind})`, () => {
    const work = mkdtempSync(join(tmpdir(), 'gbrain-foreign-oauth-'));
    const homes: string[] = [];
    const engines: BrainEngine[] = [];
    const databases: string[] = [];
    let admin: ReturnType<typeof postgres> | undefined;
    let template = '';

    const databaseUrl = (name: string) => { const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`; return url.toString(); };
    beforeAll(async () => {
      if (kind === 'pglite') {
        template = join(work, 'template.pglite');
        const engine = new PGLiteEngine();
        await engine.connect({ database_path: template });
        await engine.initSchema();
        await engine.disconnect();
        return;
      }
      assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
      template = `gbrain_test_foreign_oauth_tpl_${randomUUID().replace(/-/g, '')}`;
      await admin.unsafe(`CREATE DATABASE ${template}`);
      databases.push(template);
      const engine = new PostgresEngine();
      await engine.connect({ database_url: databaseUrl(template), poolSize: 4 });
      await engine.initSchema();
      await engine.disconnect();
    }, 300_000);

    afterAll(async () => {
      for (const engine of [...engines]) await engine.disconnect().catch(() => {});
      for (const name of databases.reverse()) await admin?.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await admin?.end();
      for (const home of homes) rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    });

    const brain = async (atHead: boolean): Promise<Brain> => {
      if (kind === 'pglite') {
        const database_path = join(work, randomUUID());
        if (atHead) cpSync(template, database_path, { recursive: true });
        return { config: { engine: 'pglite', database_path }, open: async () => {
          const engine = new PGLiteEngine(); await engine.connect({ database_path }); engines.push(engine); return engine;
        } };
      }
      const name = `gbrain_test_foreign_oauth_${randomUUID().replace(/-/g, '')}`;
      await admin!.unsafe(atHead ? `CREATE DATABASE ${name} TEMPLATE ${template}` : `CREATE DATABASE ${name}`);
      databases.push(name);
      return { config: { engine: 'postgres', database_url: databaseUrl(name) }, open: async () => {
        const engine = new PostgresEngine(); await engine.connect({ database_url: databaseUrl(name), poolSize: 4 }); engines.push(engine); return engine;
      } };
    };
    const close = async (engine: BrainEngine) => { await engine.disconnect(); engines.splice(engines.indexOf(engine), 1); };
    const applyMigrations = async (b: Brain, args: string[]) => {
      const home = makeHome({ engine: 'pglite' });
      homes.push(home);
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(b.config));
      const r = await collect(spawnDriver(home, writeSchemaDriver(home, { migrations: ['noop'], args })));
      return { code: r.code, out: r.stderr + r.stdout };
    };
    const shapeOf = async (engine: BrainEngine, qualified: string) => (await engine.executeRaw<{ t: string | null }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attname = 'expires_at' AND NOT a.attisdropped`, [qualified]))[0]?.t ?? null;

    test('#9190: an upgrade refuses before any migration, naming the table, the column, both types and the fix', async () => {
      const b = await brain(true);
      const engine = await b.open();
      await engine.executeRaw('DROP TABLE oauth_tokens');
      await engine.executeRaw(FOREIGN_TOKENS);
      await engine.executeRaw(FOREIGN_ROW);
      await engine.setConfig('version', '205');
      const error = await runMigrations(engine).then(() => null, (e: unknown) => e as Error);
      expect(error?.message).toContain('oauth_tokens.expires_at is timestamp with time zone');
      expect(error?.message).toContain('needs bigint');
      expect(error?.message).toContain('SET SCHEMA');
      expect(error?.message).toContain('gbrain apply-migrations --force-schema --yes');
      expect(await engine.getConfig('version')).toBe('205');
      expect(await engine.executeRaw('SELECT token_type FROM oauth_tokens')).toEqual([{ token_type: 'Bearer' }]);
    }, 300_000);

    test('#9190: a fresh install refuses a foreign oauth_codes, oauth_clients or oauth_tokens before creating any gbrain table', async () => {
      for (const [ddl, named] of [
        ['CREATE TABLE oauth_codes (code_hash text PRIMARY KEY, client_id text, expires_at timestamptz)', 'oauth_codes.expires_at is timestamp with time zone'],
        ['CREATE TABLE oauth_clients (client_id uuid PRIMARY KEY, client_name text)', 'oauth_clients.client_id is uuid'],
        ['CREATE TABLE oauth_tokens (token_hash text PRIMARY KEY, token_type text, client_id text, scopes text[], resource text, created_at timestamptz)', 'oauth_tokens.expires_at is missing'],
      ] as const) {
        const b = await brain(false);
        const engine = await b.open();
        await engine.executeRaw(ddl);
        const error = await engine.initSchema().then(() => null, (e: unknown) => e as Error);
        expect(error?.message).toContain(named);
        expect(await engine.executeRaw<{ t: string | null }>(`SELECT to_regclass('pages')::text AS t`)).toEqual([{ t: null }]);
        await close(engine);
      }
    }, 300_000);

    test('#9191: rerunning apply-migrations --force-schema recreates a blob-owned table that is missing', async () => {
      const b = await brain(true);
      const engine = await b.open();
      await engine.executeRaw('DROP TABLE oauth_tokens');
      await engine.setConfig('version', '209');
      await close(engine);
      const run = await applyMigrations(b, FORCE_SCHEMA);
      expect(run.code, run.out).toBe(0);
      const after = await b.open();
      expect(await shapeOf(after, 'oauth_tokens')).toBe('bigint');
      expect(await after.getConfig('version')).toBe(String(LATEST_VERSION));
    }, 300_000);

    test('gbrain\'s own OAuth tables in an older release\'s shape pass the check and upgrade to head', async () => {
      for (const [from, keep] of [[32, V32_COLUMNS], [209, null]] as const) {
        const b = await brain(true);
        const engine = await b.open();
        for (const table of ['oauth_clients', 'oauth_tokens', 'oauth_codes'] as const) {
          const later = keep ? (await engine.executeRaw<{ c: string }>(
            `SELECT attname AS c FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`, [table]))
            .map(r => r.c).filter(c => !keep[table].includes(c)) : ADDED_AFTER_V209[table];
          for (const column of later) await engine.executeRaw(`ALTER TABLE ${table} DROP COLUMN ${column} CASCADE`);
        }
        await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('client-example', 'Example client')`);
        await engine.executeRaw(`INSERT INTO oauth_tokens (token_hash, token_type, client_id, expires_at) VALUES ('token-example', 'access', 'client-example', 4102444800)`);
        await engine.executeRaw(`INSERT INTO oauth_codes (code_hash, client_id, code_challenge, redirect_uri, expires_at) VALUES ('code-example', 'client-example', 'challenge', 'http://localhost/cb', 4102444800)`);
        await engine.setConfig('version', String(from));
        await close(engine);
        const run = await applyMigrations(b, ['--yes', '--non-interactive', '--no-autopilot-install']);
        expect(run.code, `from v${from}: ${run.out}`).toBe(0);
        expect(run.out).not.toContain('foreign_table');
        const after = await b.open();
        expect(await after.getConfig('version')).toBe(String(LATEST_VERSION));
        expect(await after.executeRaw('SELECT token_type FROM oauth_tokens')).toEqual([{ token_type: 'access' }]);
        expect(await after.executeRaw('SELECT code_hash FROM oauth_codes')).toEqual([{ code_hash: 'code-example' }]);
        expect(await after.executeRaw(`SELECT to_regclass('oauth_tokens') IS NOT NULL AS t, (SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'oauth_tokens'::regclass AND attname = 'grant_type') AS g, (SELECT count(*)::int FROM pg_attribute WHERE attrelid = 'oauth_clients'::regclass AND attname = 'attest_read') AS a`))
          .toEqual([{ t: true, g: 1, a: 1 }]);
        await close(after);
      }
    }, 600_000);

    test('a brain stopped at v210 by a foreign table recovers with the steps the refusal names', async () => {
      const b = await brain(true);
      const engine = await b.open();
      await engine.executeRaw('DROP TABLE oauth_tokens');
      await engine.executeRaw(FOREIGN_TOKENS);
      await engine.executeRaw(FOREIGN_ROW);
      await engine.setConfig('version', '209');
      await close(engine);
      for (const args of [FORCE_SCHEMA, ['--yes', '--non-interactive', '--no-autopilot-install']]) {
        const refused = await applyMigrations(b, args);
        expect(refused.code, refused.out).toBe(1);
        expect(refused.out).toContain('[foreign_table]');
        expect(refused.out).toContain('oauth_tokens.expires_at is timestamp with time zone');
      }

      const moving = await b.open();
      await moving.executeRaw('CREATE SCHEMA other_app_example');
      await moving.executeRaw('ALTER TABLE oauth_tokens SET SCHEMA other_app_example');
      await close(moving);
      const rerun = await applyMigrations(b, FORCE_SCHEMA);
      expect(rerun.code, rerun.out).toBe(0);
      const after = await b.open();
      expect(await shapeOf(after, 'oauth_tokens')).toBe('bigint');
      expect(await shapeOf(after, 'other_app_example.oauth_tokens')).toBe('timestamp with time zone');
      expect(await after.executeRaw('SELECT token_type FROM other_app_example.oauth_tokens')).toEqual([{ token_type: 'Bearer' }]);
      expect(await after.getConfig('version')).toBe(String(LATEST_VERSION));
    }, 300_000);
  });
}
