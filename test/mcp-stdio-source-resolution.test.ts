import { describe, test, expect, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveMcpStdioSourceScope } from '../src/mcp/server.ts';
import { withEnv } from './helpers/with-env.ts';
import { stubSourceMembers, type StubSourceMemberOptions } from './helpers/source-members-stub.ts';

function makeEngine(registeredSources: string[], opts: StubSourceMemberOptions = {}): BrainEngine {
  return {
    kind: 'pglite',
    ...stubSourceMembers(registeredSources.map(id => ({ id })), opts),
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

      // #5081: an explicit tier carries the explicit-read binding; no source
      // in this fixture is federated, so it admits only the bound source.
      expect(scope).toEqual({
        sourceId: 'team-alpha',
        tier: 'dotfile',
        explicitReadBinding: { sourceId: 'team-alpha', via: '.gbrain-source', sourceIds: ['team-alpha'], optedOut: [] },
      });
    });
  });

  test('#5081: a failed admission lookup keeps the resolved pin instead of falling back to default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-mcp-source-'));
    scratchDirs.push(dir);
    writeSourceDotfile(dir, 'team-alpha');
    // The dotfile's existence check answers (the first listAllSources); the admission lookup (the next source read, the
    // active list and then the every-source fallback) fails.
    let activeListReads = 0;
    const failing = makeEngine(['default', 'team-alpha'], {
      fail: member => {
        if (member === 'listAllSources' && ++activeListReads > 1) return new Error('sources table unavailable');
        if (member === 'listSourceRecords') return new Error('sources table unavailable');
        return undefined;
      },
    });

    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      expect(await resolveMcpStdioSourceScope(failing, dir)).toEqual({ sourceId: 'team-alpha', tier: 'dotfile' });
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

      expect(scope).toEqual({
        sourceId: 'env-source',
        tier: 'env',
        explicitReadBinding: { sourceId: 'env-source', via: 'GBRAIN_SOURCE', sourceIds: ['env-source'], optedOut: [] },
      });
    });
  });
});
