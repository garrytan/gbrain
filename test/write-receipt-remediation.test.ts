/**
 * B4 + A1 principal rule: a replayed write receipt derives its fix from the
 * registry template filled from the journal row's own fields (no schema
 * change: the journal keeps code + message), keeps the frozen `error`, and
 * reads the receipt on the channel that owns it.
 */
import { describe, expect, test } from 'bun:test';
import { writeResponse } from '../src/core/persistence/service.ts';
import { pageIdentityError, PAGE_MISSING_MESSAGE, yamlLocator } from '../src/core/persistence/page-identity.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { fillFixTemplate, toAgentError, type RenderContext, type Transport } from '../src/core/agent-output.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const REQUEST_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/** A journal row exactly as a pre-wave release stored it: code + message, no new columns. */
function oldStyleRow(over: Partial<WriteRequest> = {}): WriteRequest {
  return {
    id: '1', request_id: REQUEST_ID, operation: 'put_page', source_id: 'notes', slug: 'people/alice-example',
    principal_kind: 'local_stdio', principal_id: 'p-stdio', state: 'failed',
    error_code: 'page_identity_changed', error_message: PAGE_MISSING_MESSAGE,
    outcome: null, created_at: new Date(0), updated_at: new Date(0), ...over,
  } as unknown as WriteRequest;
}

function replay(row: WriteRequest): OperationError {
  try { writeResponse(row); } catch (e) { return e as OperationError; }
  throw new Error('writeResponse did not throw for a terminal failure');
}

const render = (transport: Transport, callable: string[] = [], principal?: string): RenderContext => ({
  transport, isCallable: t => callable.includes(t), preapproved: () => false, ...(principal ? { principal } : {}),
});
const envelope = (e: unknown, transport: Transport, callable: string[] = [], principal?: string) =>
  toAgentError(e, { transport, op: 'put_page', mutating: true, outcome: 'failed', render: render(transport, callable, principal) });

describe('replayed receipts (B4)', () => {
  test('an old-style missing-page row: error stays page_identity_changed, code becomes page_not_found, fix reads the page', () => {
    const e = replay(oldStyleRow());
    expect(e.code).toBe('page_identity_changed');
    expect(e.suggestion).not.toContain('Inspect this receipt');
    const mcp = envelope(e, 'stdio', ['get_page', 'get_write_request']);
    expect(mcp).toMatchObject({
      error: 'page_identity_changed', code: 'page_not_found', write_error: 'page_identity_changed',
      write_request: { request_id: REQUEST_ID, state: 'failed' },
      fix: { mcp: { tool: 'get_page', arguments: { slug: 'people/alice-example', source_id: 'notes' } }, actor: 'agent', next: 'run', consent: [] },
    });
    const cli = envelope(e, 'cli');
    expect(cli.fix).toMatchObject({ argv: ['gbrain', 'get', '--source', 'notes', '--', 'people/alice-example'], next: 'run' });
    expect(cli.suggestion).toContain('gbrain get --source notes -- people/alice-example');
  });

  test('a replaced page keeps code page_identity_changed', () => {
    const e = replay(oldStyleRow({ error_message: 'The accepted page identity changed.' }));
    expect(envelope(e, 'cli')).toMatchObject({ error: 'page_identity_changed', code: 'page_identity_changed', fix: { argv: ['gbrain', 'get', '--source', 'notes', '--', 'people/alice-example'] } });
  });

  test('revision_conflict fills the same read from receipt fields', () => {
    const e = replay(oldStyleRow({ state: 'conflict', error_code: 'revision_conflict', error_message: 'The page changed during preparation.' }));
    expect(envelope(e, 'cli').fix?.command).toBe('gbrain get --source notes -- people/alice-example');
  });

  test('an unsafe slug drops the template; the fix falls back to the receipt read', () => {
    const e = replay(oldStyleRow({ slug: '--yes', principal_kind: 'local_cli' }));
    const env = envelope(e, 'cli');
    expect(env.fix?.argv).toEqual(['gbrain', 'write-request', '--', REQUEST_ID]);
    expect(JSON.stringify(env)).not.toContain('{slug}');
  });
});

