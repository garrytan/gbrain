/**
 * Failing-side proof for every check-module-size.sh rule. The guard-self-test
 * fixtures cover rule 1 (growth) in both policies; these tests drive rules
 * 2-4 and the unknown-policy arm through GBRAIN_GUARD_ROOT temp trees so no
 * rule can rot into a permanently-green no-op — the exact failure class the
 * module-size ratchet exists to kill.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO_ROOT, 'scripts', 'check-module-size.sh');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTree(tsvRows: string[], files: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-module-size-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'module-size-limits.tsv'), tsvRows.join('\n') + '\n');
  for (const [rel, lines] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, Array.from({ length: lines }, (_, i) => `export const l${i} = ${i};`).join('\n') + '\n');
  }
  return root;
}

/** Like makeTree but with verbatim file content (region-exempt fixtures). */
function makeTreeWithContent(tsvRows: string[], files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-module-size-'));
  tempDirs.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'module-size-limits.tsv'), tsvRows.join('\n') + '\n');
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function runGuard(root: string, env: Record<string, string> = {}) {
  const res = spawnSync('bash', [GUARD], {
    encoding: 'utf8',
    env: { ...process.env, GBRAIN_GUARD_ROOT: root, ...env },
    timeout: 30_000,
  });
  return { code: res.status ?? -1, out: `${res.stdout}\n${res.stderr}` };
}

describe('check-module-size.sh rule-by-rule failing sides', () => {
  test('rule 2: stale ceiling after a shrink fails with the exact lower-to value', () => {
    const root = makeTree(['src/small.ts\t500\tratchet\tfixture'], { 'src/small.ts': 10 });
    const r = runGuard(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('shrank to 10');
    expect(r.out).toContain('Lower the ceiling');
  });

  test('rule 2 slack: within the slack window passes', () => {
    const root = makeTree(['src/small.ts\t40\tratchet\tfixture'], { 'src/small.ts': 10 });
    const r = runGuard(root, { GBRAIN_MODULE_SIZE_SLACK: '50' });
    expect(r.code).toBe(0);
  });

  test('rule 3: a TSV row for a deleted file fails with remove-the-row', () => {
    const root = makeTree(['src/ghost.ts\t100\tratchet\tfixture'], {});
    const r = runGuard(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not exist');
    expect(r.out).toContain('remove the row');
  });

  test('rule 4: an unlisted src file over the cap fails; under the cap passes', () => {
    const over = makeTree([], { 'src/unlisted.ts': 30 });
    const rOver = runGuard(over, { GBRAIN_MODULE_SIZE_NEWFILE_CAP: '20' });
    expect(rOver.code).toBe(1);
    expect(rOver.out).toContain('over the 20 cap for files not listed');

    const under = makeTree([], { 'src/unlisted.ts': 10 });
    expect(runGuard(under, { GBRAIN_MODULE_SIZE_NEWFILE_CAP: '20' }).code).toBe(0);
  });

  test('unknown policy fails loudly instead of skipping the row', () => {
    const root = makeTree(['src/x.ts\t100\tfreeform\tfixture'], { 'src/x.ts': 10 });
    const r = runGuard(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unknown policy 'freeform'");
  });

  test('region-exempt: a spoof-named const (MIGRATIONS_ANYTHING) does not open the region', () => {
    // 23 total lines; 21 sit inside a region opened by a SPOOF-named const.
    // A loose prefix match would exempt them (measured 2 → pass); the
    // tightened opener (`export const MIGRATIONS` + ':', ' ', or '=')
    // measures all 23 lines → growth FAIL against the 5-line ceiling.
    const content =
      [
        'export const MIGRATIONS_ANYTHING = [',
        ...Array.from({ length: 20 }, (_, i) => `  { version: ${i} },`),
        '];',
        'export function runnerLogic() { return 1; }',
      ].join('\n') + '\n';
    const root = makeTreeWithContent(['src/spoof.ts\t5\tregion-exempt\tfixture'], { 'src/spoof.ts': content });
    const r = runGuard(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('over its 5 ceiling');
  });

  test('region-exempt: an unclosed MIGRATIONS region fails loudly instead of exempting the file tail', () => {
    // Region opens (the `= [` form) and never closes — EOF while in_region.
    // Ceiling 100 is generous on purpose: only the unclosed-region check can
    // produce this failure.
    const content =
      ['export const MIGRATIONS = [', '  { version: 1 },', '  { version: 2 },', '  { version: 3 },'].join('\n') + '\n';
    const root = makeTreeWithContent(['src/unclosed.ts\t100\tregion-exempt\tfixture'], {
      'src/unclosed.ts': content,
    });
    const r = runGuard(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('unclosed MIGRATIONS region');
  });

  test('all violations are accumulated, not first-fail', () => {
    const root = makeTree(
      ['src/ghost.ts\t100\tratchet\tfixture', 'src/big.ts\t5\tratchet\tfixture'],
      { 'src/big.ts': 30, 'src/unlisted.ts': 30 },
    );
    const r = runGuard(root, { GBRAIN_MODULE_SIZE_NEWFILE_CAP: '20' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not exist'); // rule 3
    expect(r.out).toContain('over its 5 ceiling'); // rule 1
    expect(r.out).toContain('for files not listed'); // rule 4 (src/unlisted.ts over the 20 cap)
  });
});
