/**
 * Wire validation pins for serve-delegated sync (sync-ipc.ts).
 *
 * The validator is the trust boundary between the unix socket and the serve
 * process's SyncOpts: unknown keys MUST reject (that is the only thing keeping
 * repoPath / skipLock / lockId / concurrency unreachable from the wire), and
 * timeoutSeconds is the bounded-job guarantee.
 */

import { describe, expect, test } from 'bun:test';
import {
  DELEGATED_SYNC_OPTION_FIELDS,
  DELEGATED_SYNC_TIMEOUT_MAX_SECONDS,
  WIRE_PAGES_AFFECTED_MAX,
  toWireSyncResult,
  validateDelegatedSyncOptions,
} from '../../src/core/context/sync-ipc.ts';
import type { SyncResult } from '../../src/commands/sync.ts';

describe('validateDelegatedSyncOptions', () => {
  test('accepts the full allowlisted set and returns a fresh object', () => {
    const raw = {
      sourceId: 'notes',
      dryRun: true,
      full: false,
      noPull: true,
      noEmbed: false,
      noExtract: false,
      noSchemaPack: true,
      skipFailed: false,
      retryFailed: false,
      includeGitignored: true,
      timeoutSeconds: 3600,
    };
    const v = validateDelegatedSyncOptions(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error('unreachable');
    expect(v.options).toEqual(raw);
    expect(v.options).not.toBe(raw as never);
  });

  test('minimal valid payload: only timeoutSeconds', () => {
    const v = validateDelegatedSyncOptions({ timeoutSeconds: 60 });
    expect(v.ok).toBe(true);
  });

  test.each([
    ['repoPath', { repoPath: '/tmp/evil', timeoutSeconds: 60 }],
    ['skipLock', { skipLock: true, timeoutSeconds: 60 }],
    ['lockId', { lockId: 'gbrain-cycle', timeoutSeconds: 60 }],
    ['concurrency', { concurrency: 8, timeoutSeconds: 60 }],
    ['srcSubpath', { srcSubpath: '../escape', timeoutSeconds: 60 }],
    ['exclude', { exclude: ['*'], timeoutSeconds: 60 }],
    ['signal', { signal: {}, timeoutSeconds: 60 }],
    ['onProgress', { onProgress: () => {}, timeoutSeconds: 60 }],
  ])('rejects unknown/smuggled key %s fail-closed', (key, raw) => {
    const v = validateDelegatedSyncOptions(raw);
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error('unreachable');
    expect(v.error).toBe(`invalid_options:${key}`);
  });

  test.each([
    ['non-object', null],
    ['array', []],
    ['string', 'sync'],
  ])('rejects a %s payload', (_label, raw) => {
    const v = validateDelegatedSyncOptions(raw);
    expect(v.ok).toBe(false);
  });

  test('rejects wrong-typed allowlisted fields', () => {
    expect(validateDelegatedSyncOptions({ dryRun: 'yes', timeoutSeconds: 60 }).ok).toBe(false);
    expect(validateDelegatedSyncOptions({ sourceId: 42, timeoutSeconds: 60 }).ok).toBe(false);
  });

  test('timeoutSeconds is required, integer, non-negative; 0 means no server timer', () => {
    expect(validateDelegatedSyncOptions({})).toEqual({
      ok: false,
      error: 'invalid_options:timeoutSeconds',
    });
    expect(validateDelegatedSyncOptions({ timeoutSeconds: -1 }).ok).toBe(false);
    expect(validateDelegatedSyncOptions({ timeoutSeconds: 1.5 }).ok).toBe(false);
    const zero = validateDelegatedSyncOptions({ timeoutSeconds: 0 });
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.options.timeoutSeconds).toBe(0);
  });

  test('timeoutSeconds clamps to the 24h ceiling', () => {
    const v = validateDelegatedSyncOptions({ timeoutSeconds: 999_999_999 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.options.timeoutSeconds).toBe(DELEGATED_SYNC_TIMEOUT_MAX_SECONDS);
  });

  test('sourceId must satisfy the canonical shape', () => {
    expect(validateDelegatedSyncOptions({ sourceId: 'UPPER', timeoutSeconds: 60 })).toEqual({
      ok: false,
      error: 'invalid_options:sourceId',
    });
    expect(validateDelegatedSyncOptions({ sourceId: '-lead', timeoutSeconds: 60 }).ok).toBe(false);
    expect(validateDelegatedSyncOptions({ sourceId: 'ok-source', timeoutSeconds: 60 }).ok).toBe(true);
  });

  test('field table and options interface stay in lockstep', () => {
    // The validator iterates the table; if a field is added to the interface
    // but not the table it becomes unreachable from the wire — this pin makes
    // that drift loud.
    expect(Object.keys(DELEGATED_SYNC_OPTION_FIELDS).sort()).toEqual([
      'dryRun',
      'full',
      'includeGitignored',
      'noEmbed',
      'noExtract',
      'noPull',
      'noSchemaPack',
      'retryFailed',
      'skipFailed',
      'sourceId',
      'timeoutSeconds',
    ]);
  });
});

describe('toWireSyncResult', () => {
  const base: SyncResult = {
    status: 'synced',
    fromCommit: 'aaa',
    toCommit: 'bbb',
    added: 2,
    modified: 1,
    deleted: 0,
    renamed: 0,
    chunksCreated: 3,
    embedded: 0,
    pagesAffected: [],
  };

  test('passes small results through with an exact total', () => {
    const r = toWireSyncResult({ ...base, pagesAffected: ['a', 'b'] });
    expect(r.pagesAffected).toEqual(['a', 'b']);
    expect(r.pagesAffectedTotal).toBe(2);
  });

  test('truncates pagesAffected past the cap and reports the true total', () => {
    const pages = Array.from({ length: WIRE_PAGES_AFFECTED_MAX + 1 }, (_, i) => `p/${i}`);
    const r = toWireSyncResult({ ...base, pagesAffected: pages });
    expect(r.pagesAffected).toHaveLength(WIRE_PAGES_AFFECTED_MAX);
    expect(r.pagesAffectedTotal).toBe(WIRE_PAGES_AFFECTED_MAX + 1);
    expect(r.pagesAffected[0]).toBe('p/0');
  });

  test('preserves partial-result fields', () => {
    const r = toWireSyncResult({
      ...base,
      status: 'partial',
      reason: 'timeout',
      filesImported: 7,
      bankedFiles: 7,
    });
    expect(r.status).toBe('partial');
    expect(r.reason).toBe('timeout');
    expect(r.bankedFiles).toBe(7);
  });
});
