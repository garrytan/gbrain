/**
 * #8073: the opt-in derived write-through (atoms from `extract_atoms`, concepts
 * from `synthesize_concepts`) commits every file it writes into a repo-backed
 * source, so the checkout never collects untracked or modified generated files.
 *
 * Protects: with `cycle.extract_atoms.write_through` on and the source's
 * local_path a Git checkout, each batch of atom files (an item's atoms and the
 * files of the atoms it retired, or the enable-time backfill) lands as one
 * commit naming exactly those paths through the shared-checkout commit door,
 * leaving `git status` clean; a hardened checkout still gets one commit per
 * batch, not one per file. A concept's file write commits the same way. A
 * commit the checkout refuses (a pre-commit hook here) rolls back every file
 * the batch wrote, leaves the pages database-only (`source_path` NULL) so the
 * next run's backfill writes them again, and reports a typed
 * `details.write_through_failed` entry with a `warn` status. A declared
 * `storage.db_only` directory stays database-only and commits nothing. A
 * repo-less source (no local_path) keeps every atom in the database and
 * reports nothing; a local_path that is not a Git checkout keeps its files.
 * Fails when: the hook writes files and leaves them uncommitted (the pre-fix
 * path), commits one file at a time, or leaves files behind after a refused
 * commit. A crash between a batch's file writes and its commit (the `derivedWriteSeams.beforeCommit` fault point)
 * leaves the files on disk, and the next run's batch commit sweeps them in through the door's pending ledger.
 * Seams: `derivedWriteSeams.beforeCommit` (a throw there stands in for a process crash: no rollback runs), the phases' `_transcripts` / `_chat` / `_atoms` test inputs (no paid
 * call). PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { derivedWriteSeams } from '../../src/core/cycle/derived-write-through.ts';
import { commitPathsLocked } from '../../src/core/git/commit-push.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from '../pathological/harness.ts';

type Layout = 'git' | 'plain' | 'none';

interface Brain {
  engine: BrainEngine;
  root: string;
  git(...args: string[]): string;
  path(slug: string): string;
  atoms(live?: boolean): Promise<Array<{ slug: string; source_path: string | null }>>;
  extract(titles: string[], hash: string | null, filePath?: string): Promise<{ status: string; failed: Array<{ code: string; paths: string[] }> }>;
}

const chat = (titles: string[]) => async (_o: ChatOpts): Promise<ChatResult> => {
  const text = JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} body.` })));
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
  };
};

async function withBrain(databaseUrl: string | undefined, layout: Layout, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-8073-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (layout === 'git') {
          git('init', '-q');
          git('config', 'user.name', 'Example Writer');
          git('config', 'user.email', 'writer@example.invalid');
          writeFileSync(join(root, 'README.md'), '# source-a\n');
          git('add', 'README.md');
          git('commit', '-qm', 'init');
        }
        if (layout !== 'none') await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        await engine.setConfig('cycle.extract_atoms.write_through', 'true');
        await run({
          engine, root, git,
          path: slug => join(root, `${slug}.md`),
          atoms: async (live = true) => engine.executeRaw<{ slug: string; source_path: string | null }>(
            "SELECT slug, source_path FROM pages WHERE type = 'atom' AND (deleted_at IS NULL) = $1 ORDER BY slug", [live]),
          async extract(titles, hash, filePath = '/fake/2026-09-07-meeting.txt') {
            const result = await runPhaseExtractAtoms(engine, {
              _transcripts: hash ? [{ filePath, content: 'content', contentHash: hash }] : [], _pages: [], _chat: chat(titles),
            });
            const failed = (result.details as { write_through_failed?: Array<{ code: string; paths: string[] }> }).write_through_failed ?? [];
            return { status: result.status, failed };
          },
        });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const commitCount = (b: Brain) => Number(b.git('rev-list', '--count', 'HEAD'));
const lastCommitPaths = (b: Brain) => b.git('show', '--no-renames', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort();
const dirty = (b: Brain) => b.git('status', '--porcelain', '--untracked-files=all');
const relOf = (slug: string) => `${slug}.md`;
const filesUnder = (dir: string): string[] => !existsSync(dir) ? [] : readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name);

function installHook(b: Brain, name: string, body: string): void {
  const hook = join(b.root, '.git', 'hooks', name);
  writeFileSync(hook, body);
  chmodSync(hook, 0o755);
}
const refuseCommits = (b: Brain) => installHook(b, 'pre-commit', '#!/bin/sh\necho "refused by policy" >&2\nexit 1\n');
const installHardenedHook = (b: Brain) => installHook(b, 'post-commit', '#!/usr/bin/env bash\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n');

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`#8073 derived write-through commits its files (${backend})`, () => {
    test('extract_atoms: an item\'s atom files land as one commit naming exactly them, and the checkout stays clean', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        const before = commitCount(b);
        const phase = await b.extract(['Renders vs proof', 'Founder lesson'], 'hash-one');
        const slugs = (await b.atoms()).map(a => a.slug);
        expect(slugs).toHaveLength(2);
        expect({ status: phase.status, failed: phase.failed, dirty: dirty(b) }).toEqual({ status: 'ok', failed: [], dirty: '' });
        expect({ commits: commitCount(b) - before, paths: lastCommitPaths(b) }).toEqual({ commits: 1, paths: slugs.map(relOf).sort() });
      });
    }, 180_000);

    test('extract_atoms: a retired atom\'s file removal is committed with the new atom, and the checkout stays clean', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        await b.extract(['Renders vs proof'], 'hash-one');
        const [old] = (await b.atoms()).map(a => a.slug);
        const before = commitCount(b);
        await b.extract(['A different lesson'], 'hash-two');
        const [current] = (await b.atoms()).map(a => a.slug);
        expect({ retired: (await b.atoms(false)).map(a => a.slug), oldFile: existsSync(b.path(old!)), dirty: dirty(b) })
          .toEqual({ retired: [old!], oldFile: false, dirty: '' });
        expect({ commits: commitCount(b) - before, paths: lastCommitPaths(b) }).toEqual({ commits: 1, paths: [relOf(current!), relOf(old!)].sort() });
        expect(b.git('ls-files', '--', relOf(old!))).toBe('');
      });
    }, 180_000);

    test('extract_atoms: the enable-time backfill commits its files as one batch', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        await b.engine.setConfig('cycle.extract_atoms.write_through', 'false');
        await b.extract(['Renders vs proof', 'Founder lesson'], 'hash-one');
        expect(dirty(b)).toBe('');
        await b.engine.setConfig('cycle.extract_atoms.write_through', 'true');
        const before = commitCount(b);
        await b.extract([], null);
        const slugs = (await b.atoms()).map(a => a.slug);
        expect({ commits: commitCount(b) - before, paths: lastCommitPaths(b), dirty: dirty(b) })
          .toEqual({ commits: 1, paths: slugs.map(relOf).sort(), dirty: '' });
      });
    }, 180_000);

    test('extract_atoms on a hardened checkout: still one commit per batch, not one per file', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        installHardenedHook(b);
        const before = commitCount(b);
        await b.extract(['Renders vs proof', 'Founder lesson'], 'hash-one');
        expect({ commits: commitCount(b) - before, paths: lastCommitPaths(b).length, dirty: dirty(b) }).toEqual({ commits: 1, paths: 2, dirty: '' });
      });
    }, 180_000);

    test('a refused commit rolls back every file the batch wrote, reports a typed failure, and the next run commits them', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        refuseCommits(b);
        const head = b.git('rev-parse', 'HEAD');
        const phase = await b.extract(['Renders vs proof', 'Founder lesson'], 'hash-one');
        const atoms = await b.atoms();
        expect(atoms).toHaveLength(2);
        expect({ status: phase.status, codes: phase.failed.map(f => f.code), paths: phase.failed.flatMap(f => f.paths).length })
          .toEqual({ status: 'warn', codes: ['git_unavailable'], paths: 2 });
        expect({ head: b.git('rev-parse', 'HEAD'), dirty: dirty(b), staged: b.git('diff', '--cached', '--name-only'),
          files: atoms.map(a => existsSync(b.path(a.slug))), bound: atoms.map(a => a.source_path) })
          .toEqual({ head, dirty: '', staged: '', files: [false, false], bound: [null, null] });
        rmSync(join(b.root, '.git', 'hooks', 'pre-commit'));
        const retry = await b.extract([], null);
        expect({ failed: retry.failed, paths: lastCommitPaths(b), dirty: dirty(b) })
          .toEqual({ failed: [], paths: atoms.map(a => relOf(a.slug)).sort(), dirty: '' });
      });
    }, 180_000);

    test('a crash between the file writes and the commit: the next run\'s batch commit sweeps the files it left', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        derivedWriteSeams.beforeCommit = () => { throw new Error('simulated crash before the batch commit'); };
        try {
          await b.extract(['Renders vs proof'], 'hash-one').catch(() => undefined);
        } finally {
          delete derivedWriteSeams.beforeCommit;
        }
        const [crashed] = (await b.atoms()).map(a => a.slug);
        expect({ file: existsSync(b.path(crashed!)), dirty: dirty(b) }).toEqual({ file: true, dirty: `?? ${relOf(crashed!)}` });
        await b.extract(['Founder lesson'], 'hash-two', '/fake/2026-09-08-meeting.txt');
        const slugs = (await b.atoms()).map(a => a.slug);
        expect(slugs).toContain(crashed!);
        expect({ dirty: dirty(b), paths: lastCommitPaths(b) }).toEqual({ dirty: '', paths: slugs.map(relOf).sort() });
      });
    }, 180_000);

    test('a refused commit never reverts a file another writer already committed with the batch\'s bytes', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        const mergeHead = join(b.root, '.git', 'MERGE_HEAD');
        derivedWriteSeams.beforeCommit = root => {
          writeFileSync(join(root, 'notes.md'), 'writer B\n');
          commitPathsLocked(root, ['notes.md'], 'writer B', { lockWaitMs: 5_000 });
          writeFileSync(mergeHead, `${b.git('rev-parse', 'HEAD')}\n`);
        };
        let phase: Awaited<ReturnType<Brain['extract']>>;
        try {
          phase = await b.extract(['Renders vs proof'], 'hash-one');
        } finally {
          delete derivedWriteSeams.beforeCommit;
          rmSync(mergeHead, { force: true });
        }
        const [atom] = await b.atoms();
        expect({ swept: lastCommitPaths(b), status: phase.status, failed: phase.failed, file: existsSync(b.path(atom!.slug)),
          bound: atom!.source_path !== null, dirty: dirty(b) })
          .toEqual({ swept: ['notes.md', relOf(atom!.slug)].sort(), status: 'ok', failed: [], file: true, bound: true, dirty: '' });
      });
    }, 180_000);

    test('a write root whose checkout lookup fails (unknown) is not committed into: its files stay and nothing rolls back', async () => {
      await withBrain(databaseUrl, 'plain', async b => {
        derivedWriteSeams.checkoutClass = () => 'unknown';
        let phase: Awaited<ReturnType<Brain['extract']>>;
        try {
          phase = await b.extract(['Renders vs proof'], 'hash-one');
        } finally {
          delete derivedWriteSeams.checkoutClass;
        }
        const [atom] = await b.atoms();
        expect({ status: phase.status, failed: phase.failed, file: existsSync(b.path(atom!.slug)), bound: atom!.source_path !== null })
          .toEqual({ status: 'ok', failed: [], file: true, bound: true });
      });
    }, 180_000);

    test('storage.db_only: atoms stay database-only and nothing is committed', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        writeFileSync(join(b.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - atoms/\n');
        b.git('add', 'gbrain.yml');
        b.git('commit', '-qm', 'storage tiers');
        const head = b.git('rev-parse', 'HEAD');
        const phase = await b.extract(['Renders vs proof'], 'hash-one');
        expect(await b.atoms()).toHaveLength(1);
        expect({ status: phase.status, head: b.git('rev-parse', 'HEAD'), dirty: dirty(b), files: filesUnder(join(b.root, 'atoms')) })
          .toEqual({ status: 'ok', head, dirty: '', files: [] });
      });
    }, 180_000);

    test('repo-less source (no local_path): atoms stay in the database, no file is written, nothing is reported', async () => {
      await withBrain(databaseUrl, 'none', async b => {
        const phase = await b.extract(['Renders vs proof', 'Founder lesson'], 'hash-one');
        const atoms = await b.atoms();
        expect({ status: phase.status, failed: phase.failed, atoms: atoms.length, bound: atoms.map(a => a.source_path), files: filesUnder(b.root) })
          .toEqual({ status: 'ok', failed: [], atoms: 2, bound: [null, null], files: [] });
      });
    }, 180_000);

    test('a local_path that is not a Git checkout keeps its files (there is no commit to make)', async () => {
      await withBrain(databaseUrl, 'plain', async b => {
        const phase = await b.extract(['Renders vs proof'], 'hash-one');
        const [atom] = await b.atoms();
        expect({ status: phase.status, failed: phase.failed, file: existsSync(b.path(atom!.slug)) }).toEqual({ status: 'ok', failed: [], file: true });
      });
    }, 180_000);

    test('synthesize_concepts: a concept file write is committed, and so is a rewrite of the tracked concept file', async () => {
      await withBrain(databaseUrl, 'git', async b => {
        const atoms = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `atoms/a${i}`, title: `A${i}`, body: `b${i}`, concept_refs: ['flywheel'], visibility: 'world' as const }));
        await b.engine.setConfig('cycle.synthesize_concepts.write_through', 'true');
        await runPhaseSynthesizeConcepts(b.engine, { _atoms: atoms(2), sourceId: 'default' });
        expect({ paths: lastCommitPaths(b), dirty: dirty(b) }).toEqual({ paths: ['concepts/flywheel.md'], dirty: '' });
        await b.engine.setConfig('cycle.synthesize_concepts.write_through', 'false');
        const before = commitCount(b);
        await runPhaseSynthesizeConcepts(b.engine, { _atoms: atoms(3), sourceId: 'default' });
        expect({ commits: commitCount(b) - before, paths: lastCommitPaths(b), dirty: dirty(b),
          body: b.git('show', 'HEAD:concepts/flywheel.md').includes('3 atoms reference this.') })
          .toEqual({ commits: 1, paths: ['concepts/flywheel.md'], dirty: '', body: true });
      });
    }, 180_000);
  });
}
