import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;

for (const workflow of ['test.yml', 'e2e.yml', 'release.yml']) {
  test(`${workflow} pins the Bun toolchain`, () => {
    const source = readFileSync(join(repoRoot, '.github', 'workflows', workflow), 'utf-8');

    expect(source).not.toContain('bun-version: latest');
    expect(source).toContain('bun-version: 1.3.12');
  });
}

test('release workflow typechecks before publishing binaries', () => {
  const source = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf-8');

  expect(source).toContain('name: Typecheck');
  expect(source).toContain('bunx tsc --noEmit --pretty false');
});
