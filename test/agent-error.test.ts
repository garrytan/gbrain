/**
 * Agent operator contract v1 (A1): toAgentError is a total, table-driven
 * normaliser. One instance of each error family → the frozen `error`, the
 * canonical `code`, a `fix` where one applies, and the safe-recovery rule.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { __setDocsRefForTests, renderCliError, toAgentError, type AgentErrorContext, type RenderContext } from '../src/core/agent-output.ts';
import { OperationError, opError } from '../src/core/ops/contract.ts';
import { catalogueError } from '../src/core/error-catalogue.ts';
import { errorFor } from '../src/core/errors.ts';
import { GBrainError } from '../src/core/types.ts';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import { noPricingGuidance } from '../src/core/budget/no-pricing.ts';
import { RemoteMcpError } from '../src/core/mcp-client.ts';
import { SourceTargetError } from '../src/core/source-resolver.ts';

const render = (over: Partial<RenderContext> = {}): RenderContext => ({
  transport: 'stdio', isCallable: () => true, preapproved: () => false, ...over,
});
const cx = (over: Partial<AgentErrorContext> = {}): AgentErrorContext => ({ transport: 'stdio', render: render(), ...over });

beforeAll(() => __setDocsRefForTests('master'));
afterAll(() => __setDocsRefForTests(null));

describe('normaliser rows', () => {
  test('OperationError keeps its legacy wire value and gains code/class/retryable', () => {
    const env = toAgentError(new OperationError('page_not_found', 'No page notes/x.', 'Search first.'), cx());
    expect(env).toMatchObject({ error: 'page_not_found', code: 'page_not_found', class: 'caller', retryable: false, contract_version: 1 });
    expect(env.docs_cmd).toEqual(['gbrain', 'errors', 'page_not_found']);
  });

  test('frozen legacy pair: error stays, code is canonical', () => {
    const env = toAgentError(opError('not_found', 'Job 42 not found.', 'List jobs.', { legacy_error: 'invalid_params' }), cx());
    expect([env.error, env.code]).toEqual(['invalid_params', 'not_found']);
  });

  test('F0 refresh refusal: the literal fix string becomes fix.argv; suggestion unchanged', () => {
    const e = catalogueError('refresh_dirty', 'The worktree has uncommitted changes.', 'gbrain sources refresh --source wiki --stash');
    const env = toAgentError(e, cx({ transport: 'cli', render: render({ transport: 'cli' }) }));
    expect(env.fix?.argv).toEqual(['gbrain', 'sources', 'refresh', '--source', 'wiki', '--stash']);
    expect(env.suggestion).toBe('gbrain sources refresh --source wiki --stash');
    expect(env.docs).toBe('https://github.com/garrytan/gbrain/blob/master/docs/guides/write-refusals.md#refresh_dirty');
  });

  test('StructuredAgentError → its code and hint', () => {
    const env = toAgentError(errorFor({ class: 'UsageError', code: 'code_def_requires_symbol', message: 'needs a symbol', hint: 'gbrain code-def <symbol>' }), cx());
    expect(env).toMatchObject({ error: 'code_def_requires_symbol', code: 'code_def_requires_symbol', suggestion: 'gbrain code-def <symbol>' });
  });

  test('no_pricing: fix with inputs for the rates; actor agent on CLI, host_admin remote', () => {
    const pricing = noPricingGuidance('openai:gpt-9-example', 'chat');
    const e = new BudgetExhausted('no pricing', { reason: 'no_pricing', spent: 0, cap: 1, modelId: 'openai:gpt-9-example', pricing });
    const cli = toAgentError(e, cx({ transport: 'cli', render: render({ transport: 'cli' }) }));
    expect(cli.code).toBe('no_pricing');
    expect(cli.fix?.argv?.slice(0, 4)).toEqual(['gbrain', 'pricing', 'set', 'openai:gpt-9-example']);
    expect(cli.fix?.inputs?.map(i => i.name)).toEqual(['usd_per_1m_input_tokens', 'usd_per_1m_output_tokens']);
    expect(cli.fix?.actor).toBe('agent');
    const http = toAgentError(e, cx({ transport: 'http', render: render({ transport: 'http' }) }));
    expect(http.fix?.actor).toBe('host_admin');
    expect(http.fix?.next).toBe('tell_user_to_run');
  });

  test('CredentialError, AIConfigError, AITransientError, GBrainError, legacy PhaseError objects', () => {
    expect(toAgentError(new CredentialError('access_env_missing', ' (GOOGLE_TOKEN)'), cx())).toMatchObject({ code: 'access_env_missing' });
    expect(toAgentError(new AIConfigError('no key', 'export OPENAI_API_KEY'), cx())).toMatchObject({ code: 'unavailable', reason: 'ai_config' });
    expect(toAgentError(new AIConfigError('no key', 'export OPENAI_API_KEY'), cx()).suggestion).toStartWith('export OPENAI_API_KEY');
    expect(toAgentError(new AITransientError('429'), cx())).toMatchObject({ code: 'unavailable', reason: 'ai_transient', retryable: true });
    expect(toAgentError(new GBrainError('Missing value', '', 'Pass a value'), cx())).toMatchObject({ code: 'config_error', suggestion: 'Pass a value' });
    expect(toAgentError({ class: 'PhaseError', code: 'storage_error', message: 'disk full' }, cx())).toMatchObject({ code: 'storage_error' });
  });

  test('SourceTargetError is a caller mistake (unknown_source / invalid_source) with a sources-list read, never internal_error', () => {
    const missing = toAgentError(new SourceTargetError('Source "nope" not found or is archived.'), cx({ transport: 'cli', command: 'import', render: render({ transport: 'cli' }) }));
    expect(missing).toMatchObject({ error: 'unknown_source', code: 'unknown_source', class: 'caller', fix: { argv: ['gbrain', 'sources', 'list', '--json'], next: 'run' } });
    expect(toAgentError(new SourceTargetError('Invalid GBRAIN_SOURCE value "A B". Must match [a-z0-9-]{1,32}.'), cx()).code).toBe('invalid_source');
  });

  test('RemoteMcpError preserves the server envelope fields', () => {
    const e = new RemoteMcpError('tool_error', 'failed', {
      code: 'permission_denied', canonical_code: 'insufficient_scope', message: 'needs write', suggestion: 'ask the host',
      reason: 'insufficient_scope', contract_version: 1,
    });
    expect(toAgentError(e, cx({ transport: 'cli', render: render({ transport: 'cli' }) }))).toMatchObject({
      error: 'permission_denied', code: 'insufficient_scope', message: 'needs write', reason: 'insufficient_scope',
    });
    expect(toAgentError(new RemoteMcpError('network', 'timed out', { kind: 'timeout' }), cx()).code).toBe('timeout');
  });

  test('thin client: a server fix with only an MCP form is relayed to the CLI user, not dropped', () => {
    const requestId = '11111111-2222-4333-8444-555555555555';
    const e = new RemoteMcpError('tool_error', 'pending', {
      code: 'write_pending', message: 'The write is still pending.', suggestion: 'Read the receipt before resubmitting.',
      fix: { mcp: { tool: 'get_write_request', arguments: { request_id: requestId } }, consent: [], actor: 'agent', next: 'run',
        why: 'The receipt says whether the write committed.', requires_exclusive: false },
    } as never);
    const cli = render({ transport: 'cli', isCallable: () => false });
    const env = toAgentError(e, cx({ transport: 'cli', render: cli }));
    expect(env.fix).toMatchObject({ mcp: { tool: 'get_write_request', arguments: { request_id: requestId } }, actor: 'user', next: 'tell_user_to_run' });
    expect(env.fix?.argv).toBeUndefined();
    expect(env.fix?.user_message).toContain('Call the get_write_request tool over MCP');
    expect(env.suggestion).toContain('get_write_request');
    const human = renderCliError(e, { json: false, command: 'put', tty: false });
    expect(human.stderr).toContain(`Fix: call get_write_request over MCP with {"request_id":"${requestId}"}`);
    // The same fix stays runnable where the tool is callable, and an MCP transport that cannot call it still reports.
    expect(toAgentError(e, cx()).fix).toMatchObject({ mcp: { tool: 'get_write_request' }, actor: 'agent', next: 'run' });
    expect(toAgentError(e, cx({ render: render({ isCallable: () => false }) })).fix?.next).toBe('report');
  });

  test('DB access errors classify (GBRAIN_DB_ACCESS marker); verbs keep frozen codes', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const env = toAgentError(err, cx({ op: 'list_pages' }));
    expect(env.code).toBe('database_error');
    expect(env.suggestion).toContain('GBRAIN_DB_ACCESS');
    expect(env.fix?.argv).toEqual(['gbrain', 'db-repair']);
    const verb = toAgentError(err, cx({ op: 'recall' }));
    expect(verb).toMatchObject({ error: 'unavailable', protocol_version: 1 });
  });

  test('unknown throw: internal_error naming the op, doctor fix, host_admin over http, redacted', () => {
    const env = toAgentError(new Error(`boom at ${['postgres://u', 'GSTACK_EXAMPLE_NONCE'].join(':')}@db.example.test/x`), cx({ op: 'find_orphans', transport: 'http', render: render({ transport: 'http', isCallable: () => false }) }));
    expect(env.code).toBe('internal_error');
    expect(env.suggestion).toContain('Server-side failure in find_orphans');
    expect(env.message).not.toContain('GSTACK_EXAMPLE_NONCE');
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'doctor', '--json'], actor: 'host_admin', next: 'tell_user_to_run' });
    expect(toAgentError(new Error('x'), cx({ op: 'remember' }))).toMatchObject({ error: 'internal', code: 'internal', protocol_version: 1 });
  });

  test('total: a value that breaks every row still returns the generic envelope', () => {
    const evil = new Proxy({}, { get() { throw new Error('trap'); }, getPrototypeOf() { throw new Error('trap'); } });
    expect(toAgentError(evil, cx()).code).toBe('internal_error');
  });
});

describe('safe-recovery invariant', () => {
  const receipt = { request_id: '11111111-2222-4333-8444-555555555555', state: 'queued', retry_after_ms: 1000 };

  test('a mutating op with an unknown outcome is pointed at its receipt, never retried', () => {
    const e = new OperationError('storage_error', 'write failed mid-flight');
    e.writeRequest = receipt as OperationError['writeRequest'];
    const env = toAgentError(e, cx({ op: 'put_page', mutating: true, idempotent: false, outcome: 'unknown' }));
    expect(env.fix?.mcp).toEqual({ tool: 'get_write_request', arguments: { request_id: receipt.request_id } });
    expect(env.retryable).toBe(false);
    const cli = toAgentError(e, cx({ op: 'put_page', mutating: true, outcome: 'unknown', transport: 'cli', render: render({ transport: 'cli' }) }));
    expect(cli.fix?.argv).toEqual(['gbrain', 'write-request', '--', receipt.request_id]);
  });

  test('no receipt → no receipt command; the unknown-throw text says inspect before resubmitting', () => {
    const env = toAgentError(new Error('x'), cx({ op: 'submit_job', mutating: true, outcome: 'unknown' }));
    // A1: a non-journaled mutation recovers through its own status read (submit_job → the job list), never a receipt or a resubmit.
    expect(env.fix?.argv).toEqual(['gbrain', 'jobs', 'list', '--json']);
    expect(env.fix?.mcp).toEqual({ tool: 'list_jobs', arguments: {} });
    expect(JSON.stringify(env.fix)).not.toContain('write-request');
    expect(env.suggestion).toContain('inspect state before resubmitting');
  });

  test('retryable only for idempotent ops', () => {
    expect(toAgentError(new OperationError('write_pending', 'p', 's'), cx({ mutating: true, idempotent: false })).retryable).toBe(false);
    expect(toAgentError(new OperationError('write_pending', 'p', 's'), cx({ mutating: true, idempotent: true })).retryable).toBe(true);
  });
});
