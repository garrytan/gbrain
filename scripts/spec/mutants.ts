#!/usr/bin/env bun
/**
 * Guard mutants for the TLA+ specs (spec/tla/README.md). Each mutant in spec/tla/<spec>/mutants.json removes one guard:
 *
 * - its `spec` edit is applied to a copy of the model, and TLC must report the named property (or nothing, for a
 *   mutant marked `survives`: a guard that is defense in depth at these bounds);
 * - its `code` edits, when present, are applied to the implementation in a scratch copy of the working tree, and each
 *   named test must fail on its own assertions under them and pass without them. That ties each guard the model relies
 *   on to the lines that implement it (every engine branch) and the tests that pin it.
 *
 *   bun scripts/spec/mutants.ts [<spec>] [--only <id>] [--spec-only | --code-only] [--require-postgres]
 *
 * Failure codes: MUTANT_USAGE (unknown or contradictory flags), MUTANT_NOTHING_CHECKED (every selected check was skipped), MUTANT_STALE (an edit's `before` text is not found exactly
 * once: the spec or code moved; update the mutant), MUTANT_SURVIVED (TLC found no violation, or the test passed under the
 * code edit: a property or a test no longer catches the guard), MUTANT_WRONG_PROPERTY, MUTANT_INCOMPLETE (TLC did not
 * finish, or a test failed without the edit, matched no test, or did not run to a clean assertion failure with it: a
 * signal, timeout, load error or non-assertion failure proves nothing). Each invocation writes to its own directory under TLC_OUT
 * (default .context/tlc), printed first: the scratch tree, every child's full output and each test's JUnit report.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

interface Edit { file: string; before: string; after: string }
interface CodeTest { test: string; filter: string; postgres?: boolean }
interface CodeEdit { edits: Edit[]; tests: CodeTest[] }
interface Mutant { id: string; kind: 'guard' | 'assumption' | 'survivor'; title: string; expect: string; reason?: string; config?: string; spec: Edit; code?: CodeEdit }
interface Catalog { module: string; config: string; mutants: Mutant[] }

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const FLAGS = new Set(['--only', '--spec-only', '--code-only', '--require-postgres']);
const unknown = args.filter(a => a.startsWith('--') && !FLAGS.has(a));
if (unknown.length) { console.error(`MUTANT_USAGE: unknown flag ${unknown.join(', ')}. Usage: bun scripts/spec/mutants.ts [<spec>] [--only <id>] [--spec-only | --code-only] [--require-postgres]`); process.exit(2); }
if (flag('--spec-only') && flag('--code-only')) { console.error('MUTANT_USAGE: --spec-only and --code-only together would check nothing; pass at most one.'); process.exit(2); }
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const specName = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? 'drain-lease';
const specDir = join(ROOT, 'spec/tla', specName);
const catalog = JSON.parse(readFileSync(join(specDir, 'mutants.json'), 'utf8')) as Catalog;
const out = join(process.env.TLC_OUT ?? join(ROOT, '.context/tlc'), `mutants-${specName}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const timeoutS = Number(process.env.TLC_TIMEOUT_S ?? 300);
const failures: string[] = [];
let skipped = 0, checked = 0;
const fail = (code: string, id: string, message: string) => { failures.push(`${code} ${id}: ${message}`); console.error(`FAIL ${code} ${id}: ${message}`); };

function applyOnce(text: string, edit: Edit): string | null {
  const at = text.indexOf(edit.before);
  if (at < 0 || text.indexOf(edit.before, at + 1) >= 0) return null;
  return text.slice(0, at) + edit.after + text.slice(at + edit.before.length);
}

function jar(): string {
  const r = spawnSync('bash', [join(ROOT, 'scripts/spec/tla-jar.sh')], { encoding: 'utf8' });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(2); }
  return r.stdout.trim();
}

function runSpec(m: Mutant, tla2tools: string): void {
  const work = join(out, m.id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'tmp'), { recursive: true });
  const config = m.config ?? catalog.config;
  for (const f of [`${catalog.module}.tla`, config]) cpSync(join(specDir, f), join(work, f));
  const target = join(work, m.spec.file);
  const mutated = applyOnce(readFileSync(target, 'utf8'), m.spec);
  if (mutated === null) return fail('MUTANT_STALE', m.id, `spec text not found exactly once in ${m.spec.file}: ${JSON.stringify(m.spec.before)}`);
  writeFileSync(target, mutated);
  const r = spawnSync('java', ['-XX:+UseParallelGC', `-Djava.io.tmpdir=${join(work, 'tmp')}`, '-cp', tla2tools, 'tlc2.TLC', '-workers', 'auto',
    '-config', config, '-metadir', join(work, 'states'), `${catalog.module}.tla`], { cwd: work, encoding: 'utf8', timeout: timeoutS * 1000 });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(join(work, 'tlc.log'), log);
  const spawnCode = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (spawnCode === 'ENOENT') return fail('MUTANT_INCOMPLETE', m.id, `cannot run java (ENOENT); TLC did not start. Install Java 11 or later on PATH and rerun: bun scripts/spec/mutants.ts --only ${m.id} --spec-only`);
  if (r.error || r.signal) return fail('MUTANT_INCOMPLETE', m.id, `TLC did not finish within TLC_TIMEOUT_S (${timeoutS} s) or was killed (${spawnCode ?? r.signal}). If the spec or config changed, find the action that multiplies states; otherwise rerun once. Log: ${work}/tlc.log`);
  checked++;
  const violated = log.match(/(?:Invariant|Action property|Property) (\w+) is violated/)?.[1];
  const clean = log.includes('Model checking completed. No error has been found.');
  if (m.expect === 'survives') {
    if (clean) return void console.log(`ok   ${m.id} (survivor): survives as expected (defense in depth)`);
    if (violated) return fail('MUTANT_WRONG_PROPERTY', m.id, `expected to survive, but ${violated} is violated: the guard is now load-bearing; give it an expect and a code test. Log: ${work}/tlc.log`);
    return fail('MUTANT_INCOMPLETE', m.id, `TLC did not finish (exit ${r.status ?? r.signal}). Log: ${work}/tlc.log`);
  }
  if (violated === m.expect) return void console.log(`ok   ${m.id} (${m.kind}): caught by ${violated}`);
  if (violated) return fail('MUTANT_WRONG_PROPERTY', m.id, `expected ${m.expect}, but ${violated} caught it. Log: ${work}/tlc.log`);
  if (clean) return fail('MUTANT_SURVIVED', m.id, `no property caught "${m.title}"; ${m.expect} no longer depends on this guard. Log: ${work}/tlc.log`);
  fail('MUTANT_INCOMPLETE', m.id, `TLC did not finish (exit ${r.status ?? r.signal}). Log: ${work}/tlc.log`);
}

/** The code checks run in a scratch copy of the working tree, so an interrupted run never leaves the checkout edited. */
function scratchCopy(): string {
  const dir = join(out, 'tree');
  mkdirSync(dir, { recursive: true });
  const files = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\0').filter(Boolean);
  for (const f of files) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

/**
 * One run of one test file, its full output kept in `log` and its JUnit report beside it. `outcome` is `passed` (exit 0,
 * every selected test passed), `assertion` (exit 1, and every failed test failed on an expect(): an AssertionError in the
 * JUnit report) or `broken`: a signal, a timeout, a spawn error, a load or bootstrap error, no test selected, or a
 * failure of any other type, such as an Error thrown after a passing expect(). Only `assertion` counts as a caught
 * guard; `broken` proves nothing either way.
 */
interface TestRun { outcome: 'passed' | 'assertion' | 'broken'; why: string; log: string }
function bunTest(cwd: string, t: CodeTest, log: string): TestRun {
  const junit = log.replace(/[.]log$/, '.xml');
  rmSync(junit, { force: true });
  const argv = ['test', '--timeout=300000', '--reporter=junit', `--reporter-outfile=${junit}`, t.test, '-t', t.filter];
  const r = spawnSync('bun', argv, { cwd, encoding: 'utf8', env: process.env, timeout: 600_000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(log, `$ bun ${argv.map(a => JSON.stringify(a)).join(' ')}\nexit ${r.status} signal ${r.signal} error ${r.error?.message ?? 'none'}\n\n${text}`);
  const broken = (why: string): TestRun => ({ outcome: 'broken', why, log });
  if (r.error) return broken(`bun did not run (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`);
  if (r.signal) return broken(`bun was terminated by ${r.signal}`);
  if (['Unhandled error between tests', 'SyntaxError', 'Cannot find module'].some(s => text.includes(s))) return broken('the file did not load, or an error escaped between tests');
  if (!existsSync(junit)) return broken('bun wrote no JUnit report');
  const cases = readFileSync(junit, 'utf8').split('<testcase ').slice(1).map(c => c.split('</testcase>')[0]!).filter(c => !c.includes('<skipped'));
  const failures = cases.map(c => c.includes('<failure') ? (c.split('<failure type="')[1]?.split('"')[0] ?? 'unknown') : null).filter((f): f is string => f !== null);
  if (cases.length === 0) return broken(`-t "${t.filter}" matched no test`);
  if (r.status === 0 && failures.length === 0) return { outcome: 'passed', why: `${cases.length} passed`, log };
  const other = failures.filter(type => type !== 'AssertionError');
  if (r.status === 1 && failures.length > 0 && other.length === 0) return { outcome: 'assertion', why: `${failures.length} failed on an assertion`, log };
  return broken(`exit ${r.status}, ${failures.length} failed${other.length ? ` (${other.join(', ')}, not an assertion)` : ''}`);
}

function runCode(m: Mutant, tree: string): void {
  const code = m.code!;
  const tests = code.tests.filter(t => {
    if (!t.postgres || process.env.DATABASE_URL) return true;
    if (flag('--require-postgres')) fail('MUTANT_INCOMPLETE', m.id, `${t.test} needs DATABASE_URL (a test Postgres)`);
    else { skipped++; console.log(`skip ${m.id} (code): ${t.test} needs DATABASE_URL`); }
    return false;
  });
  if (tests.length === 0) return;
  const originals = new Map<string, string>();
  let mutated = new Map<string, string>();
  for (const edit of code.edits) {
    const text = mutated.get(edit.file) ?? readFileSync(join(tree, edit.file), 'utf8');
    originals.set(edit.file, originals.get(edit.file) ?? text);
    const next = applyOnce(text, edit);
    if (next === null) return fail('MUTANT_STALE', m.id, `code text not found exactly once in ${edit.file}: ${JSON.stringify(edit.before)}`);
    mutated.set(edit.file, next);
  }
  const logs = join(out, m.id);
  mkdirSync(logs, { recursive: true });
  for (const [i, t] of tests.entries()) {
    checked++;
    const base = bunTest(tree, t, join(logs, `test-${i}-without-edit.log`));
    if (base.outcome !== 'passed') return fail('MUTANT_INCOMPLETE', m.id, `${t.test} -t "${t.filter}" must pass without the edit, but ${base.why}. Fix the test first. Log: ${base.log}`);
    try {
      for (const [file, text] of mutated) writeFileSync(join(tree, file), text);
      const under = bunTest(tree, t, join(logs, `test-${i}-with-edit.log`));
      if (under.outcome === 'broken') return fail('MUTANT_INCOMPLETE', m.id, `with the edit, ${under.why}, so the run proves nothing. Rerun once: bun scripts/spec/mutants.ts --only ${m.id} --code-only. Log: ${under.log}`);
      if (under.outcome === 'passed') return fail('MUTANT_SURVIVED', m.id, `${t.test} -t "${t.filter}" passes with the guard removed from ${[...mutated.keys()].join(', ')}; the test no longer pins it. Log: ${under.log}`);
      console.log(`ok   ${m.id} (code): ${t.test} fails on an assertion with the guard removed from ${[...mutated.keys()].join(', ')}`);
    } finally {
      for (const [file, text] of originals) writeFileSync(join(tree, file), text);
    }
  }
}

const selected = catalog.mutants.filter(m => !only || m.id === only);
if (selected.length === 0) { console.error(`no mutant ${only} in ${specName}`); process.exit(2); }
console.log(`logs: ${out}`);
if (!flag('--code-only')) { const tla2tools = jar(); for (const m of selected) runSpec(m, tla2tools); }
if (!flag('--spec-only') && selected.some(m => m.code)) {
  const tree = scratchCopy();
  for (const m of selected) if (m.code) runCode(m, tree);
  rmSync(tree, { recursive: true, force: true });
}
if (failures.length === 0 && checked === 0) { console.error(`MUTANT_NOTHING_CHECKED: every check the selection asked for was skipped (${skipped} Postgres code check(s) without DATABASE_URL); nothing was verified.`); process.exit(1); }
if (failures.length) { console.error(`\n${failures.length} mutant check(s) failed; spec/tla/README.md says what each code means.`); process.exit(1); }
console.log(`\nall ${selected.length} mutant(s) behave as catalogued${skipped ? `; partial: ${skipped} Postgres code check(s) skipped (set DATABASE_URL to a test database, or pass --require-postgres to fail instead)` : ''}`);
