/**
 * A capability refusal (`engine_capability_missing`) is never one item's
 * failure: the engine cannot serve the call for any item, so every later item
 * would refuse the same way.
 *
 * Protects: (1) classifyItemFailure reads the refusal as run-scoped, so an
 * ItemRun sweep (here the repair all-kinds loop) stops the command with the
 * refusal instead of listing every item as failed; (2) the Gmail sweep's loop
 * detection (applyLoopDetection), which logs and skips a thread whose
 * detection fails, lets the refusal through instead of reporting a healthy
 * sweep with no open loops.
 * Fails when: 'engine_capability_missing' leaves RUN_SCOPED_CODES, or
 * applyLoopDetection's catch swallows the refusal again.
 * Seams: a stub engine whose every member refuses; stub repair kinds passed as
 * the registry, as runRepairKinds accepts.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { classifyItemFailure } from '../src/core/item-failure.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { applyLoopDetection } from '../src/core/google/loops-enqueue.ts';
import { NO_EXCLUSION } from '../src/core/google/loops-exclusion.ts';
import type { GoogleSyncDeps } from '../src/core/google/sweep-shared.ts';
import type { GmailThreadData } from '../src/core/google/types.ts';
import type { RepairKind, RepairResult, RepairScope } from '../src/core/repair/core.ts';
import { runRepairKinds } from '../src/commands/repair.ts';

/** An engine that implements nothing: every member refuses with engine_capability_missing. */
function refusingEngine(): BrainEngine {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return () => { throw capabilityMissing('raw_sql', String(prop)); };
    },
  }) as BrainEngine;
}

describe('engine_capability_missing is run-scoped', () => {
  test('classifyItemFailure reads the refusal as run-scoped', () => {
    expect(classifyItemFailure(capabilityMissing('raw_sql', 'executeRaw')).scope).toBe('run');
  });

  test('the repair all-kinds sweep stops on the first refusal instead of failing each kind', async () => {
    const kinds: RepairKind[] = ['timeline', 'visibility', 'safe-chunks'];
    const ran: RepairKind[] = [];
    const refusal = capabilityMissing('raw_sql', 'executeRaw');
    const scope = { source_ids: ['default'] } as unknown as RepairScope;
    const outcome = await runRepairKinds(kinds, scope, { apply: false, noEmbed: true, named: false }, async (kind): Promise<RepairResult> => {
      ran.push(kind);
      throw refusal;
    }).then(results => ({ results }), (error: unknown) => ({ error }));
    expect(outcome).toEqual({ error: refusal });
    expect(ran).toEqual(['timeline']);
  });
});

describe('Gmail loop detection lets a capability refusal through', () => {
  test('applyLoopDetection re-raises engine_capability_missing instead of logging and skipping the thread', async () => {
    const logs: string[] = [];
    const deps = {
      engine: refusingEngine(), sourceId: 'gsrc', opts: { sourceId: 'gsrc', noEmbed: true, noExtract: true },
      entry: { id: 'google:a@example.com', provider: 'google', kind: 'oauth2', client_ref: 'byo', secret: {}, meta: { account: 'a@example.com' } },
      log: (msg: string) => { logs.push(msg); }, tick: () => {}, exclusion: NO_EXCLUSION, managed: null,
      processedThreads: new Set<string>(), extractCandidates: [],
    } as unknown as GoogleSyncDeps;
    const thread: GmailThreadData = { threadId: '1111aaaa', account: 'a@example.com', messages: [] };
    const error = await applyLoopDetection(deps, thread, 'emails/2026/08/a-1111aaaa').then(() => null, (err: unknown) => err);
    expect((error as { code?: unknown } | null)?.code).toBe('engine_capability_missing');
  });

  test('any other detection failure is still logged and the thread skipped', async () => {
    const logs: string[] = [];
    const engine = new Proxy({}, { get: (_t, prop) => prop === 'then' ? undefined : () => { throw new Error('transient read failure'); } }) as BrainEngine;
    const deps = {
      engine, sourceId: 'gsrc', opts: { sourceId: 'gsrc', noEmbed: true, noExtract: true },
      entry: { id: 'google:a@example.com', provider: 'google', kind: 'oauth2', client_ref: 'byo', secret: {}, meta: { account: 'a@example.com' } },
      log: (msg: string) => { logs.push(msg); }, tick: () => {}, exclusion: NO_EXCLUSION, managed: null,
      processedThreads: new Set<string>(), extractCandidates: [],
    } as unknown as GoogleSyncDeps;
    const thread: GmailThreadData = { threadId: '1111aaaa', account: 'a@example.com', messages: [] };
    expect(await applyLoopDetection(deps, thread, 'emails/2026/08/a-1111aaaa')).toBeNull();
    expect(logs.join('\n')).toContain('transient read failure');
  });
});
