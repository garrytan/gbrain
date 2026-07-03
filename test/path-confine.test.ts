/**
 * Security tests for the shared path-confinement + dotfile-trust helpers
 * (src/core/path-confine.ts) and their integration into the source / brain
 * resolvers and the skills-dir auto-detector.
 *
 * Threat model: a multi-user POSIX host where an attacker can write into a
 * shared ancestor directory of the victim's CWD. The hardening must refuse a
 * routing dotfile (`.gbrain-source` / `.gbrain-mount`) the victim doesn't own,
 * and refuse a `skills/` directory that escapes its declared workspace via
 * symlink. (#418 / #419, codex #9)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync,
  lstatSync, type Stats,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isTrustedDotfile, isPathContained, realpathOrResolve, isWriteTargetContained,
} from '../src/core/path-confine.ts';
import { validateSlug } from '../src/core/utils.ts';
import { resolveSourceId } from '../src/core/source-resolver.ts';
import { resolveBrainId } from '../src/core/brain-resolver.ts';
import { HOST_BRAIN_ID } from '../src/core/brain-registry.ts';
import { autoDetectSkillsDir } from '../src/core/repo-root.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ── helpers ────────────────────────────────────────────────

const created: string[] = [];
function scratch(prefix = 'path-confine-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fakeStats(opts: { uid: number; mode: number; symlink?: boolean }): Stats {
  return {
    uid: opts.uid,
    mode: opts.mode,
    isSymbolicLink: () => opts.symlink === true,
  } as unknown as Stats;
}

/** Stub engine for resolveSourceId: registers `ids`, no local_paths, no default. */
function stubEngine(ids: string[]): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const t = params?.[0];
        return (ids.includes(t as string) ? [{ id: t } as unknown as T] : []);
      }
      if (sql.includes('SELECT id, local_path FROM sources')) return [] as unknown as T[];
      return [] as unknown as T[];
    },
    getConfig: async () => null,
  } as unknown as BrainEngine;
}

// ── isTrustedDotfile (synthetic Stats — precise branch coverage) ──

describe('isTrustedDotfile', () => {
  const realGetuid = process.getuid;
  beforeEach(() => { (process as { getuid?: () => number }).getuid = () => 1000; });
  afterEach(() => { (process as { getuid?: () => number }).getuid = realGetuid; });

  test('own, not world-writable, not symlink → trusted', () => {
    expect(isTrustedDotfile(fakeStats({ uid: 1000, mode: 0o644 }))).toBe(true);
  });
  test('foreign-owned → NOT trusted', () => {
    expect(isTrustedDotfile(fakeStats({ uid: 2000, mode: 0o644 }))).toBe(false);
  });
  test('root-owned → trusted (root-as-root allowance)', () => {
    expect(isTrustedDotfile(fakeStats({ uid: 0, mode: 0o644 }))).toBe(true);
  });
  test('world-writable, even when owned → NOT trusted', () => {
    expect(isTrustedDotfile(fakeStats({ uid: 1000, mode: 0o666 }))).toBe(false);
  });
  test('symlink → NOT trusted regardless of ownership', () => {
    expect(isTrustedDotfile(fakeStats({ uid: 1000, mode: 0o644, symlink: true }))).toBe(false);
  });
  test('no getuid (Windows) → trusted by default', () => {
    (process as { getuid?: () => number }).getuid = undefined;
    expect(isTrustedDotfile(fakeStats({ uid: 2000, mode: 0o666 }))).toBe(true);
  });
});

describe('isTrustedDotfile — real fs (lstat)', () => {
  test('a real owned file is trusted; a symlink and a world-writable file are not', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    const dir = scratch();
    const ownFile = join(dir, 'own');
    writeFileSync(ownFile, 'x');
    expect(isTrustedDotfile(lstatSync(ownFile))).toBe(true);

    const link = join(dir, 'link');
    symlinkSync(ownFile, link);
    expect(isTrustedDotfile(lstatSync(link))).toBe(false);

    const ww = join(dir, 'ww');
    writeFileSync(ww, 'x');
    chmodSync(ww, 0o666);
    expect(isTrustedDotfile(lstatSync(ww))).toBe(false);
  });
});

// ── isPathContained + realpathOrResolve ────────────────────

