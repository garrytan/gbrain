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

  test('wasm-abort verdict for the existing #223 signature', () => {
    const msg = 'abort() called from wasm runtime on macOS 26.3 build';
    expect(classifyPgliteInitError(msg)).toBe('wasm-abort');
  });

  // WAL-repair wave: THE real production message from a torn-WAL Emscripten
  // abort — no "runtime"/"wasm" in it, so the legacy arms let it fall
  // through to 'unknown' (which is exactly how #223 got misdiagnosed).
  test('wasm-abort verdict for the bare Emscripten Aborted() message', () => {
    expect(
      classifyPgliteInitError('Aborted(). Build with -sASSERTIONS for more info.'),
    ).toBe('wasm-abort');
  });

  test('wasm-abort verdict for RuntimeError-prefixed Aborted()', () => {
    expect(
      classifyPgliteInitError('RuntimeError: Aborted(). Build with -sASSERTIONS for more info.'),
    ).toBe('wasm-abort');
  });

  test('wasm-abort verdict for the generic RuntimeError: unreachable trap', () => {
    expect(classifyPgliteInitError('RuntimeError: unreachable')).toBe('wasm-abort');
  });

  test('bunfs still wins when a wasm-abort marker co-occurs (bunfs arm is first)', () => {
    const msg = "RuntimeError: Aborted(). ENOENT open '/$$bunfs/root/pglite.data'";
    expect(classifyPgliteInitError(msg)).toBe('bunfs');
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

  // #2348 — corrupted PGLite data dir (concurrent open trashed catalog/extension).
  test('corrupt verdict for the 58P01 internal_load_library signature', () => {
    const msg = 'error: relation "content_chunks" does not exist\n  code: 58P01\n  file: "dfmgr.c"\n  routine: "internal_load_library"';
    expect(classifyPgliteInitError(msg)).toBe('corrupt');
  });

  test('corrupt verdict when the vector type can no longer load', () => {
    expect(classifyPgliteInitError('type "vector" does not exist')).toBe('corrupt');
  });

  test('corrupt verdict beats the wasm-runtime match (58P01 wins over "wasm runtime")', () => {
    // A message mentioning both must classify as corrupt, not wasm-abort —
    // recovery guidance, not the WAL-repair hint (WAL repair cannot fix
    // catalog corruption).
    expect(classifyPgliteInitError('wasm runtime: 58P01 internal_load_library')).toBe('corrupt');
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

  test('wasm-abort verdict names torn WAL as the cause, keeps the #223 link, AND original error', () => {
    const msg = buildPgliteInitErrorMessage('wasm-abort', original);
    // The re-diagnosis is the load-bearing copy: corrupt WAL after an unclean
    // shutdown, explicitly NOT the historical macOS-WASM attribution.
    expect(msg).toContain('NOT a macOS WASM bug');
    expect(msg).toContain('https://github.com/garrytan/gbrain/issues/223');
    // Full recovery ladder: in-place repair → rebuild → switch engines.
    expect(msg).toContain('gbrain pglite-repair --dry-run');
    expect(msg).toContain('reinit-pglite');
    expect(msg).toContain('docs/ENGINES.md');
    expect(msg).toContain('gbrain doctor');
    expect(msg).toContain(`Original error: ${original}`);
    expect(msg).not.toContain('Bun vfs');
  });

  // WAL-repair wave: the 4th param folds what auto-repair did (or why it
  // didn't run) into the hint so the message never lies about the state of
  // the data dir.
  test('wasm-abort + {repair: disabled} names the off switch', () => {
    const msg = buildPgliteInitErrorMessage('wasm-abort', original, 'darwin', { repair: 'disabled' });
    expect(msg).toContain('GBRAIN_PGLITE_WAL_REPAIR=off');
    expect(msg).toContain(original);
  });

  test('wasm-abort + {repair: failed-restored} says RESTORED and names the backup path', () => {
    const msg = buildPgliteInitErrorMessage('wasm-abort', original, 'darwin', {
      repair: 'failed-restored',
      backupPath: '/x/b',
    });
    expect(msg).toContain('RESTORED');
    expect(msg).toContain('/x/b');
    expect(msg).toContain(original);
  });

  test('wasm-abort + {repair: failed-not-restored} says RESET state, backup path, restore manually', () => {
    const msg = buildPgliteInitErrorMessage('wasm-abort', original, 'darwin', {
      repair: 'failed-not-restored',
      backupPath: '/x/b',
    });
    expect(msg).toContain('RESET state');
    expect(msg).toContain('/x/b');
    expect(msg.toLowerCase()).toContain('restore manually');
    expect(msg).toContain(original);
  });

  test('wasm-abort + {repair: in-memory} says there is no stored state to repair', () => {
    const msg = buildPgliteInitErrorMessage('wasm-abort', original, 'darwin', { repair: 'in-memory' });
    expect(msg).toContain('in-memory');
    expect(msg).toContain(original);
  });

  test('wasm-abort + {repair: skipped-live-writer} surfaces the skip detail verbatim', () => {
    const detail = 'the data-dir lock was reaped from pid 4242 (SENTINEL-LIVE-WRITER)';
    const msg = buildPgliteInitErrorMessage('wasm-abort', original, 'darwin', {
      repair: 'skipped-live-writer',
      detail,
    });
    expect(msg).toContain(detail);
    expect(msg).toContain(original);
  });

  // #2674: the unknown-verdict hint is platform-gated. The macOS 26.3
  // attribution (#223) only appears on darwin; elsewhere the hint names
  // the causes that are actually plausible off-macOS.
  test('unknown verdict on darwin surfaces the doctor + #223 fallback AND original error', () => {
    const msg = buildPgliteInitErrorMessage('unknown', original, 'darwin');
    expect(msg).toContain('gbrain doctor');
    expect(msg).toContain('issues/223');
    // WAL-repair wave: the darwin branch is reframed to the real root cause
    // behind the #223 reports (torn WAL from unclean shutdown) and offers the
    // mutation-free diagnosis command.
    expect(msg).toContain('corrupt WAL/checkpoint state');
    expect(msg).toContain('unclean');
    expect(msg).toContain('gbrain pglite-repair --dry-run');
    expect(msg).toContain(original);
  });

  test('unknown verdict on non-darwin does NOT mention macOS 26.3', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const msg = buildPgliteInitErrorMessage('unknown', original, platform);
      expect(msg).not.toContain('macOS 26.3');
      expect(msg).not.toContain('issues/223');
      expect(msg).toContain('gbrain doctor');
      expect(msg).toContain('gbrain reinit-pglite');
      expect(msg).toContain(original);
    }
  });

  test('corrupt verdict surfaces the reinit-pglite recovery, NOT the macOS hint', () => {
    const msg = buildPgliteInitErrorMessage('corrupt', original);
    expect(msg).toContain('gbrain reinit-pglite');
    expect(msg).toContain('corrupted');
    // WAL-repair wave: the dry-run diagnosis is offered (report-only — WAL
    // repair cannot fix catalog corruption, and the copy says so).
    expect(msg).toContain('gbrain pglite-repair --dry-run');
    expect(msg).toContain(original);
    expect(msg).not.toContain('issues/223');
  });

  test('all verdicts produce the canonical header line', () => {
    for (const v of ['bunfs', 'wasm-abort', 'corrupt', 'unknown'] as const) {
      const msg = buildPgliteInitErrorMessage(v, original);
      expect(msg.startsWith('PGLite failed to initialize its WASM runtime.')).toBe(true);
    }
  });
});

