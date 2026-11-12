import type { BrainEngine } from '../engine.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { TOKEN_TTL_MAX_SECONDS, TOKEN_TTL_MIN_SECONDS, grantFromRow } from '../grants/model.ts';
import { migrationNotice } from './helpers.ts';
import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Brings stored per-client access-token lifetimes and outstanding access
// tokens inside the issuance bounds (src/core/grants/model.ts). An override
// above the maximum becomes the maximum, a positive one below the minimum
// becomes the minimum, and a non-positive one (issued as the server default)
// becomes NULL. Outstanding access tokens expire no later than created_at plus
// the maximum; no expiry is ever extended. Refresh tokens and legacy bearer
// tokens are untouched. Every change writes an oauth_grant_audit row. All
// client rows are locked first so in-flight issuance commits before tokens
// are shortened. Re-running finds nothing left to change.
/**
 * Older releases stamped created_at at transaction start on the database clock
 * and expires_at from the application clock after the client lock, so a token
 * issued at exactly the maximum can read a few seconds over it. Tokens within
 * this slack were never out of bounds and are left alone (no audit row).
 */
const ISSUANCE_CLOCK_SLACK_SECONDS = 300;

export async function clampOAuthTokenTtls(engine: BrainEngine): Promise<void> {
  await engine.transaction(async tx => {
    const sql = sqlQueryForEngine(tx);
    const clients = await sql`SELECT * FROM oauth_clients ORDER BY client_id FOR UPDATE`;
    const names = new Map(clients.map(row => [String(row.client_id), String(row.client_name ?? '')]));
    for (const row of clients) {
      const before = grantFromRow(row);
      const stored = before.tokenTtlSeconds;
      if (stored === null || (stored >= TOKEN_TTL_MIN_SECONDS && stored <= TOKEN_TTL_MAX_SECONDS)) continue;
      const tokenTtlSeconds = stored > TOKEN_TTL_MAX_SECONDS ? TOKEN_TTL_MAX_SECONDS : stored > 0 ? TOKEN_TTL_MIN_SECONDS : null;
      const after = { ...before, tokenTtlSeconds, revision: before.revision + 1 };
      await sql`UPDATE oauth_clients SET token_ttl = ${tokenTtlSeconds}, grant_revision = ${after.revision} WHERE client_id = ${before.clientId}`;
      await sql`INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
        VALUES (${before.clientId}, 'migration', 'clamp_token_ttl', ${after.revision},
          ${JSON.stringify(before)}::text::jsonb, ${JSON.stringify(after)}::text::jsonb)`;
      migrationNotice(`  OAuth client ${before.clientName || '<unnamed>'} (${before.clientId}): access-token lifetime ${stored}s -> ${tokenTtlSeconds ?? 'server default'}${tokenTtlSeconds === null ? '' : 's'}\n`);
    }
    const shortened = await sql`UPDATE oauth_tokens
      SET expires_at = FLOOR(EXTRACT(EPOCH FROM created_at))::bigint + ${TOKEN_TTL_MAX_SECONDS}
      WHERE token_type = 'access' AND expires_at > FLOOR(EXTRACT(EPOCH FROM created_at))::bigint + ${TOKEN_TTL_MAX_SECONDS + ISSUANCE_CLOCK_SLACK_SECONDS}
      RETURNING client_id`;
    const perClient = new Map<string, number>();
    for (const row of shortened) perClient.set(String(row.client_id), (perClient.get(String(row.client_id)) ?? 0) + 1);
    for (const [clientId, count] of perClient) {
      const [current] = await sql`SELECT grant_revision FROM oauth_clients WHERE client_id = ${clientId}`;
      const revision = Number(current?.grant_revision ?? 0);
      await sql`INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
        VALUES (${clientId}, 'migration', 'shorten_access_tokens', ${revision}, NULL,
          ${JSON.stringify({ clientId, shortenedAccessTokens: count, maxAccessTokenLifetimeSeconds: TOKEN_TTL_MAX_SECONDS })}::text::jsonb)`;
      migrationNotice(`  OAuth client ${names.get(clientId) || '<unnamed>'} (${clientId}): ${count} access token(s) now expire 90 days after issue\n`);
    }
  });
}

export const v210: Migration = {
  version: 210,
  name: 'clamp_oauth_token_ttl',
  idempotent: true,
  sql: '',
  handler: clampOAuthTokenTtls,
};
