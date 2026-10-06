#!/usr/bin/env bun
/**
 * Postgres-arm lane guard (GBRA-47 D8; docs/TESTING.md#coverage-responsibilities-before-consolidation).
 *
 * The unit, serial and slow lanes unset DATABASE_URL, so a test file whose
 * PostgreSQL arm is gated on it runs that arm only where a Postgres lane names
 * the file. This guard fails on every test/ file outside test/e2e/ that has
 * such an arm and no Postgres lane:
 *
 *   - arm: a zero-argument `testBackends()` call, or a `process.env.DATABASE_URL`
 *     read (directly or through a variable that holds it) used as a condition,
 *     a call or constructor argument, or a `database_url`/`databaseUrl`
 *     property value. Code inside a `withEnv({ DATABASE_URL: ... })` callback
 *     supplies its own URL and is not an arm.
 *   - lane: a row in test/postgres-unit-arms.txt (persistence-validation's
 *     unit-postgres-arms job and the race hunt read it); a workflow step that
 *     runs with DATABASE_URL (step, job or workflow env, or exported in its
 *     script) and names the file; a test/e2e/ file that imports it (the
 *     registerPostgresTests wrappers); a tests/heavy/ script that names it (the
 *     heavy job runs with DATABASE_URL); or a row in scripts/e2e-backend-matrix.txt.
 *
 * An arm that is deliberately not run yet is an ALLOWLIST row naming its
 * reason and TODO; a row for a file that is laned, has no arm or is gone fails.
 * A test/postgres-unit-arms.txt row that is malformed, duplicated, unsorted,
 * names a missing file or a file with no gated arm fails too.
 *
 * test/fixtures/ is never scanned. Seam: GBRAIN_GUARD_ROOT (fixture tree root);
 * in a fixture tree `*.test.fixture.ts` files count as their `*.test.ts` names,
 * so committed self-test fixtures stay out of bun's test discovery.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { load } from 'js-yaml';
import ts from 'typescript';
import { ARMS_LIST, readArmsList } from './postgres-unit-arms.ts';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const TEST_FILE = process.env.GBRAIN_GUARD_ROOT ? /\.test(\.fixture)?\.ts$/ : /\.test\.ts$/;
const DOCS = 'docs/TESTING.md#coverage-responsibilities-before-consolidation';
const LIST_DOCS = 'docs/TESTING.md#postgres-arm-lanes';

/** Arms deliberately left out of every Postgres lane. Each row names its reason and TODO. */
const ALLOWLIST: Record<string, string> = {
  'test/export-scale.slow.test.ts': 'the 100,001-page Postgres arm passes but takes ~9 minutes; no lane has that budget yet (TODOS: give the export-scale Postgres arm a scheduled lane)',
};

function files(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...files(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}
const rel = (abs: string) => relative(ROOT, abs).replace(/\\/g, '/').replace(/\.test\.fixture\.ts$/, '.test.ts');
const TEST_PATH = /\btest\/[A-Za-z0-9_./-]+\.test\.ts\b/g;

function isDatabaseUrlRead(node: ts.Node): boolean {
  const env = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === 'env'
    && ts.isIdentifier(e.expression) && e.expression.text === 'process';
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'DATABASE_URL' && env(node.expression);
  if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression)
    && node.argumentExpression.text === 'DATABASE_URL' && env(node.expression);
  return false;
}

/** How a value flows from `node`: 'gate' (condition, argument, connection URL), a variable name it initializes, or null. */
function use(node: ts.Node): 'gate' | { alias: string } | null {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)
      || ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) continue;
    if (ts.isConditionalExpression(parent)) { if (parent.condition === child) return 'gate'; continue; }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      return op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken ? 'gate' : null;
    }
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent)) return parent.expression === child ? 'gate' : null;
    if (ts.isCallExpression(parent)) {
      if (parent.expression === child) return null;
      const callee = parent.expression;
      return ts.isIdentifier(callee) && callee.text === 'expect' ? null : 'gate';
    }
    if (ts.isNewExpression(parent)) return parent.expression === child ? null : 'gate';
    if (ts.isPropertyAssignment(parent)) {
      const name = ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name) ? parent.name.text : '';
      return ['database_url', 'databaseUrl'].includes(name) ? 'gate' : null;
    }
    if (ts.isVariableDeclaration(parent)) return ts.isIdentifier(parent.name) ? { alias: parent.name.text } : null;
    return null;
  }
  return null;
}