describe('isPathContained', () => {
  test('real subdir is contained', () => {
    const dir = scratch();
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    expect(isPathContained(sub, dir)).toBe(true);
  });
  test('symlink escaping the parent is NOT contained', () => {
    const dir = scratch();
    const outside = scratch('pc-outside-');
    const link = join(dir, 'escape');
    symlinkSync(outside, link);
    expect(isPathContained(link, dir)).toBe(false);
  });
  test('symlink resolving INSIDE the parent IS contained', () => {
    const dir = scratch();
    const real = join(dir, 'real');
    mkdirSync(real);
    const link = join(dir, 'inlink');
    symlinkSync(real, link);
    expect(isPathContained(link, dir)).toBe(true);
  });
  test('missing path → not contained (fail-closed)', () => {
    const dir = scratch();
    expect(isPathContained(join(dir, 'nope'), dir)).toBe(false);
  });
  test('sibling prefix does not match (/foo vs /foobar)', () => {
    const base = scratch();
    const foo = join(base, 'foo'); const foobar = join(base, 'foobar');
    mkdirSync(foo); mkdirSync(foobar);
    expect(isPathContained(foobar, foo)).toBe(false);
  });
});

describe('realpathOrResolve', () => {
  test('resolves a symlink to its real target', () => {
    const dir = scratch();
    const real = join(dir, 'real'); mkdirSync(real);
    const link = join(dir, 'link'); symlinkSync(real, link);
    expect(realpathOrResolve(link)).toBe(realpathOrResolve(real));
  });
  test('nonexistent path → lexical resolve (does not throw)', () => {
    const p = join(scratch(), 'does', 'not', 'exist');
    expect(realpathOrResolve(p)).toBe(p);
  });
});

// ── validateSlug dangerous-char hardening (#1647-slug / codex #6) ──

describe('validateSlug — dangerous-char guard', () => {
  test('allows legitimate slugs (lowercase, unicode, dot, underscore, CJK, nested)', () => {
    for (const ok of ['notes/2026', 'münchen', 'my_notes', 'a-b/c-d', '会议/纪要', 'readme.v2', 'Mixed-Case']) {
      expect(() => validateSlug(ok)).not.toThrow();
    }
  });
  test('rejects path traversal and leading slash (existing behavior preserved)', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', '/abs/path', '']) {
      expect(() => validateSlug(bad)).toThrow();
    }
  });
  test('rejects NUL / control bytes', () => {
    expect(() => validateSlug("a" + String.fromCharCode(0x00) + "b")).toThrow(/control/);
    expect(() => validateSlug("a" + String.fromCharCode(0x1f) + "b")).toThrow(/control/);
  });
  test('rejects Unicode bidirectional / RTL overrides', () => {
    expect(() => validateSlug("a" + String.fromCharCode(0x202e) + "b")).toThrow(/bidirectional|RTL/);
    expect(() => validateSlug("a" + String.fromCharCode(0x2066) + "b")).toThrow(/bidirectional|RTL/);
  });
  test('rejects backslashes', () => {
    expect(() => validateSlug('a\\b')).toThrow(/[Bb]ackslash/);
  });
  test('rejects URL-encoded path separators / traversal', () => {
    for (const bad of ['a%2e%2e/b', 'a%2fb', 'a%5cb', 'A%2E%2Eb']) {
      expect(() => validateSlug(bad)).toThrow(/URL-encoded/);
    }
  });
});

// ── isWriteTargetContained (write-through FS sink) ──────────

describe('isWriteTargetContained', () => {
  test('a new file directly under root is contained', () => {
    const root = scratch();
    expect(isWriteTargetContained(join(root, 'page.md'), root)).toBe(true);
  });
  test('a new file in a new nested dir under root is contained', () => {
    const root = scratch();
    expect(isWriteTargetContained(join(root, 'sub', 'deep', 'page.md'), root)).toBe(true);
  });
  test('a ../ escape is refused', () => {
    const root = scratch();
    expect(isWriteTargetContained(join(root, '..', 'escape.md'), root)).toBe(false);
  });
  test('a symlinked intermediate dir escaping the root is refused', () => {
    if (typeof process.getuid !== 'function') return;
    const root = scratch();
    const outside = scratch('wt-outside-');
    symlinkSync(outside, join(root, 'link')); // root/link → outside
    // target lands under the escaping symlink → real path is outside root
    expect(isWriteTargetContained(join(root, 'link', 'page.md'), root)).toBe(false);
  });
  test('a symlinked intermediate dir staying inside the root is allowed', () => {
    const root = scratch();
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(isWriteTargetContained(join(root, 'link', 'page.md'), root)).toBe(true);
  });
});

// ── source-resolver integration (#418) ─────────────────────

