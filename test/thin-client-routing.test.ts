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
 *   (c) recognized-but-malformed routable forms report a nonzero CLI verdict
 *       instead of returning false (the subcommand IS routable — the args
 *       are just wrong).
 *
 * The remote transport is stubbed via spyOn on the mcp-client module
 * namespace (NOT mock.module — isolation guard R2 keeps module mocks out of
 * non-serial files): callRemoteTool records (tool, args) and returns a real
 * MCP content envelope, so the REAL unpackToolResult exercises the
 * JSON.parse(content[0].text) path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as mcpClient from '../src/core/mcp-client.ts';
import { routeThinClientCommand } from '../src/commands/thin-client-routing.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const cfg: GBrainConfig = { engine: 'pglite', remote_mcp: { mcp_url: 'http://127.0.0.1:1/mcp', issuer_url: 'http://127.0.0.1:1', oauth_client_id: 'fixture', oauth_client_secret: 'fixture' } };

const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let callSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let previousExitCode: typeof process.exitCode;
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

afterEach(() => {
  _resetCliExitVerdictForTests();
  // Verdicts also mirror process.exitCode; undefined does not clear it in Bun.
  process.exitCode = previousExitCode ?? 0;
});

beforeEach(() => {
  previousExitCode = process.exitCode;
  _resetCliExitVerdictForTests();
  calls.length = 0;
  logs.length = 0;
  errs.length = 0;
});

