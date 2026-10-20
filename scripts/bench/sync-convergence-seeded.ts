#!/usr/bin/env bun
/**
 * #6712 PR 4 shadow validation on seeded fixtures (replaces the production baseline): builds a managed test brain over a
 * generated Git checkout, seeds a named mix of paths whose class design v3.2 §2.3 fixes (rows 1-19 plus the in_flight
 * overlay, the §2.6 valve and the §2.7 bootstrap rules), and compares every path's predicted class and action tag from
 * the read-only shadow (PR 4a, src/core/persistence/sync-pass.ts) with the expected one. Synthetic content only.
 *
 *   bun scripts/bench/sync-convergence-seeded.ts --engine pglite|postgres [--database-url <admin url>] [--out <file.md>]
 *     [--scale [--files 61000] [--rate 0.01] [--rounds 3] [--cache-dir <dir>]]
 *
 * The mix (no --scale) seeds through real gbrain calls wherever the state is reachable that way: performManagedSync (the
 * first sync, and a second one that writes holds), put_page and delete_page (soft delete and purge) through the
 * page-mutation path, Git commits, writeGitHold / clearGitHold, and the journal's admitWrite for open work. Raw SQL is
 * used only where nothing else reaches the state; each case's seed names which. It then runs the redacted dry run
 * (gbrain sync --dry-run --json --redact-paths) and gbrain sync status --json --detail through the CLI handlers, plus the
 * library read (readShadowLevel + buildConvergenceReceipt with every path sampled), and compares all three.
 *
 * --scale seeds a converged source of --files pages by direct SQL (sync-convergence-lib.ts seedSource), seeds --rate of
 * them across the SQL- and Git-reachable part of the mix, times the full round and compares every path.
 *
 * test/sync-convergence-seeded-6712.test.ts runs the mix as a test (PGLite; Postgres with DATABASE_URL).
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { RECOVERY_VERSION } from '../../src/core/markdown.ts';
import { isSyncable, resolveSlugForPath } from '../../src/core/sync.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { preparePageAdmission, submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { clearGitHold, readGitSourceHolds, SYNC_IMPORT_PROVENANCE_OP, writeGitHold } from '../../src/core/persistence/sync-holds.ts';
import { readShadowLevel, SYNC_ORIGIN_DELETED_OP, type ShadowLevel } from '../../src/core/persistence/sync-pass.ts';
import { buildConvergenceReceipt, type ConvergenceClassKey, type ConvergenceReceipt } from '../../src/core/persistence/sync-convergence.ts';
import type { SyncPathAction } from '../../src/core/persistence/sync-classify.ts';
import { gitBlobOid, sha256 } from '../../src/core/persistence/digest.ts';
import { ensureFixture, fixtureContent, fixturePath, resetFixture, seedSource, type Fixture } from './sync-convergence-lib.ts';

// ─── the case table ──────────────────────────────────────────────────

/** `outside_domain`: the path is not in the pass's domain (v3.1 §2.3), so it gets no class. */
export type ExpectedKey = ConvergenceClassKey | 'outside_domain';
export interface Expected { key: ExpectedKey; action?: SyncPathAction; settled?: boolean; sub?: 'pending' | 'db_only' | 'unproven';
  side?: 'both' | 'unknown' | 'deleted'; state?: 'tombstone_edited' | 'purged_differs' | 'file_gone'; keepDbWrite?: boolean; fullSkipped?: boolean }
/**
 * A known disagreement, kept on the case so the report lists it: (a) the shadow differs from the design (the case's
 * expectation is the design's; the test pins the difference with test.failing), or (b) the shadow follows the design
 * and the design's answer is wrong for the issue named.
 */
export interface Finding { kind: 'a' | 'b'; ref: string; text: string }
/** `expect` is the design's class; `today` is what PR 4a predicts where a finding says it differs (the test pins it, so a fix turns it red). */
export interface SeededCase { category: string; path: string; expect: Expected; row: string; seed: string; finding?: Finding; today?: Expected }

const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const titleOf = (path: string) => path.replace(/^.*[\\/]/, '').replace(/\.md$/, '');

export const FINDINGS = {
  dirtyAbsorbed: { kind: 'b', ref: 'v3.2 §2.3 row 11 before row 12 vs §2.1 (Dp is read for candidates only); sync-pass.ts settledBeforeDirtiness',
    text: 'The design contradicts itself on an uncommitted edit of a matched path: row order puts it in row 11 dirty (settled, absorbed), but §2.1 reads Dp for candidates only, so the dirtiness of a matched path is never known. 4a follows §2.1 and says matched. Settlement and the action tag agree (settled, none); only the class differs.' },
  fullLegacy: { kind: 'b', ref: 'v3.1 §2.7 ("--full imports legacy-marked paths"), which v3.2 §2.7 keeps, vs v3.2 §2.3 row 10 (no episode clause)',
    text: 'v3.1 §2.7 says --full imports legacy-marked page-less paths (master\'s --full does), but v3.2\'s row 10 has no episode clause and obligation is defined on live pages only, so the table keeps them legacy_same under --full; 4a follows the table.' },
  refusedOnce: { kind: 'b', ref: 'v3.1 §2.7 (bootstrap legacy markers, kept by v3.2 §2.7); v3.2 §2.3 row 10',
    text: 'A file refused before it ever had a page (#6875 gate 2, #6865) is unchanged since baseline_commit and has no page, so bootstrap treats it as purged before PR 4: a legacy marker, row 10 legacy_same, settled with action none. PR 4 would report these files synced while they are missing from search.' },
  rescreenHold: { kind: 'b', ref: 'v3.2 §2.3 row 1 (not rescreen-due) then row 10; sync-holds.ts holdRescreenDue',
    text: 'frontmatter_slug_conflict and legacy_slug_conflict holds are always rescreen-due, so row 1 never holds them; with no page and an unchanged file they fall to row 10 legacy_same (settled, none) while the hold row still exists, so the class contradicts the hold that status shows.' },
  dirtyGlossary: { kind: 'b', ref: 'v3.2 §9 class glossary; sync-classify.ts syncClassAction',
    text: 'Row 11 dirty is settled when absorbed or published, but the glossary gives a class one action and 4a tags every dirty path repair, so a settled write-through publication waiting for its commit reads as needing a person.' },
  gitTruth: { kind: 'b', ref: 'master #5459 (keptWorkingTreePages); v3.2 §2.3 row 4 ("any provenance")',
    text: 'master #5459: Git is the truth for tracked paths; row 4 is keptWorkingTreePages. A page Git imported whose file left Git is row 5 delete (row 6 delete_drift without proof) even when a copy lingers untracked; only a working-tree (or unknown-provenance) import is kept. Design row 4 says any provenance, so the shadow follows master, not the table.' },
  twinInvisible: { kind: 'b', ref: 'v3.2 §2.3 domain (pages with a recorded origin only)',
    text: 'A #6885 legacy twin (source_path NULL) is outside the domain: the pair reads as one matched path and nothing in convergence counts it, so PR 4 can neither report nor converge already-forked pairs.' },
} as const satisfies Record<string, Finding>;

// ─── seeding the mix through gbrain ──────────────────────────────────

export interface MixBrain { engine: BrainEngine; ctx: OperationContext; root: string }
const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const MASS = 60;
const MATCHED = ['mix/matched-1.md', 'mix/matched-2.md', 'mix/matched-3.md'];

function gitIn(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 30 }).trim();
}
const commitStaged = (root: string, message: string) => gitIn(root, ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message]);
const write = (root: string, path: string, body: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };

/** Stage 0, before the brain claims the checkout: every file the first sync imports. */
export function mixSetup({ root }: { root: string }): void {
  gitIn(root, ['init', '-q', '-b', 'main']);
  const initial = [...MATCHED, 'mix/import-changed.md', 'mix/reparse-parser.md', 'mix/reparse-origin.md', 'mix/adopt-revision.md', 'mix/adopt-hash.md',
    'mix/dbahead-pending.md', 'mix/dbahead-dbonly.md', 'mix/dbahead-unproven.md', 'kept/clean-drift.md', 'kept/dirty-drift.md', 'kept/dbonly.md',
    'mix/drift-both.md', 'mix/drift-unknown.md', 'mix/held-file-drift.md', 'mix/held-concurrent.md', 'mix/held-dirty.md',
    'mix/delete-proof.md', 'mix/delete-drift.md', 'mix/tomb-same.md', 'mix/tomb-edited.md', 'mix/tomb-untracked.md', 'mix/tomb-gone.md',
    'mix/purged-nomarker.md', 'mix/purged-marker-same.md', 'mix/purged-marker-differs.md', 'mix/legacy-marker.md',
    'mix/kept-file.md', 'mix/dirty-held.md', 'mix/dirty-absorbed.md', 'mix/dirty-published.md', 'mix/legacy-unverified.md',
    'mix/inflight-wt.md', 'mix/inflight-dbonly.md', 'mix/Twin Page.md', ...Array.from({ length: MASS }, (_, i) => `mass/note-${i}.md`)];
  for (const path of initial) write(root, path, note(titleOf(path), `Synthetic ${titleOf(path)} one.`));
  gitIn(root, ['add', '-A']);
  commitStaged(root, 'seeded mix');
}

