/**
 * WP4 (amendment 32 / ENG-8) — writeSurfaceChangeAudit is best-effort by
 * design: the surface mutation has already committed when the audit write
 * runs, so an engine failure must resolve `false` (after a stderr warn),
 * NEVER throw — a failed audit row must not turn a successful mutation into
 * a caller-visible error. Happy-path row shape is pinned over real PGLite in
 * test/request-tools.test.ts; this file pins the fail-open contract with an
 * engine stub.
 */

import { describe, test, expect } from 'bun:test';
import { writeSurfaceChangeAudit, type SurfaceChangeAudit } from '../src/core/surface-audit.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { McpRequestLogRow } from '../src/core/engine-sql/telemetry.ts';

const AUDIT: SurfaceChangeAudit = {
  actor: 'cl-test',
  client_id: 'cl-test',
  old: null,
  new: 'starter',
  via: 'request_tools',
};

describe('writeSurfaceChangeAudit fail-open contract', () => {
  test('a throwing engine resolves false and does not throw', async () => {
    const throwing = {
      logMcpRequest: async () => { throw new Error('pool exhausted'); },
    } as unknown as BrainEngine;
    await expect(writeSurfaceChangeAudit(throwing, AUDIT)).resolves.toBe(false);
  });

  test('a working engine resolves true and binds the params object raw (jsonb discipline)', async () => {
    let captured: McpRequestLogRow | null = null;
    const capturing = {
      logMcpRequest: async (row: McpRequestLogRow) => {
        captured = row;
      },
    } as unknown as BrainEngine;
    await expect(writeSurfaceChangeAudit(capturing, AUDIT)).resolves.toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.operation).toBe('surface_change');
    // The params value is a RAW OBJECT (never JSON.stringify — #2339 class); logMcpRequest binds it as jsonb.
    const jsonbParam = captured!.params;
    expect(typeof jsonbParam).toBe('object');
    expect(jsonbParam).toMatchObject({ actor: 'cl-test', client_id: 'cl-test', old: null, new: 'starter', via: 'request_tools' });
  });
});
