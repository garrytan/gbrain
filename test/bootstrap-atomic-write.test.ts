/**
 * atomic-write.ts — the ONE atomic config writer for bootstrap host surfaces.
 * Pins the symlink-preservation contract (live AND dangling links survive as
 * links; the write lands at the resolved target) plus the mode ladder:
 * forceMode > existing-file mode > freshMode.
 *
 * The dangling case is the red-team finding: existsSync FOLLOWS symlinks, so
 * a dangling link reads "absent" and a naive rename would replace the link
 * itself with a regular file — a dotfile-manager layout whose target was
 * cleaned up would silently stop being managed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteTextFile } from '../src/core/bootstrap/atomic-write.ts';
import { permsEnforced } from './helpers/fs-perms.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-atomic-write-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteTextFile — symlink preservation', () => {
  test('live symlink: write lands in the TARGET, the link survives as a link', () => {
    const target = join(dir, 'dotfiles', 'config.jsonc');
    mkdirSync(join(dir, 'dotfiles'), { recursive: true });
    writeFileSync(target, '{"old":true}');
    const link = join(dir, 'config.jsonc');
    symlinkSync(target, link);

    atomicWriteTextFile(link, '{"new":true}');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"new":true}');
    expect(readFileSync(link, 'utf8')).toBe('{"new":true}');
  });

  test('DANGLING symlink: the missing target is created (parent dir too) and the link survives', () => {
    const target = join(dir, 'dotfiles', 'nested', 'config.jsonc'); // dir does not exist either
    const link = join(dir, 'config.jsonc');
    symlinkSync(target, link);
    expect(existsSync(link)).toBe(false); // existsSync follows the link — the trap

    atomicWriteTextFile(link, '{"created":true}', { freshMode: 0o600 });

    expect(lstatSync(link).isSymbolicLink()).toBe(true); // NOT replaced by a regular file
    expect(readFileSync(target, 'utf8')).toBe('{"created":true}');
    expect(readFileSync(link, 'utf8')).toBe('{"created":true}');
    expect(statSync(target).mode & 0o777).toBe(0o600); // fresh target takes freshMode
  });

  test('DANGLING symlink with RELATIVE link text resolves against the link dir', () => {
    const link = join(dir, 'config.jsonc');
    symlinkSync(join('sub', 'real.jsonc'), link); // relative, target absent

    atomicWriteTextFile(link, 'relative-ok');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, 'sub', 'real.jsonc'), 'utf8')).toBe('relative-ok');
    expect(readFileSync(link, 'utf8')).toBe('relative-ok');
  });
});

describe('atomicWriteTextFile — mode ladder', () => {
  test('fresh file (ENOENT) takes freshMode', () => {
    const p = join(dir, 'fresh.json');
    atomicWriteTextFile(p, '{}', { freshMode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test('fresh file without freshMode gets the platform default (no chmod)', () => {
    const p = join(dir, 'fresh-default.json');
    atomicWriteTextFile(p, '{}');
    expect(existsSync(p)).toBe(true); // mode is umask-dependent; existence is the pin
  });

  test('forceMode overrides an existing file\'s looser mode', () => {
    const p = join(dir, 'secret.toml');
    writeFileSync(p, 'old');
    chmodSync(p, 0o644); // a known loose mode first
    atomicWriteTextFile(p, 'new', { forceMode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, 'utf8')).toBe('new');
  });

  test('existing file\'s own mode is inherited when neither force nor fresh applies', () => {
    const p = join(dir, 'keep-mode.json');
    writeFileSync(p, 'old');
    chmodSync(p, 0o640);
    atomicWriteTextFile(p, 'new', { freshMode: 0o600 }); // freshMode must NOT apply — the file exists
    expect(statSync(p).mode & 0o777).toBe(0o640);
    expect(readFileSync(p, 'utf8')).toBe('new');
  });
});

describe('atomicWriteTextFile — failure hygiene (no tmp litter)', () => {
  test('a failing rename does not leak the .tmp- file (target is a directory → rename throws)', () => {
    // The resolved target being a DIRECTORY makes writeFileSync of the tmp
    // succeed but renameSync(tmp, target) throw — the exact mid-sequence
    // failure shape (ENOSPC/EACCES class) that used to strand tmp litter
    // next to the user's config.
    const target = join(dir, 'config.jsonc');
    mkdirSync(target, { recursive: true });
    expect(() => atomicWriteTextFile(target, '{"x":1}')).toThrow();
    const litter = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    expect(litter).toEqual([]);
    expect(lstatSync(target).isDirectory()).toBe(true); // target untouched
  });

  // skipIf: asserts a write MUST fail on a 0555 dir — unrunnable on hosts
  // that don't enforce permission bits (FUSE/overlay sandboxes, root).
  test.skipIf(!permsEnforced())('a failing write in a read-only dir throws without leaving litter behind', () => {
    if (process.getuid?.() === 0) return; // root ignores modes
    const ro = join(dir, 'ro');
    mkdirSync(ro, { recursive: true });
    writeFileSync(join(ro, 'config.jsonc'), 'old');
    chmodSync(ro, 0o500);
    try {
      expect(() => atomicWriteTextFile(join(ro, 'config.jsonc'), 'new')).toThrow();
    } finally {
      chmodSync(ro, 0o700);
    }
    const litter = readdirSync(ro).filter((n) => n.includes('.tmp-'));
    expect(litter).toEqual([]);
    expect(readFileSync(join(ro, 'config.jsonc'), 'utf8')).toBe('old'); // original intact
  });
});