describe('stringifyPgliteInitError — non-Error rejections (#2674)', () => {
  test('Error instance yields its message', () => {
    expect(stringifyPgliteInitError(new Error('boom'))).toBe('boom');
  });

  test('plain object with message yields the message, not "[object Object]"', () => {
    const emscriptenAbort = { message: 'Aborted(). Build with -sASSERTIONS for more info.' };
    expect(stringifyPgliteInitError(emscriptenAbort)).toBe(
      'Aborted(). Build with -sASSERTIONS for more info.',
    );
  });

  test('primitive rejections stringify as-is', () => {
    expect(stringifyPgliteInitError('raw string')).toBe('raw string');
    expect(stringifyPgliteInitError(42)).toBe('42');
    expect(stringifyPgliteInitError(null)).toBe('null');
    expect(stringifyPgliteInitError(undefined)).toBe('undefined');
  });

  // WAL-repair wave: Emscripten's FS layer throws message-LESS objects (e.g.
  // `ErrnoError { name: 'ErrnoError', errno: 20 }` when the data dir is a
  // symlink NODEFS refuses to mount) — never "[object Object]".
  test('message-less ErrnoError-shaped object yields name + errno', () => {
    expect(stringifyPgliteInitError({ name: 'ErrnoError', errno: 20 })).toBe('ErrnoError (errno 20)');
  });

  test('message-less nameless object with other props yields its JSON', () => {
    expect(stringifyPgliteInitError({ code: 'ENOENT' })).toBe('{"code":"ENOENT"}');
  });

  test('message-less object with a name and serializable props yields name-prefixed JSON', () => {
    expect(stringifyPgliteInitError({ name: 'Weird' })).toBe('Weird: {"name":"Weird"}');
  });

  test('circular object with a name falls back to the bare name (JSON.stringify throws)', () => {
    const c: Record<string, unknown> = { name: 'Circ' };
    c.self = c;
    expect(stringifyPgliteInitError(c)).toBe('Circ');
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
