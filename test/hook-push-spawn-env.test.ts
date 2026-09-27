/**
 * `gbrain hook` fires `gbrain sources push` as a DETACHED child. A child
 * spawned WITHOUT an explicit `env` option does not see the parent's cwd-.env
 * quarantine deletions (core/env-trust.ts — verified on Bun 1.3.10), so a
 * hostile repo's GBRAIN_* keys would resurface inside the push process. The
 * spawn is private and fire-and-forget, so this is a source-shape guard (the
 * proven `autopilot-*-wiring.test.ts` pattern).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// test-reads-source-ok: the property under test is a source SHAPE — every detached/exec spawn in hook.ts must pass `env: process.env` so the cwd-.env quarantine reaches the child; a runtime probe cannot enumerate spawn sites, only grepping the source can.
const SRC = readFileSync(join(import.meta.dir, '../src/commands/hook.ts'), 'utf8');

function spawnDetachedPushBody(): string {
  const start = SRC.indexOf('function spawnDetachedPush(');
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('spawnDetachedPush env handoff', () => {
  test('the detached push child is spawned with the (quarantined) process.env, explicitly', () => {
    const body = spawnDetachedPushBody();
    expect(body).toMatch(/spawn\([^)]*\{[^}]*detached:\s*true[^}]*env:\s*process\.env[^}]*\}/s);
  });

  test('every detached spawn in hook.ts carries an explicit env option', () => {
    const detachedSpawns = SRC.match(/spawn\([^;]*detached:\s*true[^;]*;/gs) ?? [];
    expect(detachedSpawns.length).toBeGreaterThan(0);
    // Either the quarantined object itself, or a fresh object spread FROM it (both see the deletions).
    for (const s of detachedSpawns) expect(s).toMatch(/env:\s*(?:process\.env|\{\s*\.\.\.process\.env)/);
  });
});

describe('tryExecAsync env handoff', () => {
  test('the git exec wrapper passes the (quarantined) process.env explicitly', () => {
    const start = SRC.indexOf('function tryExecAsync(');
    expect(start).toBeGreaterThan(-1);
    const body = SRC.slice(start, SRC.indexOf('\n}\n', start));
    expect(body).toMatch(/execFile\([\s\S]*?\{[^}]*env:\s*process\.env[^}]*\}/);
  });
});
