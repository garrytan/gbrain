/**
 * v0.32/v0.33 thin-client routing audit — the ROUTE additions.
 *
 * On a thin-client install (`remote_mcp` in config) `gbrain forget` and
 * `gbrain jobs list|get` must call the remote MCP op instead of reading an
 * empty local store, and `runJobs` must refuse any other subcommand that
 * arrives with a null engine. The REFUSE additions are spawned in
 * test/cli-dispatch-thin-client.test.ts (refusedCommands); the recall route
 * is owned by test/recall-thin-client-fallback.serial.test.ts.
 *
 * callRemoteTool is stubbed with spyOn on the module namespace (the pattern
 * in test/thin-client-routing.test.ts) and returns a real MCP content
 * envelope, so the real unpackToolResult runs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mcpClient from '../src/core/mcp-client.ts';
import { runForget } from '../src/commands/recall.ts';
import { runJobs } from '../src/commands/jobs.ts';
import { withEnv } from './helpers/with-env.ts';

let home: string;
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let reply: unknown = null;
let callSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-thin-route-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'pglite',
    remote_mcp: { issuer_url: 'http://127.0.0.1:1', mcp_url: 'http://127.0.0.1:1/mcp', oauth_client_id: 'fixture', oauth_client_secret: 'fixture' },
  }));
  callSpy = spyOn(mcpClient, 'callRemoteTool').mockImplementation(
    async (_cfg: unknown, tool: string, args: Record<string, unknown> = {}) => {
      calls.push({ tool, args });
      return { content: [{ type: 'text', text: JSON.stringify(reply) }] } as never;
    },
  );
});

afterAll(() => {
  callSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => { calls.length = 0; });

async function thinClient(fn: () => Promise<void>): Promise<{ out: string; exitCode: number | undefined }> {
  const out: string[] = [];
  let exitCode: number | undefined;
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const err = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as never);
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { exitCode = code; throw new Error('__exit__'); }) as never);
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, fn);
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  } finally {
    log.mockRestore(); err.mockRestore(); write.mockRestore(); exit.mockRestore();
  }
  return { out: out.join('\n'), exitCode };
}

const job = { id: 7, name: 'embed', queue: 'default', status: 'completed', priority: 0, attempts_made: 1, max_attempts: 3, attempts_started: 1, stalled_counter: 0, max_stalled: 1, backoff_type: 'fixed', backoff_delay: 0, backoff_jitter: 0, stacktrace: [], data: {}, created_at: '2026-01-01T00:00:00.000Z' };

describe('thin-client routing audit — ROUTE additions call the remote op', () => {
  test('gbrain forget <id> calls the remote forget op and never a local engine', async () => {
    reply = { id: '42', expired: true };
    const { out } = await thinClient(() => runForget(async () => { throw new Error('local engine opened'); }, ['42', '--reason', 'fixture']));
    expect(calls.map(c => c.tool)).toEqual(['forget']);
    expect(calls[0].args).toMatchObject({ id: '42' });
    expect(out).toContain('Forgot fact id=42');
  });

  test('gbrain jobs list calls list_jobs with the parsed filters', async () => {
    reply = [job];
    const { out } = await thinClient(() => runJobs(null, ['list', '--status', 'completed', '--queue', 'default', '--limit', '5', '--json']));
    expect(calls).toEqual([{ tool: 'list_jobs', args: { status: 'completed', queue: 'default', limit: 5 } }]);
    expect(JSON.parse(out)[0].id).toBe(7);
  });

  test('gbrain jobs get <id> calls get_job with a numeric id', async () => {
    reply = job;
    const { out } = await thinClient(() => runJobs(null, ['get', '7']));
    expect(calls).toEqual([{ tool: 'get_job', args: { id: 7 } }]);
    expect(out).toContain('Job #7: embed (COMPLETED)');
  });

  test('runJobs refuses a non-routable subcommand that arrives with a null engine', async () => {
    const { out, exitCode } = await thinClient(() => runJobs(null, ['stats']));
    expect(exitCode).toBe(1);
    expect(out).toContain('`gbrain jobs stats` needs a local engine and cannot run on a thin client.');
    expect(calls).toEqual([]);
  });
});
