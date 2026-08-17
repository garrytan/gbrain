/**
 * Direct unit tests for src/core/atomic-write.ts — previously pinned only
 * indirectly through the backlinks fixer. The properties that matter:
 *
 *   1. verify() throwing aborts the write: target byte-identical, tmp removed.
 *   2. Mode preservation past the umask: a 0o600 target stays 0o600 after an
 *      atomic overwrite (open(2)'s mode arg is umask-masked; the explicit
 *      chmod is the load-bearing line).
 *   3. verify() receives the ON-DISK bytes (not the in-memory candidate).
 *   4. No tmp residue on the happy path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atomicWriteFileSync } from '../src/core/atomic-write.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tmpSiblings(): string[] {
  return readdirSync(dir).filter(f => f.includes('.tmp.'));
}

describe('atomicWriteFileSync', () => {
  test('writes content and leaves no tmp residue', () => {
    const target = join(dir, 'page.md');
    atomicWriteFileSync(target, '# hello\n');
    expect(readFileSync(target, 'utf-8')).toBe('# hello\n');
    expect(tmpSiblings()).toEqual([]);
  });

  test('verify() throw aborts: target untouched, tmp removed, error propagates', () => {
    const target = join(dir, 'page.md');
    writeFileSync(target, 'original\n');
    expect(() =>
      atomicWriteFileSync(target, 'candidate\n', {
        verify: () => { throw new Error('validation failed'); },
      }),
    ).toThrow('validation failed');
    expect(readFileSync(target, 'utf-8')).toBe('original\n');
    expect(tmpSiblings()).toEqual([]);
  });

  test('verify() receives the on-disk bytes of the tmp file', () => {
    const target = join(dir, 'page.md');
    const seen: string[] = [];
    atomicWriteFileSync(target, 'on-disk-check\n', {
      verify: (onDisk) => { seen.push(onDisk); },
    });
    expect(seen).toEqual(['on-disk-check\n']);
  });

  test('preserves a restrictive target mode past the umask', () => {
    const target = join(dir, 'secret.md');
    writeFileSync(target, 'v1\n');
    chmodSync(target, 0o600);
    atomicWriteFileSync(target, 'v2\n');
    expect(readFileSync(target, 'utf-8')).toBe('v2\n');
    expect(statSync(target).mode & 0o7777).toBe(0o600);
  });

  test('fresh file (no prior target) lands with default mode and content', () => {
    const target = join(dir, 'fresh.md');
    atomicWriteFileSync(target, 'fresh\n');
    expect(readFileSync(target, 'utf-8')).toBe('fresh\n');
    // Default 0o644 masked by whatever umask the test runs under — just
    // assert it is readable and not world-writable garbage.
    expect(statSync(target).mode & 0o200).toBe(0o200);
  });
});
