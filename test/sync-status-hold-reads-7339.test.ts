import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { HOLD_ESCALATE_MS } from '../src/core/persistence/sync-fault-class.ts';
import { GIT_HOLD_OP, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const path = (i: number) => `held/page-${i}.md`;

/** The statements the engine's top-level executeRaw sends while `fn` runs. */
async function countStatements<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<{ n: number; value: T }> {
  const target = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target.executeRaw!;
  let n = 0;
  target.executeRaw = function (this: unknown, ...args: unknown[]) { n++; return original.apply(this, args); };
  try { const value = await fn(); return { n, value }; } finally { delete target.executeRaw; }
}

/** Abandoned uncommitted edits: worktree_dirty holds escalated past the attempts and a day, each recording its file's current bytes. */
async function abandonedHolds(engine: BrainEngine, root: string, from: number, to: number): Promise<void> {
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  await engine.transaction(async tx => {
    for (let i = from; i < to; i++) {
      writeFileSync(join(root, path(i)), `uncommitted edit ${i}\n`);
      await writeGitHold(tx, { source_id: 'default', incarnation: source!.incarnation, path: path(i), source_path: path(i), slug: `held/page-${i}`, page_id: null,
        code: 'worktree_dirty', message: 'uncommitted edit', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
        meta: { working_hash: sha(`uncommitted edit ${i}\n`) } as never });
    }
  });
  const old = new Date(Date.now() - 2 * HOLD_ESCALATE_MS).toISOString();
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array(jsonb_set(completed_keys->0,'{meta}',
    (completed_keys->0->'meta') || jsonb_build_object('attempts',3,'first_held_at',$2::text,'edited_at',$2::text))) WHERE op=$1`, [GIT_HOLD_OP, old]);
}

// Value: protects=a plain `sync status` costs a fixed number of statements however many abandoned uncommitted edits a source
//   holds, and still notices an edit whose bytes changed (#7339: about 11k holds took minutes over a remote pooler, one
//   statement per hold); fails_when=the live-editor check re-reads every escalated worktree_dirty hold's row even when its
//   recorded working hash already matches the file, or stops refreshing a hold whose bytes changed; why_new=the L4 tests pin
//   the escalation rule and unblock's attempts, never the status read's statement count; seam=none (the executeRaw counter
//   wraps the real engine); no_claim=wall time on a remote Postgres, or the --detail reads
test('#7339: plain sync status reads abandoned worktree_dirty holds in a fixed number of statements, and still refreshes a changed edit', () => managedBrain(async ({ engine, root }) => {
  const log = console.log; console.log = () => {};
  try { await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true }); } finally { console.log = log; }
  mkdirSync(join(root, 'held'));
  await abandonedHolds(engine, root, 0, 1);
  await readSyncStatus(engine, 'default', { detail: false });
  const one = await countStatements(engine, () => readSyncStatus(engine, 'default', { detail: false }));
  await abandonedHolds(engine, root, 1, 40);
  const many = await countStatements(engine, () => readSyncStatus(engine, 'default', { detail: false }));
  expect(many.value.holds.filter(hold => hold.needs_human)).toHaveLength(40);
  expect(many.n).toBe(one.n);

  writeFileSync(join(root, path(7)), 'a person is editing this again\n');
  const edited = await readSyncStatus(engine, 'default', { detail: false });
  expect(edited.holds.find(hold => hold.path === path(7))?.needs_human).toBe(false);
  expect(edited.holds.filter(hold => hold.needs_human)).toHaveLength(39);
}, { setup: ({ root }) => {
  git(root, 'init', '-q');
  writeFileSync(join(root, 'readme-example.md'), '# Example\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
} }), 180_000);
