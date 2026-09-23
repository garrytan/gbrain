import { describe, expect, test } from 'bun:test';
import { formatDiscoverGitRootError } from '../src/core/sync-git.ts';

describe('discoverGitRoot error classification', () => {
  test('ENOENT git spawn is reported as an execution failure, not a non-repository', () => {
    const message = formatDiscoverGitRootError('/vault', { code: 'ENOENT', message: 'spawn git ENOENT' });
    expect(message).toContain('Could not run git');
    expect(message).toContain('ENOENT');
    expect(message).not.toContain('Not inside a git repository');
  });

  test('EACCES cwd/spawn shape is reported honestly', () => {
    const message = formatDiscoverGitRootError('/vault', { code: 'EACCES', message: 'permission denied' });
    expect(message).toContain('Could not run git');
    expect(message).toContain('EACCES');
  });

  test('genuine git not-a-repository exit keeps the friendly guidance', () => {
    const message = formatDiscoverGitRootError('/vault', {
      status: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    expect(message).toContain('Not inside a git repository');
  });
});
