/**
 * Lane B (B1/B2/B6/B7/B8) on the jobs / loops / think / timeline /
 * transcripts / extraction / attribution ops: refusals carry a filled,
 * surface-correct next step, the jobs not-found frozen pair keeps
 * `error: invalid_params` with `code: not_found`, host-only refusals name the
 * exact host command, and MCP text names params, not CLI flags.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { toAgentError, type Transport } from '../src/core/agent-output.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

const op = (name: string) => operations.find(o => o.name === name)!;

function stubEngine(rows: unknown[] = []) {
  return {
    kind: 'pglite',
    executeRaw: async () => rows,
    getConfig: async () => null,
  } as unknown as OperationContext['engine'];
}

function ctx(transport: Transport, over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: stubEngine(), config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} },
    remote: transport !== 'cli', ...(transport === 'cli' ? {} : { transport }), dryRun: false, sourceId: 'notes',
    ...over,
  } as unknown as OperationContext;
}

async function envelopeOf(name: string, c: OperationContext, params: Record<string, unknown>, callable: string[] = []) {
  const transport: Transport = c.remote === false ? 'cli' : c.transport === 'http' ? 'http' : 'stdio';
  try {
    await op(name).handler(c, params);
  } catch (e) {
    return toAgentError(e, { transport, op: name, render: { transport, isCallable: t => callable.includes(t), preapproved: () => false } });
  }
  throw new Error(`${name} did not throw`);
}

describe('jobs ops (real queue)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('version', '85');
  });

  test('a missing job keeps error invalid_params, reports code not_found, and points at the job list', async () => {
    const cli = await envelopeOf('get_job', ctx('cli', { engine }), { id: 999_999 });
    expect(cli).toMatchObject({ error: 'invalid_params', code: 'not_found', fix: { argv: ['gbrain', 'jobs', 'list', '--json'], next: 'run' } });
    const mcp = await envelopeOf('get_job_progress', ctx('stdio', { engine }), { id: 999_999 }, ['list_jobs']);
    expect(mcp).toMatchObject({ error: 'invalid_params', code: 'not_found', fix: { mcp: { tool: 'list_jobs', arguments: {} }, next: 'run' } });
  });

  test('a wrong-state transition says nothing changed and reads the job, never retries it', async () => {
    const job = await new MinionQueue(engine).add('sync', {});
    await op('cancel_job').handler(ctx('cli', { engine }), { id: job.id });
    const env = await envelopeOf('cancel_job', ctx('cli', { engine }), { id: job.id });
    expect(env).toMatchObject({ error: 'invalid_params', fix: { argv: ['gbrain', 'jobs', 'get', String(job.id), '--json'], next: 'run' } });
    expect(env.suggestion).toContain('Nothing changed');
    expect(env.suggestion).not.toMatch(/retry/i);
  });
});

describe('jobs ops (refusals)', () => {
  test('an agent-fenced missing job shares the frozen not-found envelope', async () => {
    const env = await envelopeOf('get_job', ctx('http', { auth: { clientId: 'client-a', scopes: ['agent'], token: 't' } }), { id: 7 }, ['list_jobs']);
    expect(env).toMatchObject({ error: 'invalid_params', code: 'not_found', fix: { mcp: { tool: 'list_jobs' } } });
  });

  test('no client identity without admin is a scope denial that keeps error permission_denied', async () => {
    const env = await envelopeOf('list_jobs', ctx('http', { auth: { clientId: '', scopes: ['agent'], token: 't' } }), {});
    expect(env).toMatchObject({ error: 'permission_denied', code: 'insufficient_scope', fix: { actor: 'host_admin', next: 'tell_user_to_run' } });
  });

  test('submit_agent on the local CLI points at gbrain agent run with the prompt as a declared input', async () => {
    const env = await envelopeOf('submit_agent', ctx('cli'), { prompt: 'hello' });
    expect(env.error).toBe('invalid_request');
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'agent', 'run', '--', '<prompt>'], consent: ['paid'], inputs: [{ name: 'prompt' }] });
  });

  test('submit_agent names max_turns as an MCP param with an example', async () => {
    const env = await envelopeOf('submit_agent', ctx('http', { auth: { clientId: 'client-a', scopes: ['agent'], token: 't' } }), { prompt: 'hi', max_turns: 500 });
    expect(env.code).toBe('invalid_params');
    expect(env.suggestion).toContain('submit_agent {"max_turns": 20}');
    expect(env.suggestion).not.toMatch(/--max-turns/);
  });
});

describe('loops ops', () => {
  test('a mute outside the write source names the bound source and the exact host command', async () => {
    const env = await envelopeOf('loops_mute', ctx('stdio'), { kind: 'sender', value: 'alice@example.com', source_id: 'other' });
    expect(env.error).toBe('permission_denied');
    expect(env.suggestion).toContain("source 'notes'");
    expect(env.fix).toMatchObject({
      argv: ['gbrain', 'loops', 'mute', 'sender', 'alice@example.com', '--source', 'other'], actor: 'user', next: 'tell_user_to_run',
    });
  });

  test('a hostile mute value is never interpolated', async () => {
    const env = await envelopeOf('loops_mute', ctx('stdio'), { kind: 'sender', value: '--yes', source_id: 'other' });
    expect(env.fix).toBeUndefined();
  });

  test('an invalid as_of names the param on MCP', async () => {
    const env = await envelopeOf('open_loops', ctx('http'), { as_of: 'yesterday' });
    expect(env.code).toBe('invalid_params');
    expect(env.suggestion).toContain('`as_of`');
    expect(env.suggestion).not.toMatch(/--as-of/);
  });
});

describe('think', () => {
  test('an unusable explicit model is a caller error naming `model`, not --model', async () => {
    const env = await envelopeOf('think', ctx('http'), { question: 'q', model: 'bogusprovider:foo' });
    expect(env.code).toBe('invalid_params');
    expect(env.message).toMatch(/not usable.*unknown_provider/);
    expect(`${env.message} ${env.suggestion}`).not.toMatch(/--model/);
    expect(env.suggestion).toContain('`model`');
  });
});

describe('add_timeline_entry', () => {
  test('a bad date names the positional on the CLI and the param over MCP', async () => {
    const cli = await envelopeOf('add_timeline_entry', ctx('cli'), { slug: 'notes/x', date: '2026-02-30', summary: 's' });
    expect(cli).toMatchObject({ error: 'invalid_params', message: 'Invalid calendar date "2026-02-30"' });
    expect(cli.suggestion).toContain('the date argument');
    const mcp = await envelopeOf('add_timeline_entry', ctx('http'), { slug: 'notes/x', date: '2026/02/01', summary: 's' });
    expect(mcp.suggestion).toContain('`date`');
  });
});

describe('get_recent_transcripts', () => {
  test('the local-only refusal names the host command with the caller\'s window', async () => {
    const env = await envelopeOf('get_recent_transcripts', ctx('http'), { days: 3, summary: false });
    expect(env).toMatchObject({
      error: 'permission_denied',
      fix: { argv: ['gbrain', 'transcripts', 'recent', '--days', '3', '--full', '--json'], actor: 'host_admin', next: 'tell_user_to_run' },
    });
  });
});

describe('extraction_review', () => {
  test('a remote reject names the exact owner command and asks consent for the soft-delete', async () => {
    const env = await envelopeOf('extraction_review', ctx('stdio'), { action: 'reject', slugs: ['people/alice-example', 'companies/acme-example'] });
    expect(env.error).toBe('permission_denied');
    expect(env.fix).toMatchObject({
      argv: ['gbrain', 'extraction-review', 'reject', '--slugs', 'people/alice-example,companies/acme-example'],
      consent: ['destructive'], actor: 'user', next: 'tell_user_to_run',
    });
  });

  test('an unsafe slug falls back to the pending list', async () => {
    const env = await envelopeOf('extraction_review', ctx('stdio'), { action: 'promote', slugs: ['--yes'] });
    expect(env.fix?.argv).toEqual(['gbrain', 'extraction-pending']);
  });

  test('empty slugs on the CLI renders the flag; the message names no flag', async () => {
    const env = await envelopeOf('extraction_review', ctx('cli'), { action: 'promote', slugs: [] });
    expect(env.message).not.toMatch(/--slugs/);
    expect(env.suggestion).toContain('--slugs slug1,slug2');
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'extraction-pending'], next: 'run' });
  });
});

describe('get_write_attribution', () => {
  test('two row selectors render per surface and the fix attributes the first one', async () => {
    const mcp = await envelopeOf('get_write_attribution', ctx('http'), { slug: 'notes/x', take: 2, timeline: 3 }, ['get_write_attribution']);
    expect(mcp.message).toBe('Pass at most one of fact, take or timeline.');
    expect(mcp.fix).toMatchObject({ mcp: { tool: 'get_write_attribution', arguments: { slug: 'notes/x', take: 2 } }, next: 'run' });
    const cli = await envelopeOf('get_write_attribution', ctx('cli'), { slug: 'notes/x', fact: 1, take: 2 });
    expect(cli.message).toBe('Pass at most one of --fact, --take or --timeline.');
    expect(cli.fix?.argv).toEqual(['gbrain', 'attribution', 'notes/x', '--fact', '1']);
  });

  test('a non-positive row id names the param on MCP', async () => {
    const env = await envelopeOf('get_write_attribution', ctx('http'), { slug: 'notes/x', fact: -1 });
    expect(env.code).toBe('invalid_params');
    expect(env.suggestion).toContain('fact: 1');
    expect(`${env.message} ${env.suggestion}`).not.toMatch(/--fact/);
  });
});
