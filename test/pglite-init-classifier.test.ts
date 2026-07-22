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

  test('macos-26-3 verdict for the existing #223 signature', () => {
    const msg = 'abort() called from wasm runtime on macOS 26.3 build';
    expect(classifyPgliteInitError(msg)).toBe('macos-26-3');
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
    // A message mentioning both must classify as corrupt, not macos-26-3 —
    // recovery guidance, not the wrong macOS-WASM hint.
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

  test('macos-26-3 verdict surfaces the #223 link AND original error', () => {
    const msg = buildPgliteInitErrorMessage('macos-26-3', original);
    expect(msg).toContain('https://github.com/garrytan/gbrain/issues/223');
    expect(msg).toContain('macOS 26.3');
    expect(msg).toContain(original);
    expect(msg).not.toContain('Bun vfs');
  });

  // #2674: the unknown-verdict hint is platform-gated. The macOS 26.3
  // attribution (#223) only appears on darwin; elsewhere the hint names
  // the causes that are actually plausible off-macOS.
  test('unknown verdict on darwin surfaces the doctor + #223 fallback AND original error', () => {
    const msg = buildPgliteInitErrorMessage('unknown', original, 'darwin');
    expect(msg).toContain('gbrain doctor');
    expect(msg).toContain('issues/223');
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
    expect(msg).toContain(original);
    expect(msg).not.toContain('issues/223');
  });

  test('all verdicts produce the canonical header line', () => {
    for (const v of ['bunfs', 'macos-26-3', 'corrupt', 'unknown'] as const) {
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