/** The mix's cases, as design v3.2 §2.3 classifies them in committed mode without --full. */
export function mixCases(): SeededCase[] {
  const c = (category: string, path: string, expect: Expected, row: string, seed: string, finding?: Finding, today?: Expected): SeededCase =>
    ({ category, path, expect, row, seed, ...(finding ? { finding } : {}), ...(today ? { today } : {}) });
  const settledNone = { action: 'none' as const, settled: true };
  return [
    ...MATCHED.map(path => c('matched', path, { key: 'matched', ...settledNone }, 'row 12', 'sync')),
    ...Array.from({ length: MASS }, (_, i) => c('matched (mass set, untouched)', `mass/note-${i}.md`, { key: 'matched', ...settledNone }, 'row 12', 'sync')),
    c('import: changed file', 'mix/import-changed.md', { key: 'import', action: 'import', settled: false }, 'row 16', 'sync, git commit'),
    c('import: new file', 'mix/import-new.md', { key: 'import', action: 'import', settled: false }, 'row 16', 'git commit'),
    c('reparse: parser obligation', 'mix/reparse-parser.md', { key: 'reparse', action: 'reparse', settled: false }, 'row 14', 'sync, raw SQL (record parser_version)'),
    c('reparse: origin obligation', 'mix/reparse-origin.md', { key: 'reparse', action: 'reparse', settled: false }, 'row 14', 'sync, raw SQL (record origin)'),
    c('adopt: arm 1 by revision', 'mix/adopt-revision.md', { key: 'adopt', action: 'adopt', settled: true }, 'row 13 clause 2', 'sync, raw SQL (record revision removed)'),
    c('adopt: by expected_hash', 'mix/adopt-hash.md', { key: 'adopt', action: 'adopt', settled: true }, 'row 13 clause 1', 'sync, put_page (write-through), git commit'),
    c('db_ahead pending', 'mix/dbahead-pending.md', { key: 'db_ahead', action: 'none', settled: true, sub: 'pending' }, 'row 15', 'sync, put_page (write-through), git checkout'),
    c('db_ahead db_only', 'mix/dbahead-dbonly.md', { key: 'db_ahead', action: 'none', settled: true, sub: 'db_only' }, 'row 15', 'sync, put_page (write-through off)'),
    c('db_ahead unproven', 'mix/dbahead-unproven.md', { key: 'db_ahead', action: 'none', settled: true, sub: 'unproven' }, 'row 15', 'sync, raw SQL (record revision removed), put_page (write-through off)'),
    c('db_ahead db_only under keep_db', 'kept/dbonly.md', { key: 'db_ahead', action: 'keep_db', settled: true, sub: 'db_only', keepDbWrite: true }, 'row 15 with row 18\'s write', 'sync, put_page (write-through off), gbrain.yml'),
    c('keep_db: clean committed drift', 'kept/clean-drift.md', { key: 'keep_db', action: 'keep_db', settled: false }, 'row 18', 'sync, put_page (write-through off), git commit, gbrain.yml'),
    c('keep_db prefix, dirty (not keep_db)', 'kept/dirty-drift.md', { key: 'dirty', action: 'hold', settled: false }, 'row 11 (precedes 18)', 'sync, put_page (write-through off), git commit, uncommitted edit'),
    c('drift both', 'mix/drift-both.md', { key: 'drift', action: 'hold', settled: false, side: 'both' }, 'row 19', 'sync, put_page (write-through off), git commit'),
    c('drift unknown', 'mix/drift-unknown.md', { key: 'drift', action: 'hold', settled: false, side: 'unknown' }, 'row 19', 'sync, raw SQL (record revision removed), put_page (write-through off), git commit'),
    c('held: file_drift', 'mix/held-file-drift.md', { key: 'held', ...settledNone }, 'row 1', 'sync, put_page (write-through off), git commit, writeGitHold'),
    c('held: concurrent_write', 'mix/held-concurrent.md', { key: 'held', ...settledNone }, 'row 1', 'sync, git commit, writeGitHold'),
    c('held: worktree_dirty', 'mix/held-dirty.md', { key: 'held', ...settledNone }, 'row 1', 'git commit and uncommitted edit, the worktree_dirty hold a release before PR 4b wrote (raw state)'),
    c('held: invalid_frontmatter', 'mix/held-badfm.md', { key: 'held', ...settledNone }, 'row 1', 'git commit, sync (writes the hold)'),
    c('held: frontmatter_slug_conflict (#6865 stray slug: line)', 'mix/held-stray.md', { key: 'held', action: 'import', settled: false }, 'row 1, re-screen due (rulings b2)', 'git commit, sync (writes the hold)'),
    c('held: legacy_slug_conflict', 'mix/Legacy Name.md', { key: 'held', action: 'import', settled: false }, 'row 1, re-screen due (rulings b2)', 'raw SQL (legacy page without source_path), git commit, sync (writes the hold)'),
    c('refused once, no hold row (#6875 gate 2, #6865)', 'mix/refused-once.md', { key: 'import', action: 'import', settled: false }, 'row 16: no deletion proof, so no legacy marker (rulings b1)', 'git commit, sync (writes the hold), clearGitHold'),
    c('delete (proof)', 'mix/delete-proof.md', { key: 'delete', action: 'delete', settled: false }, 'row 5', 'sync, git rm and commit'),
    c('delete_drift (no proof)', 'mix/delete-drift.md', { key: 'delete_drift', action: 'hold', settled: false, side: 'deleted', state: 'file_gone' }, 'row 6', 'sync, put_page (write-through off), git rm and commit'),
    c('deleted_same: tombstone', 'mix/tomb-same.md', { key: 'deleted_same', ...settledNone }, 'row 8', 'sync, delete_page (write-through off)'),
    c('deleted_edited: tombstone', 'mix/tomb-edited.md', { key: 'deleted_edited', action: 'hold', settled: false, side: 'deleted', state: 'tombstone_edited' }, 'row 9', 'sync, delete_page, git commit'),
    c('untracked: tombstone, file left T, still on disk', 'mix/tomb-untracked.md', { key: 'untracked', ...settledNone }, 'row 3', 'sync, delete_page, git rm --cached and commit'),
    c('gone (committed mode: row 3 precedes row 7)', 'mix/tomb-gone.md', { key: 'untracked', ...settledNone }, 'row 3', 'sync, delete_page, git rm and commit'),
    c('untracked page-less file (committed mode)', 'mix/untracked-new.md', { key: 'outside_domain' }, 'v3.1 §2.3 domain', 'file written, never committed'),
    c('purged before PR 4, no marker', 'mix/purged-nomarker.md', { key: 'legacy_same', ...settledNone }, 'row 10 via §2.7 bootstrap', 'sync, delete_page purge (write-through off)'),
    c('deleted_same: deleted marker', 'mix/purged-marker-same.md', { key: 'deleted_same', ...settledNone }, 'row 8', 'sync, delete_page purge (writes the marker)'),
    c('deleted_edited: deleted marker', 'mix/purged-marker-differs.md', { key: 'deleted_edited', action: 'hold', settled: false, side: 'deleted', state: 'purged_differs' }, 'row 9', 'sync, delete_page purge, raw SQL (marker), git commit'),
    c('legacy_same: legacy marker', 'mix/legacy-marker.md', { key: 'legacy_same', ...settledNone }, 'row 10', 'sync, delete_page purge, raw SQL (the legacy marker PR 4b writes)'),
    c('delete: Git-imported page, file left T, still on disk (#5459)', 'mix/kept-file.md', { key: 'delete', action: 'delete', settled: false }, 'row 5 (master #5459)', 'sync, git rm --cached and commit', FINDINGS.gitTruth),
    c('kept: working-tree import, never in T, still on disk', 'mix/kept-working.md', { key: 'kept', ...settledNone }, 'row 4 (keptWorkingTreePages)', 'sync --working-tree of an untracked file'),
    c('dirty: committed edit under an uncommitted one', 'mix/dirty-held.md', { key: 'dirty', action: 'hold', settled: false }, 'row 11', 'sync, git commit, uncommitted edit'),
    c('dirty: uncommitted edit of a synced file (absorbed)', 'mix/dirty-absorbed.md', { key: 'matched', action: 'none', settled: true }, 'row 12: Dp is read for candidates only (rulings b3)', 'sync, uncommitted edit', FINDINGS.dirtyAbsorbed),
    c('dirty: write-through publication not committed (published)', 'mix/dirty-published.md', { key: 'dirty', action: 'none', settled: true }, 'row 11 (settled: published)', 'sync, put_page (write-through)', FINDINGS.dirtyGlossary),
    c('spelling: case-only', 'mix/Case-Pair.md', { key: 'spelling', action: 'refuse' }, 'row 2', 'git commit'),
    c('spelling: case-only', 'mix/case-pair.md', { key: 'spelling', action: 'refuse' }, 'row 2', 'git commit'),
    c('spelling: separator-only', 'mix\\sep-pair.md', { key: 'spelling', action: 'refuse' }, 'row 2', 'git commit'),
    c('spelling: separator-only', 'mix/sep-pair.md', { key: 'spelling', action: 'refuse' }, 'row 2', 'git commit'),
    c('legacy_unverified', 'mix/legacy-unverified.md', { key: 'legacy_unverified', action: 'none', settled: true }, 'row 17', 'sync, raw SQL (record stripped, receipt compacted)'),
    c('in_flight: open write-through put_page on a changed file', 'mix/inflight-wt.md', { key: 'in_flight', action: 'import', settled: false }, 'overlay on row 16', 'sync, git commit, admitWrite (consumer stopped)'),
    c('in_flight: open put_page (write-through off) on a changed file', 'mix/inflight-dbonly.md', { key: 'in_flight', action: 'import', settled: false }, 'overlay on row 16', 'sync, git commit, admitWrite (consumer stopped)'),
    c('#6885 legacy twin pair (file side)', 'mix/Twin Page.md', { key: 'matched', ...settledNone }, 'row 12', 'sync, raw SQL (legacy twin page without source_path)', FINDINGS.twinInvisible),
  ];
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}

