/**
 * GST-3534: a managed pass while other writers keep committing.
 *
 * Before: every round of a pass read the level at the current HEAD, and a round at a commit its previous round had not read
 * re-read the source's whole `I⋈P` (pages joined with import records), as did every restart. A writer committing during
 * every round made each round and each restart pay for the whole read.
 *
 * Protects:
 * - Rounds after the first patch the previous round's `I⋈P` even when HEAD moved (checked against a whole read by
 *   GBRAIN_SYNC_LEVEL_REUSE_VERIFY), `sync status`'s `convergence.levels` counts the heads and reads, and the plain sync
 *   after a pass that ended `not_converged` checkpoints the newest commit.
 * - A pass that stops resumable (a slice's writer_yield) keeps its `I⋈P` for the next pass, whose first round patches it.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SEEDED = 120;
type Round = { round: number; head: string; patched: boolean };

afterEach(() => { installFaultHook(undefined); __resetTreeReuseForTests(); });

for (const backend of testBackends()) describe(`[${backend}] GST-3534: a pass while HEAD keeps moving`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const open = databaseUrl ? () => isolatedPersistencePostgres(databaseUrl) : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (let i = 0; i < SEEDED; i++) writeFileSync(join(root, `notes/n${i}.md`), note(`n${i}`, `The body of n${i}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };
  const brain = (run: Parameters<typeof managedBrain>[0]) => withEnv({ GBRAIN_SYNC_LEVEL_REUSE_VERIFY: '1' }, () => managedBrain(run, { databaseUrl, ...(open ? { open } : {}), setup }));
  const write = (root: string, name: string) => { writeFileSync(join(root, `notes/${name}.md`), note(name, `The body of ${name}.`)); git(root, 'add', '-A'); git(root, 'commit', '-qm', `write ${name}`); };
  /** A round's commit and whether its `I⋈P` read patched the previous one, from its `sync:level_read` detail. */
  const roundOf = (detail: { round?: number; level?: { shadow?: unknown; confirm?: { taken?: boolean } | null } }): Round =>
    ({ round: detail.round!, head: (detail.level!.shadow as { head: string }).head, patched: detail.level!.confirm?.taken === true });
  const rounds = (): Round[] => {
    const seen: Round[] = [];
    installFaultHook((point, detail) => { if (point === 'sync:level_read' && detail.level) seen.push(roundOf(detail)); });
    return seen;
  };
  const slugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
    "SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL AND slug LIKE 'notes/w%' ORDER BY slug")).map(row => row.slug);

  test('a writer committing during every round: each later round patches the previous read, and the next sync checkpoints the newest commit', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    write(root, 'w0');
    const seen: Round[] = [];
    let writes = 0;
    installFaultHook((point, detail) => {
      if (point === 'sync:round_start' && (detail.round ?? 0) > 1) write(root, `w${++writes}`);
      if (point === 'sync:level_read' && detail.level) seen.push(roundOf(detail));
    });
    const pass = await performManagedSync(engine, OPTS);
    installFaultHook(undefined);
    expect(seen.map(r => r.round)).toEqual([1, 2, 3, 4]);
    expect(new Set(seen.map(r => r.head)).size).toBe(4);
    expect({ status: pass.status, reason: pass.reason ?? null }).toEqual({ status: 'partial', reason: 'not_converged' });
    // Rounds 2-4 read a commit their previous round had not, and patched its I⋈P (the verify mode compared each with a whole read).
    expect(seen.map(r => r.patched)).toEqual([seen[0]!.patched, true, true, true]);
    const convergence = (await readSyncStatus(engine, 'default')).convergence as { outcome: string; levels: unknown };
    expect({ outcome: convergence.outcome, levels: convergence.levels })
      .toEqual({ outcome: 'resumable', levels: { heads: 4, whole: seen[0]!.patched ? 0 : 1, patched: seen[0]!.patched ? 4 : 3 } });
    const next = await performManagedSync(engine, OPTS);
    // Round 4 already imported w3, so the next plain sync finds nothing left and only checkpoints the newest commit.
    expect({ status: next.status, toCommit: next.toCommit }).toEqual({ status: 'up_to_date', toCommit: seen[3]!.head });
    expect(await slugs(engine)).toEqual(['notes/w0', 'notes/w1', 'notes/w2', 'notes/w3']);
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }), 300_000);

  test('a pass that stops resumable keeps its I⋈P: the next pass\'s first round patches it', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const name of ['w0', 'w1', 'w2']) writeFileSync(join(root, `notes/${name}.md`), note(name, `The body of ${name}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'three notes');
    const sliced = await performManagedSync(engine, OPTS, { maxPages: 1, maxMs: 120_000 });
    expect({ status: sliced.status, reason: sliced.reason }).toEqual({ status: 'partial', reason: 'writer_yield' });
    const seen = rounds();
    const next = await performManagedSync(engine, OPTS);
    expect(next.status).toBe('synced');
    expect(seen[0]).toMatchObject({ round: 1, patched: true });
    expect(await slugs(engine)).toEqual(['notes/w0', 'notes/w1', 'notes/w2']);
  }), 300_000);
});
