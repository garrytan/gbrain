/**
 * B5 contract: every scope deny path builds one envelope (code
 * insufficient_scope, the caller's frozen `error`, client id + current scopes
 * in `why`, the exact `gbrain auth` command, actor host_admin on http), and a
 * 429 on the thin client's /token mint renders as rate_limited with a
 * provider-side wait.
 */
import { describe, expect, test } from 'bun:test';
import { scopeDeniedError } from '../src/core/ops/op-fix.ts';
import { toAgentError } from '../src/core/agent-output.ts';
import { isScopeErrorCode } from '../src/core/error-catalogue.ts';
import { RemoteMcpError } from '../src/core/mcp-client.ts';

const render = (transport: 'stdio' | 'http') => ({ transport, isCallable: () => false, preapproved: () => false });
const envelope = (e: unknown, transport: 'stdio' | 'http' = 'http') => toAgentError(e, { transport, op: 'put_page', render: render(transport) });

describe('scope denials (B5)', () => {
  test('serve-http OAuth client: frozen error, canonical code, exact rescope command', () => {
    const env = envelope(scopeDeniedError({ op: 'put_page', required: ['write'], auth: { clientId: 'gbrain_cl_abc', scopes: ['read'] }, transport: 'http' }));
    expect(env).toMatchObject({
      error: 'insufficient_scope', code: 'insufficient_scope', reason: 'insufficient_scope',
      message: "Operation put_page requires 'write' scope",
      why: "Client gbrain_cl_abc has scopes [read]; put_page needs 'write'.",
      class: 'host_only', retryable: false,
      fix: {
        argv: ['gbrain', 'auth', 'rescope', '--client', 'gbrain_cl_abc', '--scopes', 'read,write'],
        command: 'gbrain auth rescope --client gbrain_cl_abc --scopes read,write',
        consent: ['credentials'], actor: 'host_admin', next: 'tell_user_to_run',
      },
    });
    expect(env.fix?.user_message).toContain('whoever runs this gbrain server');
    expect(env.suggestion).toContain('gbrain auth rescope --client gbrain_cl_abc --scopes read,write');
  });

  test('legacy bearer token: error stays permission_denied; rescope-token by id', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const env = envelope(scopeDeniedError({
      op: 'submit_agent', required: ['agent'], transport: 'http', message: 'Tool requires agent scope', legacy_error: 'permission_denied',
      auth: { clientId: 'legacy-name', scopes: ['read', 'write'], principal: { kind: 'legacy_token', id } },
    }));
    expect(env).toMatchObject({
      error: 'permission_denied', code: 'insufficient_scope', message: 'Tool requires agent scope',
      fix: { argv: ['gbrain', 'auth', 'rescope-token', '--id', id, '--scopes', 'read,write,agent'], actor: 'host_admin' },
    });
    expect(isScopeErrorCode(env.error, env.code, env.reason)).toBe(true);
  });

  test('stdio local writer: the user reviews the grant in a terminal on this machine', () => {
    const env = envelope(scopeDeniedError({
      op: 'put_skill', required: ['skills_write'], auth: { clientId: '', scopes: ['read', 'write'] }, transport: 'stdio',
      message: 'This operation requires an explicit shared-skills grant.', legacy_error: 'permission_denied',
    }), 'stdio');
    expect(env).toMatchObject({
      error: 'permission_denied', code: 'insufficient_scope',
      fix: { argv: ['gbrain', 'auth', 'local-writer', 'list', '--json'], consent: [], actor: 'user', next: 'tell_user_to_run' },
    });
  });

  test('a hostile client id never reaches argv', () => {
    const e = scopeDeniedError({ op: 'put_page', required: ['write'], auth: { clientId: '--yes; rm -rf', scopes: [] }, transport: 'http' });
    expect(e.fix?.argv).toEqual(['gbrain', 'auth', 'clients', '--json']);
  });
});

describe('thin-client /token 429 (#5949, B5)', () => {
  test('rate_limited renders code rate_limited, actor provider, next wait, retryable', () => {
    const err = new RemoteMcpError('rate_limited', 'OAuth /token failed: rate-limited', {
      status: 429, retry_after_s: 900, code: 'rate_limited',
      why: "The brain host's OAuth /token mint budget is spent (HTTP 429); it clears by itself in 900s.",
      suggestion: 'Wait 900s, then re-run the same command.',
      fix: { argv: ['gbrain', 'remote', 'doctor', '--json'], consent: [], actor: 'provider', why: 'Retry after 900s.', requires_exclusive: false },
    });
    const env = toAgentError(err, { transport: 'cli', command: 'search', render: { transport: 'cli', isCallable: () => false, preapproved: () => false } });
    expect(env).toMatchObject({
      error: 'rate_limited', code: 'rate_limited', retryable: true, class: 'retryable',
      fix: { actor: 'provider', next: 'wait', command: 'gbrain remote doctor --json' },
    });
    expect(env.why).toContain('900s');
  });

  test('a bare rate_limited transport reason still maps to the registry code', () => {
    const env = toAgentError(new RemoteMcpError('rate_limited', 'OAuth /token failed'), { transport: 'cli', render: { transport: 'cli', isCallable: () => false, preapproved: () => false } });
    expect(env.code).toBe('rate_limited');
    expect(env.retryable).toBe(true);
  });
});