/** Seeds the mix on a brain whose checkout mixSetup created and that has not synced yet; returns the cases. */
export async function seedMix(brain: MixBrain): Promise<SeededCase[]> {
  const { engine, ctx, root } = brain;
  const add = (...paths: string[]) => gitIn(root, ['add', '--', ...paths]);
  const oidAt = (path: string) => gitIn(root, ['rev-parse', `HEAD:${path}`]);
  const snapshot = async (slug: string) => { const s = await engine.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true }); if (!s) throw new Error(`no page ${slug}`); return s; };
  const committed = (requestId: string) => waitUntil(`request ${requestId}`, async () =>
    (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed');
  const putPage = async (path: string, body: string) => {
    const slug = resolveSlugForPath(path), requestId = randomUUID();
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: (await snapshot(slug)).revision, content: note(titleOf(path), body) } });
    await committed(requestId);
  };
  const deletePage = async (path: string, purge = false) => {
    const slug = resolveSlugForPath(path);
    await operations.find(op => op.name === 'delete_page')!.handler(ctx, { slug, expected_revision: (await snapshot(slug)).revision, request_id: randomUUID(), ...(purge ? { purge: true } : {}) });
  };
  const recordSql = (path: string, expression: string) => engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array(${expression})
    WHERE op=$1 AND completed_keys->0->>'origin'=$2`, [SYNC_IMPORT_PROVENANCE_OP, path]);
  const withoutTrigger = async (run: () => Promise<unknown>) => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try { await run(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  };

  // Stage 1: the first sync imports every file with a complete record.
  const first = await performManagedSync(engine, SYNC);
  if (first.status !== 'first_sync') throw new Error(`the first sync ended ${first.status}`);
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");

  // Stage 1b: a working-tree sync imports an untracked file (provenance working), which stays on disk and never enters T.
  write(root, 'mix/kept-working.md', note('kept-working', 'An untracked working-tree note.'));
  const working = await performManagedSync(engine, { ...SYNC, workingTree: true });
  if (working.status !== 'synced') throw new Error(`the working-tree sync ended ${working.status}`);

  // Stage 2: a second sync writes the holds master writes itself.
  await withoutTrigger(() => engine.executeRaw("INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth) VALUES('default','mix/Legacy Name','note','markdown','Legacy Name','A legacy page.')"));
  write(root, 'mix/held-dirty.md', note('held-dirty', 'Synthetic held-dirty two.'));
  write(root, 'mix/held-badfm.md', '---\ntitle: [unclosed\n---\nSynthetic body.\n');
  write(root, 'mix/held-stray.md', '---\ntitle: held-stray\nslug: somewhere-else\n---\nSynthetic body.\n');
  write(root, 'mix/refused-once.md', '---\ntitle: refused-once\nslug: another-place\n---\nSynthetic body.\n');
  write(root, 'mix/Legacy Name.md', note('Legacy Name', 'Synthetic legacy name.'));
  add('mix/held-dirty.md', 'mix/held-badfm.md', 'mix/held-stray.md', 'mix/refused-once.md', 'mix/Legacy Name.md');
  commitStaged(root, 'files sync holds');
  write(root, 'mix/held-dirty.md', note('held-dirty', 'An uncommitted draft on top.'));
  // PR 4b's pass does not import a dirty working copy and raises no worktree_dirty hold (the path is dirty); the hold is
  // the one a release before PR 4b wrote for this state, so it is seeded as that release left it (raw state).
  const draft = note('held-dirty', 'An uncommitted draft on top.'), staged = note('held-dirty', 'Synthetic held-dirty two.');
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path: 'mix/held-dirty.md', source_path: 'mix/held-dirty.md', slug: 'mix/held-dirty', page_id: null,
    code: 'worktree_dirty', message: 'mix/held-dirty.md has uncommitted working-tree bytes that match neither the pinned commit nor the current page, so its import is held.',
    upstream_version: createHash('sha256').update(staged).digest('hex'), observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
    meta: { recovery_version: RECOVERY_VERSION, blob_oid: oidAt('mix/held-dirty.md'), working_hash: createHash('sha256').update(draft).digest('hex') } } as Parameters<typeof writeGitHold>[1]));
  await performManagedSync(engine, SYNC);
  const holds = new Map(((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).map(hold => [hold.path, hold.code]));
  for (const [path, code] of [['mix/held-dirty.md', 'worktree_dirty'], ['mix/held-badfm.md', 'invalid_frontmatter'], ['mix/held-stray.md', 'frontmatter_slug_conflict'],
    ['mix/refused-once.md', 'frontmatter_slug_conflict'], ['mix/Legacy Name.md', 'legacy_slug_conflict']] as const)
    if (holds.get(path) !== code) throw new Error(`the second sync held ${path} as ${holds.get(path) ?? 'nothing'}, expected ${code}; holds ${JSON.stringify([...holds])}; pages ${JSON.stringify(await engine.executeRaw("SELECT slug, source_path FROM pages WHERE slug LIKE 'mix/%' AND (slug ILIKE '%legacy%' OR slug LIKE '%held%' OR slug LIKE '%refused%' OR slug LIKE '%place%' OR slug LIKE '%somewhere%')"))}`);
  // #6875 gate 2: a file refused before refusals were recorded as holds has no hold row at all.
  await engine.transaction(tx => clearGitHold(tx, { sourceId: 'default', incarnation, path: 'mix/refused-once.md', observedAt: new Date(Date.now() + 60_000).toISOString() }));

  // Stage 3a: write-through publications (the default); the effect writes the file and records expected_hash.
  for (const path of ['mix/adopt-hash.md', 'mix/dbahead-pending.md', 'mix/dirty-published.md']) await putPage(path, `A write-through edit of ${titleOf(path)}.`);
  await waitUntil('git effects', async () => !(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE kind='git' AND state IN ('queued','running')")).length);
  gitIn(root, ['checkout', '--', 'mix/dbahead-pending.md']);

  // Stage 3b: database-only writes (write-through off), soft deletes and purges.
  await engine.setConfig('sync.write_through', 'false');
  for (const path of ['mix/dbahead-unproven.md', 'mix/drift-unknown.md']) await recordSql(path, "(completed_keys->0) - 'revision'");
  for (const path of ['mix/dbahead-dbonly.md', 'mix/dbahead-unproven.md', 'kept/dbonly.md', 'kept/clean-drift.md', 'kept/dirty-drift.md', 'mix/drift-both.md',
    'mix/drift-unknown.md', 'mix/held-file-drift.md', 'mix/delete-drift.md']) await putPage(path, `A database-only edit of ${titleOf(path)}.`);
  for (const path of ['mix/tomb-same.md', 'mix/tomb-edited.md', 'mix/tomb-untracked.md', 'mix/tomb-gone.md']) await deletePage(path);
  const purgedOids = new Map(['mix/purged-marker-same.md', 'mix/purged-marker-differs.md', 'mix/legacy-marker.md'].map(path => [path, oidAt(path)]));
  for (const path of ['mix/purged-nomarker.md', 'mix/purged-marker-same.md', 'mix/purged-marker-differs.md', 'mix/legacy-marker.md']) await deletePage(path, true);

  // Stage 3c: raw SQL, only where no gbrain call reaches the state.
  await recordSql('mix/reparse-parser.md', `jsonb_set(completed_keys->0, '{parser,parser_version}', '"import=0"')`);
  await recordSql('mix/reparse-origin.md', `jsonb_set(completed_keys->0, '{origin}', '"mix/elsewhere.md"')`);
  await recordSql('mix/adopt-revision.md', "(completed_keys->0) - 'revision'");
  await recordSql('mix/legacy-unverified.md', "(completed_keys->0) - 'revision' - 'disk_blob_oid' - 'parser' - 'blob_oid'");
  // Receipt compaction NULLs the intent (journal.ts), as a release before PR 0 left it.
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_requests SET intent=NULL, compacted=true WHERE slug='mix/legacy-unverified'");
  });
  // The purge wrote each origin's deleted marker through PR 4b's writer (sync-markers.ts); the deleted cases check that
  // real row. A purge before PR 4b left none (purged-nomarker), and a legacy marker is the bootstrap's (raw SQL for both).
  // The bootstrap writes a legacy marker with its deletion proof: the committed delete_page that removed the page (rulings b1).
  const purgeRequest = async (slug: string) => (await engine.executeRaw<{ id: string }>("SELECT request_id::text AS id FROM persistence_requests WHERE slug=$1 AND operation='delete_page' AND state='committed' ORDER BY sequence DESC LIMIT 1", [slug]))[0]?.id ?? null;
  const markerKey = (path: string) => `default:${incarnation}:${path}`;
  for (const path of ['mix/purged-marker-same.md', 'mix/purged-marker-differs.md']) {
    const [row] = await engine.executeRaw<{ value: { kind: string; blob_oids: string[] } }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_ORIGIN_DELETED_OP, markerKey(path)]);
    if (row?.value.kind !== 'deleted' || !row.value.blob_oids.includes(purgedOids.get(path)!)) throw new Error(`the purge of ${path} wrote no deleted marker naming its blob: ${JSON.stringify(row ?? null)}`);
  }
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [SYNC_ORIGIN_DELETED_OP, markerKey('mix/purged-nomarker.md')]);
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys',
    [SYNC_ORIGIN_DELETED_OP, markerKey('mix/legacy-marker.md'), JSON.stringify([{ kind: 'legacy', blob_oids: [purgedOids.get('mix/legacy-marker.md')!], deletion: await purgeRequest('mix/legacy-marker'), sha256: null, revision: null, page_id: null, at: new Date().toISOString() }])]);
  await withoutTrigger(() => engine.executeRaw("INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth) VALUES('default','mix/Twin Page','note','markdown','Twin Page','Synthetic Twin Page one.')"));

  // Stage 3d: the Git side, one commit that names its paths.
  const edited = ['mix/import-changed.md', 'kept/clean-drift.md', 'kept/dirty-drift.md', 'mix/drift-both.md', 'mix/drift-unknown.md', 'mix/held-file-drift.md',
    'mix/held-concurrent.md', 'mix/tomb-edited.md', 'mix/purged-marker-differs.md', 'mix/dirty-held.md', 'mix/inflight-wt.md', 'mix/inflight-dbonly.md'];
  for (const path of edited) write(root, path, note(titleOf(path), `A committed edit of ${titleOf(path)}.`));
  write(root, 'mix/import-new.md', note('import-new', 'Synthetic import-new.'));
  add(...edited, 'mix/import-new.md', 'mix/adopt-hash.md');
  // Write-through is off, so delete_page left every file: tomb-gone leaves the checkout, tomb-untracked and kept-file only leave T.
  gitIn(root, ['rm', '-q', '--', 'mix/delete-proof.md', 'mix/delete-drift.md', 'mix/tomb-gone.md']);
  gitIn(root, ['rm', '-q', '--cached', '--', 'mix/tomb-untracked.md', 'mix/kept-file.md']);
  commitStaged(root, 'seeded edits');
  for (const path of ['kept/dirty-drift.md', 'mix/dirty-held.md', 'mix/dirty-absorbed.md']) write(root, path, note(titleOf(path), `An uncommitted draft of ${titleOf(path)}.`));
  write(root, 'mix/untracked-new.md', note('untracked-new', 'Never committed.'));

  // Stage 3e: the holds a sync would write for these two (the classifier only reads them).
  for (const [path, code] of [['mix/held-file-drift.md', 'file_drift'], ['mix/held-concurrent.md', 'concurrent_write']] as const) {
    const page = await snapshot(resolveSlugForPath(path));
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path, source_path: path, slug: page.page.slug, page_id: Number(page.page.id), code,
      message: `Synthetic ${code} hold.`, upstream_version: sha256(Buffer.from(note(titleOf(path), `A committed edit of ${titleOf(path)}.`))),
      observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
      meta: { recovery_version: RECOVERY_VERSION, blob_oid: oidAt(path), page_revision: page.revision, ...(code === 'file_drift' ? { sides: 'both' as const } : {}) } }));
  }

  // Stage 3f: open work. With the consumer stopped an admitted request stays queued (nothing after this awaits a write).
  await disposePersistenceConsumer(engine);
  for (const [path, writeThrough] of [['mix/inflight-wt.md', 'true'], ['mix/inflight-dbonly.md', 'false']] as const) {
    await engine.setConfig('sync.write_through', writeThrough);
    const slug = resolveSlugForPath(path);
    const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), expected_revision: (await snapshot(slug)).revision,
      content: note(titleOf(path), 'A queued agent edit.') } });
    if (!prepared.admission) throw new Error(`put_page on ${slug} replayed instead of admitting`);
    const row = await admitWrite(engine, prepared.admission);
    if (row.state !== 'queued') throw new Error(`the open put_page on ${slug} is ${row.state}`);
  }
  await engine.setConfig('sync.write_through', 'false');
  // The mix is the brain as PR 4b's first pass finds it on upgrade: no pass row, so the shadow reads it as the bootstrap
  // (design §2.7). The seeding's own syncs ran the pass; its row is removed (raw state).
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-pass'");
  // keep_db is read from the checkout when the pass classifies; it is written last so no keep_db worker acts during seeding.
  write(root, 'gbrain.yml', 'storage:\n  keep_db:\n    - kept/\n');
  return mixCases().filter(entry => !SPELLING.includes(entry.path));
}

const SPELLING = ['mix/Case-Pair.md', 'mix/case-pair.md', 'mix\\sep-pair.md', 'mix/sep-pair.md'];

/**
 * Row 2 last, in its own commit: master's refusal of a spelling collision (page_identity_changed) aborts discovery, and
 * with it the dry run's receipt, so the CLI checks run on the mix before the collision lands.
 */
export function seedSpelling(root: string, cases: SeededCase[]): SeededCase[] {
  for (const path of SPELLING) write(root, path, note(titleOf(path), `Synthetic ${titleOf(path)}.`));
  gitIn(root, ['add', '--', ...SPELLING]);
  commitStaged(root, 'spelling collisions');
  return [...cases, ...mixCases().filter(entry => SPELLING.includes(entry.path))];
}

/** Phase B: a mass removal that trips #2828's valve (mass/* plus the mix's two single deletes). */
export function seedMassDelete(root: string, cases: SeededCase[]): SeededCase[] {
  gitIn(root, ['rm', '-q', '-r', '--', 'mass']);
  commitStaged(root, 'mass removal');
  return cases.map(entry => entry.path.startsWith('mass/') || entry.path === 'mix/delete-proof.md' || entry.path === 'mix/kept-file.md'
    ? { ...entry, category: entry.path.startsWith('mass/') ? 'deletes_withheld (mass removal)' : 'deletes_withheld (a single delete of the mix, same trip)', row: '§2.6 valve on row 5',
      seed: `${entry.seed}, git rm and commit (mass)`, expect: { key: 'deletes_withheld', action: 'delete', settled: true } }
    : entry);
}

/**
 * Working mode (sync.include_working_tree, or a detached HEAD): the level is the bytes on disk, so these paths change
 * class. Only the paths whose working-mode class this mix pins are listed; the rest of the domain is left unchecked.
 */
export function workingCases(cases: SeededCase[]): SeededCase[] {
  const want: Record<string, { expect: Expected; row: string; finding?: Finding; today?: Expected }> = {
    'mix/tomb-gone.md': { expect: { key: 'gone', action: 'none', settled: true }, row: 'row 7 (working mode: L absent, no live page)' },
    'mix/delete-proof.md': { expect: { key: 'delete', action: 'delete', settled: false }, row: 'row 5 (L absent, not present, proof)' },
    'mix/delete-drift.md': { expect: { key: 'delete_drift', action: 'hold', settled: false }, row: 'row 6 (L absent, not present, no proof)' },
    'mix/untracked-new.md': { expect: { key: 'import', action: 'import', settled: false }, row: 'row 16 (in U, no page, no marker)' },
    'mix/dirty-absorbed.md': { expect: { key: 'import', action: 'import', settled: false }, row: 'row 16 (L = the disk bytes, proof)' },
    'mix/dirty-held.md': { expect: { key: 'import', action: 'import', settled: false }, row: 'row 16 (L = the disk bytes, proof)' },
  };
  return cases.filter(entry => want[entry.path]).map(entry => {
    const { finding: _finding, today: _today, ...rest } = entry;
    return { ...rest, category: `${entry.category}, working mode`, ...want[entry.path]! };
  });
}

/**
 * The --full variant (v3.2 §6): an open episode makes every live page an obligation, so fileSame ∧ dbSame pages are
 * row 14 reparse, adoption (row 13 needs ¬obligation) falls to row 15 or 16, db_only and unproven pages are excluded
 * and counted (row 15), and legacy-marked page-less paths import (v3.1 §2.7).
 */
export function fullCases(cases: SeededCase[]): SeededCase[] {
  const to = (entry: SeededCase, row: string, expect: Expected, finding?: Finding, today?: Expected): SeededCase => {
    const { finding: _finding, today: _today, ...rest } = entry;
    return { ...rest, category: `${entry.category}, --full`, row, expect, ...(finding ? { finding } : {}), ...(today ? { today } : {}) };
  };
  return cases.map(entry => {
    const e = entry.expect;
    // An open episode makes the matched dirty-absorbed path a candidate, so its Dp is read and row 11 applies.
    if (entry.path === 'mix/dirty-absorbed.md') return to(entry, 'row 11 (a candidate under --full, so Dp is read)', { key: 'dirty', action: 'none', settled: true });
    if (e.key === 'matched') return to(entry, 'row 14 (episode obligation)', { key: 'reparse', action: 'reparse', settled: false }, entry.finding);
    if (entry.path === 'mix/adopt-revision.md') return to(entry, 'row 15 (fileSame, ¬dbSame, arm 1 attests)', { key: 'db_ahead', action: 'none', settled: true, sub: 'pending' });
    if (e.key === 'adopt') return to(entry, 'row 16 (¬fileSame, proof)', { key: 'import', action: 'import', settled: false });
    if (e.key === 'db_ahead' && e.sub !== 'pending') return to(entry, 'row 15 (full_skipped_db_ahead)', { ...e, fullSkipped: true });
    if (e.key === 'legacy_same') return to(entry, 'v3.1 §2.7: --full imports legacy-marked paths (rulings b5)', { key: 'import', action: 'import', settled: false });
    return entry;
  });
}

// ─── comparing ───────────────────────────────────────────────────────

export interface Predicted { key: ExpectedKey; action: SyncPathAction; settled: boolean; sub?: string; side?: string; state?: string; keepDbWrite?: boolean; fullSkipped?: boolean; glossary: string }
/** `match`: the prediction equals the design's expectation; `asToday`: it equals `today ?? expect` (what the test asserts). */
export interface PathResult { entry: SeededCase; predicted: Predicted | null; match: boolean; asToday: boolean; diffs: string[] }
export interface EvalRun {
  label: string; level: ShadowLevel; receipt: ConvergenceReceipt; results: PathResult[]; unseeded: string[]; wall_ms: number;
  totality: { eligibleAtHead: number; classifiedAtHead: number; missing: string[]; duplicates: string[]; countsSum: number; paths: number; ok: boolean };
  counts: Array<{ key: string; expected: number; receipt: number }>;
}

/** Every path of the level, keyed as the receipt keys it (in_flight, keep_db_pending and deletes_withheld included), against the cases. */
export async function evaluate(engine: BrainEngine, cases: SeededCase[], input: { label: string; full?: boolean; workingTree?: boolean; sourceId?: string; partial?: boolean }): Promise<EvalRun> {
  const started = performance.now();
  const level = (await readShadowLevel(engine, { sourceId: input.sourceId ?? 'default', full: input.full, workingTree: input.workingTree }))!;
  const receipt = await buildConvergenceReceipt(engine, level, { redactPaths: false, sampleCap: Number.MAX_SAFE_INTEGER, screen: false });
  const wall_ms = Math.round(performance.now() - started);
  const sampled = new Map<string, { key: string; action: string }>();
  for (const [key, samples] of Object.entries(receipt.samples)) for (const sample of samples ?? []) sampled.set(sample.path, { key, action: sample.action });
  const byPath = new Map(level.paths.map(entry => [entry.path, entry]));
  const results = cases.map((entry): PathResult => {
    const got = byPath.get(entry.path);
    const sample = sampled.get(entry.path);
    const predicted: Predicted | null = got ? { key: (sample?.key ?? got.result.cls) as ExpectedKey, action: got.result.action,
      settled: got.result.settled || sample?.key === 'keep_db_pending' || sample?.key === 'deletes_withheld',
      ...(got.result.sub ? { sub: got.result.sub } : {}), ...(got.result.side ? { side: got.result.side } : {}), ...(got.result.state ? { state: got.result.state } : {}),
      ...(got.result.keepDbWrite ? { keepDbWrite: true } : {}), ...(got.result.fullSkipped ? { fullSkipped: true } : {}), glossary: sample?.action ?? 'none' } : null;
    const differences = (expected: Expected) => {
      if (!predicted) return expected.key === 'outside_domain' ? [] : [`key: expected ${expected.key}, not in the domain`];
      return Object.entries(expected).flatMap(([field, want]) => {
        const have = (predicted as unknown as Record<string, unknown>)[field] ?? (typeof want === 'boolean' ? false : undefined);
        return have === want ? [] : [`${field}: expected ${String(want)}, predicted ${String(have)}`];
      });
    };
    const diffs = differences(entry.expect);
    return { entry, predicted, match: diffs.length === 0, asToday: entry.today ? differences(entry.today).length === 0 : diffs.length === 0, diffs };
  });
  const seeded = new Set(cases.map(entry => entry.path));
  const unseeded = input.partial ? [] : level.paths.map(entry => entry.path).filter(path => !seeded.has(path));
  const atHead = gitIn(level.gitRoot, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(path => path && isSyncable(path, { strategy: 'markdown' }));
  const classified = level.paths.filter(entry => entry.state.tree !== null).map(entry => entry.path);
  const seen = new Set<string>(), duplicates: string[] = [];
  for (const entry of level.paths) { if (seen.has(entry.path)) duplicates.push(entry.path); seen.add(entry.path); }
  const classifiedSet = new Set(classified);
  const missing = atHead.filter(path => !classifiedSet.has(path));
  const countsSum = Object.values(receipt.counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const expected = new Map<string, number>();
  for (const entry of cases) if (entry.expect.key !== 'outside_domain') expected.set(entry.expect.key, (expected.get(entry.expect.key) ?? 0) + 1);
  const keys = input.partial ? [] : [...new Set([...expected.keys(), ...Object.keys(receipt.counts)])].sort();
  return { label: input.label, level, receipt, results, unseeded, wall_ms,
    totality: { eligibleAtHead: atHead.length, classifiedAtHead: classified.length, missing, duplicates, countsSum, paths: level.paths.length,
      ok: !missing.length && !duplicates.length && countsSum === level.paths.length && classified.length === atHead.length },
    counts: keys.map(key => ({ key, expected: expected.get(key) ?? 0, receipt: (receipt.counts as Record<string, number>)[key] ?? 0 })) };
}

/** Runs a CLI handler and captures the one JSON document it writes under --json, and its exit code. */
export async function captureCli(run: () => Promise<void>): Promise<{ json: Record<string, unknown> | null; exit: number; error?: { code: string | null; message: string } }> {
  const out: string[] = [];
  const saved = { write: process.stdout.write, errWrite: process.stderr.write, log: console.log, error: console.error, warn: console.warn, exit: process.exit };
  class Exit extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
  const { currentExitCode, setCliExitVerdict } = await import('../../src/core/cli-force-exit.ts');
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(' ')); };
  console.error = () => {};
  console.warn = () => {};
  process.exit = ((code?: number) => { throw new Exit(code ?? 0); }) as typeof process.exit;
  setCliExitVerdict(0);
  let exit = 0, error: { code: string | null; message: string } | undefined;
  try { await run(); exit = currentExitCode(); }
  catch (caught) {
    if (caught instanceof Exit) exit = caught.code;
    else { exit = 1; error = { code: typeof (caught as { code?: unknown }).code === 'string' ? (caught as { code: string }).code : null, message: (caught as Error).message }; }
  }
  finally { Object.assign(process.stdout, { write: saved.write }); Object.assign(process.stderr, { write: saved.errWrite }); Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn }); process.exit = saved.exit; setCliExitVerdict(0); }
  const text = out.join('');
  return { json: text.includes('{') ? JSON.parse(text.slice(text.indexOf('{'))) as Record<string, unknown> : null, exit, ...(error ? { error } : {}) };
}

export const redactPath = (path: string) => `sha256:${createHash('sha256').update(path).digest('hex').slice(0, 16)}`;

export interface CliCheck { dryRunExit: number; statusExit: number; dryRunError?: { code: string | null; message: string }; statusError?: { code: string | null; message: string }; dryRunCounts: string; statusCounts: string; libraryCounts: string; redactionLeaks: string[];
  redactedSamplesChecked: number; redactedSampleMismatches: string[]; dryRunConvergence: ConvergenceReceipt; statusConvergence: ConvergenceReceipt }

/** The CLI side: the redacted dry run and status --detail, compared with the library run and the cases. */
export async function cliChecks(engine: BrainEngine, run: EvalRun): Promise<CliCheck> {
  const { runSync } = await import('../../src/commands/sync.ts');
  const dry = await captureCli(() => runSync(engine, ['--source', 'default', '--no-pull', '--dry-run', '--json', '--no-embed', '--redact-paths']));
  const status = await captureCli(() => runSync(engine, ['status', '--source', 'default', '--json', '--detail']));
  const dryConvergence = dry.json?.convergence as ConvergenceReceipt, statusConvergence = status.json?.convergence as ConvergenceReceipt;
  const counts = (receipt: ConvergenceReceipt | undefined) => JSON.stringify(Object.entries(receipt?.counts ?? {}).sort());
  const text = JSON.stringify(dryConvergence ?? {});
  const leaks = run.results.map(result => result.entry.path).filter(path => text.includes(path) || text.includes(resolveSlugForPath(path)));
  const byRedacted = new Map(run.results.map(result => [redactPath(result.entry.path), result]));
  const mismatches: string[] = [];
  let checked = 0;
  for (const [key, samples] of Object.entries(dryConvergence?.samples ?? {})) for (const sample of samples ?? []) {
    checked++;
    const result = byRedacted.get(sample.path);
    if (!result) mismatches.push(`${sample.path}: not a seeded path`);
    else if (result.predicted?.key !== key) mismatches.push(`${result.entry.path}: redacted sample under ${key}, library ${result.predicted?.key}`);
    else if (result.predicted.glossary !== sample.action) mismatches.push(`${result.entry.path}: redacted action ${sample.action}, library ${result.predicted.glossary}`);
  }
  // A refused dry run reports its refusal as the envelope's code, beside its convergence receipt.
  const dryRunError = dry.error ?? (typeof dry.json?.code === 'string' ? { code: dry.json.code, message: String(dry.json.message ?? '') } : undefined);
  return { dryRunExit: dry.exit, statusExit: status.exit, ...(dryRunError ? { dryRunError } : {}), ...(status.error ? { statusError: status.error } : {}), dryRunCounts: counts(dryConvergence), statusCounts: counts(statusConvergence), libraryCounts: counts(run.receipt),
    redactionLeaks: leaks, redactedSamplesChecked: checked, redactedSampleMismatches: mismatches, dryRunConvergence: dryConvergence, statusConvergence };
}

// ─── report ──────────────────────────────────────────────────────────

const show = (key: ExpectedKey, action?: string) => `${key}${action ? ` / ${action}` : ''}`;
const cell = (text: string) => text.replaceAll('|', '\\|');

export function renderRun(run: EvalRun): string {
  const lines = [`### ${run.label} [measured]`, '', '| category | count | expected (class / action) | predicted | match |', '|---|---:|---|---|---|'];
  const groups = new Map<string, PathResult[]>();
  for (const result of run.results) { const key = `${result.entry.category}\u0000${show(result.entry.expect.key, result.entry.expect.action)}`; groups.set(key, [...(groups.get(key) ?? []), result]); }
  for (const [key, results] of groups) {
    const [category, expected] = key.split('\u0000');
    const predicted = [...new Set(results.map(result => result.predicted ? show(result.predicted.key, result.predicted.action) : 'outside_domain'))].join(', ');
    const matched = results.filter(result => result.match).length;
    lines.push(`| ${cell(category!)} | ${results.length} | ${expected} | ${predicted} | ${matched === results.length ? 'yes' : `**no** (${results.length - matched})`} |`);
  }
  const t = run.totality;
  lines.push('', `Totality: ${t.ok ? 'ok' : '**failed**'}. ${t.eligibleAtHead} eligible paths at HEAD, ${t.classifiedAtHead} classified with a tree entry, ${t.missing.length} missing, `
    + `${t.duplicates.length} classified twice; ${t.paths} domain paths, and the receipt's class counts sum to ${t.countsSum}.`
    + (run.unseeded.length ? ` Unseeded domain paths: ${run.unseeded.join(', ')}.` : ' Every domain path is a seeded case.'), '',
  '| receipt key | seeded (expected) | receipt count | match |', '|---|---:|---:|---|',
  ...run.counts.map(row => `| ${row.key} | ${row.expected} | ${row.receipt} | ${row.expected === row.receipt ? 'yes' : '**no**'} |`));
  const misses = run.results.filter(result => !result.match);
  if (misses.length) lines.push('', 'Mismatches:', ...misses.map(result => `- \`${result.entry.path}\` (${result.entry.category}): ${result.diffs.join('; ')}${result.entry.finding ? ` [finding (${result.entry.finding.kind})]` : ' [unexplained]'}`));
  const r = run.receipt;
  lines.push('', `Receipt: candidates ${r.candidates}, settled ${r.settled}, in_flight ${r.in_flight}, decisions ${JSON.stringify(r.decisions)}, would_hold ${r.would_hold}, `
    + `deletes ${JSON.stringify({ count: r.deletes.count, reconcilable: r.deletes.reconcilable, ratio: r.deletes.ratio, verdict: r.deletes.verdict })}, `
    + `db_ahead ${JSON.stringify({ pending: r.db_ahead.pending, db_only: r.db_ahead.db_only, unproven: r.db_ahead.unproven })}, keep_db_admitted ${r.keep_db_admitted}, `
    + `legacy_unverified ${r.legacy_unverified}, legacy_pageless ${r.legacy_pageless}, full_skipped_db_ahead ${r.full_skipped_db_ahead}. Read and receipt wall time ${run.wall_ms} ms.`,
  '', `timings_ms: \`${JSON.stringify(run.level.timings_ms)}\``);
  return lines.join('\n');
}

