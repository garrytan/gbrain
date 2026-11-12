/**
 * migration preflight must name the table and column when a foreign oauth_tokens table has a
 * non-bigint expires_at, instead of surfacing a raw operator error.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

test('preflight reports the mismatched expires_at type', async () => {
  await engine.executeRaw('ALTER TABLE oauth_tokens ALTER COLUMN expires_at TYPE timestamptz USING to_timestamp(expires_at)');
  await engine.setConfig('version', '209');
  let message = '';
  try { await runMigrations(engine); } catch (e) { message = e instanceof Error ? e.message : String(e); }
  expect(message).toContain('oauth_tokens.expires_at is timestamp with time zone, expected bigint');
});
