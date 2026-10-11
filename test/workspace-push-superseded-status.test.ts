/**
 * #5799: a push-status record that a managed worktree has superseded must not
 * feed the hook's FAILING banner or staleness note. The predicate is pure
 * apart from the managed-root marker lookup, exercised here with a real
 * `.gbrain-managed` marker in a temp dir; no git, no engine, no env mutation.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSupersededPushStatus, livePushStatuses, type PushStatusEntry } from '../src/core/workspace-push.ts';

let dir: string;
let managedRoot: string;
let plainRoot: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-push-superseded-'));
  managedRoot = join(dir, 'managed');
  plainRoot = join(dir, 'plain');
  mkdirSync(managedRoot);
  mkdirSync(plainRoot);
  writeFileSync(join(managedRoot, '.gbrain-managed'), '');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (over: Partial<PushStatusEntry>): PushStatusEntry => ({ ts: '2026-10-01T00:00:00.000Z', ok: false, file: '/dev/null', ...over });

describe('isSupersededPushStatus (#5799)', () => {
  test('a managed-worktree refusal is superseded by its code, and by the reason prefix an older record carries', () => {
    expect(isSupersededPushStatus(entry({ code: 'writer_coordinator_required', reason: 'writer_coordinator_required: This path belongs to the managed canonical worktree /x.', repoRoot: plainRoot }))).toBe(true);
    expect(isSupersededPushStatus(entry({ reason: 'writer_coordinator_required: This file belongs to a managed canonical worktree.', repoRoot: plainRoot }))).toBe(true);
  });

  test('any record whose root is a managed worktree now is superseded, success included', () => {
    expect(isSupersededPushStatus(entry({ reason: 'push failed: remote rejected', repoRoot: managedRoot }))).toBe(true);
    expect(isSupersededPushStatus(entry({ ok: true, repoRoot: managedRoot }))).toBe(true);
    expect(isSupersededPushStatus(entry({ ok: true, repoRoot: join(managedRoot, 'brain') }))).toBe(true);
  });

  test('a live failure on an unmanaged root, or a record with no root, stays', () => {
    expect(isSupersededPushStatus(entry({ reason: 'push failed: remote rejected', repoRoot: plainRoot }))).toBe(false);
    expect(isSupersededPushStatus(entry({ reason: 'push failed: remote rejected', repoRoot: join(dir, 'gone') }))).toBe(false);
    expect(isSupersededPushStatus(entry({ reason: 'push failed: remote rejected' }))).toBe(false);
    expect(isSupersededPushStatus(entry({ code: 'secret_scan_blocked', reason: 'secret_scan_blocked: 1 finding', repoRoot: plainRoot }))).toBe(false);
  });

  test('livePushStatuses keeps order and drops only the superseded records', () => {
    const live = entry({ reason: 'push failed: remote rejected', repoRoot: plainRoot });
    const ok = entry({ ok: true, repoRoot: plainRoot });
    const fenced = entry({ code: 'writer_coordinator_required', reason: 'writer_coordinator_required: fenced', repoRoot: plainRoot });
    const managed = entry({ ok: true, repoRoot: managedRoot });
    expect(livePushStatuses([fenced, live, managed, ok])).toEqual([live, ok]);
    expect(livePushStatuses([])).toEqual([]);
  });

  // The hook.ts call site (banner + SessionStart note read livePushStatuses) is pinned
  // end to end by test/hook-push-banner-superseded.serial.test.ts.
});
