/**
 * Failing-side proof for every check-orphan-modules.mjs rule. The
 * guard-self-test fixtures cover the hard-orphan rule (bad) and the pass path
 * with a permitted test-only and a script-reachable module (good); these tests
 * drive the named permitted-set rules through GBRAIN_GUARD_ROOT temp trees and
 * pin the diagnostic contract (rule, module, importers, reason, remedy, rerun
 * command, docs anchor), so a delete-one-add-one swap or a stale entry cannot
 * pass silently.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO_ROOT, 'scripts', 'check-orphan-modules.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Permitted = Array<{ path?: string; reason?: string }>;

function makeTree(files: Record<string, string>, permitted?: Permitted): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-orphan-modules-'));
  tempDirs.push(root);
  const all: Record<string, string> = {
    'src/entry.ts': "import { used } from './used.ts';\nconsole.log(used);\n",
    'src/used.ts': "export const used = 'reachable';\n",
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  if (permitted) writeFileSync(join(root, 'permitted-test-only.json'), JSON.stringify(permitted));
  return root;
}

function runGuard(root: string) {
  const r = spawnSync('node', [GUARD], { env: { ...process.env, GBRAIN_GUARD_ROOT: root }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function expectDiagnostic(stderr: string, rule: string, path: string) {
  expect(stderr).toContain(`FAIL [orphan-modules/${rule}] ${path}`);
  expect(stderr).toContain('rerun: bun run check:orphan-modules');
  expect(stderr).toContain('docs: docs/TESTING.md#orphan-module-guard');
}

const helperTree = {
  'src/helper.ts': "export const helper = 1;\n",
  'test/uses-helper.ts': "import { helper } from '../src/helper.ts';\nexport const h = helper;\n",
};

describe('check-orphan-modules permitted test-only set', () => {
  test('a permitted test-only module passes', () => {
    const r = runGuard(makeTree(helperTree, [{ path: 'src/helper.ts', reason: 'fixture helper' }]));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('1 permitted test-only');
  });

  test('a new test-only module missing from the set fails with its importing tests', () => {
    const r = runGuard(makeTree(helperTree, []));
    expect(r.status).toBe(1);
    expectDiagnostic(r.stderr, 'unpermitted-test-only', 'src/helper.ts');
    expect(r.stderr).toContain('imported by: test/uses-helper.ts');
    expect(r.stderr).toContain('reachable from tests but from no runtime entrypoint');
    expect(r.stderr).toContain('add { path, reason } to PERMITTED_TEST_ONLY');
  });

  test('a delete-one-add-one swap fails: the new module is unpermitted and the old entry is stale', () => {
    const r = runGuard(makeTree(helperTree, [{ path: 'src/removed.ts', reason: 'fixture helper' }]));
    expect(r.status).toBe(1);
    expectDiagnostic(r.stderr, 'unpermitted-test-only', 'src/helper.ts');
    expectDiagnostic(r.stderr, 'stale-permitted-entry', 'src/removed.ts');
    expect(r.stderr).toContain('reason: the module no longer exists');
  });

  test('an entry whose module became runtime-reachable is stale', () => {
    const r = runGuard(makeTree({
      ...helperTree,
      'src/entry.ts': "import { used } from './used.ts';\nimport { helper } from './helper.ts';\nconsole.log(used, helper);\n",
    }, [{ path: 'src/helper.ts', reason: 'fixture helper' }]));
    expect(r.status).toBe(1);
    expectDiagnostic(r.stderr, 'stale-permitted-entry', 'src/helper.ts');
    expect(r.stderr).toContain('reason: the module is now reachable from a runtime entrypoint');
    expect(r.stderr).toContain('do not restore code to satisfy the list');
  });

  test('an entry no test imports any more is stale (and the module is a hard orphan)', () => {
    const r = runGuard(makeTree({ 'src/helper.ts': "export const helper = 1;\n" }, [{ path: 'src/helper.ts', reason: 'fixture helper' }]));
    expect(r.status).toBe(1);
    expectDiagnostic(r.stderr, 'stale-permitted-entry', 'src/helper.ts');
    expect(r.stderr).toContain('reason: no test imports the module any more');
  });

  test("a 'script-reachable' entry must be imported from scripts/**", () => {
    const tagged: Permitted = [{ path: 'src/helper.ts', reason: 'script-reachable' }];
    const stale = runGuard(makeTree(helperTree, tagged));
    expect(stale.status).toBe(1);
    expectDiagnostic(stale.stderr, 'stale-permitted-entry', 'src/helper.ts');
    expect(stale.stderr).toContain("tagged 'script-reachable' but no scripts/** file imports it");

    const reached = runGuard(makeTree({
      ...helperTree,
      'scripts/gen.ts': "import { helper } from '../src/helper.ts';\nexport const g = helper;\n",
    }, tagged));
    expect(reached.status).toBe(0);
  });

  test('an entry without a reason is invalid', () => {
    const r = runGuard(makeTree(helperTree, [{ path: 'src/helper.ts', reason: ' ' }]));
    expect(r.status).toBe(1);
    expectDiagnostic(r.stderr, 'invalid-permitted-entry', 'src/helper.ts');
    expect(r.stderr).toContain('every permitted test-only module needs one');
  });

  test('a module imported by nothing is a hard orphan', () => {
    const r = runGuard(makeTree({ 'src/orphan.ts': "export const o = 1;\n" }));
    expect(r.status).toBe(1);
    expectDiagnostic(r.stderr, 'hard-orphan', 'src/orphan.ts');
    expect(r.stderr).toContain('unreachable from every runtime entrypoint and every test');
  });
});
