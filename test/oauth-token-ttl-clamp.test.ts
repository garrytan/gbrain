/**
 * #5040: access tokens never outlive the 90-day maximum. Authoring gate:
 * (1) protects issuance (per-client override and server default), the
 * upgrade clamp of stored client lifetimes and outstanding access tokens
 * (audited, never lengthening, refresh tokens untouched, re-runnable), the
 * rescope of a formerly out-of-range client, the whoami repair template and
 * the `serve --token-ttl` bounds; (2) fails when a stored or configured
 * lifetime above the maximum is honored, or an upgraded brain keeps a
 * 10-year token valid; (3) the existing DCR TTL tests only cover in-range
 * overrides; (4) no production seam. Both engines: PGLite here, PostgreSQL
 * through test/e2e/oauth-token-ttl-clamp-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { readClientGrant, rescopeClientGrant } from '../src/core/grants/service.ts';
import { describeAuthCapabilities } from '../src/core/harness/capabilities.ts';
import * as auth from '../src/commands/auth.ts';
import { runServe } from '../src/commands/serve.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const TEN_YEARS = 315_360_000;
const DAY = 86_400;
const NINETY_DAYS = 7_776_000;

for (const kind of testBackends()) {
  describe(`OAuth access-token lifetime ceiling (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let provider: GBrainOAuthProvider;
    const providerFor = (tokenTtl?: number) => new GBrainOAuthProvider({
      sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))), tokenTtl,
    });
    beforeAll(async () => {
      if (kind === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      provider = providerFor();
    }, 120_000);
    afterAll(async () => { await close?.(); });

    const machineClient = (name: string) => provider.registerClientManual(name, ['client_credentials'], 'read', [], 'default');
    const storeTtl = (clientId: string, ttl: number | null) =>
      engine.executeRaw('UPDATE oauth_clients SET token_ttl = $1 WHERE client_id = $2', [ttl, clientId]);
    const seedToken = async (clientId: string, type: 'access' | 'refresh', ageSeconds: number, expiresIn: number) => {
      const token = `gbrain_${type === 'access' ? 'at' : 'rt'}_fixture_${crypto.randomUUID()}`;
      const now = Math.floor(Date.now() / 1000);
      await engine.executeRaw(
        `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, created_at)
         VALUES ($1, $2, $3, ARRAY['read'], $4, to_timestamp($5))`,
        [hashToken(token), type, clientId, now + expiresIn, now - ageSeconds],
      );
      return { token, createdAt: now - ageSeconds, expiresAt: now + expiresIn };
    };
    const expiryOf = async (token: string) =>
      Number((await engine.executeRaw<{ expires_at: string }>('SELECT expires_at FROM oauth_tokens WHERE token_hash = $1', [hashToken(token)]))[0]!.expires_at);
    const auditRows = (clientId: string) => engine.executeRaw<{ action: string; actor: string; before_grant: any; after_grant: any }>(
      'SELECT action, actor, before_grant, after_grant FROM oauth_grant_audit WHERE client_id = $1 AND actor = $2 ORDER BY id', [clientId, 'migration']);
    const clampMigration = MIGRATIONS.find(m => m.name.endsWith('clamp_oauth_token_ttl'));
    const rerunClamp = async () => {
      expect(clampMigration).toBeDefined();
      await engine.setConfig('version', String(clampMigration!.version - 1));
      await runMigrations(engine);
    };

    test('a stored override above the maximum issues a 90-day token', async () => {
      const { clientId, clientSecret } = await machineClient('ttl-override-example');
      await storeTtl(clientId, TEN_YEARS);
      const tokens = await provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
      expect(tokens.expires_in).toBe(NINETY_DAYS);
      const auth = await provider.verifyAccessToken(tokens.access_token);
      expect(auth.expiresAt! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(NINETY_DAYS);
    });

    test('a server default above the maximum issues a 90-day token', async () => {
      const longDefault = providerFor(TEN_YEARS);
      const { clientId, clientSecret } = await longDefault.registerClientManual('ttl-default-example', ['client_credentials'], 'read', [], 'default');
      const tokens = await longDefault.exchangeClientCredentials(clientId, clientSecret!, 'read');
      expect(tokens.expires_in).toBe(NINETY_DAYS);
    });

    test('upgrade clamps stored lifetimes and outstanding access tokens, audited and re-runnable', async () => {
      const over = await machineClient('ttl-over-example');
      const under = await machineClient('ttl-under-example');
      const zero = await machineClient('ttl-zero-example');
      const valid = await machineClient('ttl-valid-example');
      await storeTtl(over.clientId, TEN_YEARS);
      await storeTtl(under.clientId, 30);
      await storeTtl(zero.clientId, 0);
      await storeTtl(valid.clientId, 3600);
      const old = await seedToken(over.clientId, 'access', 100 * DAY, 9 * 365 * DAY);
      const recent = await seedToken(over.clientId, 'access', DAY, 9 * 365 * DAY);
      const shorter = await seedToken(over.clientId, 'access', DAY, 3600);
      const refresh = await seedToken(over.clientId, 'refresh', 100 * DAY, 9 * 365 * DAY);
      const validToken = await seedToken(valid.clientId, 'access', DAY, 3600);
      const revisions = new Map<string, number>();
      for (const c of [over, under, zero, valid]) revisions.set(c.clientId, (await readClientGrant(engine, c.clientId)).revision);

      const beforeAuth = await provider.verifyAccessToken(old.token);
      const whoami = describeAuthCapabilities(beforeAuth);
      expect(whoami.remediation.map(r => r.reason)).toContain('token_ttl_invalid');
      expect(whoami.delegation_repair?.preview_command).toContain('--token-ttl');
      expect(whoami.delegation_repair?.missing_choices.map(c => c.placeholder)).toContain('<APPROVED_TTL_SECONDS>');

      await rerunClamp();

      expect((await readClientGrant(engine, over.clientId)).tokenTtlSeconds).toBe(NINETY_DAYS);
      expect((await readClientGrant(engine, under.clientId)).tokenTtlSeconds).toBe(60);
      expect((await readClientGrant(engine, zero.clientId)).tokenTtlSeconds).toBeNull();
      expect((await readClientGrant(engine, valid.clientId)).tokenTtlSeconds).toBe(3600);
      for (const c of [over, under, zero]) expect((await readClientGrant(engine, c.clientId)).revision).toBe(revisions.get(c.clientId)! + 1);
      expect((await readClientGrant(engine, valid.clientId)).revision).toBe(revisions.get(valid.clientId)!);

      await expect(provider.verifyAccessToken(old.token)).rejects.toThrow('Token expired');
      expect(await expiryOf(recent.token)).toBe(recent.createdAt + NINETY_DAYS);
      expect((await provider.verifyAccessToken(recent.token)).expiresAt).toBe(recent.createdAt + NINETY_DAYS);
      expect(await expiryOf(shorter.token)).toBe(shorter.expiresAt);
      expect(await expiryOf(refresh.token)).toBe(refresh.expiresAt);
      expect(await expiryOf(validToken.token)).toBe(validToken.expiresAt);

      const overAudit = await auditRows(over.clientId);
      expect(overAudit.map(r => r.action)).toEqual(['clamp_token_ttl', 'shorten_access_tokens']);
      expect(overAudit[0]!.before_grant.tokenTtlSeconds).toBe(TEN_YEARS);
      expect(overAudit[0]!.after_grant.tokenTtlSeconds).toBe(NINETY_DAYS);
      expect(overAudit[1]!.after_grant.shortenedAccessTokens).toBe(2);
      expect((await auditRows(under.clientId))[0]!.before_grant.tokenTtlSeconds).toBe(30);
      expect(await auditRows(valid.clientId)).toEqual([]);
      const marked = await auth.tokenLifetimeClampedClients(engine);
      expect([over, under, zero, valid].map(c => marked.has(c.clientId))).toEqual([true, true, true, false]);

      await rerunClamp();
      expect((await auditRows(over.clientId)).length).toBe(2);
      expect(await expiryOf(recent.token)).toBe(recent.createdAt + NINETY_DAYS);
      expect((await readClientGrant(engine, over.clientId)).revision).toBe(revisions.get(over.clientId)! + 1);

      const rescoped = await rescopeClientGrant(engine, over.clientId, { surface: 'verbs' }, { actor: 'test' });
      expect(rescoped.after.surface).toBe('verbs');
      expect(rescoped.after.tokenTtlSeconds).toBe(NINETY_DAYS);
    }, 60_000);

    test('a token issued at the maximum a few seconds off its created_at is not shortened or marked clamped', async () => {
      const { clientId } = await machineClient('ttl-at-max-example');
      await storeTtl(clientId, NINETY_DAYS);
      const atMax = await seedToken(clientId, 'access', DAY, NINETY_DAYS - DAY + 2);
      await rerunClamp();
      expect(await expiryOf(atMax.token)).toBe(atMax.expiresAt);
      expect(await auditRows(clientId)).toEqual([]);
    }, 60_000);

    test('a token issued after waiting on the client lock expires within the maximum of its own created_at', async () => {
      const { clientId, clientSecret } = await machineClient('ttl-lock-wait-example');
      await storeTtl(clientId, TEN_YEARS);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let lockTaken!: () => void;
      const taken = new Promise<void>(resolve => { lockTaken = resolve; });
      const holder = engine.transaction(async tx => {
        await tx.executeRaw('SELECT 1 FROM oauth_clients WHERE client_id = $1 FOR UPDATE', [clientId]);
        lockTaken();
        await held;
      });
      await taken;
      const issued = provider.exchangeClientCredentials(clientId, clientSecret!, 'read');
      await new Promise(resolve => setTimeout(resolve, 1_100));
      release();
      await holder;
      await issued;
      const rows = await engine.executeRaw<{ over: string }>(
        `SELECT count(*) AS over FROM oauth_tokens WHERE client_id = $1 AND token_type = 'access'
           AND expires_at > FLOOR(EXTRACT(EPOCH FROM created_at))::bigint + $2`, [clientId, NINETY_DAYS]);
      expect(Number(rows[0]!.over)).toBe(0);
    }, 60_000);

    test('issuance racing the upgrade never leaves a token past the maximum', async () => {
      const { clientId, clientSecret } = await machineClient('ttl-race-example');
      await storeTtl(clientId, TEN_YEARS);
      await engine.setConfig('version', String(clampMigration!.version - 1));
      await Promise.all([
        runMigrations(engine),
        ...Array.from({ length: 4 }, () => provider.exchangeClientCredentials(clientId, clientSecret!, 'read')),
      ]);
      const rows = await engine.executeRaw<{ over: string }>(
        `SELECT count(*) AS over FROM oauth_tokens WHERE client_id = $1 AND token_type = 'access'
           AND expires_at > FLOOR(EXTRACT(EPOCH FROM created_at))::bigint + $2`, [clientId, NINETY_DAYS]);
      expect(Number(rows[0]!.over)).toBe(0);
    }, 60_000);
  });
}

describe('serve --token-ttl bounds', () => {
  for (const value of [String(TEN_YEARS), 'abc', '0', '']) {
    test(`--token-ttl ${JSON.stringify(value)} is refused before the server starts`, async () => {
      await expect(runServe({} as BrainEngine, ['--http', '--token-ttl', value])).rejects.toThrow(
        '--token-ttl must be an integer number of seconds between 60 and 7776000 (90 days)');
    });
  }
});
