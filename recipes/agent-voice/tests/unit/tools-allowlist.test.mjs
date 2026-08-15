/**
 * tools-allowlist.test.mjs — D14-A invariant.
 *
 * The voice-callable tool router exposes ONLY read-only ops by default.
 * Write ops (put_page, submit_job, etc.) are permanently denylisted; even
 * adding them to a local override file MUST NOT enable them.
 *
 * This test pins the allow-list shape and the rejection behavior. If a
 * future contributor adds an unsafe op to READ_ONLY_OPS (e.g. "put_page")
 * or removes the DENYLIST check, the test fails loud.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  READ_ONLY_OPS,
  OPTIONAL_OPS,
  DENYLIST,
  getEffectiveAllowlist,
  rejectedToolResult,
  dispatchTool,
  describeAllowlist,
} from '../../code/tools.mjs';

describe('READ_ONLY_OPS', () => {
  it('is the documented set of 8 read ops', () => {
    expect(READ_ONLY_OPS).toEqual([
      'search',
      'query',
      'get_page',
      'list_pages',
      'find_experts',
      'get_recent_salience',
      'get_recent_transcripts',
      'read_article',
    ]);
  });

  it('contains zero ops that look write-shaped', () => {
    // Any op whose name suggests a write (put_, set_, delete_, submit_,
    // upload_, write_, create_, update_) MUST NOT be in READ_ONLY_OPS.
    const writeVerbs = /^(put_|set_|delete_|submit_|upload_|write_|create_|update_|insert_|add_)/;
    for (const op of READ_ONLY_OPS) {
      expect(op, `${op} looks write-shaped`).not.toMatch(writeVerbs);
    }
  });

  it('is frozen (compile-time immutable)', () => {
    expect(Object.isFrozen(READ_ONLY_OPS)).toBe(true);
  });
});

describe('DENYLIST', () => {
  it('contains the high-blast-radius ops', () => {
    expect(DENYLIST).toContain('put_page');
    expect(DENYLIST).toContain('submit_job');
    expect(DENYLIST).toContain('file_upload');
    expect(DENYLIST).toContain('delete_page');
    expect(DENYLIST).toContain('shell');
    expect(DENYLIST).toContain('sync_brain');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DENYLIST)).toBe(true);
  });

  it('has no overlap with READ_ONLY_OPS', () => {
    for (const op of DENYLIST) {
      expect(READ_ONLY_OPS, `${op} appears in both DENYLIST and READ_ONLY_OPS`).not.toContain(op);
    }
  });

  it('has no overlap with OPTIONAL_OPS', () => {
    for (const op of DENYLIST) {
      expect(OPTIONAL_OPS, `${op} appears in both DENYLIST and OPTIONAL_OPS`).not.toContain(op);
    }
  });
});

describe('OPTIONAL_OPS', () => {
  it('contains opt-in write ops only', () => {
    // OPTIONAL_OPS may contain bounded write ops, but each MUST be safe
    // enough that an operator opt-in is reasonable. Specifically: no
    // arbitrary-page-write (put_page), no shell (submit_job for shell), no
    // file upload, no delete.
    expect(OPTIONAL_OPS).toContain('set_reminder');
    expect(OPTIONAL_OPS).toContain('log_to_brain');
    expect(OPTIONAL_OPS).not.toContain('put_page');
    expect(OPTIONAL_OPS).not.toContain('submit_job');
  });
});

describe('getEffectiveAllowlist()', () => {
  beforeEach(() => {
    // Force-reload between tests to avoid module-level memoization carrying
    // overrides from one case to the next.
    getEffectiveAllowlist({ forceReload: true });
  });

  it('returns READ_ONLY_OPS by default (no local override)', () => {
    const allowlist = getEffectiveAllowlist({ forceReload: true });
    // No tools-allowlist.local.json shipped — should be exactly READ_ONLY_OPS.
    expect([...allowlist].sort()).toEqual([...READ_ONLY_OPS].sort());
  });
});

describe('dispatchTool() rejection paths', () => {
  it('rejects denylisted ops with code "denylisted"', async () => {
    for (const op of DENYLIST) {
      const result = await dispatchTool(op, {});
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe('denylisted');
      expect(result.error.op).toBe(op);
      expect(result.error.message).toMatch(/disabled/);
    }
  });

  it('rejects unknown ops not in the allow-list with code "not_in_allowlist"', async () => {
    const result = await dispatchTool('unknown_op', {});
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe('not_in_allowlist');
    expect(result.error.op).toBe('unknown_op');
  });

  it('rejects ops that look like they should be writes but are not even allowed', async () => {
    // Sample a few high-blast write ops; they must reject.
    for (const op of ['put_page', 'submit_job', 'file_upload', 'delete_page', 'shell']) {
      const result = await dispatchTool(op, {});
      expect(result.error.code).toBe('denylisted');
    }
  });

  it('never throws on rejection — always returns a {error: ...} envelope', async () => {
    // The voice agent depends on never having a tool call HANG via unhandled
    // exception. Even bizarre inputs must return a structured envelope.
    await expect(dispatchTool(undefined, {})).resolves.toHaveProperty('error');
    await expect(dispatchTool(null, {})).resolves.toHaveProperty('error');
    await expect(dispatchTool('', {})).resolves.toHaveProperty('error');
    await expect(dispatchTool(42, {})).resolves.toHaveProperty('error');
  });
});

describe('rejectedToolResult()', () => {
  it('returns the documented shape', () => {
    const r = rejectedToolResult('foo', 'not_in_allowlist');
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe('not_in_allowlist');
    expect(r.error.op).toBe('foo');
    expect(typeof r.error.message).toBe('string');
  });

  it('distinguishes "denylisted" vs "not_in_allowlist" in the message', () => {
    const denied = rejectedToolResult('put_page', 'denylisted');
    const notAllowed = rejectedToolResult('foo', 'not_in_allowlist');
    expect(denied.error.message).not.toBe(notAllowed.error.message);
    expect(denied.error.message).toMatch(/disabled/);
    expect(notAllowed.error.message).toMatch(/opt in/);
  });
});

describe('describeAllowlist()', () => {
  it('returns the structured breakdown', () => {
    const desc = describeAllowlist({ forceReload: true });
    expect(desc.read_only).toEqual([...READ_ONLY_OPS]);
    expect(desc.optional).toEqual([...OPTIONAL_OPS]);
    expect(desc.denylist).toEqual([...DENYLIST]);
    expect(desc.effective.length).toBeGreaterThanOrEqual(READ_ONLY_OPS.length);
  });
});
