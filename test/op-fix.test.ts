import { describe, expect, test } from 'bun:test';
import { hostFix, hostOnlyError, invalidParam, opTransport, paramUse, readFix, trustedCliRequired } from '../src/core/ops/op-fix.ts';
import { renderAction, cliRenderContext, toAgentError } from '../src/core/agent-output.ts';

const cli = { remote: false } as const;
const stdio = { remote: true, transport: 'stdio' } as const;
const http = { remote: true, transport: 'http' } as const;
const mcpRender = (transport: 'stdio' | 'http', callable: string[] = []) => ({
  transport, isCallable: (t: string) => callable.includes(t), preapproved: () => false,
});

describe('op-fix builders', () => {
  test('opTransport maps the trust flag and transport', () => {
    expect(opTransport(cli)).toBe('cli');
    expect(opTransport(stdio)).toBe('stdio');
    expect(opTransport(http)).toBe('http');
    expect(opTransport({ remote: true })).toBe('stdio');
  });

  test('paramUse renders the caller surface (B8)', () => {
    expect(paramUse(cli, 'no_pull')).toBe('--no-pull');
    expect(paramUse(stdio, 'no_pull')).toBe('no_pull: true');
    expect(paramUse(cli, 'limit', 20)).toBe('--limit 20');
    expect(paramUse(http, 'source_id', 'docs')).toBe('source_id: "docs"');
  });

  test('hostFix: agent on the CLI, user on stdio, host_admin on http; relay text over MCP', () => {
    const argv = ['gbrain', 'migrate', 'embeddings', '--source', 'docs'];
    expect(hostFix(cli, argv, 'why')).toEqual({ argv, consent: [], actor: 'agent', why: 'why', requires_exclusive: false });
    expect(hostFix(stdio, argv, 'why').actor).toBe('user');
    expect(hostFix(http, argv, 'why')).toMatchObject({ actor: 'host_admin', user_message: expect.stringContaining('server') });
    const rendered = renderAction(hostFix(http, argv, 'why'), mcpRender('http'));
    expect(rendered).toMatchObject({ next: 'tell_user_to_run', command: 'gbrain migrate embeddings --source docs' });
  });

  test('hostOnlyError carries code, suggestion and a rendered fix', () => {
    const e = hostOnlyError(stdio, 'permission_denied', 'local-only', ['gbrain', 'doctor', '--json'], 'Doctor runs on the host.');
    expect(e.code).toBe('permission_denied');
    expect(e.suggestion).toContain('trusted local CLI');
    const env = toAgentError(e, { transport: 'stdio', op: 'x', render: mcpRender('stdio') });
    expect(env.fix).toMatchObject({ actor: 'user', next: 'tell_user_to_run', command: 'gbrain doctor --json' });
  });

  test('invalidParam lists choices and an example on each surface', () => {
    const mcp = invalidParam(stdio, 'find_orphans', 'mode', 'Invalid mode.', { choices: ['inbound', 'islanded'] });
    expect(mcp.code).toBe('invalid_params');
    expect(mcp.suggestion).toBe('Pass `mode` as one of: inbound, islanded. Example: find_orphans {"mode": "inbound"}.');
    const local = invalidParam(cli, 'find_orphans', 'mode', 'Invalid mode.', { choices: ['inbound', 'islanded'] });
    expect(local.suggestion).toBe('Pass --mode as one of: inbound, islanded. Example: --mode inbound.');
    const typed = invalidParam(stdio, 'list_pages', 'limit', 'bad', { def: { type: 'number', description: 'Max rows.' } });
    expect(typed.suggestion).toBe('Pass `limit` as a number (Max rows). Example: list_pages {"limit": 10}.');
  });

  test('invalidParam keeps a frozen legacy error value', () => {
    const e = invalidParam(stdio, 'get_job', 'id', 'bad', { legacy_error: 'invalid_params', def: { type: 'number' } });
    expect(e.code).toBe('invalid_params');
  });

  test('readFix is a no-consent agent step', () => {
    const f = readFix('Lists jobs.', { argv: ['gbrain', 'jobs', 'list'], mcp: { tool: 'list_jobs', arguments: {} } });
    expect(renderAction(f, cliRenderContext())).toMatchObject({ next: 'run', command: 'gbrain jobs list' });
    expect(renderAction(f, mcpRender('stdio', ['list_jobs']))).toMatchObject({ next: 'run', mcp: { tool: 'list_jobs' } });
  });

  test('trustedCliRequired reads the registration first and never re-registers', () => {
    const e = trustedCliRequired('Sync requires a current trusted CLI registration.');
    expect(e).toMatchObject({ code: 'permission_denied', reason: 'trusted_cli_required', message: 'Sync requires a current trusted CLI registration.' });
    expect(renderAction(e.fix!, cliRenderContext())).toMatchObject({ command: 'gbrain auth local-writer list --json', actor: 'user', next: 'tell_user_to_run' });
  });
});
