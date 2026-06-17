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
  isPgliteDataDirRecoveryCandidate,
  type PgliteDataDirPreflightSnapshot,
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

  test('persistent existing PGLite-shaped data dir can be a recovery candidate', () => {
    const snapshot: PgliteDataDirPreflightSnapshot = {
      persistent: true,
      exists: true,
      isDirectory: true,
      entries: ['PG_VERSION', 'base', 'global', 'pg_wal'],
      hasPgVersion: true,
      hasBaseDir: true,
      hasGlobalDir: true,
      hasPgWalDir: true,
    };
    expect(classifyPgliteInitError('Aborted(native code)', snapshot)).toBe(
      'pglite-data-dir-recovery-candidate',
    );
  });

  test('data-dir recovery candidate does not apply to in-memory or fresh missing dataDir', () => {
    expect(classifyPgliteInitError('Aborted(native code)', {
      persistent: false,
      exists: false,
    })).toBe('unknown');
    expect(classifyPgliteInitError('Aborted(native code)', {
      persistent: true,
      exists: false,
    })).toBe('unknown');
  });

  test('known bunfs and macOS signatures keep precedence over data-dir snapshot', () => {
    const snapshot: PgliteDataDirPreflightSnapshot = {
      persistent: true,
      exists: true,
      isDirectory: true,
      hasPgVersion: true,
    };
    expect(classifyPgliteInitError('ENOENT: cannot open pglite.data', snapshot)).toBe(
      'bunfs',
    );
    expect(classifyPgliteInitError(
      'abort() called from wasm runtime on macOS 26.3 build',
      snapshot,
    )).toBe(
      'macos-26-3',
    );
  });
});

describe('isPgliteDataDirRecoveryCandidate', () => {
  test('accepts fabricated Postgres-shaped snapshot entries', () => {
    expect(isPgliteDataDirRecoveryCandidate({
      persistent: true,
      exists: true,
      isDirectory: true,
      entries: ['base', 'global'],
    })).toBe(true);
  });

  test('rejects generic non-empty persistent directories', () => {
    expect(isPgliteDataDirRecoveryCandidate({
      persistent: true,
      exists: true,
      isDirectory: true,
      entries: ['README.md', 'tmp'],
    })).toBe(false);
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

  test('all verdicts produce the canonical header line', () => {
    const verdicts = [
      'bunfs',
      'macos-26-3',
      'pglite-data-dir-recovery-candidate',
      'unknown',
    ] as const;
    for (const v of verdicts) {
      const msg = buildPgliteInitErrorMessage(v, original);
      expect(msg.startsWith('PGLite failed to initialize its WASM runtime.')).toBe(true);
    }
  });

  test('data-dir recovery candidate surfaces rebuild hint and avoids corruption wording', () => {
    const msg = buildPgliteInitErrorMessage('pglite-data-dir-recovery-candidate', original);
    expect(msg).toContain('existing PGLite data directory may need recovery/rebuild');
    expect(msg).toContain('gbrain doctor --rebuild-pglite');
    expect(msg).not.toMatch(/wal-corruption|WAL corruption/i);
    expect(msg).toContain(original);
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