export function renderCli(cli: CliCheck): string {
  return `CLI [measured]: \`gbrain sync --dry-run --json --redact-paths\` exited ${cli.dryRunExit}${cli.dryRunError ? ` (${cli.dryRunError.code}: ${cli.dryRunError.message})` : ''} and its convergence counts ${cli.dryRunCounts === cli.libraryCounts ? 'equal' : '**differ from**'} the library receipt's; `
    + `\`gbrain sync status --json --detail\` exited ${cli.statusExit}${cli.statusError ? ` (${cli.statusError.code})` : ''}, counts ${cli.statusCounts === cli.libraryCounts ? 'equal' : '**differ**'}. `
    + `${cli.redactedSamplesChecked} redacted samples mapped back to their seeded paths, ${cli.redactedSampleMismatches.length} disagreeing with the library class or action`
    + `${cli.redactedSampleMismatches.length ? ` (${cli.redactedSampleMismatches.join('; ')})` : ''}; ${cli.redactionLeaks.length} paths or slugs leaked under --redact-paths.`;
}

export function renderFindings(runs: EvalRun[], extra: Finding[] = []): string {
  const found = new Map<string, { finding: Finding; paths: Set<string> }>(extra.map(finding => [finding.text, { finding, paths: new Set<string>() }]));
  for (const run of runs) for (const result of run.results) {
    const finding = result.entry.finding;
    if (!finding || (result.entry.today && result.match)) continue;
    const item = found.get(finding.text) ?? { finding, paths: new Set<string>() };
    item.paths.add(result.entry.path);
    found.set(finding.text, item);
  }
  const unexplained = runs.flatMap(run => run.results.filter(result => !result.asToday || (!result.match && !result.entry.today)).map(result => `- ${run.label}: \`${result.entry.path}\` ${result.diffs.join('; ')}`));
  const fixedA = runs.flatMap(run => run.results.filter(result => result.match && result.entry.today).map(result => `${run.label}: \`${result.entry.path}\``));
  const list = (kind: 'a' | 'b') => [...found.values()].filter(item => item.finding.kind === kind)
    .map(item => `- ${item.finding.text} (${item.finding.ref}${item.paths.size ? '; ' : ''}${[...item.paths].slice(0, 8).map(path => `\`${path}\``).join(', ')}${item.paths.size > 8 ? ` and ${item.paths.size - 8} more` : ''})`);
  return ['## (a) shadow bugs: the shadow differs from the design', '', ...list('a'), ...(fixedA.length ? ['', `Cases whose pinned difference is gone (drop their today): ${fixedA.join(', ')}.`] : []), '',
    '## (b) design gaps: the shadow follows the design, and the design is wrong for the issue named', '', ...list('b'), '',
    '## (c) fixture errors', '', ...(unexplained.length ? ['Unexplained mismatches (fixture errors until classified):', ...unexplained] : ['None open: every mismatch is a listed finding, pinned by its case.'])].join('\n');
}

// ─── scale ───────────────────────────────────────────────────────────

/**
 * The SQL- and Git-reachable part of the mix at scale, round-robin over --rate of the fixture's pages. Every case is
 * seeded by direct SQL or Git on top of seedSource's converged source (gbrain writes at 61k on PGLite would take hours),
 * so holds are writeGitHold rows; open work and write-through attestations need real requests and stay mix-only.
 */
export const SCALE_KINDS = ['import_changed', 'import_new', 'reparse_parser', 'reparse_origin', 'db_only', 'unproven', 'drift_both', 'drift_unknown', 'delete', 'delete_drift',
  'tombstone_same', 'tombstone_edited', 'tombstone_untracked', 'kept', 'dirty', 'dirty_absorbed', 'held_invalid_frontmatter', 'legacy_unverified', 'deleted_marker_same',
  'legacy_marker', 'pageless_baseline', 'spelling'] as const;
export type ScaleKind = typeof SCALE_KINDS[number];
const SCALE_EXPECT: Record<ScaleKind, { expect: Expected; row: string; finding?: Finding; today?: Expected }> = {
  import_changed: { expect: { key: 'import', action: 'import' }, row: 'row 16' }, import_new: { expect: { key: 'import', action: 'import' }, row: 'row 16' },
  reparse_parser: { expect: { key: 'reparse', action: 'reparse' }, row: 'row 14' }, reparse_origin: { expect: { key: 'reparse', action: 'reparse' }, row: 'row 14' },
  db_only: { expect: { key: 'db_ahead', action: 'none', sub: 'db_only' }, row: 'row 15' }, unproven: { expect: { key: 'db_ahead', action: 'none', sub: 'unproven' }, row: 'row 15' },
  drift_both: { expect: { key: 'drift', action: 'hold', side: 'both' }, row: 'row 19' }, drift_unknown: { expect: { key: 'drift', action: 'hold', side: 'unknown' }, row: 'row 19' },
  delete: { expect: { key: 'delete', action: 'delete' }, row: 'row 5' }, delete_drift: { expect: { key: 'delete_drift', action: 'hold' }, row: 'row 6' },
  tombstone_same: { expect: { key: 'deleted_same', action: 'none' }, row: 'row 8' }, tombstone_edited: { expect: { key: 'deleted_edited', action: 'hold' }, row: 'row 9' },
  tombstone_untracked: { expect: { key: 'untracked', action: 'none' }, row: 'row 3' }, kept: { expect: { key: 'kept', action: 'none' }, row: 'row 4 (keptWorkingTreePages)' },
  dirty: { expect: { key: 'dirty', action: 'hold' }, row: 'row 11' },
  dirty_absorbed: { expect: { key: 'matched', action: 'none' }, row: 'row 12: Dp is read for candidates only (rulings b3)', finding: FINDINGS.dirtyAbsorbed },
  held_invalid_frontmatter: { expect: { key: 'held', action: 'none' }, row: 'row 1' }, legacy_unverified: { expect: { key: 'legacy_unverified', action: 'none' }, row: 'row 17' },
  deleted_marker_same: { expect: { key: 'deleted_same', action: 'none' }, row: 'row 8' }, legacy_marker: { expect: { key: 'legacy_same', action: 'none' }, row: 'row 10' },
  pageless_baseline: { expect: { key: 'legacy_same', action: 'none' }, row: 'row 10 via §2.7', finding: FINDINGS.refusedOnce }, spelling: { expect: { key: 'spelling', action: 'refuse' }, row: 'row 2' },
};

export interface ScaleResult { files: number; seeded: number; byKind: Record<string, number>; cases: SeededCase[]; seed_ms: number; rounds: Array<{ wall_ms: number; timings_ms: Record<string, number> }>; run: EvalRun }

/** Seeds the scale mix on a source seedSource converged at the fixture's base, then times rounds full shadow rounds. */
export async function seedScale(engine: BrainEngine, fixture: Fixture, input: { sourceId: string; rate: number; rounds: number; log: (line: string) => void }): Promise<ScaleResult> {
  const { sourceId } = input, root = fixture.repo;
  const started = performance.now();
  const n = Math.max(SCALE_KINDS.length, Math.round(fixture.files * input.rate));
  const step = Math.floor(fixture.files / n);
  const picks = Array.from({ length: n }, (_, j) => ({ i: j * step + 1, kind: SCALE_KINDS[j % SCALE_KINDS.length]!, path: fixturePath(j * step + 1) }));
  const byKind: Record<string, number> = {};
  for (const pick of picks) byKind[pick.kind] = (byKind[pick.kind] ?? 0) + 1;
  const of = (...kinds: ScaleKind[]) => picks.filter(pick => kinds.includes(pick.kind));
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const ids = new Map((await engine.executeRaw<{ id: number; source_path: string }>('SELECT id, source_path FROM pages WHERE source_id=$1 AND source_path=ANY($2::text[])',
    [sourceId, picks.map(pick => pick.path)])).map(row => [row.source_path, Number(row.id)]));
  const idsOf = (list: typeof picks) => list.map(pick => ids.get(pick.path)!);
  const fingerprints = (list: typeof picks) => list.map(pick => `${sourceId}:${incarnation}:${ids.get(pick.path)}`);
  const recordSql = (list: typeof picks, expression: string) => engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array(${expression})
    WHERE op=$1 AND fingerprint=ANY($2::text[])`, [SYNC_IMPORT_PROVENANCE_OP, fingerprints(list)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await recordSql(of('reparse_parser'), `jsonb_set(completed_keys->0, '{parser,parser_version}', '"import=0"')`);
    await recordSql(of('reparse_origin'), `jsonb_set(completed_keys->0, '{origin}', to_jsonb('elsewhere/' || (completed_keys->0->>'origin')))`);
    await recordSql(of('unproven', 'drift_unknown'), "(completed_keys->0) - 'revision'");
    // Row 4 is keptWorkingTreePages (#5459): the kept picks leave T below, so their records say a working-tree import.
    await recordSql(of('kept'), `jsonb_set(completed_keys->0, '{working}', 'true')`);
    await recordSql(of('legacy_unverified'), "(completed_keys->0) - 'revision' - 'disk_blob_oid' - 'parser' - 'blob_oid'");
    // A database-only edit: the page's revision moves off its record's, with no request (so no attestation).
    await engine.executeRaw('UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, idsOf(of('db_only', 'unproven', 'drift_both', 'drift_unknown', 'delete_drift'))]);
    await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, idsOf(of('tombstone_same', 'tombstone_edited', 'tombstone_untracked'))]);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, idsOf(picks)]);
    const purged = of('deleted_marker_same', 'legacy_marker', 'pageless_baseline');
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=ANY($2::text[])', [SYNC_IMPORT_PROVENANCE_OP, fingerprints(purged)]);
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, idsOf(purged)]);
    const format = fixture.base.length === 64 ? 'sha256' : 'sha1';
    for (const pick of of('deleted_marker_same', 'legacy_marker'))
      await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)', [SYNC_ORIGIN_DELETED_OP, `${sourceId}:${incarnation}:${pick.path}`,
        JSON.stringify([{ kind: pick.kind === 'legacy_marker' ? 'legacy' : 'deleted', blob_oids: [gitBlobOid(fixtureContent(pick.i), format)], sha256: null, revision: null, page_id: null, at: new Date().toISOString() }])]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }

  const rename = (path: string, to: string) => path.replace(/note-(\d+)\.md$/, to);
  const badFrontmatter = new Set(of('held_invalid_frontmatter').map(pick => pick.path));
  const edited = of('import_changed', 'drift_both', 'drift_unknown', 'tombstone_edited', 'dirty', 'held_invalid_frontmatter').map(pick => pick.path);
  for (const path of edited) writeFileSync(join(root, path), badFrontmatter.has(path) ? '---\ntitle: [unclosed\n---\nSynthetic body.\n' : `---\ntitle: Scale edit\n---\nScale edit of ${path}.\n`);
  const fresh = of('import_new').map(pick => rename(pick.path, 'new-$1.md'));
  const spelled = of('spelling').flatMap(pick => [rename(pick.path, 'Pair-$1.md'), rename(pick.path, 'pair-$1.md')]);
  for (const path of [...fresh, ...spelled]) writeFileSync(join(root, path), `---\ntitle: ${titleOf(path)}\n---\nSynthetic ${titleOf(path)}.\n`);
  gitIn(root, ['add', '--', ...edited, ...fresh, ...spelled]);
  gitIn(root, ['rm', '-q', '--', ...of('delete', 'delete_drift').map(pick => pick.path)]);
  gitIn(root, ['rm', '-q', '--cached', '--', ...of('tombstone_untracked', 'kept').map(pick => pick.path)]);
  commitStaged(root, 'scale seed');
  for (const pick of of('dirty', 'dirty_absorbed')) writeFileSync(join(root, pick.path), `---\ntitle: Uncommitted\n---\nUncommitted edit of ${pick.path}.\n`);
  for (const pick of of('held_invalid_frontmatter')) {
    const oid = gitIn(root, ['rev-parse', `HEAD:${pick.path}`]);
    await engine.transaction(tx => writeGitHold(tx, { source_id: sourceId, incarnation, path: pick.path, source_path: pick.path, slug: resolveSlugForPath(pick.path), page_id: ids.get(pick.path)!,
      code: 'invalid_frontmatter', message: 'Synthetic invalid_frontmatter hold.', upstream_version: null, observed_at: new Date().toISOString(), run_id: null, mode: 'managed',
      meta: { recovery_version: RECOVERY_VERSION, blob_oid: oid, reason: 'needs_interpretation' } }));
  }
  const seed_ms = Math.round(performance.now() - started);
  input.log(`scale: seeded ${n} paths over ${SCALE_KINDS.length} kinds in ${seed_ms} ms`);

  const cases: SeededCase[] = [];
  const replaced = new Set<string>();
  for (const pick of picks) {
    const { expect, row, finding, today } = SCALE_EXPECT[pick.kind];
    const add = (path: string, seed: string) => cases.push({ category: pick.kind, path, expect, row, seed, ...(finding ? { finding } : {}), ...(today ? { today } : {}) });
    if (pick.kind === 'import_new') add(rename(pick.path, 'new-$1.md'), 'git commit');
    else if (pick.kind === 'spelling') { add(rename(pick.path, 'Pair-$1.md'), 'git commit'); add(rename(pick.path, 'pair-$1.md'), 'git commit'); }
    else { add(pick.path, 'seedSource, then raw SQL and Git'); replaced.add(pick.path); }
  }
  for (let i = 0; i < fixture.files; i++) { const path = fixturePath(i); if (!replaced.has(path)) cases.push({ category: 'matched (unseeded)', path, expect: { key: 'matched', action: 'none' }, row: 'row 12', seed: 'seedSource' }); }
  const rounds: ScaleResult['rounds'] = [];
  for (let k = 0; k < input.rounds; k++) {
    const t = performance.now();
    const level = (await readShadowLevel(engine, { sourceId }))!;
    await buildConvergenceReceipt(engine, level, { redactPaths: true, sampleCap: 20, screen: false });
    rounds.push({ wall_ms: Math.round(performance.now() - t), timings_ms: level.timings_ms });
  }
  const run = await evaluate(engine, cases, { label: `scale: ${fixture.files} files, ${n} seeded (${(input.rate * 100).toFixed(1)}%)`, sourceId });
  return { files: fixture.files, seeded: n, byKind, cases, seed_ms, rounds, run };
}

