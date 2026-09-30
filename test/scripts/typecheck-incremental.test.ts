import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pkg from '../../package.json';

const tsc = resolve(import.meta.dir, '../../node_modules/typescript/bin/tsc');
const [command, ...args] = pkg.scripts.typecheck.split(/\s+/);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, file: string, content: string) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(source = 'export const answer: number = 42;\n', strict = true) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-typecheck-'));
  roots.push(root);
  write(root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: {
    target: 'ESNext', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES5'],
    types: [], strict, skipLibCheck: true, noEmit: true,
  } }));
  write(root, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json', include: ['src'] }));
  write(root, 'src/main.ts', source);
  return root;
}

function check(root: string) {
  expect(command).toBe('tsc');
  const result = spawnSync(Bun.which('node') ?? process.execPath, [tsc, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(existsSync(join(root, 'node_modules/.cache/gbrain-typecheck.tsbuildinfo'))).toBe(true);
  return { status: result.status ?? -1, output: result.stdout + result.stderr };
}

function rejects(root: string, code: string) {
  const result = check(root);
  expect([1, 2]).toContain(result.status);
  expect(result.output).toContain(code);
  return result.output;
}

describe('native incremental typecheck', () => {
  test('reuses compiler state without hiding edited-source or newly added-file errors', () => {
    const root = fixture();
    expect(check(root).status).toBe(0);
    expect(check(root).status).toBe(0);
    expect(readdirSync(join(root, 'src'))).toEqual(['main.ts']);

    write(root, 'src/main.ts', 'export const answer: string = 42;\n');
    const first = rejects(root, 'TS2322');
    expect(rejects(root, 'TS2322')).toEqual(first);
    write(root, 'src/main.ts', 'export const answer: number = 42;\n');
    expect(check(root).status).toBe(0);

    write(root, 'src/extra.ts', 'export const extra: string = 42;\n');
    rejects(root, 'TS2322');
    rmSync(join(root, 'src/extra.ts'));
    expect(check(root).status).toBe(0);
  });

  test('invalidates inherited compiler options and the configured root file set', () => {
    const root = fixture('export function identity(value) { return value; }\n', false);
    expect(check(root).status).toBe(0);
    const basePath = join(root, 'tsconfig.base.json');
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    base.compilerOptions.strict = true;
    writeFileSync(basePath, JSON.stringify(base));
    const first = rejects(root, 'TS7006');
    expect(rejects(root, 'TS7006')).toEqual(first);
    base.compilerOptions.strict = false;
    writeFileSync(basePath, JSON.stringify(base));
    expect(check(root).status).toBe(0);

    write(root, 'extra/more.ts', 'export const more: string = 42;\n');
    expect(check(root).status).toBe(0);
    write(root, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json', include: ['src', 'extra'] }));
    rejects(root, 'TS2322');
    write(root, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json', include: ['src'] }));
    expect(check(root).status).toBe(0);
  });

  test('invalidates dependency contents and package type-entry changes', () => {
    const root = fixture('import type { Value } from "fixture-dep";\nexport const answer: Value = 42;\n');
    const dependency = 'node_modules/fixture-dep';
    const manifest = { name: 'fixture-dep', version: '1.0.0', types: 'index.d.ts' };
    write(root, `${dependency}/package.json`, JSON.stringify(manifest));
    write(root, `${dependency}/index.d.ts`, 'export type Value = number;\n');
    expect(check(root).status).toBe(0);

    const declaration = join(root, dependency, 'index.d.ts');
    const previous = statSync(declaration);
    writeFileSync(declaration, 'export type Value = string;\n');
    utimesSync(declaration, previous.atime, previous.mtime);
    const first = rejects(root, 'TS2322');
    expect(rejects(root, 'TS2322')).toEqual(first);
    writeFileSync(declaration, 'export type Value = number;\n');
    expect(check(root).status).toBe(0);

    write(root, `${dependency}/other.d.ts`, 'export type Value = string;\n');
    write(root, `${dependency}/package.json`, JSON.stringify({ ...manifest, types: 'other.d.ts' }));
    rejects(root, 'TS2322');
    write(root, `${dependency}/package.json`, JSON.stringify(manifest));
    expect(check(root).status).toBe(0);
  });

  test('does not turn cached diagnostics, incompatible state, or malformed state into success', () => {
    const root = fixture('export const answer: string = 42;\n');
    const first = rejects(root, 'TS2322');
    expect(rejects(root, 'TS2322')).toEqual(first);
    const cache = join(root, 'node_modules/.cache/gbrain-typecheck.tsbuildinfo');
    const info = JSON.parse(readFileSync(cache, 'utf8'));
    info.version = '0.0.0-incompatible';
    writeFileSync(cache, JSON.stringify(info));
    expect(rejects(root, 'TS2322')).toEqual(first);
    writeFileSync(cache, '{');
    expect(rejects(root, 'TS2322')).toEqual(first);
    write(root, 'src/main.ts', 'export const answer: number = 42;\n');
    expect(check(root).status).toBe(0);
  });
});
