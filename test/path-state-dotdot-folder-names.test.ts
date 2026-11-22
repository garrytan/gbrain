/**
 * Two Git path-state probes judged a file "outside the checkout" when `relative(checkout, file)` started with `..`, which
 * also matches a legal first folder named `..drafts`:
 *  - `gitPathState` (fact fence write-through) answered 'unknown', so the fence commit was skipped and audited as
 *    `git_durability_prewrite_state_unknown`;
 *  - `canonicalDeletionState` (file-drift repair) answered 'unknown', so a page whose file was deleted from such a
 *    folder could not be told apart from one that was never committed.
 * Protects: files under `..drafts` get the same answers as files under `notes` (clean / self_dirty / foreign_dirty;
 * in_head / gone), and paths that really leave the checkout (outside, a sibling that shares the checkout's name prefix,
 * `../x`, a symlinked folder that points out) are still 'unknown'.
 * Authoring gate: (1) the answers of the two exported probes; (2) a startsWith('..') check that is not component-aware;
 * (3) no existing test calls either probe with such a folder; (4) no seam, real git repositories in a temp directory.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitPathState } from '../src/core/facts/fence-write.ts';
import { canonicalDeletionState } from '../src/core/persistence/reconcile-state.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-path-state-dotdot-')));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
let n = 0;

/** A checkout `work` (committed `<folder>/a.md`, `<folder>/b.md`), a sibling `work2` that shares its name prefix, and `outside`. */
function fixture(folder: string) {
  const base = join(dir, `case-${n++}`), work = join(base, 'work'), work2 = join(base, 'work2'), outside = join(base, 'outside');
  for (const d of [work, work2, outside]) mkdirSync(d, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'writer@example.invalid']); git(work, ['config', 'user.name', 'Example Writer']); git(work, ['config', 'commit.gpgsign', 'false']);
  write(work, `${folder}/a.md`, 'a\n'); write(work, `${folder}/b.md`, 'b\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'seed']);
  write(work2, 'a.md', 'sibling\n'); write(outside, 'a.md', 'outside\n');
  symlinkSync(outside, join(work, 'linked'));
  return { work, work2, outside };
}

for (const folder of ['..drafts', 'notes']) {
  test(`gitPathState: a file under ${folder} is clean, then self_dirty once edited`, () => {
    const { work } = fixture(folder);
    const a = join(work, folder, 'a.md');
    expect(gitPathState(work, a)).toBe('clean');
    appendFileSync(a, 'edited\n');
    expect(gitPathState(work, a)).toBe('self_dirty');
    appendFileSync(join(work, folder, 'b.md'), 'edited\n');
    write(work, `${folder}/c.md`, 'new\n');
    expect(gitPathState(work, a)).toBe('self_dirty');
    // The probe is limited to the target path, so a sibling's dirt does not change the answer for another file.
    expect(gitPathState(work, join(work, folder, 'b.md'))).toBe('self_dirty');
  });

  test(`canonicalDeletionState: a file deleted from ${folder} is in_head when committed and gone when never committed`, () => {
    const { work } = fixture(folder);
    rmSync(join(work, folder, 'a.md'));
    expect(canonicalDeletionState(work, join(work, folder, 'a.md'))).toBe('in_head');
    expect(canonicalDeletionState(work, join(work, folder, 'never.md'))).toBe('gone');
  });
}

test('both probes still answer unknown for a path that leaves the checkout (and the symlink case for the deletion probe)', () => {
  const { work, work2, outside } = fixture('..drafts');
  const leaving = [join(outside, 'a.md'), join(work2, 'a.md'), join(work, '..', 'outside', 'a.md'), join(work, '..', 'work2', 'a.md'), join(work, '..')];
  for (const path of leaving) {
    expect(`${path}: ${gitPathState(work, path)}`).toBe(`${path}: unknown`);
    expect(`${path}: ${canonicalDeletionState(work, path)}`).toBe(`${path}: unknown`);
  }
  // A symlinked folder that points out: canonicalDeletionState resolves it and refuses. (gitPathState does not resolve
  // symlinks and answers from git alone; that is separate from this bug and is not asserted here.)
  expect(canonicalDeletionState(work, join(work, 'linked', 'a.md'))).toBe('unknown');
});