/** One recorded remote call, asserted whole (op name + exact args). */
function soleCall(): { tool: string; args: Record<string, unknown> } {
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  if (['takes_add', 'takes_update', 'takes_resolve', 'takes_supersede'].includes(call.tool)) {
    expect(call.args.request_id).toMatch(/^[0-9a-f-]{36}$/);
    const { request_id, ...args } = call.args;
    return { ...call, args };
  }
  return call;
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

describe('routeThinClientCommand — beliefs changes runs through the host delta', () => {
  const window = { source_id: 'default', since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z', coverage_from: null, truncated: false,
    changes: [{ kind: 'fact', slug: 'companies/acme-example', change: 'added', subject: { claim: 'Acme sells gadgets' }, before: null, after: { fact: 'Acme sells gadgets' },
      before_known: true, cause: { event: 'fact.asserted', op: 'put_page' }, evidence: { event_id: 7, recorded_at: '2026-10-02T00:00:00.000Z', slug: 'companies/acme-example', row: 1 }, trust_tier: 'agent' }] };
  const reply = (body: unknown) => callSpy.mockImplementationOnce(async (_cfg: GBrainConfig, tool: string, args: Record<string, unknown> = {}) => {
    calls.push({ tool, args });
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  });

  test('entities and --since map onto delta {since, beliefs, entities}; the text is the host renderer', async () => {
    reply({ pages: [], beliefs: window });
    expect(await routeThinClientCommand(cfg, 'beliefs', ['changes', 'companies/acme-example', 'people/alice-example', '--since', '2026-10-01'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'delta', args: { since: '2026-10-01T00:00:00.000Z', beliefs: true, entities: 'companies/acme-example,people/alice-example' } });
    expect(logs.join('\n')).toBe(['Belief changes on default from 2026-10-01T00:00:00.000Z to 2026-10-08T00:00:00.000Z: 1',
      '- [2026-10-02] fact on companies/acme-example: added "Acme sells gadgets" (put_page, event 7, row 1)'].join('\n'));
  });

  test('a host whose delta has no beliefs is reported, not printed as empty', async () => {
    reply({ pages: [] });
    const stderr: string[] = [];
    const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as never);
    try {
      expect(await routeThinClientCommand(cfg, 'beliefs', ['changes'])).toBe(true);
    } finally { write.mockRestore(); }
    expect(currentExitCode()).not.toBe(0);
    expect(stderr.join('')).toContain('Error [unavailable]: The remote brain\'s delta does not return belief changes');
    expect(logs).toEqual([]);
  });
});

describe('routeThinClientCommand — (b) host-bound forms return false', () => {
  const hostBound: Array<[string, string[]]> = [
    ['search', ['modes', '--reset']],
    ['search', ['tune', '--apply']],
    ['quarantine', ['scan']],
    ['quarantine', ['clear']],
    ['takes', ['extract']],
    ['takes', ['grades']],
    ['beliefs', ['changes', '--source', 'notes']],
    ['beliefs', ['status']],
    ['takes', ['horizon', 'scan']],
    ['takes', ['horizon', 'set', 'companies/acme-example', '--row', '1', '--date', '2025-06-30']],
    ['takes', ['horizon', 'clear', 'companies/acme-example', '--row', '1']],
    ['takes', ['journal']],
    ['takes', ['journal', '--holder', 'alice-example', '--json']],
    ['takes', ['scorecard', '--group-by', 'holder']],
    ['takes', ['scorecard', 'alice-example', '--min-n', '5']],
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
    if (command === 'takes' && ['add', 'update', 'resolve', 'supersede'].includes(args[0])) {
      expect(exited).toBeNull();
      expect(currentExitCode()).toBe(1);
      expect(errs.join('\n')).toContain('Error [invalid_params]');
    } else {
      expect(exited).toBe('EXIT:1');
      expect(errs.join('\n')).toContain('Usage:');
    }
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

describe('routeThinClientCommand — wakeshift watch (Wakeshift report-back over MCP)', () => {
  const TAIL = 'Wakeshift: run \`wakeshift wait --session sk-example\` in the background to be woken.';
  function respond(result: unknown, extra: Array<{ type: string; text: string }>): void {
    callSpy.mockImplementationOnce(async (_cfg: GBrainConfig, tool: string, args: Record<string, unknown> = {}) => {
      calls.push({ tool, args });
      return { content: [{ type: 'text', text: JSON.stringify(result) }, ...extra] };
    });
  }
  const watching = { watching: true, watch: 3, job: 812, event: 'gbrain.job.finished', status: 'active', already_finished: false, expires_in: '7d', fallback: 'If no wake arrives, call wait_job 812 (or run gbrain jobs wait 812).' };

  test('watch job routes to watch_job with the caller params as given, and the tail is the last stdout line', async () => {
    respond(watching, [{ type: 'text', text: TAIL }]);
    expect(await routeThinClientCommand(cfg, 'wakeshift', ['watch', 'job', '812', '--session-key', 'sk-example', '--harness', 'grok-bot', '--conversation-id', 'conv-1'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'watch_job', args: { id: 812, session_key: 'sk-example', harness: 'grok-bot', conversation_id: 'conv-1' } });
    expect(logs.at(-1)).toBe(TAIL);
    expect(logs.join('\n')).toContain('wait_job 812');
    expect(errs.join('\n')).not.toContain('sk-example');
  });

  test('no --harness sends no harness; write and cron route to their own ops', async () => {
    respond(watching, []);
    expect(await routeThinClientCommand(cfg, 'wakeshift', ['watch', 'job', '9'])).toBe(true);
    expect(calls.at(-1)).toEqual({ tool: 'watch_job', args: { id: 9 } });
    respond({ watching: true, request_id: 'req-example' }, []);
    expect(await routeThinClientCommand(cfg, 'wakeshift', ['watch', 'write', 'req-example', '--harness', 'muse'])).toBe(true);
    expect(calls.at(-1)).toEqual({ tool: 'watch_write_request', args: { request_id: 'req-example', harness: 'muse' } });
    respond({ watching: true, name: 'nightly-digest' }, []);
    expect(await routeThinClientCommand(cfg, 'wakeshift', ['watch', 'cron', 'nightly-digest'])).toBe(true);
    expect(calls.at(-1)).toEqual({ tool: 'watch_cron', args: { name: 'nightly-digest' } });
  });

  test('--json prints the result as one JSON line, then the tail last; a gbrain notice block is never taken for the tail', async () => {
    respond(watching, [{ type: 'text', text: TAIL }]);
    expect(await routeThinClientCommand(cfg, 'wakeshift', ['watch', 'job', '812', '--json'])).toBe(true);
    expect(JSON.parse(logs[0]!)).toEqual(watching);
    expect(logs.at(-1)).toBe(TAIL);
    logs.length = 0;
    respond(watching, [{ type: 'text', text: '[gbrain notice no_worker kind=info]\nwhy: no worker' }]);
    expect(await routeThinClientCommand(cfg, 'wakeshift', ['watch', 'job', '812', '--json'])).toBe(true);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toEqual(watching);
  });

  test('accept-terms routes to accept_wakeshift_terms with the terms_version and prints what to do next', async () => {
    respond({ accepted: true, terms_version: '0123456789abcdef', next: 'Call the watch tool again.' }, []);
    expect(await routeThinClientCommand(cfg, 'wakeshift', ['accept-terms', '0123456789abcdef'])).toBe(true);
    expect(soleCall()).toEqual({ tool: 'accept_wakeshift_terms', args: { terms_version: '0123456789abcdef' } });
    expect(logs.join('\n')).toContain('Run the watch again');
  });

  test('only watch routes: every other wakeshift subcommand is host-bound', async () => {
    for (const sub of ['status', 'enable', 'disable', 'test']) {
      expect(await routeThinClientCommand(cfg, 'wakeshift', [sub])).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  test('a malformed watch is a usage error with nothing sent', async () => {
    for (const args of [['watch'], ['watch', 'job'], ['watch', 'job', 'abc'], ['watch', 'page', 'x'], ['watch', 'job', '1', '--harness']]) {
      expect(await routeThinClientCommand(cfg, 'wakeshift', args)).toBe(true);
      expect(currentExitCode()).toBe(2);
      _resetCliExitVerdictForTests();
    }
    expect(calls).toHaveLength(0);
  });
});
