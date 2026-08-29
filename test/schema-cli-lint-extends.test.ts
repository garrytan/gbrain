// #4501 — `gbrain schema lint <name>` must lint the MERGED manifest
// (extends chain resolved), matching the no-name branch's loadActivePack
// path. Pre-fix, the named-pack branch linted the raw loadPackFromFile
// manifest, so a child pack referencing inherited parent types (e.g.
// `enrichable_types: [{type: person}]` with person declared in
// gbrain-base) failed lint with `enrichable_types_undeclared`.
//
// Hermetic subprocess tests, same pattern as test/schema-cli.test.ts.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');

let GBRAIN_HOME: string;

beforeAll(() => {
  GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-schema-lint-extends-'));
  // gbrainPath appends '.gbrain' to GBRAIN_HOME.
  const packsDir = join(GBRAIN_HOME, '.gbrain', 'schema-packs');

  // Child pack extending gbrain-base; references the INHERITED 'person'
  // page_type. Lint-clean only when the extends chain is resolved.
  mkdirSync(join(packsDir, 'lint-child'), { recursive: true });
  writeFileSync(join(packsDir, 'lint-child', 'pack.yaml'), [
    'api_version: gbrain-schema-pack-v1',
    'name: lint-child',
    'version: 1.0.0',
    'extends: gbrain-base',
    'enrichable_types:',
    '  - type: person',
    '',
  ].join('\n'), 'utf-8');

  // Child pack whose parent doesn't exist — lint must fall back to the
  // raw child manifest with a warning instead of hard-failing.
  mkdirSync(join(packsDir, 'lint-orphan'), { recursive: true });
  writeFileSync(join(packsDir, 'lint-orphan', 'pack.yaml'), [
    'api_version: gbrain-schema-pack-v1',
    'name: lint-orphan',
    'version: 1.0.0',
    'extends: no-such-parent-pack',
    'page_types:',
    '  - name: widget',
    '    primitive: entity',
    '',
  ].join('\n'), 'utf-8');
});

afterAll(() => {
  rmSync(GBRAIN_HOME, { recursive: true, force: true });
});

function gbrain(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync('bun', ['run', 'src/cli.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GBRAIN_DATABASE_URL: '',
      DATABASE_URL: '',
      GBRAIN_HOME,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code: result.status ?? -1,
  };
}

describe('gbrain schema lint <name> resolves the extends chain (#4501)', () => {
  test('child pack referencing inherited parent type lints clean', () => {
    const r = gbrain(['schema', 'lint', 'lint-child']);
    expect(r.stdout + r.stderr).not.toContain('enrichable_types_undeclared');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('lint clean');
  }, 30000);

  test('--json reports the child pack name against the merged manifest', () => {
    const r = gbrain(['schema', 'lint', 'lint-child', '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.pack).toBe('lint-child');
    expect(parsed.ok).toBe(true);
  }, 30000);

  test('missing parent falls back to raw child manifest with a stderr warning', () => {
    const r = gbrain(['schema', 'lint', 'lint-orphan']);
    // The raw child itself is lint-clean, so the command succeeds …
    expect(r.code).toBe(0);
    // … but the unresolvable chain is surfaced on stderr.
    expect(r.stderr).toContain('could not resolve extends chain');
    expect(r.stderr).toContain('lint-orphan');
  }, 30000);

  test('unknown pack name still errors', () => {
    const r = gbrain(['schema', 'lint', 'no-such-pack-anywhere']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Pack not found');
  }, 30000);
});
