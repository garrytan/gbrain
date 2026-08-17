/**
 * `gbrain agent` CLI tests. Covers arg parsing, --since parser, and the
 * submit path end-to-end against PGLite so we verify trusted submission,
 * protected-name guard, and fan-out wiring.
 *
 * The full handler-run loop is NOT exercised here (tested in subagent-
 * handler.test.ts). This file checks the CLI's submission + orchestration
 * glue.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { __testing as agentTesting, runAgentRun } from '../src/commands/agent.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseSince } from '../src/commands/agent-logs.ts';
import { isProtectedJobName, PROTECTED_JOB_NAMES } from '../src/core/minions/protected-names.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('parseRunFlags', () => {
  test('follow defaults off when stdout is non-TTY (test env)', () => {
    const { flags, rest } = agentTesting.parseRunFlags(['hello', 'world']);
    expect(flags.follow).toBe(process.stdout.isTTY === true);
    expect(rest).toEqual(['hello', 'world']);
  });

  test('leading flags parsed; first positional begins the prompt', () => {
    const { flags, rest } = agentTesting.parseRunFlags([
      '--model', 'claude-opus-4-7', '--max-turns', '30', 'summarize', 'everything',
    ]);
    expect(flags.model).toBe('claude-opus-4-7');
    expect(flags.maxTurns).toBe(30);
    expect(rest).toEqual(['summarize', 'everything']);
  });

  test('--tools comma-split', () => {
    const { flags } = agentTesting.parseRunFlags(['--tools', 'brain_search, brain_get_page', 'prompt']);
    expect(flags.tools).toEqual(['brain_search', 'brain_get_page']);
  });

  test('--detach implies !follow', () => {
    const { flags } = agentTesting.parseRunFlags(['--detach', 'x']);
    expect(flags.detach).toBe(true);
    expect(flags.follow).toBe(false);
  });

  test('double-dash ends flag parsing explicitly', () => {
    const { flags, rest } = agentTesting.parseRunFlags(['--model', 'm', '--', '--not-a-flag']);
    expect(flags.model).toBe('m');
    expect(rest).toEqual(['--not-a-flag']);
  });

  test('#1738: unknown --flag is prompt text, not an error', () => {
    const { rest } = agentTesting.parseRunFlags(['--what', 'x']);
    expect(rest).toEqual(['--what', 'x']);
  });

  test('#1738: trailing --detach is hoisted out of the prompt', () => {
    const { flags, rest } = agentTesting.parseRunFlags(['do', 'the', 'thing', '--detach']);
    expect(flags.detach).toBe(true);
    expect(flags.follow).toBe(false);
    expect(rest).toEqual(['do', 'the', 'thing']);
  });

  test('#1738: leading flags + trailing switch both apply', () => {
    const { flags, rest } = agentTesting.parseRunFlags(['--model', 'm', 'summarize', '--detach', '--no-follow']);
    expect(flags.model).toBe('m');
    expect(flags.detach).toBe(true);
    expect(flags.follow).toBe(false);
    expect(rest).toEqual(['summarize']);
  });

  test('#1738: a --switch mid-prompt (not trailing) stays verbatim', () => {
    const { flags, rest } = agentTesting.parseRunFlags(['summarize', '--detach', 'the', 'doc']);
    expect(flags.detach).toBe(false);
    expect(rest).toEqual(['summarize', '--detach', 'the', 'doc']);
  });

  test('#1738: a freeform prompt starting with --word is preserved', () => {
    const { rest } = agentTesting.parseRunFlags(['--note:', 'do', 'the', 'thing']);
    expect(rest).toEqual(['--note:', 'do', 'the', 'thing']);
  });

  test('#1738: -- suppresses trailing-switch hoisting', () => {
    const { flags, rest } = agentTesting.parseRunFlags(['--', 'do', 'x', '--detach']);
    expect(flags.detach).toBe(false);
    expect(rest).toEqual(['do', 'x', '--detach']);
  });

  test('#1738: -- AFTER a positional also suppresses hoisting (no silent detach flip)', () => {
    // The leading-flag loop breaks at the first positional, so the `escaped`
    // flag never fires for a `--` placed later. A literal `--` ANYWHERE must
    // still mean "hoist nothing" — otherwise `agent run note -- body --detach`
    // silently detaches and drops the `--` as junk.
    const { flags, rest } = agentTesting.parseRunFlags(['note', '--', 'body', '--detach']);
    expect(flags.detach).toBe(false);
    expect(rest).toEqual(['note', '--', 'body', '--detach']);
  });

  test('#1738: value-flag missing its value throws a usage error', () => {
    expect(() => agentTesting.parseRunFlags(['--model'])).toThrow(/requires a value/);
    expect(() => agentTesting.parseRunFlags(['--model', '--detach', 'x'])).toThrow(/requires a value/);
  });

  test('#1738: numeric value-flag rejects a non-number', () => {
    expect(() => agentTesting.parseRunFlags(['--max-turns', 'abc', 'x'])).toThrow(/expects a number/);
  });

  test('--subagent-def + --timeout-ms parsed', () => {
    const { flags } = agentTesting.parseRunFlags([
      '--subagent-def', 'researcher', '--timeout-ms', '60000', 'hello',
    ]);
    expect(flags.subagentDef).toBe('researcher');
    expect(flags.timeoutMs).toBe(60000);
  });

  test('--fanout-manifest parsed', () => {
    const { flags } = agentTesting.parseRunFlags(['--fanout-manifest', '/tmp/m.json']);
    expect(flags.fanoutManifest).toBe('/tmp/m.json');
  });

  test('#2922: --source parsed as a leading value-flag', () => {
    const { flags, rest } = agentTesting.parseRunFlags(['--source', 'corporate', 'do', 'x']);
    expect(flags.source).toBe('corporate');
    expect(rest).toEqual(['do', 'x']);
  });

  test('#2922: --source missing its value throws a usage error', () => {
    expect(() => agentTesting.parseRunFlags(['--source'])).toThrow(/requires a value/);
    expect(() => agentTesting.parseRunFlags(['--source', '--detach', 'x'])).toThrow(/requires a value/);
  });
});

describe('parseSince', () => {
  test('returns undefined on empty input', () => {
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince('')).toBeUndefined();
  });

  test('parses ISO-8601 timestamps', () => {
    const iso = '2026-04-20T12:00:00.000Z';
    expect(parseSince(iso)).toBe(iso);
  });

  test('parses relative 5m', () => {
    const out = parseSince('5m')!;
    const parsed = new Date(out).getTime();
    const now = Date.now();
    expect(now - parsed).toBeGreaterThanOrEqual(5 * 60 * 1000 - 1000);
    expect(now - parsed).toBeLessThan(5 * 60 * 1000 + 1000);
  });

  test('parses relative 2h', () => {
    const out = parseSince('2h')!;
    const delta = Date.now() - new Date(out).getTime();
    expect(delta).toBeGreaterThanOrEqual(2 * 3600 * 1000 - 1000);
  });

  test('parses relative 1d', () => {
    const out = parseSince('1d')!;
    const delta = Date.now() - new Date(out).getTime();
    expect(delta).toBeGreaterThanOrEqual(86_400_000 - 1000);
  });

  test('throws on unparseable input', () => {
    expect(() => parseSince('not-a-date')).toThrow(/could not parse/);
  });
});

describe('protected-name guard includes subagent + aggregator', () => {
  test('shell stays protected', () => {
    expect(isProtectedJobName('shell')).toBe(true);
    expect(PROTECTED_JOB_NAMES.has('shell')).toBe(true);
  });

  test('subagent is protected (v0.15)', () => {
    expect(isProtectedJobName('subagent')).toBe(true);
  });

  test('subagent_aggregator is protected (v0.15)', () => {
    expect(isProtectedJobName('subagent_aggregator')).toBe(true);
  });

  test('a random non-protected name is not protected', () => {
    expect(isProtectedJobName('sync')).toBe(false);
  });

  test('trim normalization still blocks " subagent "', () => {
    expect(isProtectedJobName('  subagent  ')).toBe(true);
  });
});

describe('queue.add trusted-submit gate for subagent', () => {
  test('subagent without allowProtectedSubmit throws', async () => {
    await expect(queue.add('subagent', { prompt: 'hi' })).rejects.toThrow();
  });

  test('subagent with allowProtectedSubmit succeeds', async () => {
    const job = await queue.add('subagent', { prompt: 'hi' }, {}, { allowProtectedSubmit: true });
    expect(job.name).toBe('subagent');
    expect(job.status).toBe('waiting');
  });

  test('subagent_aggregator gated the same way', async () => {
    await expect(queue.add('subagent_aggregator', { children_ids: [] })).rejects.toThrow();
    const ok = await queue.add('subagent_aggregator', { children_ids: [1] }, {}, {
      allowProtectedSubmit: true,
    });
    expect(ok.name).toBe('subagent_aggregator');
  });

  test('v0.38 S1.7: subagent with any tool-supporting provider passes the queue gate', async () => {
    // v0.38 D6/D7 — the Anthropic pin is removed. The gateway tool loop
    // routes any provider with native tool calling. Submit-time guard now
    // refuses ONLY on unusable:no_tools or unknown verdicts.
    const openaiJob = await queue.add(
      'subagent',
      { prompt: 'hi', model: 'openai:gpt-5.2' },
      {},
      { allowProtectedSubmit: true },
    );
    expect(openaiJob.name).toBe('subagent');

    const googleJob = await queue.add(
      'subagent',
      { prompt: 'hi', model: 'google:gemini-1.5-pro' },
      {},
      { allowProtectedSubmit: true },
    );
    expect(googleJob.name).toBe('subagent');
  });

  test('v0.38 S1.7: subagent with Anthropic data.model still succeeds', async () => {
    const job = await queue.add(
      'subagent',
      { prompt: 'hi', model: 'anthropic:claude-opus-4-7' },
      {},
      { allowProtectedSubmit: true },
    );
    expect(job.name).toBe('subagent');
  });

  test('v0.38 S1.7: subagent with unknown provider is rejected at submit time', async () => {
    // The remaining hard reject — unknown providers can't be classified, so
    // we refuse the job rather than risk burning money on something we
    // can't verify supports tools.
    await expect(
      queue.add('subagent', { prompt: 'hi', model: 'madeup-provider:foo' }, {}, { allowProtectedSubmit: true }),
    ).rejects.toThrow(/unknown provider/i);
  });

  test('v0.38 S1.7: subagent with embedding-only provider (no chat) is rejected', async () => {
    // Voyage has no chat touchpoint → classifyCapabilities returns 'unknown' →
    // refused at submit. Same rejection path as unknown provider.
    await expect(
      queue.add('subagent', { prompt: 'hi', model: 'voyage:voyage-3-large' }, {}, { allowProtectedSubmit: true }),
    ).rejects.toThrow(/unknown provider/i);
  });
});

describe('#2922: submit-time source resolution', () => {
  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM sources WHERE id != 'default'`);
    await engine.unsetConfig('sources.default');
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('corporate', 'Corporate') ON CONFLICT (id) DO NOTHING`,
    );
  });

  async function jobData(jobId: number): Promise<Record<string, unknown>> {
    const rows = await engine.executeRaw<{ data: unknown }>(
      `SELECT data FROM minion_jobs WHERE id = $1`, [jobId],
    );
    return typeof rows[0]!.data === 'string'
      ? JSON.parse(rows[0]!.data as string)
      : rows[0]!.data as Record<string, unknown>;
  }

  async function onlyJobData(): Promise<Record<string, unknown>> {
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
    );
    expect(rows.length).toBe(1);
    return jobData(rows[0]!.id);
  }

  test('explicit --source lands on SubagentHandlerData.source_id', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      await runAgentRun(engine, ['--detach', '--source', 'corporate', 'write', 'a', 'page']);
      const data = await onlyJobData();
      expect(data.source_id).toBe('corporate');
      expect(data.prompt).toBe('write a page');
    });
  });

  test('no --source: sources.default (tier 5) is honored instead of the seed default', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      await engine.setConfig('sources.default', 'corporate');
      await runAgentRun(engine, ['--detach', 'write', 'a', 'page']);
      const data = await onlyJobData();
      expect(data.source_id).toBe('corporate');
    });
  });

  test('GBRAIN_SOURCE env (tier 2) is honored', async () => {
    await withEnv({ GBRAIN_SOURCE: 'corporate' }, async () => {
      await runAgentRun(engine, ['--detach', 'write', 'a', 'page']);
      const data = await onlyJobData();
      expect(data.source_id).toBe('corporate');
    });
  });

  test('no signal at all: resolves to the seed default (legacy behavior preserved)', async () => {
    await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
      await runAgentRun(engine, ['--detach', 'write', 'a', 'page']);
      const data = await onlyJobData();
      expect(data.source_id).toBe('default');
    });
  });

  test('fan-out children all carry the resolved source_id', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-source-'));
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        const manifestPath = path.join(tmp, 'm.json');
        fs.writeFileSync(manifestPath, JSON.stringify([
          { prompt: 'chunk 1' }, { prompt: 'chunk 2' },
        ]));
        await runAgentRun(engine, [
          '--source', 'corporate', '--fanout-manifest', manifestPath, '--detach',
        ]);
        const rows = await engine.executeRaw<{ id: number }>(
          `SELECT id FROM minion_jobs WHERE name = 'subagent' ORDER BY id`,
        );
        expect(rows.length).toBe(2);
        for (const r of rows) {
          const data = await jobData(r.id);
          expect(data.source_id).toBe('corporate');
        }
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--source "" (empty explicit value) exits 2 without silently falling back', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        try {
          await runAgentRun(engine, ['--detach', '--source', '', 'write', 'a', 'page']);
          throw new Error('expected runAgentRun to exit');
        } catch (e: any) {
          expect(e.message).toBe('EXIT');
        }
      });
      expect(spy).toHaveBeenCalledWith(2);
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(rows.length).toBe(0);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test('--source __all__ is rejected (subagent writes must target exactly one source)', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        try {
          await runAgentRun(engine, ['--detach', '--source', '__all__', 'write', 'a', 'page']);
          throw new Error('expected runAgentRun to exit');
        } catch (e: any) {
          expect(e.message).toBe('EXIT');
        }
      });
      expect(spy).toHaveBeenCalledWith(2);
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(rows.length).toBe(0);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test('--source pointing at a nonexistent id surfaces a clean error, not a stack trace', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        try {
          await runAgentRun(engine, ['--detach', '--source', 'does-not-exist', 'write', 'a', 'page']);
          throw new Error('expected runAgentRun to exit');
        } catch (e: any) {
          expect(e.message).toBe('EXIT');
        }
      });
      expect(spy).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('not found'))).toBe(true);
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(rows.length).toBe(0);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test('--source pointing at an archived source is rejected with a restore hint', async () => {
    const spy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('EXIT'); });
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'corporate'`);
      await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
        try {
          await runAgentRun(engine, ['--detach', '--source', 'corporate', 'write', 'a', 'page']);
          throw new Error('expected runAgentRun to exit');
        } catch (e: any) {
          expect(e.message).toBe('EXIT');
        }
      });
      expect(spy).toHaveBeenCalledWith(1);
      expect(errSpy.mock.calls.some(call => String(call[0]).includes('archived'))).toBe(true);
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT id FROM minion_jobs WHERE name = 'subagent'`,
      );
      expect(rows.length).toBe(0);
    } finally {
      await engine.executeRaw(`UPDATE sources SET archived = false WHERE id = 'corporate'`);
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('fan-out manifest shape (integration)', () => {
  test('fanout-manifest with 3 entries creates 3 subagent children + 1 aggregator', async () => {
    // Manually replicate what runAgentRun does for --fanout-manifest > 1.
    // We don't invoke runAgentRun (it calls process.exit on error) — we
    // assert that the plumbing works via direct queue calls with the
    // same flags it uses.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
    try {
      const manifestPath = path.join(tmp, 'm.json');
      fs.writeFileSync(manifestPath, JSON.stringify([
        { prompt: 'chunk 1' }, { prompt: 'chunk 2' }, { prompt: 'chunk 3' },
      ]));

      // Aggregator first.
      const agg = await queue.add(
        'subagent_aggregator',
        { children_ids: [] },
        { max_stalled: 3 },
        { allowProtectedSubmit: true },
      );
      const kids: number[] = [];
      for (const p of ['chunk 1', 'chunk 2', 'chunk 3']) {
        const c = await queue.add(
          'subagent',
          { prompt: p },
          { parent_job_id: agg.id, on_child_fail: 'continue', max_stalled: 3 },
          { allowProtectedSubmit: true },
        );
        kids.push(c.id);
      }
      await engine.executeRaw(
        `UPDATE minion_jobs SET data = jsonb_set(data, '{children_ids}', $1::jsonb) WHERE id = $2`,
        [JSON.stringify(kids), agg.id],
      );

      // Aggregator should be in waiting-children since kids were submitted
      // with parent_job_id = agg.id (Lane 1B behavior).
      const aggNow = await queue.getJob(agg.id);
      expect(aggNow?.status).toBe('waiting-children');

      // Aggregator's data.children_ids reflects the spawned children.
      const dataRow = await engine.executeRaw<{ data: unknown }>(
        `SELECT data FROM minion_jobs WHERE id = $1`, [agg.id],
      );
      const data = typeof dataRow[0]!.data === 'string'
        ? JSON.parse(dataRow[0]!.data as string)
        : dataRow[0]!.data as Record<string, unknown>;
      expect(data.children_ids).toEqual(kids);

      // Each child should have on_child_fail = 'continue'.
      const childRows = await engine.executeRaw<{ on_child_fail: string }>(
        `SELECT on_child_fail FROM minion_jobs WHERE parent_job_id = $1`, [agg.id],
      );
      expect(childRows.length).toBe(3);
      expect(childRows.every(r => r.on_child_fail === 'continue')).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('dispatcher routes register (cathedral-6)', () => {
  test('runAgent dispatches register and its --help never touches the engine', async () => {
    const { runAgent } = await import('../src/commands/agent.ts');
    // engine=null: the SELF_HELP_WITHOUT_ENGINE lane. Help must print and return.
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      await runAgent(null, ['register', '--help']);
    } finally {
      console.log = orig;
    }
    const out = logs.join('\n');
    expect(out).toContain('gbrain agent register');
    expect(out).toContain('--preset daily-driver|coding-agent');
  });

  test('top-level help mentions register', async () => {
    const { runAgent } = await import('../src/commands/agent.ts');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      await runAgent(null, ['--help']);
    } finally {
      console.log = orig;
    }
    expect(logs.join('\n')).toContain('agent register');
  });

  test('`agent run -- --help` is NOT a help request (-- terminator honored)', async () => {
    const { runAgent } = await import('../src/commands/agent.ts');
    // With a null engine and a post-`--` --help, the dispatcher must treat it
    // as a REAL run (and refuse on the missing engine) — never print help.
    const errs: string[] = [];
    const origErr = console.error;
    const origExit = process.exit;
    let exitCode: number | undefined;
    console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
    (process as any).exit = (code?: number) => { exitCode = code; throw new Error('__exit__'); };
    try {
      await runAgent(null, ['run', '--', '--help']).catch((e) => {
        if (!/__exit__/.test(String(e?.message))) throw e;
      });
    } finally {
      console.error = origErr;
      (process as any).exit = origExit;
    }
    expect(exitCode).toBe(1);
    expect(errs.join('\n')).toContain('needs a configured brain');
  });
});
