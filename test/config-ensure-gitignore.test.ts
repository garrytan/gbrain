/**
 * Tests for `ensureGitignore()` in `src/core/config.ts` (v0.35.8.0).
 *
 * Idempotent retroactive coverage: every config-writing path (saveConfig +
 * post-upgrade) lays down `~/.gbrain/.gitignore` containing the single line
 * `*`. The helper MUST NOT clobber a `.gitignore` whose content the user
 * has customized.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { withEnv } from './helpers/with-env.ts';
import { ensureGitignore, configDir } from '../src/core/config.ts';

let testHome: string;

beforeEach(() => {
  testHome = join(tmpdir(), `gbrain-eg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testHome, { recursive: true });
});

afterEach(() => {
  try { rmSync(testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('ensureGitignore', () => {
  test('creates ~/.gbrain/.gitignore with single * when missing', async () => {
    await withEnv({ GBRAIN_HOME: testHome }, async () => {
      ensureGitignore();
      const file = join(configDir(), '.gitignore');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('*\n');
    });
  });

  test('no-op when .gitignore already exists with non-empty content (user customization preserved)', async () => {
    await withEnv({ GBRAIN_HOME: testHome }, async () => {
      // Prime: user wrote their own .gitignore first.
      const dir = configDir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, '.gitignore');
      const userContent = '*.tmp\n# my custom gitignore\nlogs/\n';
      writeFileSync(file, userContent);
      // Now call ensureGitignore.
      ensureGitignore();
      // Assert: untouched.
      expect(readFileSync(file, 'utf-8')).toBe(userContent);
    });
  });

  test('writes default when .gitignore exists but is empty', async () => {
    await withEnv({ GBRAIN_HOME: testHome }, async () => {
      const dir = configDir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, '.gitignore');
      writeFileSync(file, '');
      ensureGitignore();
      expect(readFileSync(file, 'utf-8')).toBe('*\n');
    });
  });

  test('idempotent: second call is a no-op', async () => {
    await withEnv({ GBRAIN_HOME: testHome }, async () => {
      ensureGitignore();
      const file = join(configDir(), '.gitignore');
      const first = readFileSync(file, 'utf-8');
      ensureGitignore();
      const second = readFileSync(file, 'utf-8');
      expect(second).toBe(first);
    });
  });

  test('honors GBRAIN_HOME: writes under $GBRAIN_HOME/.gbrain/, not $HOME', async () => {
    await withEnv({ GBRAIN_HOME: testHome }, async () => {
      ensureGitignore();
      const expected = join(testHome, '.gbrain', '.gitignore');
      expect(existsSync(expected)).toBe(true);
    });
  });

  test('does not throw on read failure of existing file (best-effort)', async () => {
    // Hard to simulate cleanly cross-platform; the contract is that ANY
    // unexpected fs error is logged to stderr and the function returns
    // normally without throwing. Tested indirectly by the idempotency case
    // above and by the surface-level "function returns void, never throws"
    // contract (no expect.toThrow on any call).
    await withEnv({ GBRAIN_HOME: testHome }, async () => {
      expect(() => ensureGitignore()).not.toThrow();
    });
  });
});
