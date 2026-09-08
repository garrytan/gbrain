import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertStdioSourceBindable } from '../src/mcp/source-preflight.ts';
import { DEGRADED_STATE } from '../src/core/degraded-marker.ts';
import { withEnv } from './helpers/with-env.ts';

function makeEngine(
  registeredSources: string[],
  opts: { throwing?: boolean; archived?: string[] } = {},
): BrainEngine {
  return {
    kind: 'postgres',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (opts.throwing) throw new Error('engine down');
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const id = params?.[0];
        if (typeof id !== 'string' || !registeredSources.includes(id)) return [];
        // Mirror the real predicate: an archived row is only filtered out when
        // the query asks for it.
        if (sql.includes('archived = false') && opts.archived?.includes(id)) return [];
        return [{ id } as T];
      }
      return [];
    },
  } as unknown as BrainEngine;
}

describe('stdio MCP source preflight', () => {
  test('no GBRAIN_SOURCE: nothing to check', async () => {
    await expect(assertStdioSourceBindable(makeEngine(['default']), undefined)).resolves.toBeUndefined();
    await expect(assertStdioSourceBindable(makeEngine(['default']), '')).resolves.toBeUndefined();
  });

  test('registered source passes', async () => {
    await expect(assertStdioSourceBindable(makeEngine(['default', 'wiki']), 'wiki')).resolves.toBeUndefined();
  });

  test('well-formed but unregistered source refuses to serve, naming the value and the fix', async () => {
    const p = assertStdioSourceBindable(makeEngine(['default']), 'workspace');
    await expect(p).rejects.toThrow(/GBRAIN_SOURCE="workspace" is not a registered active source/);
    await expect(assertStdioSourceBindable(makeEngine(['default']), 'workspace')).rejects.toThrow(/gbrain sources list/);
  });

  test('archived source refuses to serve, same as a missing one', async () => {
    const engine = makeEngine(['default', 'old-wiki'], { archived: ['old-wiki'] });
    await expect(assertStdioSourceBindable(engine, 'old-wiki')).rejects.toThrow(/missing or archived/);
  });

  test('__all__ sentinel and malformed values are left to the resolver', async () => {
    await expect(assertStdioSourceBindable(makeEngine(['default']), '__all__')).resolves.toBeUndefined();
    await expect(assertStdioSourceBindable(makeEngine(['default']), 'Not A Valid Id!')).resolves.toBeUndefined();
  });

  test('engine failure does not block startup (guards config, not connectivity)', async () => {
    await expect(assertStdioSourceBindable(makeEngine([], { throwing: true }), 'workspace')).resolves.toBeUndefined();
  });

  test('degraded engine: preflight is skipped without touching executeRaw', async () => {
    let calls = 0;
    const engine = {
      kind: 'postgres',
      [DEGRADED_STATE]: () => true,
      executeRaw: async <T>(): Promise<T[]> => { calls++; return []; },
    } as unknown as BrainEngine;
    await expect(assertStdioSourceBindable(engine, 'workspace')).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  // Integration: the guard is wired into startMcpServer and fires BEFORE any
  // transport attaches. This is the discriminating case for the fix — without
  // the server.ts wiring, startMcpServer proceeds and this expectation fails.
  const scratch: string[] = [];
  afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

  test('startMcpServer refuses a phantom GBRAIN_SOURCE before attaching a transport', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-preflight-home-'));
    scratch.push(home);
    const { startMcpServer } = await import('../src/mcp/server.ts');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: 'phantom-source' }, async () => {
      await expect(startMcpServer(makeEngine(['default']))).rejects.toThrow(/GBRAIN_SOURCE="phantom-source" is not a registered active source/);
    });
  });
});
