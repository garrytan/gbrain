import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import {
  createSyncPlan,
  SYNC_PLAN_SAMPLE_LIMIT,
  type SyncPlanOperation,
} from '../src/core/sync-plan.ts';
import { LockReleaseFailedError } from '../src/core/db-lock.ts';
import {
  buildGBrainSyncErrorEnvelope,
  SyncLockBusyError,
} from '../src/commands/sync.ts';

function planFor(operations: SyncPlanOperation[]) {
  return createSyncPlan({
    mode: 'incremental',
    sourceId: 'source-a',
    repoPath: '/repo',
    fromCommit: '1'.repeat(40),
    targetCommit: '2'.repeat(40),
    strategy: 'auto',
    operations,
  });
}

describe('immutable sync plan evidence', () => {
  for (const count of [0, 99, 100, 101]) {
    test(`caps deterministic affected evidence at ${SYNC_PLAN_SAMPLE_LIMIT} for ${count} operations`, () => {
      const plan = planFor(
        Array.from({ length: count }, (_, index) => ({
          kind: 'add' as const,
          path: `notes/${String(index).padStart(3, '0')}.md`,
          slug: `notes/${String(index).padStart(3, '0')}`,
        })),
      );

      expect(plan.affected.total).toBe(count);
      expect(plan.affected.sample).toHaveLength(
        Math.min(count, SYNC_PLAN_SAMPLE_LIMIT),
      );
      expect(plan.affected.truncated).toBe(count > SYNC_PLAN_SAMPLE_LIMIT);
    });
  }

  test('digest is UTF-8 bytewise over exact kind/path/slug/from_path lines', () => {
    const operations: SyncPlanOperation[] = [
      { kind: 'modify', path: 'é.md', slug: 'accent' },
      { kind: 'add', path: '你好.md', slug: '你好' },
      { kind: 'delete', path: '💾.md', slug: 'disk' },
      { kind: 'rename', path: 'Ω.ts', fromPath: 'old.ts', slug: 'omega.ts' },
    ];
    const lines = operations
      .map((operation) =>
        [
          operation.kind,
          operation.path,
          operation.slug,
          operation.fromPath ?? '',
        ].join('\t') + '\n')
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
      )
      .join('');
    const expected = createHash('sha256').update(lines, 'utf8').digest('hex');

    expect(planFor(operations).affectedDigest).toBe(expected);
  });

  test('digest distinguishes renames with different source paths', () => {
    const first = planFor([
      {
        kind: 'rename',
        path: 'notes/new.md',
        fromPath: 'notes/first.md',
        slug: 'notes/new',
      },
    ]);
    const second = planFor([
      {
        kind: 'rename',
        path: 'notes/new.md',
        fromPath: 'notes/second.md',
        slug: 'notes/new',
      },
    ]);

    expect(first.affected.sample[0]?.from_path).toBe('notes/first.md');
    expect(second.affected.sample[0]?.from_path).toBe('notes/second.md');
    expect(first.affectedDigest).not.toBe(second.affectedDigest);
  });

  test('full plan commitment binds target content and schema-pack identity', () => {
    const first = createSyncPlan({
      mode: 'incremental',
      sourceId: 'default',
      repoPath: '/brain',
      fromCommit: 'a'.repeat(40),
      targetCommit: 'b'.repeat(40),
      strategy: 'markdown',
      schemaPackIdentity: 'base@1+aaaaaaaa',
      operations: [{
        kind: 'modify',
        path: 'notes/topic.md',
        slug: 'notes/topic',
        contentHash: '1'.repeat(64),
      }],
    });
    const contentChanged = createSyncPlan({
      mode: 'incremental',
      sourceId: 'default',
      repoPath: '/brain',
      fromCommit: 'a'.repeat(40),
      targetCommit: 'b'.repeat(40),
      strategy: 'markdown',
      schemaPackIdentity: 'base@1+aaaaaaaa',
      operations: [{
        kind: 'modify',
        path: 'notes/topic.md',
        slug: 'notes/topic',
        contentHash: '2'.repeat(64),
      }],
    });
    const packChanged = createSyncPlan({
      mode: 'incremental',
      sourceId: 'default',
      repoPath: '/brain',
      fromCommit: 'a'.repeat(40),
      targetCommit: 'b'.repeat(40),
      strategy: 'markdown',
      schemaPackIdentity: 'base@2+bbbbbbbb',
      operations: [{
        kind: 'modify',
        path: 'notes/topic.md',
        slug: 'notes/topic',
        contentHash: '1'.repeat(64),
      }],
    });

    expect(contentChanged.affectedDigest).toBe(first.affectedDigest);
    expect(packChanged.affectedDigest).toBe(first.affectedDigest);
    expect(contentChanged.planDigest).not.toBe(first.planDigest);
    expect(packChanged.planDigest).not.toBe(first.planDigest);
    expect(first.planDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  for (const [label, value] of [
    ['tab', 'bad\tpath.md'],
    ['line-feed', 'bad\npath.md'],
    ['carriage-return', 'bad\rpath.md'],
    ['nul', 'bad\u0000path.md'],
  ] as const) {
    test(`fails closed on ${label} in a digest field`, () => {
      expect(() =>
        planFor([{ kind: 'add', path: value, slug: 'bad' }]),
      ).toThrow(/control character.*affected digest/);
    });
  }

  test('requires from_path only for rename operations', () => {
    expect(() =>
      planFor([{ kind: 'rename', path: 'to.md', slug: 'to' }]),
    ).toThrow(/rename operations require/);

    expect(() =>
      planFor([
        {
          kind: 'modify',
          path: 'to.md',
          slug: 'to',
          fromPath: 'from.md',
        },
      ]),
    ).toThrow(/must not carry from_path/);
  });

  test('preservation evidence never contaminates mutation digest or sample', () => {
    const mutation: SyncPlanOperation = {
      kind: 'modify',
      path: 'src/app.ts',
      slug: 'src/app.ts',
    };
    const base = planFor([mutation]);
    const withPreserve = planFor([
      mutation,
      {
        kind: 'preserve',
        path: 'notes/legacy.md',
        slug: 'notes/legacy',
        reason: 'excluded-by-selected-strategy',
      },
    ]);

    expect(withPreserve.preserved).toBe(1);
    expect(withPreserve.affected).toEqual(base.affected);
    expect(withPreserve.affectedDigest).toBe(base.affectedDigest);
  });
});

describe('sync JSON lock errors', () => {
  test('release failure reports lock_only state with a stable reason', () => {
    const envelope = buildGBrainSyncErrorEnvelope(
      new LockReleaseFailedError(
        'gbrain-sync:source-a',
        new Error('injected'),
      ),
    );
    expect(envelope.reason_code).toBe('lock_release_failed');
    expect(envelope.state_changed).toBe('lock_only');
  });

  test('busy lock reports a stable refusal reason', () => {
    const envelope = buildGBrainSyncErrorEnvelope(
      new SyncLockBusyError('busy', 'gbrain-sync:source-a'),
    );
    expect(envelope.status).toBe('refused');
    expect(envelope.reason_code).toBe('lock_busy');
    expect(envelope.state_changed).toBe('none');
  });
});