describe('resolveSourceId — .gbrain-source dotfile trust', () => {
  test('trusted dotfile resolves to its id (control)', async () => {
    const dir = scratch();
    writeFileSync(join(dir, '.gbrain-source'), 'evil\n');
    expect(await resolveSourceId(stubEngine(['evil', 'default']), null, dir)).toBe('evil');
  });
  test('symlinked dotfile is REFUSED → falls through to default', async () => {
    if (typeof process.getuid !== 'function') return;
    const dir = scratch();
    const target = join(dir, 'target'); writeFileSync(target, 'evil\n');
    symlinkSync(target, join(dir, '.gbrain-source'));
    expect(await resolveSourceId(stubEngine(['evil', 'default']), null, dir)).toBe('default');
  });
  test('world-writable dotfile is REFUSED → falls through to default', async () => {
    if (typeof process.getuid !== 'function') return;
    const dir = scratch();
    const df = join(dir, '.gbrain-source'); writeFileSync(df, 'evil\n'); chmodSync(df, 0o666);
    expect(await resolveSourceId(stubEngine(['evil', 'default']), null, dir)).toBe('default');
  });
});

// ── brain-resolver integration (#418, brain axis) ──────────

describe('resolveBrainId — .gbrain-mount dotfile trust', () => {
  const noMounts = () => [];
  test('trusted dotfile resolves to its id (control)', () => {
    const dir = scratch();
    writeFileSync(join(dir, '.gbrain-mount'), 'evil-brain\n');
    expect(resolveBrainId(null, dir, noMounts)).toBe('evil-brain');
  });
  test('symlinked .gbrain-mount is REFUSED → falls through to host', () => {
    if (typeof process.getuid !== 'function') return;
    const dir = scratch();
    const target = join(dir, 'm'); writeFileSync(target, 'evil-brain\n');
    symlinkSync(target, join(dir, '.gbrain-mount'));
    expect(resolveBrainId(null, dir, noMounts)).toBe(HOST_BRAIN_ID);
  });
  test('world-writable .gbrain-mount is REFUSED → falls through to host', () => {
    if (typeof process.getuid !== 'function') return;
    const dir = scratch();
    const df = join(dir, '.gbrain-mount'); writeFileSync(df, 'evil-brain\n'); chmodSync(df, 0o666);
    expect(resolveBrainId(null, dir, noMounts)).toBe(HOST_BRAIN_ID);
  });
});

// ── repo-root skills-dir confinement (#419) ────────────────

describe('autoDetectSkillsDir — skills/ symlink confinement', () => {
  function seedSkills(dir: string): void {
    mkdirSync(join(dir, 'skills'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'RESOLVER.md'), '# RESOLVER\n');
  }

  test('OPENCLAW_WORKSPACE: escaping skills symlink is refused', () => {
    if (typeof process.getuid !== 'function') return;
    const ws = scratch('ws-'); const outside = scratch('outside-');
    seedSkills(outside); // real skills with RESOLVER.md, OUTSIDE the workspace
    symlinkSync(join(outside, 'skills'), join(ws, 'skills')); // ws/skills → outside/skills
    const found = autoDetectSkillsDir(scratch('cwd-'), { OPENCLAW_WORKSPACE: ws });
    expect(found.source).not.toBe('openclaw_workspace_env');
    expect(found.dir).not.toBe(join(ws, 'skills'));
  });

  test('OPENCLAW_WORKSPACE: in-workspace skills symlink is allowed', () => {
    const ws = scratch('ws-');
    mkdirSync(join(ws, '_real'), { recursive: true });
    writeFileSync(join(ws, '_real', 'RESOLVER.md'), '# RESOLVER\n');
    symlinkSync(join(ws, '_real'), join(ws, 'skills')); // contained symlink
    const found = autoDetectSkillsDir(scratch('cwd-'), { OPENCLAW_WORKSPACE: ws });
    expect(found.source).toBe('openclaw_workspace_env');
    expect(found.dir).toBe(join(ws, 'skills'));
  });

  test('cwd_walk_up: escaping skills symlink is refused', () => {
    if (typeof process.getuid !== 'function') return;
    const ws = scratch('ws-'); const outside = scratch('outside-');
    mkdirSync(join(outside, 'skills'), { recursive: true });
    symlinkSync(join(outside, 'skills'), join(ws, 'skills'));
    const found = autoDetectSkillsDir(ws, {});
    expect(found.dir).toBeNull();
  });

  test('cwd_walk_up: in-workspace skills symlink is allowed', () => {
    const ws = scratch('ws-');
    mkdirSync(join(ws, '_real'), { recursive: true });
    symlinkSync(join(ws, '_real'), join(ws, 'skills'));
    const found = autoDetectSkillsDir(ws, {});
    expect(found.source).toBe('cwd_walk_up');
    expect(found.dir).toBe(join(ws, 'skills'));
  });
});