/** Inside a `withEnv({ DATABASE_URL: ... }, ...)` callback the file supplies the URL itself, so nothing gates on the lane. */
function underOwnDatabaseUrl(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'withEnv') {
      const env = parent.arguments[0];
      if (env && ts.isObjectLiteralExpression(env) && env.properties.some(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) && p.name.text === 'DATABASE_URL')) return true;
    }
  }
  return false;
}

/** First line of a Postgres arm in `path`, or null. */
export function postgresArm(path: string): { line: number; what: string } | null {
  const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const aliases = new Set<string>();
  const found: Array<{ line: number; what: string }> = [];
  const reads: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'testBackends' && node.arguments.length === 0
      && !underOwnDatabaseUrl(node)) {
      found.push({ line: line(node), what: 'testBackends()' });
    }
    if (isDatabaseUrlRead(node) && !underOwnDatabaseUrl(node)) reads.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const read of reads) {
    const flow = use(read);
    if (flow === 'gate') found.push({ line: line(read), what: 'process.env.DATABASE_URL' });
    else if (flow) aliases.add(flow.alias);
  }
  if (aliases.size) {
    const refs = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && aliases.has(node.text) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
        && use(node) === 'gate') found.push({ line: line(node), what: `${node.text} (holds process.env.DATABASE_URL)` });
      ts.forEachChild(node, refs);
    };
    refs(sf);
  }
  return found.sort((a, b) => a.line - b.line)[0] ?? null;
}

