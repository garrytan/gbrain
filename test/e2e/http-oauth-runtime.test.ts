/**
 * E2E HTTP OAuth runtime smoke.
 *
 * This simulates a ChatGPT-style OAuth client against the real Bun HTTP MCP
 * server and a real Postgres database. It does not require ChatGPT, OpenAI, or
 * Anthropic credentials.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const smokeScriptPath = `${repoRoot}/scripts/smoke-test-http-oauth.ts`;

test('package exposes the HTTP OAuth smoke command', () => {
  const packageJson = JSON.parse(readFileSync(`${repoRoot}/package.json`, 'utf-8')) as {
    scripts?: Record<string, string>;
  };

  expect(packageJson.scripts?.['smoke:http-oauth']).toBe('bun run scripts/smoke-test-http-oauth.ts');
  expect(existsSync(smokeScriptPath)).toBe(true);
});

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('E2E: HTTP OAuth runtime smoke', () => {
  beforeAll(setupDB);
  afterAll(teardownDB);

  test('completes OAuth/DCR/PKCE over the real HTTP server and records Postgres evidence', async () => {
    const smoke = await import('../../scripts/smoke-test-http-oauth.ts') as {
      runHttpOAuthSmoke: (options: {
        databaseUrl: string;
        host: string;
        port: number;
        approvalToken: string;
        signingSecret: string;
        cleanup: boolean;
      }) => Promise<{
        baseUrl: string;
        accessTokenRows: number;
        requestLogRows: number;
        logOperations: string[];
        refreshedTokenWorked: boolean;
        initialTokenRejectedAfterRefresh: boolean;
      }>;
    };

    const consoleLogs: unknown[][] = [];
    const originalLog = console.log;
    let result: Awaited<ReturnType<typeof smoke.runHttpOAuthSmoke>>;
    console.log = (...args: unknown[]) => {
      consoleLogs.push(args);
    };
    try {
      result = await smoke.runHttpOAuthSmoke({
        databaseUrl: process.env.DATABASE_URL!,
        host: '127.0.0.1',
        port: 0,
        approvalToken: 'owner-secret',
        signingSecret: 'test-signing-secret',
        cleanup: false,
      });
    } finally {
      console.log = originalLog;
    }

    expect(result.baseUrl).toStartWith('http://127.0.0.1:');
    expect(result.accessTokenRows).toBeGreaterThanOrEqual(2);
    expect(result.requestLogRows).toBeGreaterThanOrEqual(4);
    expect(result.logOperations).toEqual(expect.arrayContaining([
      'initialize',
      'tools/list',
      'get_stats',
    ]));
    expect(result.refreshedTokenWorked).toBe(true);
    expect(result.initialTokenRejectedAfterRefresh).toBe(true);
    expect(consoleLogs).toEqual([]);

    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const accessTokens = await sql`
        SELECT name, scopes, last_used_at, revoked_at FROM access_tokens
        WHERE name = 'oauth:MBrain OAuth Smoke'
        ORDER BY created_at
      `;
      expect(accessTokens.length).toBeGreaterThanOrEqual(2);
      expect(accessTokens.every(row => Array.isArray(row.scopes) && row.scopes.includes('mcp'))).toBe(true);
      expect(accessTokens.every(row => row.last_used_at !== null)).toBe(true);
      expect(accessTokens.filter(row => row.revoked_at !== null)).toHaveLength(1);
      expect(accessTokens.filter(row => row.revoked_at === null)).toHaveLength(accessTokens.length - 1);

      const logs = await sql`
        SELECT token_name, operation, status FROM mcp_request_log
        WHERE token_name = 'oauth:MBrain OAuth Smoke'
        ORDER BY created_at
      `;
      expect(logs.map(row => row.operation)).toEqual(expect.arrayContaining([
        'initialize',
        'tools/list',
        'get_stats',
      ]));
      expect(logs.every(row => row.status === 'success')).toBe(true);
    } finally {
      await sql`
        DELETE FROM mcp_request_log
        WHERE token_name = 'oauth:MBrain OAuth Smoke'
      `;
      await sql`
        DELETE FROM access_tokens
        WHERE name = 'oauth:MBrain OAuth Smoke'
      `;
      await sql.end();
    }
  });
});
