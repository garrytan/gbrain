/**
 * #6712 PR 4b (GBRA-108): the fold proof (sync-pass-confirm.ts) judges each row against S1's snapshot, not against its
 * xmin alone, so a transaction that holds the cluster's xmin back (a stuck idle-in-transaction session) no longer makes the
 * pass's earlier, already-visible writes read as foreign; a write S1 could not see is still caught, a subtransaction's
 * included.
 *
 * Protects:
 * - with an idle-in-transaction session (an assigned xid) opened before the brain's pages are written, a one-file
 *   writeback still folds its stamp;
 * - with that session open, a foreign write committed between the round's level read and its fold is caught: the stamp
 *   publishes alone (foreign_page_write) and the confirm round reads in full;
 * - a transaction in flight at S1 that writes an import record and commits mid-pass is caught, also when it writes it
 *   inside a savepoint (its row's xmin is a subtransaction id S1's snapshot does not list, below S1's xmax once a later
 *   transaction has ended).
 *
 * Postgres only: each case needs a second transaction open beside
 * the pass, which PGLite's single connection cannot hold; on PGLite S1's snapshot never lists a running transaction.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  for (const slug of ['a', 'b']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};
/** A one-file commit whose file is not canonical: its import rewrites it (a writeback). */
const writebackCommit = (root: string) => { writeFileSync(join(root, 'notes/a.md'), '---\ntitle: notes/a\n---\nA committed change of notes/a.\n'); commit(root, 'change a, not canonical'); };
const lastSequence = async (engine: BrainEngine) => Number((await engine.executeRaw<{ s: number }>('SELECT COALESCE(max(sequence),0) AS s FROM persistence_requests'))[0]!.s);
/** The requests after `after` that carried the pass stamp, and how each published it. */
const stamped = (engine: BrainEngine, after: number) => engine.executeRaw<{ kind: string; stamp: string | null; skipped: string | null }>(
  "SELECT intent->>'kind' AS kind, outcome->>'pass_stamp' AS stamp, outcome->>'pass_stamp_skipped' AS skipped FROM persistence_requests WHERE sequence > $1 AND intent ? 'stamp' ORDER BY sequence", [after]);
/** A page write outside the pass, as another writer of the source makes it (inside the caller's transaction). */
const foreignWrite = async (tx: BrainEngine) => {
  await tx.executeRaw("SELECT set_config('gbrain.write_sources','[\"default\"]',true)");
  await tx.executeRaw("UPDATE pages SET title=title||' (edited)' WHERE source_id='default' AND slug='notes/b'");
};
/**
 * A write of notes/b's import record outside the pass. A page write queues its projection rebuild, whose own later write
 * would be caught whatever the proof made of the first; the record write stands alone.
 */
const foreignRecordWrite = async (tx: BrainEngine) => {
  await tx.executeRaw("SELECT set_config('gbrain.write_sources','[\"default\"]',true)");
  const [row] = await tx.executeRaw<{ n: number }>(`WITH w AS (UPDATE op_checkpoints SET completed_keys=completed_keys WHERE op='sync-import-provenance'
    AND fingerprint LIKE 'default:%:' || (SELECT id FROM pages WHERE source_id='default' AND slug='notes/b')::text RETURNING 1) SELECT count(*)::int AS n FROM w`);
  expect(row!.n).toBe(1);
};
/** A session on the cluster that holds an assigned xid open until released (a read-only session, pg_dump's, holds none). */
function idleSession(url: string): { opened: Promise<void>; release: () => Promise<void> } {
  const sql = postgres(url, { max: 1 });
  let done: (() => void) | undefined, ready!: () => void;
  const opened = new Promise<void>(resolve => { ready = resolve; });
  const held = sql.begin(async tx => { await tx`SELECT txid_current()`; ready(); await new Promise<void>(resolve => { done = resolve; }); });
  return { opened, release: async () => { done?.(); await held.catch(() => undefined); await sql.end(); } };
}

const databaseUrl = requirePostgresTestDatabase();
afterEach(() => installFaultHook(undefined));

const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { databaseUrl, setup });

describe(`#6712 PR 4b fold proof under a held xmin (postgres)`, () => {
  test('an idle-in-transaction session opened before the pages were written: a one-file writeback still folds its stamp', () => brain(async ({ engine, root }) => {
    const session = idleSession(databaseUrl);
    await session.opened;
    try {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writebackCommit(root);
      const after = await lastSequence(engine);
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      expect(await stamped(engine, after)).toEqual([{ kind: 'managed_sync_import', stamp: 'folded', skipped: null }]);
    } finally { await session.release(); }
  }), 180_000);

  test('with that session open, a foreign write between the level read and the fold is caught: the stamp publishes alone and the confirm round reads in full', () => brain(async ({ engine, root }) => {
    const session = idleSession(databaseUrl);
    await session.opened;
    try {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writebackCommit(root);
      const after = await lastSequence(engine);
      const rounds: Array<{ round: number; taken: boolean | null; reason: string | null }> = [];
      installFaultHook(async (point, detail) => {
        if (point !== 'sync:level_read') return;
        rounds.push({ round: detail.round as number, taken: detail.level?.confirm?.taken ?? null, reason: detail.level?.confirm?.reason ?? null });
        if (detail.round === 1) await engine.transaction(async tx => { await foreignWrite(tx); });
      });
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      installFaultHook(undefined);
      expect((await stamped(engine, after)).map(row => [row.kind, row.stamp, row.skipped])).toEqual([
        ['managed_sync_import', null, 'foreign_page_write'], ['managed_sync_checkpoint', null, null]]);
      expect(rounds.find(round => round.round === 2)).toMatchObject({ taken: false, reason: 'foreign_page_write' });
    } finally { await session.release(); }
  }), 180_000);

  for (const savepoint of [false, true]) {
    test(`a transaction in flight at S1 that writes an import record${savepoint ? ' inside a savepoint' : ''} and commits mid-pass is caught`, () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writebackCommit(root);
      const after = await lastSequence(engine);
      let commitNow!: () => void, written!: () => void;
      const wrote = new Promise<void>(resolve => { written = resolve; });
      let inFlight: Promise<void> | null = null;
      installFaultHook(async (point, detail) => {
        if (point === 'sync:round_start' && detail.round === 1) {
          inFlight = engine.transaction(async tx => {
            await tx.executeRaw('SELECT txid_current()');
            if (savepoint) await tx.executeRaw('SAVEPOINT foreign_edit');
            await foreignRecordWrite(tx);
            if (savepoint) await tx.executeRaw('RELEASE SAVEPOINT foreign_edit');
            written();
            await new Promise<void>(resolve => { commitNow = resolve; });
          });
          await wrote;
          // A later transaction ends before S1, so S1's xmax passes the write's id: only its in-progress list can tell.
          await engine.executeRaw('SELECT txid_current()');
        }
        if (point === 'sync:level_read' && detail.round === 1) { commitNow(); await inFlight; }
      });
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      installFaultHook(undefined);
      expect((await stamped(engine, after)).map(row => [row.kind, row.stamp, row.skipped])).toEqual([
        ['managed_sync_import', null, 'foreign_checkpoint_write'], ['managed_sync_checkpoint', null, null]]);
    }), 180_000);
  }
});
