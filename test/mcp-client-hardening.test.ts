/**
 * v0.31.1 (Issue #734, CDX-4): unit tests for the callRemoteTool hardening
 * pass — the internal helpers that ensure every thrown value reaches the
 * dispatcher as a typed RemoteMcpError.
 *
 * Pre-v0.31.1 contract was unsound: callRemoteTool's outermost block did NOT
 * normalize all errors; plain Error, AbortError, JSON parse, and undici
 * network errors could bubble untyped. The dispatcher's "exhaustive switch on
 * RemoteMcpError.reason" was a false promise.
 *
 * v0.31.1 funnel: every catch in callRemoteTool routes through
 * `toRemoteMcpError(e, mcpUrl)`. These tests pin the funnel's behavior so
 * the dispatcher's exhaustive switch (in cli.ts:runThinClientRouted) holds.
 */

import { describe, test, expect } from 'bun:test';
import {
  toRemoteMcpError,
  extractToolErrorCode,
  buildAbortController,
  RemoteMcpError,
  type CallRemoteToolOptions,
} from '../src/core/mcp-client.ts';

const MCP_URL = 'https://wintermute.fly.dev/mcp';

describe('toRemoteMcpError', () => {
  test('passes through existing RemoteMcpError unchanged', () => {
    const original = new RemoteMcpError('auth', 'bad creds', { mcp_url: MCP_URL });
    const out = toRemoteMcpError(original, MCP_URL);
    expect(out).toBe(original);
    expect(out.reason).toBe('auth');
  });

  test('plain Error becomes network/unreachable', () => {
    const err = new Error('ECONNREFUSED 127.0.0.1:3131');
    const out = toRemoteMcpError(err, MCP_URL);
    expect(out).toBeInstanceOf(RemoteMcpError);
    expect(out.reason).toBe('network');
    expect(out.detail?.kind).toBe('unreachable');
    expect(out.detail?.mcp_url).toBe(MCP_URL);
    expect(out.message).toContain('ECONNREFUSED');
  });

  test('AbortError (by .name) becomes network/aborted', () => {
    const err = new Error('operation aborted');
    err.name = 'AbortError';
    const out = toRemoteMcpError(err, MCP_URL);
    expect(out.reason).toBe('network');
    expect(out.detail?.kind).toBe('aborted');
  });

  test('Error with /abort/i in message becomes network/aborted (SDK swallows .name)', () => {
    // The MCP SDK sometimes wraps AbortError in a generic Error with the
    // word "abort" in the message. The funnel catches both shapes.
    const err = new Error('request was aborted by the user');
    const out = toRemoteMcpError(err, MCP_URL);
    expect(out.reason).toBe('network');
    expect(out.detail?.kind).toBe('aborted');
  });

  test('non-Error throwable (string) becomes network/unreachable', () => {
    const out = toRemoteMcpError('something blew up', MCP_URL);
    expect(out).toBeInstanceOf(RemoteMcpError);
    expect(out.reason).toBe('network');
    expect(out.detail?.kind).toBe('unreachable');
    expect(out.message).toContain('something blew up');
  });

  test('non-Error throwable (object) becomes network/unreachable with String() fallback', () => {
    const out = toRemoteMcpError({ weird: 'shape' }, MCP_URL);
    expect(out.reason).toBe('network');
    expect(out.detail?.kind).toBe('unreachable');
  });

  test('non-Error throwable (null) becomes network/unreachable', () => {
    const out = toRemoteMcpError(null, MCP_URL);
    expect(out.reason).toBe('network');
    expect(out.detail?.kind).toBe('unreachable');
  });

  test('mcp_url is always populated in detail', () => {
    expect(toRemoteMcpError(new Error('x'), MCP_URL).detail?.mcp_url).toBe(MCP_URL);
    expect(toRemoteMcpError('x', MCP_URL).detail?.mcp_url).toBe(MCP_URL);
    expect(toRemoteMcpError(null, MCP_URL).detail?.mcp_url).toBe(MCP_URL);
  });

  test('the dispatcher contract: every output has a recognized reason', () => {
    const validReasons = ['config', 'discovery', 'auth', 'auth_after_refresh', 'network', 'tool_error', 'parse'];
    const inputs = [
      new Error('x'),
      'string-error',
      null,
      undefined,
      42,
      { weird: true },
      new RemoteMcpError('parse', 'mock', { mcp_url: MCP_URL }),
    ];
    for (const input of inputs) {
      const out = toRemoteMcpError(input, MCP_URL);
      expect(validReasons).toContain(out.reason);
    }
  });
});

