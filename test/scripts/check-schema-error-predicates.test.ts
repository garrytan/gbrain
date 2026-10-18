/**
 * Wave 18b (1.1): scripts/check-schema-error-predicates.ts fails on a call to
 * a broad schema-error predicate or a raw '42703' comparison in src/ outside
 * src/core/utils.ts, names the strict replacement and how to allowlist, and
 * passes the strict predicate and the real tree.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const GUARD = join(REPO, 'scripts', 'check-schema-error-predicates.ts');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(files: Record<string, string> | null) {
  let env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GBRAIN_GUARD_ROOT;
  if (files) {
    const tree = mkdtempSync(join(tmpdir(), 'gbrain-schema-predicates-'));
    dirs.push(tree);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(tree, rel, '..'), { recursive: true });
      writeFileSync(join(tree, rel), body);
    }
    env = { ...env, GBRAIN_GUARD_ROOT: tree };
  }
  const r = spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('check-schema-error-predicates.ts', () => {
  test.each([
    ['isUndefinedColumnError', "import { isUndefinedColumnError } from '../utils.ts';\nexport const f = (e: unknown) => isUndefinedColumnError(e, 'x');\n"],
    ['isUndefinedTableError', "import { isUndefinedTableError } from '../utils.ts';\nexport const f = (e: unknown) => isUndefinedTableError(e);\n"],
    ['a dynamic-import destructure', "export async function f(e: unknown) { const { isUndefinedTableError } = await import('../utils.ts'); return isUndefinedTableError(e); }\n"],
    ['a raw === comparison', "export const f = (e: { code?: string }) => e.code === '42703';\n"],
    ['a raw !== comparison', "export const f = (e: { code?: string }) => '42703' !== e.code;\n"],
    ['a switch case', "export function f(code: string) { switch (code) { case '42703': return true; default: return false; } }\n"],
  ])('%s fails with location, the strict replacement and the allowlist recipe', (_label, body) => {
    const r = run({ 'src/core/doctor-thing/example.ts': body });
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL [schema_error_predicate_broad]: src/core/doctor-thing/example.ts:');
    expect(r.out).toContain('use isMissingSchemaObject(e, "column", [names])');
    expect(r.out).toContain('to ALLOWLIST in scripts/check-schema-error-predicates.ts');
    expect(r.out).toContain('See:  scripts/check-schema-error-predicates.ts (header)');
  });

  test('the strict predicate, comments, other SQLSTATEs and utils.ts itself pass', () => {
    const r = run({
      'src/core/utils.ts': "export function isUndefinedColumnError(e: unknown, c: string) { return (e as { code?: string }).code === '42703' || String(e).includes(c); }\n",
      'src/core/ok.ts': [
        "import { isMissingSchemaObject } from './utils.ts';",
        '// isUndefinedColumnError(e) in a comment is not a call.',
        "export const f = (e: unknown) => isMissingSchemaObject(e, 'column', ['a', 'b']);",
        "export const g = (e: { code?: string }) => e.code === '42P01' || e.code === '42501';",
        "export const h = { codes: ['42703'] };",
      ].join('\n') + '\n',
    });
    expect(r.out).toContain('check-schema-error-predicates: ok');
    expect(r.code).toBe(0);
  });

  test('the real tree passes (every remaining broad use is allowlisted with a reason)', () => {
    const r = run(null);
    expect(r.out).toContain('check-schema-error-predicates: ok');
    expect(r.code).toBe(0);
  });
});