/** Test files a Postgres lane runs, with where each is named. */
export function postgresLanes(): Map<string, string> {
  const laned = new Map<string, string>();
  const add = (path: string, lane: string) => { if (!laned.has(path)) laned.set(path, lane); };
  for (const path of readArmsList(ROOT).files) add(path, ARMS_LIST);
  for (const workflow of files(join(ROOT, '.github', 'workflows'), name => /\.ya?ml$/.test(name))) {
    const doc = load(readFileSync(workflow, 'utf8')) as { env?: Record<string, unknown>; jobs?: Record<string, { env?: Record<string, unknown>; steps?: Array<{ name?: string; env?: Record<string, unknown>; run?: string }> }> } | undefined;
    for (const [jobName, job] of Object.entries(doc?.jobs ?? {})) for (const step of job.steps ?? []) {
      const run = String(step.run ?? '');
      if (!(step.env?.DATABASE_URL || job.env?.DATABASE_URL || doc?.env?.DATABASE_URL || /\bDATABASE_URL=/.test(run))) continue;
      for (const [path] of run.matchAll(TEST_PATH)) add(path, `${rel(workflow)} › ${jobName} › ${step.name ?? 'run'}`);
    }
  }
  for (const wrapper of files(join(ROOT, 'test', 'e2e'), name => TEST_FILE.test(name))) {
    for (const [, spec] of readFileSync(wrapper, 'utf8').matchAll(/(?:\bimport\s*\(\s*|\bfrom\s+)['"](\.{1,2}\/[^'"]+\.test(?:\.fixture)?\.ts)['"]/g)) {
      add(rel(resolve(dirname(wrapper), spec)), rel(wrapper));
    }
  }
  for (const script of files(join(ROOT, 'tests', 'heavy'), name => name.endsWith('.sh'))) {
    for (const [path] of readFileSync(script, 'utf8').matchAll(TEST_PATH)) add(path, rel(script));
  }
  const matrix = join(ROOT, 'scripts', 'e2e-backend-matrix.txt');
  if (existsSync(matrix)) for (const row of readFileSync(matrix, 'utf8').split('\n')) {
    if (row && !row.startsWith('#') && !row.startsWith('!')) add(row.split('\t')[0], 'scripts/e2e-backend-matrix.txt');
  }
  return laned;
}

/** Every test file outside test/e2e/ and test/fixtures/ with a DATABASE_URL-gated arm, and the arm's first line. */
export function armedFiles(): Map<string, { line: number; what: string }> {
  const armed = new Map<string, { line: number; what: string }>();
  for (const abs of files(join(ROOT, 'test'), name => TEST_FILE.test(name))) {
    const path = rel(abs);
    if (path.startsWith('test/e2e/') || path.startsWith('test/fixtures/')) continue;
    const arm = postgresArm(abs);
    if (arm) armed.set(path, arm);
  }
  return armed;
}

function main(): number {
  const laned = postgresLanes();
  const armed = armedFiles();
  const failures: string[] = [];
  for (const [path, arm] of armed) {
    if (laned.has(path) || ALLOWLIST[path]) continue;
    failures.push(`FAIL [postgres_arm_unlaned]: ${path}:${arm.line} gates a PostgreSQL arm on DATABASE_URL (${arm.what}) and no Postgres lane runs it\n`
      + `  Why: the unit, serial and slow lanes unset DATABASE_URL, so this arm skips in every CI lane.\n`
      + `  Fix: add ${path} to ${ARMS_LIST} (one line, in sorted order), or load it from a test/e2e/*-postgres.test.ts wrapper with registerPostgresTests\n`
      + `  Docs: ${DOCS}`);
  }
  const list = readArmsList(ROOT);
  for (const error of list.errors) {
    failures.push(`FAIL [postgres_arm_list_invalid]: ${error}\n`
      + `  Why: unit-postgres-arms and the race hunt read every row; a bad row drops or duplicates an arm.\n`
      + `  Fix: correct that line of ${ARMS_LIST}\n`
      + `  Docs: ${LIST_DOCS}`);
  }
  for (const path of list.files) {
    if (armed.has(path)) continue;
    const problem = existsSync(join(ROOT, path)) ? 'names a file with no DATABASE_URL-gated arm' : 'names a missing file';
    failures.push(`FAIL [postgres_arm_list_stale]: the ${ARMS_LIST} row ${path} ${problem}\n`
      + `  Why: unit-postgres-arms would run it without any PostgreSQL arm (or fail on the missing path), so the row proves nothing.\n`
      + `  Fix: delete the ${path} line from ${ARMS_LIST}\n`
      + `  Docs: ${LIST_DOCS}`);
  }
  for (const [path, reason] of Object.entries(ALLOWLIST)) {
    const problem = !armed.has(path) && !existsSync(join(ROOT, path)) ? 'names a missing file'
      : !armed.has(path) ? 'names a file with no DATABASE_URL-gated arm'
      : laned.has(path) ? `names a file a Postgres lane already runs (${laned.get(path)})` : null;
    if (!problem) continue;
    failures.push(`FAIL [postgres_arm_allowlist_stale]: the ALLOWLIST row for ${path} ${problem} (reason was: ${reason})\n`
      + `  Why: a stale row would hide the next arm added to that path.\n`
      + `  Fix: delete the ${path} row from ALLOWLIST in scripts/check-postgres-lane-coverage.ts\n`
      + `  Docs: ${DOCS}`);
  }
  if (failures.length) {
    console.error(failures.join('\n'));
    console.error(`\n${failures.length} Postgres-arm lane problem(s).`);
    return 1;
  }
  console.log(`postgres-lane-coverage: ${armed.size} test files with a DATABASE_URL-gated arm; ${armed.size - Object.keys(ALLOWLIST).length} run in a Postgres lane, ${Object.keys(ALLOWLIST).length} allowlisted.`);
  return 0;
}

if (import.meta.main) process.exit(main());