describe('principal-aware receipt recovery (A1)', () => {
  const storage = (over: Partial<WriteRequest>) => replay(oldStyleRow({ error_code: 'storage_error', error_message: 'disk full', ...over }));

  test('CLI principal on the CLI: gbrain write-request', () => {
    expect(envelope(storage({ principal_kind: 'local_cli' }), 'cli').fix).toMatchObject({ argv: ['gbrain', 'write-request', '--', REQUEST_ID], actor: 'agent', next: 'run' });
  });

  test('stdio principal over stdio: get_write_request when callable, never the CLI command (a different principal)', () => {
    const env = envelope(storage({ principal_kind: 'local_stdio' }), 'stdio', ['get_write_request']);
    expect(env.fix).toMatchObject({ mcp: { tool: 'get_write_request', arguments: { request_id: REQUEST_ID } }, actor: 'agent', next: 'run' });
    expect(env.fix?.argv).toBeUndefined();
  });

  test('receipt tool not callable: host inspection, actor host_admin', () => {
    const env = envelope(storage({ principal_kind: 'local_stdio' }), 'stdio', []);
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'sources', 'writer', 'status', 'notes', '--probe', '--json'], actor: 'host_admin', next: 'tell_user_to_run' });
  });

  test("another OAuth client's receipt over http: host inspection", () => {
    const own = envelope(storage({ principal_kind: 'oauth_client', principal_id: 'gbrain_cl_a' }), 'http', ['get_write_request'], 'gbrain_cl_a');
    expect(own.fix?.mcp?.tool).toBe('get_write_request');
    const other = envelope(storage({ principal_kind: 'oauth_client', principal_id: 'gbrain_cl_b' }), 'http', ['get_write_request'], 'gbrain_cl_a');
    expect(other.fix).toMatchObject({ actor: 'host_admin', next: 'tell_user_to_run' });
    expect(other.fix?.mcp).toBeUndefined();
  });

  test('a pending write never says retry and is not retryable for a non-idempotent op', () => {
    const e = replay(oldStyleRow({ state: 'running', error_code: null, error_message: null, principal_kind: 'local_cli' }));
    expect(e.code).toBe('write_pending');
    const env = toAgentError(e, { transport: 'cli', op: 'put_page', mutating: true, idempotent: false, outcome: 'pending', render: render('cli') });
    expect(env.retryable).toBe(false);
    expect(env.fix?.argv).toEqual(['gbrain', 'write-request', '--', REQUEST_ID]);
  });
});

describe('live page identity errors and YAML locators', () => {
  test('a missing page throws the frozen error with canonical page_not_found', () => {
    const missing = pageIdentityError(false, 'replaced');
    expect(missing.code).toBe('page_identity_changed');
    expect(missing.canonicalCode).toBe('page_not_found');
    expect(missing.message).toBe(PAGE_MISSING_MESSAGE);
    const replaced = pageIdentityError(true, 'The accepted page identity changed.');
    expect(replaced.canonicalCode).toBe('page_identity_changed');
  });

  test('yamlLocator keeps only line/column numbers', () => {
    expect(yamlLocator('YAML parse failed: Malformed YAML frontmatter at line 4')).toBe(' at line 4');
    expect(yamlLocator('bad indentation of a mapping entry (3:5)\n\n 3 | secret: [x')).toBe(' at line 3, column 5');
    expect(yamlLocator('no position here: secret')).toBe('');
  });

  test('fillFixTemplate refuses unknown or missing fields', () => {
    const t = { argv: ['gbrain', 'get', '--', '{slug}'], consent: [], actor: 'agent' as const, why: 'w', requires_exclusive: false };
    expect(fillFixTemplate(t, { slug: 'a/b' })?.argv).toEqual(['gbrain', 'get', '--', 'a/b']);
    expect(fillFixTemplate(t, {})).toBeUndefined();
    expect(fillFixTemplate(t, { slug: 'a b; rm' })).toBeUndefined();
  });
});
