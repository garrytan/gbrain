/**
 * GBRA-585 E: `gbrain auth create <name> --member <id>` without --scopes mints read and write only.
 *
 * 1. Protects: the documented way to give a person a key (access-designations.md, ADMIN.md) no longer mints an admin
 *    key; an explicit --scopes still wins (admin included), and a token without --member keeps today's grant.
 * 2. Fails when: a --member token without --scopes can call an admin operation (get_stats), cannot search or write, or
 *    --scopes / the no-member default change.
 * 3. Existing coverage: auth-create-args.test.ts (argument parsing), the scope checks of each operation.
 * 4. Real seams: `bun src/cli.ts auth create` spawned against PGLite and Postgres, the key verified by the
 *    serve --http verifier, held to the serve --http scope gate (operationScopesAllowed) and dispatched remote=true.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { openBrainFile } from './helpers/setup-serves-box.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operationsByName } from '../src/core/operations.ts';
import { operationScopesAllowed } from '../src/core/scope.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { runCli } from './helpers/cli-spawn.ts';

const roots: string[] = [];
afterAll(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

interface Brain { env: Record<string, string | undefined>; engine: () => Promise<BrainEngine>; close: () => Promise<void> }

async function brain(kind: string): Promise<Brain> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-auth-member-'));
  roots.push(home);
  const base = { HOME: home, GBRAIN_HOME: home, GBRAIN_SOURCE: undefined };
  if (kind === 'postgres') {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    return { env: { ...base, GBRAIN_DATABASE_URL: pg.databaseUrl, DATABASE_URL: pg.databaseUrl }, engine: async () => pg.engine, close: pg.close };
  }
  const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { env: base, timeoutMs: 120_000 });
  expect(init.exitCode).toBe(0);
  let engine: PGLiteEngine | null = null;
  return {
    env: base,
    engine: async () => {
      engine = await openBrainFile(home);
      return engine;
    },
    close: async () => { await engine?.disconnect(); },
  };
}

const tokenOf = (stdout: string) => stdout.match(/gbrain_[0-9a-f]{16,}/)![0];

async function call(engine: BrainEngine, token: string, tool: string, params: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
  if (!operationScopesAllowed(auth.scopes, operationsByName[tool]!)) return { isError: true, text: 'insufficient_scope (the serve --http scope gate)' };
  const out = await dispatchToolCall(engine, tool, params, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'] });
  return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
}

for (const kind of testBackends()) {
  describe(`E: auth create --member mints read and write (${kind})`, () => {
    test('--member without --scopes: read,write; get_stats is refused while search and put_page work; --scopes and no --member are unchanged', async () => {
      const b = await brain(kind);
      try {
        const cli = (args: string[]) => runCli(args, { env: b.env, timeoutMs: 120_000 });
        expect((await cli(['access', 'member', 'add', 'dave-example'])).exitCode).toBe(0);
        const laptop = await cli(['auth', 'create', 'dave-laptop', '--member', 'dave-example']);
        expect(laptop.exitCode).toBe(0);
        expect(laptop.stdout).toContain('scopes=["read","write"]');
        expect(laptop.stdout).toContain('--scopes read,write,admin');
        const admin = await cli(['auth', 'create', 'dave-admin', '--member', 'dave-example', '--scopes', 'read,write,admin']);
        expect(admin.exitCode).toBe(0);
        const bot = await cli(['auth', 'create', 'house-bot']);
        expect(bot.exitCode).toBe(0);
        expect(bot.stdout).toContain('full access (grandfathered');
        const engine = await b.engine();
        const rows = await engine.executeRaw<{ name: string; scopes: string[] | null }>("SELECT name, scopes FROM access_tokens WHERE revoked_at IS NULL ORDER BY name");
        expect(rows.map(r => [r.name, r.scopes])).toEqual([['dave-admin', ['read', 'write', 'admin']], ['dave-laptop', ['read', 'write']], ['house-bot', null]]);
        const key = tokenOf(laptop.stdout);
        const stats = await call(engine, key, 'get_stats', {});
        expect(stats.isError).toBe(true);
        expect(stats.text).toMatch(/scope/i);
        const put = await call(engine, key, 'put_page', { slug: 'notes/dave-plan', content: '---\ntitle: Dave plan\n---\n# Dave plan\n\nHarbor ledger notes davecanary.\n' });
        expect(put.isError === false || put.text.includes('"code": "write_pending"')).toBe(true);
        expect(put.text).not.toMatch(/insufficient_scope|permission_denied/);
        const found = await call(engine, key, 'search', { query: 'harbor ledger notes', match: 'keyword', limit: 5 });
        expect(found.isError).toBe(false);
        expect((await call(engine, tokenOf(admin.stdout), 'get_stats', {})).isError).toBe(false);
      } finally {
        await b.close();
      }
    }, 300_000);

    test("an owner's key made with --member reads the same pages as one made with the old full-access default", async () => {
      const b = await brain(kind);
      try {
        const cli = (args: string[]) => runCli(args, { env: b.env, timeoutMs: 120_000 });
        expect((await cli(['access', 'member', 'add', 'owner-example'])).exitCode).toBe(0);
        expect((await cli(['access', 'owner', 'set', 'owner-example'])).exitCode).toBe(0);
        for (const [slug, canary] of [['notes/world-topic', 'worldcanary'], ['journal/owner-day', 'journalcanary']]) {
          expect((await cli(['put', slug, '--content', `---\ntitle: ${slug}\n---\n# ${slug}\n\nHarbor ledger notes ${canary}.\n`])).exitCode).toBe(0);
        }
        const before = await cli(['auth', 'create', 'owner-old', '--member', 'owner-example', '--scopes', 'read,write,admin']);
        const after = await cli(['auth', 'create', 'owner-new', '--member', 'owner-example']);
        expect(before.exitCode).toBe(0);
        expect(after.exitCode).toBe(0);
        const engine = await b.engine();
        const reads = async (token: string) => {
          const r = await call(engine, token, 'search', { query: 'harbor ledger notes', match: 'keyword', limit: 20 });
          expect(r.isError).toBe(false);
          return ['worldcanary', 'journalcanary'].filter(c => r.text.includes(c)).sort();
        };
        expect(await reads(tokenOf(before.stdout))).toEqual(['journalcanary', 'worldcanary']);
        expect(await reads(tokenOf(after.stdout))).toEqual(await reads(tokenOf(before.stdout)));
      } finally {
        await b.close();
      }
    }, 300_000);
  });
}
