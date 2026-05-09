/**
 * Tests for the `enforceRemoteAccess` contract in dispatchToolCall.
 *
 * The dispatcher accepts an `enforceRemoteAccess: true` opt-in from HTTP
 * transports. When set, it must:
 *   - Reject `op.localOnly` operations.
 *   - Reject when caller scopes don't satisfy `op.scope`.
 *   - Reject when caller tier doesn't satisfy `op.tier`.
 *   - Run filterResponseByTier on the handler result.
 *
 * Regression-pin: when `enforceRemoteAccess: true` but `tier` is undefined,
 * the dispatcher must NOT fall open to ACCESS_TIER_DEFAULT (Full). It falls
 * closed to 'None' — a caller that opted into enforcement and forgot to
 * thread tier sees all-rejection rather than all-access. Same posture as
 * the response-filter path so a "skipped at the gate" scenario can't
 * silently leak via the post-handler filter.
 */

import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Minimal stub. dispatchToolCall only calls op.handler when the gates pass;
// the gates we exercise here run BEFORE the handler so the engine is never
// touched. Cast satisfies the type without standing up a real engine.
const stubEngine = {} as BrainEngine;

describe('dispatchToolCall — enforceRemoteAccess fail-closed defaults', () => {
  test('enforceRemoteAccess + missing tier rejects on a Full-required op', async () => {
    // run_doctor has no tier annotation -> required = OP_TIER_DEFAULT_REQUIRED = Full.
    // Caller didn't thread tier. Pre-fix: callerTier defaulted to Full, so
    // the gate passed and the operator's "enforce" knob did nothing.
    // Post-fix: callerTier defaults to None, so the gate rejects.
    const result = await dispatchToolCall(stubEngine, 'run_doctor', {}, {
      remote: true,
      enforceRemoteAccess: true,
      scopes: ['admin'],
      // tier intentionally omitted
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('insufficient_tier');
    expect(text).toContain("'None'");
  });

  test('enforceRemoteAccess + missing tier rejects on a Family-required op', async () => {
    // get_stats is tier:'Family'. None doesn't imply Family.
    const result = await dispatchToolCall(stubEngine, 'get_stats', {}, {
      remote: true,
      enforceRemoteAccess: true,
      scopes: ['admin'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('insufficient_tier');
  });

  test('enforceRemoteAccess + explicit Full tier passes the gate', async () => {
    // Sanity that the fail-closed default doesn't break legitimate Full callers.
    // run_doctor's handler will throw because the stub engine has no methods,
    // but the tier gate must pass first (we observe a non-tier error).
    const result = await dispatchToolCall(stubEngine, 'run_doctor', {}, {
      remote: true,
      enforceRemoteAccess: true,
      scopes: ['admin'],
      tier: 'Full',
    });
    if (result.isError) {
      expect(result.content[0].text).not.toContain('insufficient_tier');
    }
  });

  test('enforceRemoteAccess rejects localOnly ops', async () => {
    // file_upload is localOnly (RCE-adjacent surface).
    const result = await dispatchToolCall(stubEngine, 'file_upload', { path: '/tmp/x' }, {
      remote: true,
      enforceRemoteAccess: true,
      scopes: ['admin'],
      tier: 'Full',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('operation_unavailable');
    expect(result.content[0].text).toContain('local-only');
  });

  test('remote dispatch rejects localOnly ops even without enforceRemoteAccess', async () => {
    // Stdio MCP has no OAuth tier/scope context, but remote=true must still
    // honor localOnly metadata for host-local surfaces.
    const result = await dispatchToolCall(stubEngine, 'file_url', { storage_path: 'x' }, {
      remote: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('operation_unavailable');
    expect(result.content[0].text).toContain('local-only');
  });

  test('enforceRemoteAccess rejects insufficient scope', async () => {
    // put_page needs 'write' scope. Caller has only 'read'.
    const result = await dispatchToolCall(stubEngine, 'put_page', { slug: 'x', content: 'y' }, {
      remote: true,
      enforceRemoteAccess: true,
      scopes: ['read'],
      tier: 'Full',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('insufficient_scope');
  });

  test('without enforceRemoteAccess, missing tier preserves owner-trust bypass', async () => {
    // Stdio MCP and CLI rely on this: no enforceRemoteAccess -> dispatcher
    // doesn't gate on tier/scope/localOnly. The handler runs (and throws
    // here only because the stub engine has no methods).
    const result = await dispatchToolCall(stubEngine, 'run_doctor', {}, {
      remote: false,
      // enforceRemoteAccess omitted -> false
    });
    if (result.isError) {
      expect(result.content[0].text).not.toContain('insufficient_tier');
      expect(result.content[0].text).not.toContain('insufficient_scope');
      expect(result.content[0].text).not.toContain('operation_unavailable');
    }
  });
});
