/**
 * T-G12 (refactor wave 1, E3 / EO19): scripts/verify-move-only.ts.
 *
 * Protects: the move proof reviewers rely on for ~50k moved lines. A pure move
 * (re-indented, comments changed, helper newly exported, W3 migration wrapper,
 * W4 doctor-entry wrapper,
 * SyncRun-style rename map) passes; a single edited token fails in every mode
 * and the failure names file:line and the first differing token.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatReport, verifyMoveOnly } from '../../scripts/verify-move-only.ts';

const BASE_MIGRATE = `import type { BrainEngine } from './engine.ts';

async function dropInvalid(engine: BrainEngine, v: number): Promise<void> {
  await engine.runMigration(v, 'DROP INDEX CONCURRENTLY IF EXISTS x;');
}

export const MIGRATIONS: Migration[] = [
  // Version 1 is the baseline.
  {
    version: 2,
    name: 'first',
    sql: \`CREATE TABLE a (id int);\`,
  },
  {
    version: 4,
    name: 'second',
    sql: '',
    handler: async (engine) => {
      await dropInvalid(engine, 4);
    },
  },
  {
    version: 3,
    name: 'third',
    sql: 'SELECT 1;',
  },
];

export function runner(): number {
  return MIGRATIONS.length;
}
`;

const HEAD_MIGRATE = `import type { BrainEngine } from './engine.ts';
import { MIGRATIONS } from './schema-migrations/registry.generated.ts';

export { MIGRATIONS };

export function runner(): number {
  return MIGRATIONS.length;
}
`;

const HEAD_HELPERS = `import type { BrainEngine } from '../engine.ts';

/** moved and newly exported */
export async function dropInvalid(engine: BrainEngine, v: number): Promise<void> {
  await engine.runMigration(v, 'DROP INDEX CONCURRENTLY IF EXISTS x;');
}
`;

const v002 = `import type { Migration } from './types.ts';

// Version 1 is the baseline.
export const v002: Migration = {
      version: 2,
      name: 'first',
      sql: \`CREATE TABLE a (id int);\`,
};
`;
const v003 = `import type { Migration } from './types.ts';

export const v003: Migration = { version: 3, name: 'third', sql: 'SELECT 1;', };
`;
const v004 = (body = 'await dropInvalid(engine, 4);') => `import type { Migration } from './types.ts';
import { dropInvalid } from './helpers.ts';

export const v004: Migration = {
  version: 4,
  name: 'second',
  sql: '',
  handler: async (engine) => {
    ${body}
  },
};
`;
const REGISTRY = (order = 'v002, v004, v003,') => `// AUTO-GENERATED
import type { Migration } from './types.ts';
import { v002 } from './v002-first.ts';
import { v003 } from './v003-third.ts';
import { v004 } from './v004-second.ts';

export const MIGRATIONS: Migration[] = [${order}];
`;

function headFiles(overrides: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'src/core/migrate.ts': HEAD_MIGRATE,
    'src/core/schema-migrations/helpers.ts': HEAD_HELPERS,
    'src/core/schema-migrations/v002-first.ts': v002,
    'src/core/schema-migrations/v003-third.ts': v003,
    'src/core/schema-migrations/v004-second.ts': v004(),
    'src/core/schema-migrations/registry.generated.ts': REGISTRY(),
    ...overrides,
  };
  return Object.entries(files).map(([path, text]) => ({ path, text }));
}
const baseFiles = [{ path: 'src/core/migrate.ts', text: BASE_MIGRATE }];

