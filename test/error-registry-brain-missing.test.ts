/**
 * The registry's `brain_missing` entry says what `gbrain doctor` does on this version when the configured PGLite
 * brain is missing: it refuses before connecting, creates nothing in the folder, and exits 1.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: the meaning, the why and the exit code the registry (and the generated docs/guides/error-codes.md)
 *     publish for `brain_missing` match the refusal doctor really prints (src/commands/doctor/missing-brain.ts):
 *     it covers the host brain and a selected mount, an absent folder or an empty one, and it never says that
 *     `gbrain init` is the way to recreate a mount's datastore (init rewrites the host brain's config).
 *  2. Regression: the entry's `why` named a bare `gbrain init` for every brain and its summary named only a
 *     "configured PGLite brain" at "its datastore path", which is wrong for a mount and for an empty folder.
 *  3. Existing coverage misses it: doctor-missing-brain.test.ts pins what doctor prints and its exit code; nothing
 *     reads the registry entry or the guide row an agent looks the code up in.
 *  4. Seam: the real registry through `codeEntry` / `errorCodeRow` / `exitCodeForCode`, and the committed guide file.
 *     Nothing connects to a database.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeEntry, codeRetryable, exitCodeForCode } from '../src/core/error-catalogue.ts';
import { errorCodeRow } from '../src/core/error-docs.ts';

const GUIDE = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'error-codes.md'), 'utf8');

describe('brain_missing registry entry matches what doctor does', () => {
  const entry = codeEntry('brain_missing')!;

  test('is registered, exits 1, is not retryable, and only the user can fix it', () => {
    expect(entry).toBeDefined();
    expect(exitCodeForCode('brain_missing')).toBe(1);
    expect(codeRetryable('brain_missing')).toBe(false);
    expect(entry.actor).toBe('user');
    expect(entry.reasons).toEqual(['missing_brain']);
  });

  test('the meaning says doctor refused before connecting, created nothing in the folder, and covers a mount and an empty folder', () => {
    expect(entry.summary).toContain('refused before connecting');
    expect(entry.summary).toContain('created nothing in the folder');
    expect(entry.summary).toMatch(/mount/);
    expect(entry.summary).toMatch(/folder is empty/);
    expect(entry.summary).not.toContain('did not connect');
  });

  test('the why names the real init command for the host brain and says init is not the way for a mount', () => {
    expect(entry.why).toContain('gbrain init --pglite --no-embedding --path');
    expect(entry.why).toMatch(/mount[^.]*`gbrain init` is not the way/);
    expect(entry.why).not.toContain('is `gbrain init`, a decision for the user');
  });

  test('the generated guide row carries the same meaning, why and exit', () => {
    const row = errorCodeRow('brain_missing')!;
    expect(row.exit_code).toBe(1);
    expect(GUIDE).toContain(row.meaning);
    expect(GUIDE).toContain(row.why);
  });
});
