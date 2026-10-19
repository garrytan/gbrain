/**
 * A test that saves `process.exitCode` and restores it later must restore
 * `saved ?? 0`. In Bun, assigning `undefined` does not clear an earlier
 * value (`bun -e 'process.exitCode=1; process.exitCode=undefined'` exits 1),
 * so restoring a code that was never set keeps whatever the test body set,
 * and the file exits 1 with every test passing. The PGLite arm hid this:
 * PGLite's Emscripten runtime writes `process.exitCode`, so the saved value
 * was defined whenever that arm ran first, and only the Postgres-only run of
 * test/large-pages/segmented-semantic-writes.test.ts exited 1 (GBRA-135).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(import.meta.dir, '..', '..');

/** `file:line` of every restore of a saved exit code that lacks the `?? 0` fallback. */
function unsafeExitCodeRestores(path: string, source: string): string[] {
  const saved = new Set<string>();
  for (const m of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*[=:]\s*process\.exitCode\b/g)) saved.add(m[1]!);
  const found: string[] = [];
  source.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/process\.exitCode\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?=;|\}|$)/g)) {
      if (saved.has(m[1]!.split('.').pop()!)) found.push(`${path}:${i + 1}`);
    }
  });
  return found;
}

function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : testSources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('saved process.exitCode restores', () => {
  test('every restore of a saved exit code falls back to 0', () => {
    const unsafe = testSources(join(REPO, 'test')).filter(path => path !== import.meta.path).flatMap(path => unsafeExitCodeRestores(relative(REPO, path), readFileSync(path, 'utf8')));
    expect(unsafe).toEqual([]);
  });

  test('the scan flags a bare restore of a saved code and accepts the fallback', () => {
    const bare = 'const prev = process.exitCode;\ntry { run(); } finally { process.exitCode = prev; }\n';
    const member = 'const old = { exitCode: process.exitCode };\nprocess.exitCode = old.exitCode;\n';
    expect(unsafeExitCodeRestores('t.ts', bare)).toEqual(['t.ts:2']);
    expect(unsafeExitCodeRestores('t.ts', member)).toEqual(['t.ts:2']);
    expect(unsafeExitCodeRestores('t.ts', bare.replace('= prev;', '= prev ?? 0;'))).toEqual([]);
    expect(unsafeExitCodeRestores('t.ts', 'process.exitCode = code;\n')).toEqual([]);
  });
});