describe('verify-move-only: wrapper mode (W3 migration split)', () => {
  test('a real split into per-version files + generated registry passes', () => {
    const r = verifyMoveOnly(baseFiles, headFiles(), { wrapper: 'migration' });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.wrappedDefinitions).toBe(3);
    expect(formatReport(r, 'x..y')).toStartWith('OK: x..y is move-only');
  });

  test('without --wrapper the same split is not a move (wrappers are new statements)', () => {
    expect(verifyMoveOnly(baseFiles, headFiles()).ok).toBe(false);
  });

  test('one edited token inside a moved handler fails and names the file', () => {
    const r = verifyMoveOnly(baseFiles, headFiles({ 'src/core/schema-migrations/v004-second.ts': v004('await dropInvalid(engine, 5);') }), { wrapper: 'migration' });
    expect(r.ok).toBe(false);
    const report = formatReport(r, 'x..y');
    expect(report).toContain('FAIL: src/core/schema-migrations/registry.generated.ts:7 statement differs from src/core/migrate.ts:7');
    expect(report).toContain('first difference at token');
    for (const label of ['Why:', 'Fix:', 'See:  docs/TESTING.md#move-only-verifier']) expect(report).toContain(label);
  });

  test('registry order differing from the original array fails', () => {
    const r = verifyMoveOnly(baseFiles, headFiles({ 'src/core/schema-migrations/registry.generated.ts': REGISTRY('v002, v003, v004,') }), { wrapper: 'migration' });
    expect(r.ok).toBe(false);
  });

  test('a moved migration left out of the registry fails', () => {
    const r = verifyMoveOnly(baseFiles, headFiles({ 'src/core/schema-migrations/registry.generated.ts': REGISTRY('v002, v004,') }), { wrapper: 'migration' });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('wrapper v003 is defined but never referenced');
  });

  test('an edited helper body fails even though only imports changed elsewhere', () => {
    const edited = HEAD_HELPERS.replace('IF EXISTS x;', 'IF EXISTS y;');
    expect(verifyMoveOnly(baseFiles, headFiles({ 'src/core/schema-migrations/helpers.ts': edited }), { wrapper: 'migration' }).ok).toBe(false);
  });
});

describe('verify-move-only: doctor-entry mode (W4 doctor peel)', () => {
  const BASE_DOCTOR = `export async function buildChecks(engine: BrainEngine | null, args: string[]): Promise<Check[]> {
  const fastMode = args.includes('--fast');
  const checks: Check[] = [];
  // 1. First block.
  if (engine && !fastMode) {
    const { probe } = await import('./doctor/checks/probe.ts');
    checks.push(await probe(engine));
  }
  checks.push({ name: 'alpha_example', status: 'ok', message: \`fast=\${fastMode}\` });
  if (!engine) return checks;
  checks.push({ name: 'beta_example', status: 'ok', message: 'db' });
  return checks;
}
`;
  const entry = (body = "checks.push({ name: 'alpha_example', status: 'ok', message: \`fast=\${fastMode}\` });") => `import type { Check } from '../../doctor.ts';
import type { DoctorContext } from '../context.ts';

export async function runFirst(ctx: DoctorContext): Promise<Check[]> {
  const { engine, fastMode } = ctx;
  const checks: Check[] = [];
  // 1. First block, moved.
  if (engine && !fastMode) {
    const { probe } = await import('./probe.ts');
    checks.push(await probe(engine));
  }
  ${body}
  return checks;
}
`;
  const HEAD_DOCTOR = `import { runFirst } from './doctor/checks/first.ts';
export async function buildChecks(engine: BrainEngine | null, args: string[]): Promise<Check[]> {
  const fastMode = args.includes('--fast');
  const checks: Check[] = [];
  const ctx: DoctorContext = { engine, args, fastMode };
  checks.push(...(await runFirst(ctx)));
  if (!engine) return checks;
  checks.push({ name: 'beta_example', status: 'ok', message: 'db' });
  return checks;
}
`;
  const base = [{ path: 'src/commands/doctor.ts', text: BASE_DOCTOR }];
  const head = (first = entry(), doctor = HEAD_DOCTOR) => [
    { path: 'src/commands/doctor.ts', text: doctor },
    { path: 'src/commands/doctor/checks/first.ts', text: first },
  ];

  test('blocks moved into run<Topic>(ctx) entries with re-rooted import() specifiers pass', () => {
    const r = verifyMoveOnly(base, head(), { wrapper: 'doctor-entry' });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.wrappedDefinitions).toBe(1);
  });

  test('without --wrapper doctor-entry the same move fails', () => {
    expect(verifyMoveOnly(base, head()).ok).toBe(false);
  });

  test('one edited token inside a moved block fails', () => {
    const r = verifyMoveOnly(base, head(entry("checks.push({ name: 'alpha_example', status: 'warn', message: \`fast=\${fastMode}\` });")), { wrapper: 'doctor-entry' });
    expect(r.ok).toBe(false);
    expect(formatReport(r, 'x..y')).toContain('FAIL: src/commands/doctor.ts:2 statement differs from src/commands/doctor.ts:1');
  });

  test('a specifier that resolves to a different module fails', () => {
    const r = verifyMoveOnly(base, head(entry().replace("import('./probe.ts')", "import('./probe-other.ts')")), { wrapper: 'doctor-entry' });
    expect(r.ok).toBe(false);
  });

  test('an entry that buildChecks never calls fails', () => {
    const r = verifyMoveOnly(base, head(entry(), HEAD_DOCTOR.replace('  checks.push(...(await runFirst(ctx)));\n', '')), { wrapper: 'doctor-entry' });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain('entry runFirst is defined but never called from buildChecks');
  });

  test('an edit next to the call site, outside any entry, fails', () => {
    const r = verifyMoveOnly(base, head(entry(), HEAD_DOCTOR.replace('if (!engine) return checks;', 'if (!engine) return [];')), { wrapper: 'doctor-entry' });
    expect(r.ok).toBe(false);
  });
});

