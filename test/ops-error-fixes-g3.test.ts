/**
 * Lane B (B2/B6/B7/B8) on the sources / sync / request_tools / skillopt /
 * connectors / receipt / files ops: refusals carry a filled, surface-correct
 * next step, host-only refusals name the exact host command, and MCP text
 * names params, not CLI flags.
 */
import { describe, expect, test } from 'bun:test';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { toAgentError, type Transport } from '../src/core/agent-output.ts';

const op = (name: string) => operations.find(o => o.name === name)!;

function engine(managed = false, rows: unknown[] = []) {
  return {
    kind: 'pglite',
    executeRaw: async (sql: string) => (/persistence_brain/.test(sql) ? [{ enabled: managed }] : rows),
    getConfig: async () => null,
  } as unknown as OperationContext['engine'];
}

function ctx(transport: Transport, over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine(), config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} },
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

describe('sources ops', () => {
  test('sources_add path over MCP: names `url`, never --url; host fix registers the local directory', async () => {
    const env = await envelopeOf('sources_add', ctx('http'), { id: 'notes', path: '/srv/notes' });
    expect(env.code).toBe('invalid_params');
    expect(env.suggestion).toContain('url: "https://github.com/owner/repo"');
    expect(env.suggestion).not.toMatch(/--url/);
    // The HTTP view never carries host paths (redactForTransport).
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'sources', 'add', 'notes', '--path', '<path>'], actor: 'host_admin', next: 'tell_user_to_run' });
    const stdio = await envelopeOf('sources_add', ctx('stdio'), { id: 'notes', path: '/srv/notes' });
    expect(stdio.fix).toMatchObject({ argv: ['gbrain', 'sources', 'add', 'notes', '--path', '/srv/notes'], actor: 'user', next: 'tell_user_to_run' });
  });

  test('managed lifecycle refusal names the owner CLI command (B6)', async () => {
    const env = await envelopeOf('sources_remove', ctx('stdio', { engine: engine(true) }), { id: 'notes' });
    expect(env).toMatchObject({
      error: 'writer_coordinator_required',
      fix: { argv: ['gbrain', 'sources', 'remove', 'notes', '--dry-run'], actor: 'user', next: 'tell_user_to_run' },
    });
    expect(env.fix?.user_message).toContain('terminal on this machine');
  });

  test('an unsafe source id is never interpolated', async () => {
    const env = await envelopeOf('sources_add', ctx('http', { engine: engine(true) }), { id: '--yes', url: 'https://example.com/x.git' });
    expect(env.fix?.argv).toEqual(['gbrain', 'sources', 'add', '--url', 'https://example.com/x.git']);
  });
});

describe('sync_brain', () => {
  test("'__all__' refusal lists sources and renders the flag per surface", async () => {
    const cli = await envelopeOf('sync_brain', ctx('cli'), { source_id: '__all__' });
    expect(cli.suggestion).toContain('--source default');
    expect(cli.fix).toMatchObject({ argv: ['gbrain', 'sources', 'list'], next: 'run' });
    const mcp = await envelopeOf('sync_brain', ctx('stdio'), { source_id: '__all__' }, ['sources_list']);
    expect(mcp.suggestion).toContain('source_id: "default"');
    expect(mcp.fix).toMatchObject({ mcp: { tool: 'sources_list' }, next: 'run' });
  });
});

describe('request_tools', () => {
  test('an out-of-range surface lists the choices', async () => {
    const env = await envelopeOf('request_tools', ctx('http'), { surface: 'everything' });
    expect(env.suggestion).toContain('one of: verbs, starter, full');
  });

  test('above the ceiling: the host restart command, not a bare --surface', async () => {
    const env = await envelopeOf('request_tools', ctx('http', { surfaceCeiling: 'starter', auth: { clientId: 'gbrain_cl_a', scopes: ['read'], token: 't' } }), { surface: 'full' });
    expect(env).toMatchObject({ error: 'permission_denied', fix: { argv: ['gbrain', 'serve', '--surface', 'full'], actor: 'host_admin' } });
  });
});

describe('skillopt / connectors / receipts / files', () => {
  test('run_onboard auto without max_usd says to ask before spending', async () => {
    const env = await envelopeOf('run_onboard', ctx('http'), { mode: 'auto' });
    expect(env.code).toBe('invalid_params');
    expect(env.suggestion).toContain('max_usd: 1');
    expect(env.suggestion).toContain("user's OK");
  });

  test('connector_sync over MCP names the host command with the provider filled', async () => {
    const env = await envelopeOf('connector_sync', ctx('stdio'), { provider: 'claude' });
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'connectors', 'sync', 'claude', '--dry-run'], actor: 'user', next: 'tell_user_to_run' });
  });

  test('get_write_request not_found points at the caller\'s own receipts', async () => {
    const env = await envelopeOf('get_write_request', ctx('cli'), {});
    expect(env.code).toBe('invalid_params');
    expect(env.suggestion).toContain('request_id');
  });

  test('file_url not found lists stored files', async () => {
    const env = await envelopeOf('file_url', ctx('cli'), { storage_path: 'x/y.png' });
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'files', 'list'], next: 'run' });
  });
});
