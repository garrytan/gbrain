/**
 * BrainEngine parity — a whole `performSync` run on a fixture Git repository: first sync, an incremental sync that
 * adds, modifies and deletes files, and a sync with nothing new.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the sync result (status, commits, counts, affected pages, size states), the pages it leaves and the
 *    source's sync anchor are the same on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts).
 *  - Regression: an engine that does not advance the sync anchor (sources.last_commit) makes every later sync diff from
 *    the old commit; an engine that cannot read the stale-page reconcile or the size states stops the run. The Rust
 *    engine has no SQL, so every statement the run reaches has to exist as a typed member (a caught raw-SQL refusal on
 *    the way fails the Rust arm too).
 *  - Why existing coverage misses it: the sync tests run on PGLite and Postgres only, and the member parity cases
 *    check one member each, not the run that chains them.
 *  - Seam: the Postgres arm imports with one worker (its workers' own connections cannot see the per-test schema);
 *    nothing else in the run. The source row is made by harness.ts behind the backend switch; commits use fixed
 *    author and committer dates, so the commit ids are the same on every arm.
 */
import { afterAll, describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { performSync } from '../../src/commands/sync.ts';
import type { SyncResult } from '../../src/commands/sync.ts';

const { parityTest } = parityArms(testBackends());

const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

let tick = 0;
function git(cwd: string, ...args: string[]): string {
  const date = `2026-01-0${1 + (tick % 8)}T00:00:00Z`;
  return execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid', GIT_COMMITTER_NAME: 'Example',
      GIT_COMMITTER_EMAIL: 'example@example.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
}

function commit(root: string, message: string): string {
  tick++;
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  git(root, 'push', '-q', 'origin', 'main');
  return git(root, 'rev-parse', 'HEAD');
}

const note = (title: string, body: string, extra = '') => `---\ntitle: ${title}\ntype: note\n${extra}---\n${body}\n`;

/** The run's observable result, without timings and run ids. */
function view(result: SyncResult) {
  return {
    status: result.status, fromCommit: result.fromCommit, toCommit: result.toCommit,
    added: result.added, modified: result.modified, deleted: result.deleted, renamed: result.renamed,
    chunksCreated: result.chunksCreated, embedded: result.embedded, failedFiles: result.failedFiles ?? 0,
    pagesAffected: [...result.pagesAffected].sort(), size_states: result.size_states ?? null,
  };
}

describe('engine parity: a whole sync run', () => {
  parityTest('performSync gives the same first, incremental and up-to-date runs and advances the sync anchor', {
    methods: ['advanceSourceCommit', 'getSource', 'listSourcePathPages'],
    timeout: 120_000,
  }, async (engine, backend) => {
    tick = 0;
    const dir = mkdtempSync(join(tmpdir(), `gbrain-sync-parity-${backend}-`));
    scratch.push(dir);
    const home = join(dir, 'home'), origin = join(dir, 'origin.git'), root = join(dir, 'brain');
    mkdirSync(home);
    git(dir, 'init', '-q', '--bare', origin);
    git(dir, 'clone', '-q', origin, root);
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'a.md'), note('A', 'First note, linking [[notes/b]].'));
    writeFileSync(join(root, 'notes', 'b.md'), note('B', 'Second note.'));
    writeFileSync(join(root, 'notes', 'skip.md'), note('Skip', 'Kept out of embedding.', 'embed_skip: true\n'));
    const c1 = commit(root, 'seed');
    await createSource(engine, backend, 'notes', {}, root);
    return withEnv({ GBRAIN_HOME: home }, async () => {
      // A full sync on a non-PGLite engine imports with 4 workers. Postgres workers open their own connections, which
      // do not see this arm's per-test schema, so the Postgres arm imports with one worker. Rust keeps the 4 workers.
      // This is a limit of the test harness, not of the engine: this case does not cover a multi-worker Postgres import.
      const workers = backend === 'postgres' ? { concurrency: 1 } : {};
      const opts = { repoPath: root, sourceId: 'notes', noPull: true, noEmbed: true, noExtract: true, ...workers };
      const first = view(await performSync(engine, opts));
      const afterFirst = (await engine.getSource('notes'))?.last_commit ?? null;
      writeFileSync(join(root, 'notes', 'a.md'), note('A', 'First note, edited.'));
      rmSync(join(root, 'notes', 'b.md'));
      writeFileSync(join(root, 'notes', 'c.md'), note('C', 'Third note.'));
      const c2 = commit(root, 'edit');
      const second = view(await performSync(engine, opts));
      const afterSecond = (await engine.getSource('notes'))?.last_commit ?? null;
      const third = view(await performSync(engine, opts));
      const pages: Record<string, boolean> = {};
      for (const slug of ['notes/a', 'notes/b', 'notes/c', 'notes/skip']) pages[slug] = (await engine.getPage(slug, { sourceId: 'notes' })) !== null;
      const paths = (await engine.listSourcePathPages('notes')).sort((x, y) => Buffer.compare(Buffer.from(x.slug), Buffer.from(y.slug)));
      const seen = { first, second, third, anchors: { afterFirst: afterFirst === c1, afterSecond: afterSecond === c2 }, pages, paths };
      expect({ statuses: [first.status, second.status, third.status], anchors: seen.anchors })
        .toEqual({ statuses: ['first_sync', 'synced', 'up_to_date'], anchors: { afterFirst: true, afterSecond: true } });
      return seen;
    });
  });
});
