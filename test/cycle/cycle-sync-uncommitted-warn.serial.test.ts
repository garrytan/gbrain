/**
 * Untracked-gap fix — cycle-level mapping of SyncResult.uncommitted.
 *
 * A nightly dream/cycle over a dirty vault used to report a clean 'ok +0'
 * sync phase while uncommitted files sat invisible to commit-driven sync.
 * runPhaseSync must now surface working-tree drift as status 'warn' with the
 * drift note in the summary and `details.uncommitted` populated — and keep
 * the clean-run mapping at 'ok' when no drift is reported.
 *
 * Follows the test/core/cycle.serial.test.ts convention: performSync is
 * mocked module-level; runCycle runs against a real PGLite engine for locks.
 */

import { describe, test, expect, mock, beforeAll, afterAll } from 'bun:test';

let uncommitted: { added: number; modified: number; deleted: number } | undefined;

mock.module('../../src/commands/sync.ts', () => ({
  performSync: async () => ({
    status: 'synced',
    fromCommit: 'abcd',
    toCommit: 'efgh',
    added: 2,
    modified: 1,
    deleted: 0,
    renamed: 0,
    chunksCreated: 4,
    embedded: 0,
    pagesAffected: ['a'],
    ...(uncommitted ? { uncommitted } : {}),
  }),
  runSync: async () => {},
  buildSyncManifest: () => ({ added: [], modified: [], deleted: [], renamed: [] }),
  isSyncable: () => true,
  pathToSlug: (s: string) => s,
}));

const { runCycle } = await import('../../src/core/cycle.ts');
const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('runCycle sync phase — uncommitted working-tree drift', () => {
  test("drift maps to 'warn' + summary note + details.uncommitted; clean run stays 'ok'", async () => {
    // Clean run first: no uncommitted field → 'ok', no drift note.
    uncommitted = undefined;
    const clean = await runCycle(engine, { brainDir: '/tmp/brain', phases: ['sync'] });
    const cleanPhase = clean.phases.find(p => p.phase === 'sync');
    expect(cleanPhase?.status).toBe('ok');
    expect(cleanPhase?.summary).not.toContain('uncommitted');
    expect(cleanPhase?.details.uncommitted).toBeUndefined();

    // Dirty vault: uncommitted drift present → 'warn' + note + details.
    uncommitted = { added: 2, modified: 1, deleted: 0 };
    const dirty = await runCycle(engine, { brainDir: '/tmp/brain', phases: ['sync'] });
    const dirtyPhase = dirty.phases.find(p => p.phase === 'sync');
    expect(dirtyPhase?.status).toBe('warn');
    expect(dirtyPhase?.summary).toContain('3 uncommitted file(s)');
    expect(dirtyPhase?.summary).toContain('sync.include_working_tree');
    expect(dirtyPhase?.details.uncommitted).toEqual({ added: 2, modified: 1, deleted: 0 });
  }, 60_000);
});
