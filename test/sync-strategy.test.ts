import { describe, test, expect } from 'bun:test';
import { isSyncable, isCodeFilePath, slugifyCodePath, pathToSlug } from '../src/core/sync.ts';

describe('isCodeFilePath', () => {
  test('recognizes common code extensions', () => {
    expect(isCodeFilePath('src/foo.ts')).toBe(true);
    expect(isCodeFilePath('app/foo.tsx')).toBe(true);
    expect(isCodeFilePath('lib/bar.js')).toBe(true);
    expect(isCodeFilePath('Foo.jsx')).toBe(true);
    expect(isCodeFilePath('bundle.mjs')).toBe(true);
    expect(isCodeFilePath('legacy.cjs')).toBe(true);
    expect(isCodeFilePath('script.py')).toBe(true);
    expect(isCodeFilePath('class.rb')).toBe(true);
    expect(isCodeFilePath('main.go')).toBe(true);
  });

  test('rejects non-code extensions', () => {
    expect(isCodeFilePath('notes.md')).toBe(false);
    expect(isCodeFilePath('photo.jpg')).toBe(false);
    expect(isCodeFilePath('README')).toBe(false);
    // v0.20.0 Cathedral II Layer 2 widens the classifier to include
    // config formats (.json, .yaml, .toml) and web formats (.css, .html,
    // .vue) because the chunker supports them — they were dropped by the
    // 9-extension v0.19.0 allowlist. `.json` is NO LONGER rejected.
    expect(isCodeFilePath('image.svg')).toBe(false);
    expect(isCodeFilePath('archive.zip')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isCodeFilePath('Foo.TS')).toBe(true);
    expect(isCodeFilePath('Main.GO')).toBe(true);
  });
});

describe('isSyncable with strategy', () => {
  test('default strategy (markdown) behaves as before — only .md/.mdx', () => {
    expect(isSyncable('people/alice.md')).toBe(true);
    expect(isSyncable('docs/guide.mdx')).toBe(true);
    expect(isSyncable('src/foo.ts')).toBe(false);
  });

  test('strategy=code allows ts/tsx/js/py/rb/go, rejects markdown', () => {
    expect(isSyncable('src/foo.ts', { strategy: 'code' })).toBe(true);
    expect(isSyncable('src/foo.py', { strategy: 'code' })).toBe(true);
    expect(isSyncable('src/foo.go', { strategy: 'code' })).toBe(true);
    expect(isSyncable('notes.md', { strategy: 'code' })).toBe(false);
  });

  test('strategy=auto accepts both markdown and code', () => {
    expect(isSyncable('notes.md', { strategy: 'auto' })).toBe(true);
    expect(isSyncable('src/foo.ts', { strategy: 'auto' })).toBe(true);
  });

  test('existing skip rules apply across all strategies', () => {
    // Hidden directories are always skipped
    expect(isSyncable('.git/config.js', { strategy: 'code' })).toBe(false);
    // README.md is skipped under markdown
    expect(isSyncable('README.md', { strategy: 'markdown' })).toBe(false);
    // ops/ directory always skipped
    expect(isSyncable('ops/migrate.py', { strategy: 'code' })).toBe(false);
    // .raw/ sidecar always skipped
    expect(isSyncable('dir/.raw/code.ts', { strategy: 'code' })).toBe(false);
  });

  test('include globs whitelist specific patterns', () => {
    expect(isSyncable('src/foo.ts', { strategy: 'code', include: ['src/**/*.ts'] })).toBe(true);
    expect(isSyncable('lib/bar.ts', { strategy: 'code', include: ['src/**/*.ts'] })).toBe(false);
    expect(isSyncable('src/foo.py', { strategy: 'code', include: ['src/**/*.ts'] })).toBe(false);
  });

  test('exclude globs blacklist specific patterns', () => {
    expect(isSyncable('src/foo.ts', { strategy: 'code', exclude: ['**/*.test.ts'] })).toBe(true);
    expect(isSyncable('test/foo.test.ts', { strategy: 'code', exclude: ['**/*.test.ts'] })).toBe(false);
  });

  test('include + exclude compose (include first, then exclude)', () => {
    expect(
      isSyncable('src/foo.ts', {
        strategy: 'code',
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts'],
      }),
    ).toBe(true);
    expect(
      isSyncable('src/foo.test.ts', {
        strategy: 'code',
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts'],
      }),
    ).toBe(false);
  });
});

describe('slugifyCodePath', () => {
  test('flattens path with hyphens and replaces dots', () => {
    expect(slugifyCodePath('src/core/chunkers/code.ts')).toBe('src-core-chunkers-code-ts');
    expect(slugifyCodePath('app/models/user.rb')).toBe('app-models-user-rb');
    expect(slugifyCodePath('lib/foo/bar/baz.go')).toBe('lib-foo-bar-baz-go');
  });

  test('drops leading ./', () => {
    expect(slugifyCodePath('./src/foo.ts')).toBe('src-foo-ts');
  });

  test('lowercases', () => {
    expect(slugifyCodePath('Src/Foo.TS')).toBe('src-foo-ts');
  });
});

describe('pathToSlug with pageKind', () => {
  test('pageKind=markdown (default) uses slugifyPath', () => {
    expect(pathToSlug('people/alice-smith.md')).toBe('people/alice-smith');
    expect(pathToSlug('docs/guide.md', undefined, { pageKind: 'markdown' })).toBe('docs/guide');
  });

  test('pageKind=code uses slugifyCodePath (flattened)', () => {
    expect(pathToSlug('src/core/sync.ts', undefined, { pageKind: 'code' })).toBe('src-core-sync-ts');
  });

  test('repoPrefix is prepended (markdown and code)', () => {
    expect(pathToSlug('guides/foo.md', 'gbrain')).toBe('gbrain/guides/foo');
    expect(pathToSlug('src/foo.ts', 'gbrain', { pageKind: 'code' })).toBe('gbrain/src-foo-ts');
  });
});
