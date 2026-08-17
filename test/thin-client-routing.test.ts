/**
 * CLI→MCP gap-closure wave [OV6] — unit pins for routeThinClientCommand
 * (src/commands/thin-client-routing.ts).
 *
 * Three behaviors pinned per route:
 *   (a) op name + param mapping (who→holder, --row→row_num, --outcome
 *       true→correct, --days→number, --queue passthrough, --include-flagged);
 *   (b) host-bound forms return false (search modes --reset, search tune
 *       --apply, quarantine scan/clear, takes extract) so the caller falls
 *       through to refuseThinClient's hint;
 *   (c) recognized-but-malformed routable forms print usage + exit(1)
 *       instead of returning false (the subcommand IS routable — the args
 *       are just wrong).
 *
 * The remote transport is stubbed via spyOn on the mcp-client module
 * namespace (NOT mock.module — isolation guard R2 keeps module mocks out of
 * non-serial files): callRemoteTool records (tool, args) and returns a real
 * MCP content envelope, so the REAL unpackToolResult exercises the
 * JSON.parse(content[0].text) path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as mcpClient from '../src/core/mcp-client.ts';
import { routeThinClientCommand } from '../src/commands/thin-client-routing.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const cfg = {} as GBrainConfig; // callRemoteTool is stubbed; cfg is never read

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let callSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
const logs: string[] = [];
const errs: string[] = [];

beforeAll(() => {
  callSpy = spyOn(mcpClient, 'callRemoteTool').mockImplementation(
    async (_cfg: GBrainConfig, tool: string, args: Record<string, unknown> = {}) => {
      calls.push({ tool, args });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ row_num: 1, old_row: 1, new_row: 2, resolved_by: 'mcp:x' }),
        }],
      };
    },
  );
  logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
});

afterAll(() => {
  callSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

beforeEach(() => {
  calls.length = 0;
  logs.length = 0;
  errs.length = 0;
});

/** One recorded remote call, asserted whole (op name + exact args). */
function soleCall(): { tool: string; args: Record<string, unknown> } {
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

describe('routeThinClientCommand — (a) op name + param mapping per route', () => {
  test('takes list: positional slug → page_slug, --who → holder, --kind passthrough', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['list', 'people/alice-example', '--who', 'world', '--kind', 'fact'])).toBe(true);
    expect(soleCall()).toEqual({
      tool: 'takes_list',
      args: { page_slug: 'people/alice-example', holder: 'world', kind: 'fact' },
    });
  });

  test('takes list with no slug omits page_slug entirely', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['list'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'takes_list', args: {} });
  });

  test('takes search: positional query + numeric --limit', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['search', 'runway', '--limit', '5'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'takes_search', args: { query: 'runway', limit: 5 } });
  });

  test('takes scorecard: positional holder', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['scorecard', 'world'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'takes_scorecard', args: { holder: 'world' } });
  });

  test('takes calibration: --holder flag', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['calibration', '--holder', 'brain'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'takes_calibration', args: { holder: 'brain' } });
  });

  test('takes add: --who maps to holder, --since passes through, --weight numeric', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', [
      'add', 'people/alice-example', '--claim', 'c', '--kind', 'fact', '--who', 'world',
      '--weight', '0.7', '--source', 'meeting', '--since', '2026-01',
    ])).toBe(true);
    expect(soleCall()).toEqual({
      tool: 'takes_add',
      args: {
        slug: 'people/alice-example', claim: 'c', kind: 'fact', holder: 'world',
        weight: 0.7, source: 'meeting', since: '2026-01',
      },
    });
    expect(logs.join('\n')).toContain('Added take #1');
  });

  test('takes update: --row maps to row_num', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['update', 'people/alice-example', '--row', '2', '--weight', '0.4'])).toBe(true);
    expect(soleCall()).toEqual({
      tool: 'takes_update',
      args: { slug: 'people/alice-example', row_num: 2, weight: 0.4 },
    });
  });

  test('takes resolve: --quality passes through verbatim', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['resolve', 'people/alice-example', '--row', '3', '--quality', 'partial', '--evidence', 'ev', '--value', '12', '--unit', 'usd'])).toBe(true);
    expect(soleCall()).toEqual({
      tool: 'takes_resolve',
      args: { slug: 'people/alice-example', row_num: 3, quality: 'partial', evidence: 'ev', value: 12, unit: 'usd' },
    });
  });

  test('takes resolve: back-compat --outcome true maps to quality correct (+ deprecation warn)', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['resolve', 'people/alice-example', '--row', '1', '--outcome', 'true'])).toBe(true);
    expect(soleCall()).toEqual({
      tool: 'takes_resolve',
      args: { slug: 'people/alice-example', row_num: 1, quality: 'correct' },
    });
    expect(errs.join('\n')).toContain('[deprecated]');
    expect(logs.join('\n')).toContain('quality=correct');
  });

  test('takes resolve: --outcome false maps to quality incorrect', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['resolve', 'people/alice-example', '--row', '1', '--outcome', 'false'])).toBe(true);
    expect(soleCall().args.quality).toBe('incorrect');
  });

  test('takes supersede: --row → row_num, --who → holder, claim passthrough', async () => {
    expect(await routeThinClientCommand(cfg, 'takes', ['supersede', 'people/alice-example', '--row', '1', '--claim', 'newer', '--who', 'brain', '--kind', 'bet', '--weight', '0.3'])).toBe(true);
    expect(soleCall()).toEqual({
      tool: 'takes_supersede',
      args: { slug: 'people/alice-example', row_num: 1, claim: 'newer', kind: 'bet', holder: 'brain', weight: 0.3 },
    });
    expect(logs.join('\n')).toContain('Superseded #1 → new #2');
  });

  test('search modes (read form) → search_modes with empty args', async () => {
    expect(await routeThinClientCommand(cfg, 'search', ['modes'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'search_modes', args: {} });
  });

  test('search stats: --days becomes a NUMBER', async () => {
    expect(await routeThinClientCommand(cfg, 'search', ['stats', '--days', '7'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'search_stats', args: { days: 7 } });
  });

  test('search tune (read form) → search_tune with empty args', async () => {
    expect(await routeThinClientCommand(cfg, 'search', ['tune'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'search_tune', args: {} });
  });

  test('jobs stats: --queue passthrough → get_job_stats', async () => {
    expect(await routeThinClientCommand(cfg, 'jobs', ['stats', '--queue', 'embed'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'get_job_stats', args: { queue: 'embed' } });
  });

  test('cache stats → cache_stats with empty args', async () => {
    expect(await routeThinClientCommand(cfg, 'cache', ['stats'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'cache_stats', args: {} });
  });

  test('quarantine list: --include-flagged → include_flagged true', async () => {
    expect(await routeThinClientCommand(cfg, 'quarantine', ['list', '--include-flagged'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'quarantine_list', args: { include_flagged: true } });
    calls.length = 0;
    expect(await routeThinClientCommand(cfg, 'quarantine', ['list'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'quarantine_list', args: {} });
  });
});

describe('routeThinClientCommand — (b) host-bound forms return false', () => {
  const hostBound: Array<[string, string[]]> = [
    ['search', ['modes', '--reset']],
    ['search', ['tune', '--apply']],
    ['quarantine', ['scan']],
    ['quarantine', ['clear']],
    ['takes', ['extract']],
  ];

  for (const [command, args] of hostBound) {
    test(`${command} ${args.join(' ')} → false, no remote call`, async () => {
      expect(await routeThinClientCommand(cfg, command, args)).toBe(false);
      expect(calls).toHaveLength(0);
    });
  }
});

describe('routeThinClientCommand — (c) malformed routable forms print usage + exit 1', () => {
  async function expectUsageExit(command: string, args: string[]): Promise<void> {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    let exited: string | null = null;
    try {
      await routeThinClientCommand(cfg, command, args);
    } catch (e) {
      if (!(e as Error).message.startsWith('EXIT:')) throw e;
      exited = (e as Error).message;
    } finally {
      exitSpy.mockRestore();
    }
    expect(exited).toBe('EXIT:1');
    expect(errs.join('\n')).toContain('Usage:');
    // No remote write attempted on a usage error.
    expect(calls).toHaveLength(0);
  }

  test('takes search with no query', async () => {
    await expectUsageExit('takes', ['search']);
  });

  test('takes add missing --claim/--kind/--who', async () => {
    await expectUsageExit('takes', ['add', 'people/alice-example']);
  });

  test('takes update missing --row', async () => {
    await expectUsageExit('takes', ['update', 'people/alice-example', '--weight', '0.5']);
  });

  test('takes resolve missing --quality and --outcome', async () => {
    await expectUsageExit('takes', ['resolve', 'people/alice-example', '--row', '1']);
  });

  test('takes resolve with a non-boolean --outcome', async () => {
    await expectUsageExit('takes', ['resolve', 'people/alice-example', '--row', '1', '--outcome', 'maybe']);
  });

  test('takes supersede missing --claim', async () => {
    await expectUsageExit('takes', ['supersede', 'people/alice-example', '--row', '1']);
  });
});
