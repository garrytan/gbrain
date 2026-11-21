/**
 * Authoring gate:
 * (1) Protects the contract that a managed `gbrain sync` surfaces withheld deletes (`deletes_withheld`) in both human
 *     output and `--json` envelopes (including idle `up_to_date` ticks and `--all` via `printHoldNotes`), instead of
 *     silently printing `-0 soft-deleted` or `Already up to date.`.
 * (2) Fails if `runSyncPass`/`stampIdlePass` stop populating `SyncResult.deletes_withheld`, if `syncHoldJsonFields` drops
 *     it from JSON envelopes, or if `printHoldNotes` stops printing the withheld line.
 * (3) Existing #6712/#7130 tests assert `readSyncStatus` and the `op_checkpoints` record directly; none tested `SyncResult`,
 *     `buildSingleSyncJsonEnvelope`, or `printSyncResult`/`printHoldNotes` output.
 * (4) One new test seam: `mergeExtraPass` is exported so the #6340 extra-pass merge can be called directly; reaching it
 *     through `drainManagedSync` needs HEAD to move mid-run. Everything else uses existing exports (`performManagedSync`,
 *     `runDrain`, `printSyncResult`, `printHoldNotes`, `buildSingleSyncJsonEnvelope`, `readSyncStatus`).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncResult } from '../src/commands/sync.ts';
import { printSyncResult } from '../src/commands/sync/report.ts';
import { printHoldNotes } from '../src/commands/sync-diagnostics.ts';
import { buildSingleSyncJsonEnvelope } from '../src/core/sync-embed-backfill.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { runDrain } from '../src/core/persistence/sync-drain.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { SYNC_DELETES_WITHHELD_OP } from '../src/core/persistence/sync-pass-row.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setupNotes = (names: string[]) => ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q');
  for (const name of names) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, `The committed body of notes/${name}.`));
  commit(root, 'initial notes');
};

function renderSync(result: SyncResult): string {
  const chunks: string[] = [];
  const sink = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WriteStream;
  printSyncResult(result, sink);
  return chunks.join('');
}

function renderHoldNotes(result: SyncResult): string[] {
  const lines: string[] = [];
  printHoldNotes(result, line => lines.push(line));
  return lines;
}

describe('gbrain sync surfaces deletes_withheld in human output and JSON envelopes', () => {
  test('first trip, idle tick, changed set, and valve release', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.max_deletes', '1');

    // 1. First trip: remove 2 of 6 files.
    git(root, 'rm', '-q', 'notes/a.md', 'notes/b.md');
    commit(root, 'remove two notes');

    const first = await performManagedSync(engine, OPTS);
    expect(first.status).toBe('synced');
    expect(first.deleted).toBe(0);
    const [stored] = await engine.executeRaw<{ value: { set_hash: string } }>(
      'SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1',
      [SYNC_DELETES_WITHHELD_OP],
    );
    expect(first.deletes_withheld).toMatchObject({
      source_id: 'default',
      count: 2,
      reconcilable: 6,
      trip: 'max_deletes',
      caps: { maxDeletes: 1 },
      newly_withheld: true,
      set_hash: stored!.value.set_hash,
    });
    const status = await readSyncStatus(engine, 'default', { detail: false });
    expect(status.next).not.toBeNull();
    expect(first.deletes_withheld?.fix).toEqual(status.next!);
    const envelope = buildSingleSyncJsonEnvelope('default', first) as Record<string, unknown>;
    expect(envelope.deletes_withheld).toEqual(first.deletes_withheld);

    const firstOut = renderSync(first);
    expect(firstOut).toContain(
      '  Withheld 2 delete(s) of 6 file-backed page(s) (more than sync.max_deletes (1) pages); nothing was deleted. '
      + 'If the checkout is the wrong one or incomplete, restore it and sync again; if the deletion is intended, run '
      + 'GBRAIN_ALLOW_MASS_RECONCILE=1 gbrain sync --source default on the brain host. Details: gbrain sync status --source default',
    );

    // 2. Idle tick: same set still withheld.
    const idle = await performManagedSync(engine, OPTS);
    expect(idle.status).toBe('up_to_date');
    expect(idle.deletes_withheld).toMatchObject({
      source_id: 'default',
      count: 2,
      reconcilable: 6,
      trip: 'max_deletes',
      newly_withheld: false,
      set_hash: stored!.value.set_hash,
    });
    const idleOut = renderSync(idle);
    expect(idleOut).toContain('Already up to date.');
    expect(idleOut).toContain(
      '  2 delete(s) of 6 file-backed page(s) (more than sync.max_deletes (1) pages) are still withheld from an earlier sync; nothing was deleted. '
      + 'If the checkout is the wrong one or incomplete, restore it and sync again; if the deletion is intended, run '
      + 'GBRAIN_ALLOW_MASS_RECONCILE=1 gbrain sync --source default on the brain host. Details: gbrain sync status --source default',
    );

    // 3. Changed set: remove a third file.
    git(root, 'rm', '-q', 'notes/c.md');
    commit(root, 'remove a third note');
    const changed = await performManagedSync(engine, OPTS);
    expect(changed.status).toBe('synced');
    expect(changed.deleted).toBe(0);
    expect(changed.deletes_withheld).toMatchObject({
      source_id: 'default',
      count: 3,
      reconcilable: 6,
      trip: 'max_deletes',
      newly_withheld: true,
    });
    expect(changed.deletes_withheld?.set_hash).not.toBe(stored!.value.set_hash);

    // 4. Valve open: deletes apply, record clears, output has no withheld line.
    const applied = await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, () => performManagedSync(engine, OPTS));
    expect(applied.status).toBe('synced');
    expect(applied.deleted).toBe(3);
    expect(applied.deletes_withheld).toBeUndefined();
    const appliedEnvelope = buildSingleSyncJsonEnvelope('default', applied) as Record<string, unknown>;
    expect(appliedEnvelope.deletes_withheld).toBeUndefined();
    const appliedOut = renderSync(applied);
    expect(appliedOut).toContain('-3 soft-deleted');
    expect(appliedOut.toLowerCase()).not.toContain('withheld');
  }, { setup: setupNotes(['a', 'b', 'c', 'd', 'e', 'f']) }), 240_000);

  test('printHoldNotes prints mass_ratio line (covering parallel --all) and prints nothing when absent', () => {
    const base: SyncResult = {
      status: 'synced', fromCommit: 'aaaa1111', toCommit: 'bbbb2222',
      added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [],
    };
    expect(renderHoldNotes(base)).toEqual([]);

    const withWithheld: SyncResult = {
      ...base,
      deletes_withheld: {
        source_id: 'notes', count: 14, reconcilable: 24, ratio: 0.583,
        set_hash: 'a'.repeat(64), samples: ['notes/a.md'], trip: 'mass_ratio',
        caps: { maxDeletes: 500, maxDeleteRatio: 0.01 }, newly_withheld: true,
        fix: { ask_user: true, argv: ['gbrain', 'sync', '--source', 'notes', '--dry-run', '--json'], consent: [], actor: 'user', requires_exclusive: false, verify: { argv: ['gbrain', 'sync', 'status', '--source', 'notes', '--json'] }, why: 'dry run' },
      },
    };
    expect(renderHoldNotes(withWithheld)).toEqual([
      '  Withheld 14 delete(s) of 24 file-backed page(s) (more than 50% of its file-backed pages); nothing was deleted. '
      + 'If the checkout is the wrong one or incomplete, restore it and sync again; if the deletion is intended, run '
      + 'GBRAIN_ALLOW_MASS_RECONCILE=1 gbrain sync --source notes on the brain host. Details: gbrain sync status --source notes',
    ]);
  });

  test('printSyncResult prints withheld line on first_sync', () => {
    const firstSync: SyncResult = {
      status: 'first_sync', fromCommit: null, toCommit: 'bbbb2222',
      added: 1, modified: 0, deleted: 0, renamed: 0, chunksCreated: 1, embedded: 0, pagesAffected: [],
      deletes_withheld: {
        source_id: 'default', count: 14, reconcilable: 24, ratio: 0.583,
        set_hash: 'b'.repeat(64), samples: ['notes/a.md'], trip: 'mass_ratio',
        caps: { maxDeletes: 500, maxDeleteRatio: 0.01 }, newly_withheld: true,
        fix: { ask_user: true, argv: ['gbrain', 'sync', '--source', 'default', '--dry-run', '--json'], consent: [], actor: 'user', requires_exclusive: false, verify: { argv: ['gbrain', 'sync', 'status', '--source', 'default', '--json'] }, why: 'dry run' },
      },
    };
    const out = renderSync(firstSync);
    expect(out).toContain('First sync complete.');
    expect(out).toContain('  Withheld 14 delete(s) of 24 file-backed page(s) (more than 50% of its file-backed pages); nothing was deleted.');
  });

  test('runDrain preserves newly_withheld across passes in one invocation when the set hash is unchanged', async () => {
    const hash = 'c'.repeat(64);
    const withheldBase = {
      source_id: 'default', count: 2, reconcilable: 6, ratio: 0.333,
      set_hash: hash, samples: ['notes/a.md', 'notes/b.md'], trip: 'max_deletes' as const,
      caps: { maxDeletes: 1, maxDeleteRatio: 0.01 },
      fix: { ask_user: true as const, argv: ['gbrain', 'sync', '--source', 'default', '--dry-run', '--json'], consent: [], actor: 'user' as const, requires_exclusive: false, verify: { argv: ['gbrain', 'sync', 'status', '--source', 'default', '--json'] }, why: 'dry run' },
    };
    const base: SyncResult = {
      status: 'synced', fromCommit: 'aaaa1111', toCommit: 'bbbb2222',
      added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [],
    };
    let call = 0;
    const drained = await runDrain({
      pass: async () => {
        call++;
        return call === 1
          ? { ...base, status: 'partial', reason: 'writer_yield', deletes_withheld: { ...withheldBase, newly_withheld: true } }
          : { ...base, status: 'synced', deletes_withheld: { ...withheldBase, newly_withheld: false } };
      },
      announce: false,
      pauseMs: 0,
    });
    expect(call).toBe(2);
    expect(drained.deletes_withheld?.newly_withheld).toBe(true);
    expect(renderSync(drained)).toContain('  Withheld 2 delete(s) of 6 file-backed page(s) (more than sync.max_deletes (1) pages); nothing was deleted.');
  });

  test('mergeExtraPass keeps newly_withheld from the first drain for the same set, and takes the extra pass at its word otherwise', async () => {
    // Imported here so a tree without the export fails this test alone, not the whole file at load.
    const { mergeExtraPass } = await import('../src/core/persistence/sync-drain.ts');
    const withheld = (set_hash: string, newly_withheld: boolean) => ({
      source_id: 'default', count: 2, reconcilable: 6, ratio: 0.333,
      set_hash, samples: ['notes/a.md', 'notes/b.md'], trip: 'max_deletes' as const,
      caps: { maxDeletes: 1, maxDeleteRatio: 0.01 }, newly_withheld,
      fix: { ask_user: true as const, argv: ['gbrain', 'sync', '--source', 'default', '--dry-run', '--json'], consent: [], actor: 'user' as const, requires_exclusive: false, verify: { argv: ['gbrain', 'sync', 'status', '--source', 'default', '--json'] }, why: 'dry run' },
    });
    const drain = { outcome: 'synced', passes: 1, processed: 0, written: 0, waived: 0 } as unknown as NonNullable<SyncResult['drain']>;
    const base: SyncResult = {
      status: 'synced', fromCommit: 'aaaa1111', toCommit: 'bbbb2222',
      added: 0, modified: 0, deleted: 0, renamed: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], drain,
    };
    const span = { from: 'bbbb2222', to: 'cccc3333' };
    const same = 'd'.repeat(64), other = 'e'.repeat(64);

    // Same set seen first by the first drain: the merged result still says it is new to this run.
    const kept = mergeExtraPass({ ...base, deletes_withheld: withheld(same, true) }, { ...base, toCommit: 'cccc3333', deletes_withheld: withheld(same, false) }, span);
    expect(kept.deletes_withheld?.newly_withheld).toBe(true);
    expect(renderSync(kept)).toContain('  Withheld 2 delete(s) of 6 file-backed page(s)');

    // A different set, or an older one the first drain did not flag, is reported as the extra pass saw it.
    expect(mergeExtraPass({ ...base, deletes_withheld: withheld(other, true) }, { ...base, deletes_withheld: withheld(same, false) }, span).deletes_withheld?.newly_withheld).toBe(false);
    expect(mergeExtraPass({ ...base, deletes_withheld: withheld(same, false) }, { ...base, deletes_withheld: withheld(same, false) }, span).deletes_withheld?.newly_withheld).toBe(false);

    // The extra pass released or lost the set: nothing is carried over from the first drain.
    expect(mergeExtraPass({ ...base, deletes_withheld: withheld(same, true) }, base, span).deletes_withheld).toBeUndefined();
  });
});