// ─── CLI ─────────────────────────────────────────────────────────────

function flag(name: string, fallback: string): string { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback; }
const log = (line: string) => process.stderr.write(`[sync-convergence-seeded] ${line}\n`);

async function main(): Promise<number> {
  const engineKind = flag('engine', 'pglite');
  if (!['pglite', 'postgres'].includes(engineKind)) { log('--engine takes pglite or postgres'); return 2; }
  const databaseUrl = engineKind === 'postgres' ? flag('database-url', process.env.DATABASE_URL ?? '') : '';
  if (engineKind === 'postgres' && !databaseUrl) { log('--engine postgres needs --database-url or DATABASE_URL (an admin URL; the run creates and drops its own database)'); return 2; }
  const scale = process.argv.includes('--scale');
  const out = resolve(flag('out', join(homedir(), '.capy/work/6712', scale ? `shadow-eval-scale-${engineKind}.md` : `shadow-eval-${engineKind}.md`)));
  const { VERSION } = await import('../../src/version.ts');
  const header = `Measured by scripts/bench/sync-convergence-seeded.ts at ${new Date().toISOString()}: engine ${engineKind}, gbrain ${VERSION} (${gitIn(resolve(import.meta.dir, '../..'), ['rev-parse', '--short=9', 'HEAD'])}), `
    + `${execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()}, Bun ${Bun.version}.`;
  let body = '';
  if (scale) {
    const files = Number(flag('files', '61000')), rate = Number(flag('rate', '0.01')), rounds = Number(flag('rounds', '3'));
    const fixture = await ensureFixture(resolve(flag('cache-dir', join(homedir(), '.capy/work/6712/bench-fixtures'))), files, log);
    const restore = () => { resetFixture(fixture); gitIn(fixture.repo, ['clean', '-fdq']); };
    restore();
    const workDir = join(homedir(), '.capy/work/6712/seeded-runs', `${engineKind}-${files}-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    process.env.GBRAIN_HOME = join(workDir, 'home');
    let engine: BrainEngine, drop: (() => Promise<void>) | null = null;
    if (engineKind === 'pglite') {
      const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
      engine = new PGLiteEngine();
      await engine.connect({ database_path: join(workDir, 'brain.pglite') });
    } else {
      const postgres = (await import('#postgres')).default;
      const admin = postgres(databaseUrl, { max: 1, onnotice: () => {}, prepare: false });
      const database = `gbrain_seeded_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.unsafe(`CREATE DATABASE ${database}`);
      drop = async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); };
      const url = new URL(databaseUrl); url.pathname = `/${database}`;
      const { PostgresEngine } = await import('../../src/core/postgres-engine.ts');
      const pg = new PostgresEngine();
      await pg.connect({ database_url: url.toString(), poolSize: 4 });
      engine = pg;
    }
    try {
      await engine.initSchema();
      const seed = await seedSource(engine, { sourceId: 'bench-seeded', fixture, batch: 5000, log });
      const result = await seedScale(engine, fixture, { sourceId: 'bench-seeded', rate, rounds, log });
      const walls = result.rounds.map(round => round.wall_ms).sort((a, b) => a - b);
      body = [`## Scale: ${files} files, ${result.seeded} seeded paths (${(rate * 100).toFixed(1)}%), ${engineKind} [measured]`, '',
        `Seeded by kind: \`${JSON.stringify(result.byKind)}\`. Converged base (seedSource) \`${JSON.stringify(seed.timings_ms)}\` ms; the mix on top ${result.seed_ms} ms.`, '',
        `Full round (readShadowLevel plus the receipt), ${rounds} rounds, wall ms sorted: ${JSON.stringify(walls)}; max ${walls.at(-1)} ms.`, '',
        ...result.rounds.map((round, k) => `- round ${k + 1} timings_ms: \`${JSON.stringify(round.timings_ms)}\``), '', renderRun(result.run), '', renderFindings([result.run])].join('\n');
    } finally { await engine.disconnect(); await drop?.(); rmSync(workDir, { recursive: true, force: true }); restore(); }
  } else {
    const { managedBrain } = await import('../../test/helpers/managed-brain.ts');
    await managedBrain(async brain => {
      const mix = await seedMix(brain);
      const committed = await evaluate(brain.engine, mix, { label: 'committed mode, plain sync (the mix before the spelling commit)' });
      const cli = await cliChecks(brain.engine, committed);
      const after = await evaluate(brain.engine, mix, { label: 'committed mode, re-read after the CLI runs' });
      const cases = seedSpelling(brain.root, mix);
      const spelled = await evaluate(brain.engine, cases, { label: 'committed mode, plain sync, with the spelling collisions' });
      const spelledCli = await cliChecks(brain.engine, spelled);
      const full = await evaluate(brain.engine, fullCases(cases), { label: 'committed mode, --full (open episode)', full: true });
      const working = await evaluate(brain.engine, workingCases(cases), { label: 'working mode (selected paths)', workingTree: true, partial: true });
      const mass = await evaluate(brain.engine, seedMassDelete(brain.root, cases), { label: 'committed mode, after a mass removal (the valve)' });
      body = [renderRun(committed), '', renderCli(cli), ` The re-read after the CLI runs ${JSON.stringify(after.receipt.counts) === JSON.stringify(committed.receipt.counts) ? 'has the same counts' : '**has different counts**'}.`, '',
        renderRun(spelled), '', `With the spelling collisions: ${renderCli(spelledCli)}`, '', renderRun(full), '', renderRun(working), '', renderRun(mass), '',
        renderFindings([committed, spelled, full, working, mass])].join('\n');
    }, { ...(databaseUrl ? { databaseUrl } : {}), setup: mixSetup });
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, [header, '', body, ''].join('\n'));
  log(`wrote ${out}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
