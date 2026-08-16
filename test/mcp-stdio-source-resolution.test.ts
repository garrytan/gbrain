import { describe, test, expect, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveMcpStdioSourceScope } from '../src/mcp/server.ts';
import { withEnv } from './helpers/with-env.ts';

function makeEngine(registeredSources: string[]): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const id = params?.[0];
        return (typeof id === 'string' && registeredSources.includes(id)
          ? [{ id } as T]
          : []);
      }
      if (sql.includes('SELECT id, local_path FROM sources')) return [];
      if (sql.includes('SELECT id, config, archived FROM sources')) {
        return registeredSources.map(id => ({ id, config: null, archived: false }) as T);
      }
      return [];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

function writeSourceDotfile(dir: string, sourceId: string): void {
  const path = join(dir, '.gbrain-source');
  writeFileSync(path, `${sourceId}\n`);
  chmodSync(path, 0o600);
}

describe('stdio MCP source resolution', () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('honors .gbrain-source when GBRAIN_SOURCE is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mcp-source-'));
    scratchDirs.push(dir);
    writeSourceDotfile(dir, 'team-alpha');

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      const scope = await resolveMcpStdioSourceScope(
        makeEngine(['default', 'team-alpha']),
        dir,
      );

      expect(scope).toEqual({ sourceId: 'team-alpha', tier: 'dotfile' });
    });
  });

  test('GBRAIN_SOURCE wins over .gbrain-source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mcp-source-'));
    scratchDirs.push(dir);
    writeSourceDotfile(dir, 'team-alpha');

    await withEnv({ GBRAIN_SOURCE: 'env-source' }, async () => {
      const scope = await resolveMcpStdioSourceScope(
        makeEngine(['default', 'team-alpha', 'env-source']),
        dir,
      );

      expect(scope).toEqual({ sourceId: 'env-source', tier: 'env' });
    });
  });
});
