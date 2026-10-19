/**
 * A real operator-bound Postgres cancellation must reach a resident MCP
 * caller as an actionable keyword timeout, in both keyword-only branches.
 * The unit owner injects driver errors; this owner proves native SQLSTATE
 * 57014 and the stdio envelope using a tiny fixture and a held table lock.
 * Reverting the op mapping makes the envelope assertion fail. No new seam.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import postgres from '#postgres';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

let engine: PostgresEngine;
let close: (() => Promise<void>) | undefined;
let locker: ReturnType<typeof postgres>;
let client: Client;
let transport: StdioClientTransport;
let home: string;

beforeAll(async () => {
  const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  ({ engine, close } = isolated);
  await engine.putPage('notes/example', { type: 'note', title: 'Commonterm fixture', compiled_truth: 'commonterm' });
  await installFixtureChunks(engine, 'notes/example', [{ chunk_index: 0, chunk_text: 'commonterm', chunk_source: 'compiled_truth' }]);
  await engine.setConfig('search.keyword_statement_timeout_ms', '1000');
  await engine.setConfig('search.mcp_keyword_only', 'false');
  locker = postgres(isolated.databaseUrl, { max: 1, prepare: false });
  home = mkdtempSync(join(tmpdir(), 'gbrain-keyword-timeout-'));
  mkdirSync(join(home, '.gbrain'));
  writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: isolated.databaseUrl, embedding_disabled: true }));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', '--surface', 'starter', '--access', 'read-only'],
    cwd: process.cwd(),
    env: keylessBrainEnv(process.env, home, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined,
      GBRAIN_ENGINE: undefined, GBRAIN_SWEEP: '0', GBRAIN_SKIP_STARTUP_HOOKS: '1',
    }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  client = new Client({ name: 'keyword-timeout-fixture', version: '1' });
  await client.connect(transport);
  const ready = await client.callTool({ name: 'search', arguments: { query: 'commonterm', match: 'keyword', limit: 10 } });
  expect(ready.isError).not.toBe(true);
  expect(JSON.parse((ready.content as Array<{ text: string }>)[0]!.text)).toHaveLength(1);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await transport?.close();
  await locker?.end({ timeout: 5 });
  await close?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

for (const keywordOnly of [false, true]) {
  test(`native timeout reaches MCP (${keywordOnly ? 'operator keyword-only' : 'keyword paging'})`, async () => {
    await engine.setConfig('search.mcp_keyword_only', String(keywordOnly));
    const tx = await locker.reserve();
    try {
      await tx.unsafe('BEGIN');
      await tx.unsafe('LOCK TABLE content_chunks IN ACCESS EXCLUSIVE MODE');
      // Establish the native premise separately; the engine still throws the
      // original driver error, and only the keyword-only op maps it.
      const read = keywordOnly
        ? engine.searchKeyword('commonterm', { sourceId: 'default', limit: 10 })
        : engine.searchKeywordPages('commonterm', { sourceId: 'default' }, { limit: 10 });
      const native = await read.then(() => null, error => error);
      expect(native?.code).toBe('57014');
      expect(native?.message).toContain('due to statement timeout');
      const result = await client.callTool({ name: 'search', arguments: { query: 'commonterm', limit: 10, ...(keywordOnly ? {} : { match: 'keyword' }) } });
      expect(result.isError).toBe(true);
      const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(body).toMatchObject({ code: 'keyword_statement_timeout', class: 'retryable', retryable: true });
      expect(body.suggestion).toContain('source_id');
      expect(body.suggestion).toContain('types');
      expect(body.suggestion).toContain('more specific query');
    } finally {
      await tx.unsafe('ROLLBACK');
      tx.release();
    }
    const recovered = await client.callTool({ name: 'search', arguments: { query: 'commonterm', match: 'keyword', limit: 10 } });
    expect(recovered.isError).not.toBe(true);
    expect(JSON.parse((recovered.content as Array<{ text: string }>)[0]!.text)).toHaveLength(1);
  }, 30_000);
}
