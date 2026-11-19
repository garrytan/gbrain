/**
 * #5012 (non-Google half) — connector partial syncs exit non-zero and print
 * their real cause. Pre-fix a GitHub sweep with a failed item returned
 * `partial` with no `reason`/`filesImported`, so the CLI printed
 * "imported 0 of N file(s), reason=timeout" and exited 0; a cron wrapper
 * could not tell it from a clean run.
 */
import { describe, expect, test } from 'bun:test';
import { isFailedPartial, printSyncResult } from '../src/commands/sync/report.ts';
import { withConnectorPartialReason } from '../src/commands/sync/connector.ts';
import type { SyncResult } from '../src/commands/sync.ts';

const base: SyncResult = {
  status: 'partial', fromCommit: null, toCommit: '', added: 12, modified: 3, deleted: 0, renamed: 0,
  chunksCreated: 0, embedded: 0, pagesAffected: [],
};

function render(result: SyncResult): string {
  let out = '';
  printSyncResult(result, { write: (s: string) => { out += s; return true; } } as unknown as NodeJS.WriteStream);
  return out;
}

describe('#5012 connector partial reason', () => {
  test('failed items -> connector_item_failures with the written count', () => {
    const r = withConnectorPartialReason({ ...base, failedFiles: 1 });
    expect(r.reason).toBe('connector_item_failures');
    expect(r.filesImported).toBe(15);
  });

  test('an early stop with no cause -> connector_partial; an aborted run stays timeout', () => {
    expect(withConnectorPartialReason(base).reason).toBe('connector_partial');
    const ac = new AbortController();
    ac.abort();
    expect(withConnectorPartialReason(base, ac.signal).reason).toBe('timeout');
  });

  test('a reason the connector already named is kept', () => {
    expect(withConnectorPartialReason({ ...base, reason: 'timeout' }).reason).toBe('timeout');
    expect(withConnectorPartialReason({ ...base, status: 'synced' }).reason).toBeUndefined();
  });
});

describe('#5012 exit verdict', () => {
  test('connector partials and pull failures exit non-zero; timeouts keep exit 0', () => {
    expect(isFailedPartial({ status: 'partial', reason: 'connector_item_failures' })).toBe(true);
    expect(isFailedPartial({ status: 'partial', reason: 'connector_partial' })).toBe(true);
    expect(isFailedPartial({ status: 'partial', reason: 'pull_failed' })).toBe(true);
    expect(isFailedPartial({ status: 'partial', reason: 'timeout' })).toBe(false);
    expect(isFailedPartial({ status: 'synced' })).toBe(false);
  });
});

describe('#5012 printed result', () => {
  test('connector partial names the cause and the recovery, never reason=timeout', () => {
    const out = render(withConnectorPartialReason({ ...base, failedFiles: 2 }));
    expect(out).toContain('[connector_item_failures]');
    expect(out).toContain('2 connector item(s) failed');
    expect(out).toContain('15 page(s) written');
    expect(out).toContain("foresights sync --source <id>");
    expect(out).not.toContain('reason=timeout');
  });

  test('a connector sync with no commit range prints Synced:, never undefined', () => {
    const out = render({ ...base, status: 'synced' });
    expect(out.split('\n')[0]).toBe('Synced:');
    expect(out).not.toContain('undefined');
  });
});
