/**
 * Dropped wrapper audit (cli-members-next): the sync's held-move plan on Postgres (held-fact-move.ts `planningView`).
 *
 * 1. Protects: every read the plan sends ends at the plan's deadline (#6318), so a lock another session holds never keeps
 *    the sync past its preparation budget. The view bounds raw reads (`timeoutMs`), the alias read and the binding read;
 *    the strict entity resolver's typed reads (readLivePageTypes, readTrigramCandidates, ...) that replaced its raw
 *    statements must run under the same deadline (`withReadDeadline`, which PostgresEngine.preparationRead honors).
 * 2. Fails when: a resolver read the plan reaches through heldFactTarget runs with no read deadline.
 * 3. Existing coverage: test/held-move-plan-gst2497.test.ts (Postgres only: a config-table lock; no resolver read).
 * 4. Real seams: moveRuledSharedHeld, planHeldMoves, heldFactTarget, resolveStrictEntityReference and the view itself;
 *    the engine is a recording stand-in that reports `kind: 'postgres'` so the view is installed (it runs on PGLite CI).
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { moveRuledSharedHeld } from '../src/core/facts/held-fact-move.ts';
import { readDeadline } from '../src/core/read-deadline.ts';
import { resetSyncPreparationBudget } from '../src/core/persistence/sync-waivers.ts';

class Stop extends Error {}

function recordingEngine() {
  const typed: Array<{ member: string; deadline: number | undefined }> = [];
  const raw: Array<{ sql: string; timeoutMs: number | undefined }> = [];
  const own: Record<string, unknown> = {
    kind: 'postgres',
    getConfig: async () => null,
    executeRaw: async (sql: string, _params?: unknown[], opts?: { timeoutMs?: number }) => {
      raw.push({ sql, timeoutMs: opts?.timeoutMs });
      if (/\bAS due\b/.test(sql)) return [{ due: true }];
      // The unmanaged writer's mode read (managed-mode.ts) meets the singleton row of an unmanaged brain.
      if (/FROM persistence_brain\b/.test(sql)) return [{ enabled: false }];
      // One held row on the shared holding page whose entity is a bare two-word name (heldFactTarget resolves it).
      if (/FROM facts f WHERE/.test(sql) && /expired_at IS NULL ORDER BY/.test(sql)) return [{ id: 1, source_id: 'default', entity_slug: 'Acme Example',
        fact: 'A held fact.', kind: 'fact', visibility: 'world', page_exists: true, from_slug: 'memory/unattributed' }];
      return [];
    },
    resolveAliases: async () => new Map(),
    readManagedModeRows: async () => [{ enabled: false }], // an unmanaged brain, as the raw mode read answered before
    // No live page carries the bare name, so the plan goes on to the strict resolver (heldFactTarget).
    heldTargetPageLive: async () => { typed.push({ member: 'heldTargetPageLive', deadline: readDeadline() }); return false; },
    // The due check and the held rows are typed members on rust-engine/main (heldMoveDue, listHeldMoveRows) whose SQL runs on
    // the engine's own executeRaw; the plan binds them to its view, so their statement carries the deadline like a raw read.
    async heldMoveDue(this: BrainEngine) { return (await this.executeRaw<{ due: boolean }>('SELECT true AS due'))[0]?.due === true; },
    async listHeldMoveRows(this: BrainEngine) { return this.executeRaw('SELECT * FROM facts f WHERE f.expired_at IS NULL ORDER BY f.id'); },
    getWorktreeBinding: async () => { typed.push({ member: 'getWorktreeBinding', deadline: readDeadline() }); throw new Stop('stop after the resolver'); },
  };
  const engine = new Proxy(own, { get(target, key) {
    if (typeof key !== 'string' || key in target || key === 'then') return target[key as string];
    // Any other typed read: record whether it runs under a read deadline and answer it empty.
    return async () => { typed.push({ member: key, deadline: readDeadline() }); return []; };
  }, has: (target, key) => typeof key === 'string' && key !== 'then' }) as unknown as BrainEngine;
  return { engine, typed, raw };
}

describe('the held-move plan bounds the strict resolver typed reads (planningView)', () => {
  test('every typed read the plan reaches runs under the plan deadline, like its raw reads and binding read', async () => {
    resetSyncPreparationBudget();
    const { engine, typed, raw } = recordingEngine();
    await expect(moveRuledSharedHeld(engine, 'default')).rejects.toBeInstanceOf(Stop);
    // The view is installed: the due check and the plan's raw reads carry the deadline.
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every(r => typeof r.timeoutMs === 'number')).toBe(true);
    // Positive control: the binding read (intercepted) runs under the deadline.
    expect(typed.find(t => t.member === 'getWorktreeBinding')?.deadline).toEqual(expect.any(Number));
    // The resolver reads were reached ...
    // The held-move reads the plan binds to its view (DEADLINE_BOUND in held-fact-move.ts: their SQL runs on the view's
    // executeRaw, checked through `raw` above) are not resolver reads.
    const viewBound = new Set(['heldMoveDue', 'listHeldMoveRows', 'listStruckHeldRows', 'heldTargetPageLive', 'readHeldRowVisibility',
      'heldEntityPageDeleted', 'readHeldAccessState', 'readHeldConfigValue']);
    const resolver = typed.filter(t => t.member !== 'getWorktreeBinding' && !viewBound.has(t.member));
    expect(resolver.map(t => t.member)).toEqual(expect.arrayContaining(['readLivePageTypes', 'readTrigramCandidates']));
    // ... and each ran under the plan's deadline.
    expect(resolver.filter(t => t.deadline === undefined).map(t => t.member)).toEqual([]);
  });
});
