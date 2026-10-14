/**
 * v0.41.8.0 (#1340) — PGLite init-error classifier + hint routing.
 *
 * Pure-function tests over the classifier + message builder. No
 * PGLite cold-start required. The classifier sits in front of the
 * connect() catch block and routes the user-visible hint by failure
 * shape so users on macOS 12.7.6 + Bun 1.3.14 (the actual #1340
 * environment) don't get pointed at the macOS 26.3 hint (#223) by
 * mistake.
 *
 * Codex eng-review finding #9: the regex must NOT match generic
 * `pglite.data` substrings — only the literal `$$bunfs` marker OR
 * the ENOENT+pglite.data co-occurrence that bun's vfs failure shows.
 */

import { describe, test, expect } from 'bun:test';
import {
  classifyPgliteInitError,
  buildPgliteInitErrorMessage,
  stringifyPgliteInitError,
} from '../src/core/pglite-engine.ts';

describe('classifyPgliteInitError', () => {
  test('bunfs verdict for the literal $$bunfs marker', () => {
    const msg = "ENOENT: no such file or directory, open '/$$bunfs/root/pglite.data'.";
    expect(classifyPgliteInitError(msg)).toBe('bunfs');
  });

  test('bunfs verdict for ENOENT + pglite.data co-occurrence (no $$bunfs prefix)', () => {
    const msg = 'ENOENT: cannot open pglite.data: read-only file system';
    expect(classifyPgliteInitError(msg)).toBe('bunfs');
  });

  test('the existing #223 signature routes to guarded WAL repair', () => {
    const msg = 'abort() called from wasm runtime on macOS 26.3 build';
    expect(classifyPgliteInitError(msg)).toBe('wasm-abort');
  });

  test('Windows Aborted() does not route to the macOS hint', () => {
    const msg = 'Aborted(). Build with -sASSERTIONS for more info.';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('wasm-abort');
  });

  test('unknown verdict for generic / unrecognized errors', () => {
    const msg = 'TypeError: cannot read property of undefined at PGlite.create';
    expect(classifyPgliteInitError(msg)).toBe('unknown');
  });

  test('NEGATIVE: generic "pglite.data" mention WITHOUT ENOENT does not trip bunfs', () => {
    // Per Codex finding #9: the prior overbroad regex `/bunfs|pglite\.data/i`
    // would have classified this as bunfs. The tightened regex requires
    // the literal $$bunfs marker OR ENOENT+pglite.data co-occurrence.
    const msg = 'Failed to parse pglite.data manifest: invalid magic byte';
    expect(classifyPgliteInitError(msg)).toBe('unknown');
  });

  test('case-insensitive matching on bunfs marker', () => {
    expect(classifyPgliteInitError('SYSCALL ENOENT on /$$BUNFS/root')).toBe('bunfs');
  });


  test('catalog or pgvector damage is classified before generic Windows Aborted()', () => {
    const msg = 'Aborted(): code 58P01 in internal_load_library; type "vector" does not exist';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('corrupt');
  });

  test('filesystem permission errors have their own verdict', () => {
    expect(classifyPgliteInitError('EPERM: operation not permitted, open brain.pglite', 'win32')).toBe('permission');
  });

  test('PGLite lock file permission denied is not sent to WAL reset', () => {
    const msg = 'PGlite failed to initialize properly\n2026-10-14 18:50:43.696 +08 [42] FATAL: could not create lock file "postmaster.pid": Permission denied';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('permission');
    const shown = buildPgliteInitErrorMessage('permission', msg, 'win32');
    expect(shown).toContain('postmaster.pid');
    expect(shown).not.toContain('数据库本身异常');
    expect(shown).not.toContain('WASM runtime');
  });

  test('PGLite process exit without Aborted() still uses guarded WAL repair', () => {
    const msg = 'PGlite failed to initialize properly';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('wasm-abort');
    expect(buildPgliteInitErrorMessage(classifyPgliteInitError(msg, 'win32'), msg, 'win32', { repair: 'not-attempted' }))
      .toContain('WAL/checkpoint');
  });

  test('startup log that names catalog damage is not sent to WAL reset', () => {
    const msg = 'PGlite failed to initialize properly\nERROR: type "vector" does not exist';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('corrupt');
  });

  test('startup log that names toast damage is not sent to WAL reset', () => {
    const msg = 'PGlite failed to initialize properly\nunexpected chunk number 3 (expected 0) for toast value 191139 in pg_toast_16852';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('toast-corrupt');
  });

  test('toast chunk inconsistency is toast-corrupt and must not auto-reset WAL', () => {
    const msg = 'unexpected chunk number 3 (expected 0) for toast value 191139 in pg_toast_16852';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('toast-corrupt');
    expect(classifyPgliteInitError('missing chunk number 0 for toast value 12 in pg_toast_1', 'win32')).toBe('toast-corrupt');
    expect(buildPgliteInitErrorMessage('toast-corrupt', msg)).toContain('不会继续自动重置 WAL');
    expect(buildPgliteInitErrorMessage('toast-corrupt', msg)).toContain('toast-diagnose');
  });
});

