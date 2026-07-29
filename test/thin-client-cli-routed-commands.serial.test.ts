/**
 * Thin-client routed CLI-only commands must work with a null local engine.
 *
 * This locks the pre-connectEngine seam: if handleCliOnly reverts to opening
 * a local engine on thin clients, these commands will throw before the remote
 * MCP branch can run.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GBrainConfig } from '../src/core/config.ts';

const remoteConfig = {
  remote_mcp: { mcp_url: 'http://thin-client.test/mcp' },
} as GBrainConfig;

const callRemoteTool = mock(async (_config: unknown, toolName: string) => ({ toolName }));
const unpackToolResult = mock((raw: { toolName: string }) => {
  switch (raw.toolName) {
    case 'get_recent_salience':
      return [{
        slug: 'people/alice',
        title: 'Alice',
        score: 1,
        emotional_weight: 0.5,
        take_count: 0,
      }];
    case 'think':
      return {
        answer: 'remote answer',
        gaps: [],
        warnings: [],
        modelUsed: 'anthropic:claude-sonnet-4-5',
        pagesGathered: 0,
        takesGathered: 0,
        graphHits: 0,
        citations: [],
      };
    case 'traverse_graph':
      return [];
    default:
      throw new Error(`unexpected tool ${raw.toolName}`);
  }
});

mock.module('../src/core/config.ts', () => ({
  loadConfig: () => remoteConfig,
  isThinClient: () => true,
}));

mock.module('../src/core/mcp-client.ts', () => ({
  callRemoteTool,
  unpackToolResult,
}));

const { runSalience } = await import('../src/commands/salience.ts');
const { runGraphQuery } = await import('../src/commands/graph-query.ts');
const { runThinkCli } = await import('../src/commands/think.ts');

beforeEach(() => {
  callRemoteTool.mockClear();
  unpackToolResult.mockClear();
});

describe('thin-client routed CLI-only commands', () => {
  test('salience uses the remote MCP path with a null engine', async () => {
    await runSalience(null, ['--json']);

    expect(callRemoteTool.mock.calls).toHaveLength(1);
    expect(callRemoteTool.mock.calls[0][1]).toBe('get_recent_salience');
    expect(unpackToolResult.mock.calls).toHaveLength(1);
  });

  test('graph-query uses the remote MCP path with a null engine', async () => {
    await runGraphQuery(null, ['people/alice', '--depth', '1']);

    expect(callRemoteTool.mock.calls).toHaveLength(1);
    expect(callRemoteTool.mock.calls[0][1]).toBe('traverse_graph');
    expect(unpackToolResult.mock.calls).toHaveLength(1);
  });

  test('think uses the remote MCP path with a null engine', async () => {
    await runThinkCli(null, ['what', 'needs', 'checking', '--json']);

    expect(callRemoteTool.mock.calls).toHaveLength(1);
    expect(callRemoteTool.mock.calls[0][1]).toBe('think');
    expect(unpackToolResult.mock.calls).toHaveLength(1);
  });
});