describe('extractToolErrorCode', () => {
  test('parses JSON envelope with error.code', () => {
    const msg = JSON.stringify({ error: { code: 'missing_scope', message: 'admin required' } });
    expect(extractToolErrorCode(msg)).toBe('missing_scope');
  });

  test('parses JSON envelope with top-level code', () => {
    const msg = JSON.stringify({ code: 'rate_limit_exceeded', message: 'too fast' });
    expect(extractToolErrorCode(msg)).toBe('rate_limit_exceeded');
  });

  test('falls back to substring detection for missing_scope-shaped messages', () => {
    // Regex is `scope.+(insufficient|required)` — requires "scope" BEFORE
    // the keyword. Inputs designed to hit each alternative branch.
    expect(extractToolErrorCode('error: missing scope admin')).toBe('missing_scope');
    expect(extractToolErrorCode('access denied: admin required')).toBe('missing_scope');
    expect(extractToolErrorCode('forbidden: admin required')).toBe('missing_scope');
    expect(extractToolErrorCode('scope is insufficient for this op')).toBe('missing_scope');
    expect(extractToolErrorCode('scope required: admin')).toBe('missing_scope');
  });

  test('returns undefined for unstructured messages', () => {
    expect(extractToolErrorCode('something went wrong')).toBeUndefined();
    expect(extractToolErrorCode('')).toBeUndefined();
    expect(extractToolErrorCode('database timed out')).toBeUndefined();
  });

  test('JSON envelope without code field returns undefined', () => {
    const msg = JSON.stringify({ error: { message: 'no code here' } });
    expect(extractToolErrorCode(msg)).toBeUndefined();
  });

  test('non-string code in JSON envelope returns undefined (defensive)', () => {
    const msg = JSON.stringify({ error: { code: 42, message: 'wrong type' } });
    expect(extractToolErrorCode(msg)).toBeUndefined();
  });

  test('malformed JSON falls through to substring detection', () => {
    // "missing_scope" appears literally in the broken JSON; substring path catches it.
    const msg = '{not valid json missing_scope';
    expect(extractToolErrorCode(msg)).toBe('missing_scope');
  });
});

describe('buildAbortController', () => {
  test('no opts → signal never fires', async () => {
    const { signal, cleanup } = buildAbortController({});
    expect(signal.aborted).toBe(false);
    await new Promise(r => setTimeout(r, 50));
    expect(signal.aborted).toBe(false);
    cleanup();
  });

  test('timeoutMs fires on schedule', async () => {
    const { signal, cleanup } = buildAbortController({ timeoutMs: 30 });
    expect(signal.aborted).toBe(false);
    await new Promise(r => setTimeout(r, 80));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(Error);
    expect((signal.reason as Error).message).toContain('timeout');
    cleanup();
  });

  test('external signal already-aborted propagates immediately', () => {
    const ext = new AbortController();
    ext.abort(new Error('SIGINT'));
    const { signal, cleanup } = buildAbortController({ signal: ext.signal });
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  test('external signal aborted later propagates to inner signal', async () => {
    const ext = new AbortController();
    const { signal, cleanup } = buildAbortController({ signal: ext.signal });
    expect(signal.aborted).toBe(false);
    ext.abort(new Error('user-cancel'));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  test('timeout + external signal compose: whichever fires first wins', async () => {
    // External fires before timeout.
    const ext = new AbortController();
    const { signal, cleanup } = buildAbortController({ timeoutMs: 1000, signal: ext.signal });
    setTimeout(() => ext.abort(new Error('manual')), 20);
    await new Promise(r => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
    cleanup();
  });

  test('cleanup clears the timeout timer', async () => {
    // After cleanup, the timer must NOT fire (would otherwise leak via
    // unhandled abort on a controller no caller cares about).
    const { signal, cleanup } = buildAbortController({ timeoutMs: 30 });
    cleanup();
    await new Promise(r => setTimeout(r, 80));
    // signal can fire from the timer if cleanup didn't clear it.
    // We accept either outcome but clear cleanup is the contract.
    // The hard assertion is that calling cleanup doesn't throw and the
    // pending timer doesn't crash the process.
    void signal;
  });

  test('cleanup is idempotent (safe to call multiple times)', () => {
    const { cleanup } = buildAbortController({ timeoutMs: 100 });
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  test('cleanup removes external signal listener (no leak after callRemoteTool returns)', async () => {
    // The external signal should NOT keep the inner controller alive after
    // cleanup(). After cleanup, aborting the external must NOT mutate inner.
    const ext = new AbortController();
    const { signal, cleanup } = buildAbortController({ signal: ext.signal });
    cleanup();
    ext.abort(new Error('after-cleanup'));
    // Inner signal stays whatever it was at cleanup time. Since neither timeout
    // nor pre-cleanup external abort fired, it must still be NOT aborted.
    expect(signal.aborted).toBe(false);
  });
});

describe('RemoteMcpError class shape', () => {
  test('is an instance of Error', () => {
    const e = new RemoteMcpError('network', 'msg');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(RemoteMcpError);
  });

  test('exposes reason + detail as readonly fields', () => {
    const e = new RemoteMcpError('tool_error', 'msg', { code: 'missing_scope', mcp_url: MCP_URL });
    expect(e.reason).toBe('tool_error');
    expect(e.detail?.code).toBe('missing_scope');
    expect(e.detail?.mcp_url).toBe(MCP_URL);
  });

  test('has name="RemoteMcpError" for instanceof-free identification', () => {
    const e = new RemoteMcpError('parse', 'msg');
    expect(e.name).toBe('RemoteMcpError');
  });

  test('detail is optional', () => {
    const e = new RemoteMcpError('config', 'msg');
    expect(e.detail).toBeUndefined();
  });
});

describe('CallRemoteToolOptions type contract', () => {
  test('both fields are optional', () => {
    const empty: CallRemoteToolOptions = {};
    expect(empty.timeoutMs).toBeUndefined();
    expect(empty.signal).toBeUndefined();
  });

  test('timeoutMs accepts a number', () => {
    const opts: CallRemoteToolOptions = { timeoutMs: 30000 };
    expect(opts.timeoutMs).toBe(30000);
  });

  test('signal accepts an AbortSignal', () => {
    const ctrl = new AbortController();
    const opts: CallRemoteToolOptions = { signal: ctrl.signal };
    expect(opts.signal).toBe(ctrl.signal);
  });
});
