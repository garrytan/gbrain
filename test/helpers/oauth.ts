import { createHash } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { Response } from 'express';
import type { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import type { OAuthTransaction } from '../../src/core/oauth-grants.ts';
import type { SqlQuery } from '../../src/core/sql-query.ts';

export const TEST_PKCE_VERIFIER = 'synthetic-verifier-for-oauth-regression-fixtures-0123456789';
export const TEST_PKCE_CHALLENGE = createHash('sha256').update(TEST_PKCE_VERIFIER).digest('base64url');
export function pgliteOAuthTransaction(db: PGlite): OAuthTransaction {
  return fn => db.transaction(async tx => {
    const sql: SqlQuery = async (strings, ...values) => {
      const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
      return (await tx.query<Record<string, unknown>>(query, values)).rows;
    };
    return fn(sql);
  });
}

/** Existing grant tests explicitly simulate the owner's decision after authorization. */
export async function authorizeAsOwner(provider: GBrainOAuthProvider, client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
  let pendingUrl = '';
  await provider.authorize(client, params, { redirect: (url: string) => { pendingUrl = url; } } as Response);
  const id = new URL(pendingUrl, 'https://brain.example').searchParams.get('oauth_request');
  if (!id) throw new Error('Expected owner consent request');
  res.redirect(await provider.grants.decide(id, true));
}
