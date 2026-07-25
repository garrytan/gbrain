import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitSourceGit, initializeSourceGit, isSourceGitRepository } from '../src/core/source-git.ts';

const temporaryDirectories: string[] = [];

function makeSourceDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pmbrain-source-git-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Source Git version control', () => {
  test('creates a repository without committing source files', () => {
    const directory = makeSourceDirectory();
    writeFileSync(join(directory, 'note.md'), '# Note\n');

    const result = initializeSourceGit(directory);

    expect(result.created).toBe(true);
    expect(isSourceGitRepository(directory)).toBe(true);
    expect(commitSourceGit(directory, 'First version')).toMatchObject({
      committed: true,
      changedFiles: 1,
      message: 'First version',
    });
  });

  test('commits all changes and reports a no-op when the tree is clean', () => {
    const directory = makeSourceDirectory();
    initializeSourceGit(directory);
    writeFileSync(join(directory, 'first.md'), 'one\n');
    const first = commitSourceGit(directory, 'Initial');
    writeFileSync(join(directory, 'second.md'), 'two\n');
    const second = commitSourceGit(directory, 'Add second');
    const clean = commitSourceGit(directory, 'Nothing');

    expect(first.shortCommit).toHaveLength(8);
    expect(second.committed).toBe(true);
    expect(second.commit).not.toBe(first.commit);
    expect(clean).toMatchObject({ committed: false, changedFiles: 0, commit: null });
  });

  test('requires explicit initialization and bounds commit messages', () => {
    const directory = makeSourceDirectory();
    expect(() => commitSourceGit(directory, 'No repository')).toThrow('not a Git repository');
    initializeSourceGit(directory);
    writeFileSync(join(directory, 'note.md'), 'content\n');
    expect(() => commitSourceGit(directory, 'x'.repeat(201))).toThrow('cannot exceed 200');
  });
});