describe('verify-move-only: rename-map mode (Mechanical-Rename)', () => {
  const base = [{ path: 'src/commands/sync.ts', text: 'export async function phase(run: SyncRun) {\n  if (pullFailed) return 1;\n  pullFailed = true;\n  return 0;\n}\n' }];
  const head = [{ path: 'src/commands/sync.ts', text: 'export async function phase(run: SyncRun) {\n  if (run.pullFailed) return 1;\n  run.pullFailed = true;\n  return 0;\n}\n' }];

  test('identifier rewrites listed in the map pass', () => {
    expect(verifyMoveOnly(base, head, { renameMap: { pullFailed: 'run.pullFailed' } }).ok).toBe(true);
  });

  test('without the map the rewrite fails', () => {
    expect(verifyMoveOnly(base, head).ok).toBe(false);
  });

  test('one edited token beyond the map fails', () => {
    const edited = [{ path: head[0]!.path, text: head[0]!.text.replace('return 1', 'return 2') }];
    expect(verifyMoveOnly(base, edited, { renameMap: { pullFailed: 'run.pullFailed' } }).ok).toBe(false);
  });
});

describe('verify-move-only: default mode', () => {
  test('moving a function to another file, re-indented with new comments, passes', () => {
    const base = [{ path: 'a.ts', text: 'export function f(x: number) {\n  return x + 1;\n}\nexport const K = `SQL  text`;\n' }];
    const head = [
      { path: 'a.ts', text: "export { f } from './b.ts';\nexport const K = `SQL  text`;\n" },
      { path: 'b.ts', text: '// moved\nexport function f(x: number) {\n    return x + 1; // same\n}\n' },
    ];
    expect(verifyMoveOnly(base, head).ok).toBe(true);
  });

  test('whitespace inside a template literal is significant (SQL is never normalized)', () => {
    const base = [{ path: 'a.ts', text: 'export const K = `SQL  text`;\n' }];
    const head = [{ path: 'a.ts', text: 'export const K = `SQL text`;\n' }];
    expect(verifyMoveOnly(base, head).ok).toBe(false);
  });
});

describe('verify-move-only CLI over a git commit', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const SCRIPT = resolve(import.meta.dir, '..', '..', 'scripts', 'verify-move-only.ts');

  function repo(): (args: string[]) => string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-move-only-'));
    dirs.push(dir);
    const run = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout;
    };
    run(['init', '-q']);
    run(['config', 'user.email', 'alice-example@example.com']);
    run(['config', 'user.name', 'alice-example']);
    run(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'a.ts'), 'export function f() {\n  return 1;\n}\nexport function g() {\n  return 2;\n}\n');
    run(['add', '.']);
    run(['commit', '-qm', 'base']);
    return (args) => {
      if (args[0] === 'write') {
        writeFileSync(join(dir, args[1]!), args[2]!);
        return '';
      }
      if (args[0] === 'cli') return JSON.stringify(spawnSync('bun', [SCRIPT, ...args.slice(1)], { cwd: dir, encoding: 'utf8' }));
      return run(args);
    };
  }

  test('passes on a move commit and fails on an edit commit', () => {
    const r = repo();
    r(['write', 'a.ts', 'export function f() {\n  return 1;\n}\n']);
    r(['write', 'b.ts', 'export function g() {\n  return 2;\n}\n']);
    r(['add', '.']);
    r(['commit', '-qm', 'move g']);
    const ok = JSON.parse(r(['cli']));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('is move-only: 2 top-level statements across 2 files');

    r(['write', 'b.ts', 'export function g() {\n  return 3;\n}\n']);
    r(['add', '.']);
    r(['commit', '-qm', 'edit g']);
    const bad = JSON.parse(r(['cli', 'HEAD']));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('FAIL: b.ts:1 statement differs from b.ts:1');
  });
});
