import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

function topChangelogVersion(): string {
  const match = read('CHANGELOG.md').match(/^## \[([^\]]+)]/m);
  if (!match) throw new Error('CHANGELOG.md has no release header');
  return match[1];
}

describe('release contract', () => {
  test('upstream release metadata agrees', () => {
    const version = read('VERSION').trim();
    const packageVersion = JSON.parse(read('package.json')).version;
    const lock = Bun.JSONC.parse(read('bun.lock')) as {
      workspaces: { '': { version?: string } };
    };
    const lockVersion = lock.workspaces[''].version;

    expect(version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(packageVersion).toBe(version);
    expect(lockVersion).toBe(version);
    expect(topChangelogVersion()).toBe(version);
  });
});
