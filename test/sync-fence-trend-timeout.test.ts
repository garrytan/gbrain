import { describe, expect, test } from 'bun:test';
import { recordPassFenceTrend } from '../src/core/persistence/sync-prepare.ts';

/** A transaction double that models the publication transaction's transaction-local statement_timeout (5 s). */
function fakeTx() {
  let timeoutMs = 5000;
  const trace: string[] = [];
  const executeRaw = async (sql: string, params?: unknown[]): Promise<any[]> => {
    if (/current_setting\('statement_timeout'\)/.test(sql)) return [{ v: `${timeoutMs}ms` }];
    if (/set_config\('statement_timeout'/.test(sql)) {
      const v = /\$1/.test(sql) ? String(params![0]) : /'(\d+)s'/.exec(sql)![1] + 's';
      timeoutMs = v.endsWith('ms') ? parseInt(v) : parseInt(v) * 1000;
      return [];
    }
    if (/FROM persistence_requests/.test(sql)) {
      trace.push(`scan@${timeoutMs}`);
      if (timeoutMs <= 5000) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      return [];
    }
    return [];
  };
  return { tx: { executeRaw } as any, trace, timeout: () => timeoutMs };
}

describe('recordPassFenceTrend', () => {
  test('a full-history scan is not bounded by the 5 s publication timeout, which is restored after', async () => {
    const f = fakeTx();
    let error: unknown = null;
    try {
      await recordPassFenceTrend(f.tx, { worktreeId: '00000000-0000-0000-0000-000000000000', sourceId: 's', passId: 'p', since: null });
    } catch (e) { error = e; }
    expect(error).toBeNull();
    expect(f.timeout()).toBe(5000);
  });
});