describe('buildPgliteInitErrorMessage — hint routing', () => {
  const original = 'synthetic original error';

  test('bunfs verdict surfaces bun upgrade hint AND original error', () => {
    const msg = buildPgliteInitErrorMessage('bunfs', original);
    expect(msg).toContain('bun upgrade');
    expect(msg).toContain('Bun vfs');
    expect(msg).toContain(original);
    // Must NOT redirect to the wrong issue
    expect(msg).not.toContain('issues/223');
  });

  test('macos-26-3 verdict surfaces the #223 link AND original error', () => {
    const msg = buildPgliteInitErrorMessage('macos-26-3', original);
    expect(msg).toContain('https://github.com/garrytan/gbrain/issues/223');
    expect(msg).toContain('macOS 26.3');
    expect(msg).toContain(original);
    expect(msg).not.toContain('Bun vfs');
  });

  test('windows-aborted verdict surfaces a local desktop recovery hint', () => {
    const msg = buildPgliteInitErrorMessage('windows-aborted', original);
    expect(msg).toContain('On Windows');
    expect(msg).toContain('.pmbrain\\brain.pglite');
    expect(msg).toContain('does not');
    expect(msg).toContain('delete, replace, or rebuild');
    expect(msg).not.toContain('choose a fresh');
    expect(msg).toContain(original);
    expect(msg).not.toContain('macOS 26.3');
  });

  test('wasm-abort verdict explains guarded WAL recovery', () => {
    const msg = buildPgliteInitErrorMessage('wasm-abort', original, 'win32', { repair: 'failed-restored' });
    expect(msg).toContain('WAL/checkpoint');
    expect(msg).toContain('原 WAL 已恢复');
    expect(msg).toContain(original);
    expect(msg).toContain('数据库本身异常，需要先修复数据库或恢复备份。');
  });


  test('corrupt verdict stops automatic retries and protects the original database', () => {
    const msg = buildPgliteInitErrorMessage('corrupt', original, 'win32');
    expect(msg).toContain('疑似损坏');
    expect(msg).toContain('不会自动删除');
    expect(msg).toContain('备份');
    expect(msg).not.toContain('删除 .gbrain-lock');
  });

  test('permission verdict points at directory access rather than data corruption', () => {
    const msg = buildPgliteInitErrorMessage('permission', original, 'win32');
    expect(msg).toContain('权限');
    expect(msg).toContain('数据库路径');
    expect(msg).toContain(original);
  });
  test('unknown verdict surfaces pmbrain doctor AND original error', () => {
    const msg = buildPgliteInitErrorMessage('unknown', original);
    expect(msg).toContain('pmbrain doctor');
    expect(msg).not.toContain('issues/223');
    expect(msg).toContain(original);
  });

  test('all verdicts produce the canonical header line', () => {
    for (const v of ['bunfs', 'wasm-abort', 'windows-aborted', 'macos-26-3', 'corrupt', 'unknown'] as const) {
      const msg = buildPgliteInitErrorMessage(v, original);
      expect(msg.startsWith('PGLite failed to initialize its WASM runtime.')).toBe(true);
    }
    const permission = buildPgliteInitErrorMessage('permission', original);
    expect(permission.startsWith('数据库目录无法写入启动锁 postmaster.pid')).toBe(true);
  });
});


describe('stringifyPgliteInitError', () => {
  test('preserves the message from non-Error Emscripten abort objects', () => {
    expect(stringifyPgliteInitError({ message: 'Aborted(). Build with -sASSERTIONS.' })).toBe(
      'Aborted(). Build with -sASSERTIONS.',
    );
  });

  test('still handles primitive rejection values', () => {
    expect(stringifyPgliteInitError('raw failure')).toBe('raw failure');
    expect(stringifyPgliteInitError(null)).toBe('null');
  });

  test('names an ErrnoError instead of [object Object]', () => {
    expect(stringifyPgliteInitError({ name: 'ErrnoError', errno: 20, message: '[object Object]' })).toBe('ErrnoError (errno 20)');
  });
});

describe('#1340 reproducer — exact reporter error string maps to bunfs', () => {
  // This is the literal error string from the issue body.
  const reportError = `ENOENT: no such file or directory, open '/$$bunfs/root/pglite.data'.`;

  test('classifier routes the reporter\'s error to bunfs', () => {
    expect(classifyPgliteInitError(reportError)).toBe('bunfs');
  });

  test('user-visible message names bun upgrade, NOT macOS 26.3', () => {
    const verdict = classifyPgliteInitError(reportError);
    const msg = buildPgliteInitErrorMessage(verdict, reportError);
    expect(msg).toContain('bun upgrade');
    expect(msg).not.toMatch(/most commonly the macOS 26\.3/);
  });
});
