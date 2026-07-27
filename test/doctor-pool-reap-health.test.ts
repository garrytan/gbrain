// #1685 GAP B — pool_reap_health doctor check.
//
// computePoolReapHealthCheck only touches engine.kind + the pool-recovery audit
// (filesystem), so a minimal `{ kind: 'postgres' }` stub drives it hermetically.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withEnv } from './helpers/with-env.ts';
import { logPoolRecovery } from '../src/core/audit/pool-recovery-audit.ts';
import { computePoolReapHealthCheck } from '../src/commands/doctor.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pg = { kind: 'postgres' } as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pglite = { kind: 'pglite' } as any;

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-reap-health-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('computePoolReapHealthCheck', () => {
  test('null on PGLite (no pool) and on null engine', async () => {
    expect(await computePoolReapHealthCheck(pglite)).toBeNull();
    expect(await computePoolReapHealthCheck(null)).toBeNull();
  });

  test('fail when reconnect failed (reconnect is throwing)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logPoolRecovery('reap_detected');
      logPoolRecovery('reconnect_failed', new Error('EHOSTUNREACH'));
      const c = await computePoolReapHealthCheck(pg);
      expect(c?.status).toBe('fail');
      expect(c?.message).toContain('reconnect is throwing');
      expect(c?.name).toBe('pool_reap_health');
    });
  });

  // CODEX impl review #3: the fail trigger is the reconnect FAILURES themselves
  // (reconnect throwing is the real, actionable problem), NOT a fabricated
  // reap→failure causal link. A reconnect_failed with zero reaps still fails.
  test('fail on reconnect failure even with zero reaps (no false causality)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logPoolRecovery('reconnect_failed', new Error('password authentication failed'));
      const c = await computePoolReapHealthCheck(pg);
      expect(c?.status).toBe('fail');
      expect(c?.message).toContain('0 pooler reap(s) detected');
      expect(c?.message).not.toContain('not auto-recovering');
    });
  });

  test('warn on pooler thrash (>=10 reaps all recovered)', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      for (let i = 0; i < 12; i++) {
        logPoolRecovery('reap_detected');
        logPoolRecovery('reconnect_succeeded');
      }
      const c = await computePoolReapHealthCheck(pg);
      expect(c?.status).toBe('warn');
      expect(c?.message).toContain('12×');
    });
  });

  test('null (quiet) when a few reaps all recovered', async () => {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      logPoolRecovery('reap_detected');
      logPoolRecovery('reconnect_succeeded');
      const c = await computePoolReapHealthCheck(pg);
      expect(c).toBeNull();
    });
  });
});
