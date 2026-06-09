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

  test('windows path/shell verdict for #2008 NativeCommandError + WASM red herring', () => {
    const msg = `bun :
At line:1 char:31
+ ... C:\\Users\\quote-test'\\.gbrain"; bun run src/cli.ts apply-migrations --yes
+                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError

Phase A (schema) failed: PGLite failed to initialize its WASM runtime.
Original error: Aborted(). Build with -sASSERTIONS for more info.`;
    expect(classifyPgliteInitError(msg, 'win32')).toBe('windows-path-shell');
  });

  test('windows generic WASM failure does not get the apostrophe/path verdict', () => {
    const msg = 'PGLite failed to initialize its WASM runtime. Original error: Aborted().';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('windows-pglite-unknown');
  });

  test('windows abort/runtime wording never falls through to the macOS verdict', () => {
    const msg = 'PGLite failed: abort while starting runtime';
    expect(classifyPgliteInitError(msg, 'win32')).toBe('windows-pglite-unknown');
  });

  test('windows PowerShell wrapper without apostrophe path stays generic', () => {
    const msg = `bun :
At line:1 char:31
+ ... C:\\Users\\quote-safe\\.gbrain"; bun run src/cli.ts apply-migrations --yes
+                  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError

Phase A (schema) failed: PGLite failed to initialize its WASM runtime.
Original error: Aborted(). Build with -sASSERTIONS for more info.`;
    expect(classifyPgliteInitError(msg, 'win32')).toBe('windows-pglite-unknown');
  });

  test('windows apostrophe path without shell wrapper stays generic', () => {
    const msg = `PGLite failed to initialize its WASM runtime at C:\\Users\\quote-test'\\.gbrain. Original error: Aborted().`;
    expect(classifyPgliteInitError(msg, 'win32')).toBe('windows-pglite-unknown');
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

  test('unknown verdict surfaces the doctor + #223 fallback AND original error', () => {
    const msg = buildPgliteInitErrorMessage('unknown', original);
    expect(msg).toContain('gbrain doctor');
    expect(msg).toContain('issues/223');
    expect(msg).toContain(original);
  });

  test('windows path/shell verdict names #2008 and does not blame macOS', () => {
    const msg = buildPgliteInitErrorMessage(
      'windows-path-shell',
      'NativeCommandError followed by Aborted() from PGLite',
    );
    expect(msg).toContain('Windows');
    expect(msg).toContain('apostrophe');
    expect(msg).toContain('issues/2008');
    expect(msg).not.toContain('macOS 26.3');
    expect(msg).not.toContain('issues/223');
  });

  test('windows generic verdict avoids macOS and avoids apostrophe-specific advice', () => {
    const msg = buildPgliteInitErrorMessage(
      'windows-pglite-unknown',
      'PGLite failed to initialize its WASM runtime. Original error: Aborted().',
    );
    expect(msg).toContain('Windows');
    expect(msg).toContain('gbrain doctor');
    expect(msg).not.toContain('macOS 26.3');
    expect(msg).not.toContain('issues/223');
    expect(msg).not.toContain('apostrophe');
    expect(msg).not.toContain('C:\\gbrain');
  });

  test('all verdicts produce the canonical header line', () => {
    for (const v of ['bunfs', 'macos-26-3', 'windows-path-shell', 'windows-pglite-unknown', 'unknown'] as const) {
      const msg = buildPgliteInitErrorMessage(v, original);
      expect(msg.startsWith('PGLite failed to initialize its WASM runtime.')).toBe(true);
    }
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
