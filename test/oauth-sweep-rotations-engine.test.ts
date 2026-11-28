/**
 * serve --http builds its OAuth provider with the engine attached, and sweeps expired credentials once at startup
 * (serve-http.ts). Master (ceaaca6fae, #10485) made that sweep also clear refresh-token rotation records: a sealed
 * replacement pair is wiped once its reuse grace window passes, and a rotation record is deleted once the rotated
 * token would have expired. The sweep must do that with the engine attached too, not only through the SqlQuery path.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: GBrainOAuthProvider({ sql, engine, transaction }).sweepExpiredTokens() deletes expired rotation records,
 *    wipes sealed pairs past the grace window, keeps a fresh rotation's sealed pair, and counts the deleted records.
 *  - Regression: the engine path returned after deleteExpiredOauthCredentials, so a serve --http brain on Postgres or
 *    PGLite kept every expired rotation record and every sealed token pair forever.
 *  - Why existing coverage misses it: oauth-refresh-grace-9364.test.ts sweeps through OAuthGrants directly, and
 *    oauth.test.ts builds the provider without an engine.
 *  - Seam: the real provider over a real brain (PGLite, and Postgres when DATABASE_URL is set), rows written directly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { REFRESH_REUSE_GRACE_MS } from '../src/core/oauth-grants.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) {
  describe(`the startup sweep with the engine attached clears refresh rotations (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 60_000);
    afterAll(async () => { await close?.(); }, 30_000);

    test('expired rotation records are deleted, stale sealed pairs wiped, a fresh one kept', async () => {
      // As serve-http.ts builds it: the engine and a transaction that hands over the engine handle.
      const provider = new GBrainOAuthProvider({
        sql: sqlQueryForEngine(engine), engine,
        transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx), tx)),
      });
      const { clientId } = await provider.registerClientManual('sweep-rotations', ['authorization_code', 'refresh_token'], 'read',
        ['http://127.0.0.1:8989/oauth/callback'], 'default', undefined, 'none');
      const nowMs = Date.now();
      const nowS = Math.floor(nowMs / 1000);
      const insert = (hash: string, rotatedAtMs: number, expiresAt: number, sealed: string | null) => engine.executeRaw(
        `INSERT INTO oauth_refresh_rotations (token_hash, client_id, family_id, replaced_by_hash, rotated_at_ms, expires_at, sealed_pair)
         VALUES ($1, $2, 'family-sweep', $3, $4, $5, $6)`, [hash, clientId, hash + '-next', rotatedAtMs, expiresAt, sealed]);
      await insert('sweep-expired', nowMs - 2 * REFRESH_REUSE_GRACE_MS, nowS - 60, null);
      await insert('sweep-stale-seal', nowMs - REFRESH_REUSE_GRACE_MS - 60_000, nowS + 3600, 'sealed-stale');
      await insert('sweep-fresh-seal', nowMs, nowS + 3600, 'sealed-fresh');

      const swept = await provider.sweepExpiredTokens();

      const rows = await engine.executeRaw<{ token_hash: string; sealed_pair: string | null }>(
        "SELECT token_hash, sealed_pair FROM oauth_refresh_rotations WHERE family_id = 'family-sweep' ORDER BY token_hash COLLATE \"C\"");
      expect(rows).toEqual([
        { token_hash: 'sweep-fresh-seal', sealed_pair: 'sealed-fresh' },
        { token_hash: 'sweep-stale-seal', sealed_pair: null },
      ]);
      // No token or code had expired, so the one deleted rotation record is the whole count.
      expect(swept).toBe(1);
    });
  });
}
