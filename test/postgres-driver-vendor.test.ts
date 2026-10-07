import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import postgres from '#postgres';
import pkg from '../package.json';

describe('vendored Postgres driver packaging', () => {
  test('all supported imports use checked-in source, not node_modules patch installation', () => {
    expect(pkg.imports['#postgres']).toEqual({
      types: './vendor/postgres/types/index.d.ts',
      require: './vendor/postgres/cjs/src/index.js',
      default: './vendor/postgres/src/index.js',
    });
    expect('postgres' in pkg.dependencies).toBe(false);
    expect('patchedDependencies' in pkg).toBe(false);
    expect(import.meta.resolve('#postgres')).toContain('/vendor/postgres/src/index.js');
    expect(createRequire(import.meta.url).resolve('#postgres')).toContain('/vendor/postgres/cjs/src/index.js');
    expect(typeof postgres).toBe('function');
    expect(typeof createRequire(import.meta.url)('#postgres')).toBe('function');
  });

  test('preserves pinned upstream metadata and actual license', () => {
    const upstream = JSON.parse(readFileSync(new URL('../vendor/postgres/package.json', import.meta.url), 'utf8'));
    expect(upstream.name).toBe('postgres');
    expect(upstream.version).toBe('3.4.9');
    expect(upstream.license).toBe('Unlicense');
    expect(readFileSync(new URL('../vendor/postgres/UNLICENSE', import.meta.url), 'utf8')).toContain('free and unencumbered software');
  });

  test('all shipped runtime exports carry the cancellation ownership patch', () => {
    for (const path of ['src', 'cjs/src', 'cf/src']) {
      const index = readFileSync(new URL(`../vendor/postgres/${path}/index.js`, import.meta.url), 'utf8');
      expect(index).toContain('async function reserve({ signal } = {})');
      expect(index).toContain('sql.discard = reservation.discard');
      expect(index).toContain('completed.cancelPromise');
      expect(index).toContain('return poisoned(c)');
      expect(index).toContain('cancelActive(query, resolve, reject, Math.min(delay * 2, 1000))');
    }
  });
});
