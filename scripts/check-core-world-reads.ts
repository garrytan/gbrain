#!/usr/bin/env bun
/**
 * Core world-reads ratchet (GBRA-248 W1; docs/architecture/topologies.md#embedded-core-planned).
 *
 * The embeddable core (docs/architecture/topologies.md#embedded-core-planned)
 * takes every setting as an argument and keeps per-brain state on the engine.
 * This guard counts, per file under src/core (TypeScript compiler API), the
 * places that still reach the process or the machine instead:
 *
 *   load_config         loadConfig( calls (reads ~/.gbrain on every call)
 *   process_env         process.env / Bun.env references
 *   fs_import           imports or requires of fs, node:fs, fs/promises
 *   module_collection   module-level Map/Set/WeakMap/WeakSet built empty or
 *                       held in a let (per-process state; a const table built
 *                       from a literal does not count)
 *   spawn_import        imports of src/core/spawn.ts or child_process
 *   process_global      process.exit/on/once/addListener/prependListener/
 *                       chdir/umask calls
 *   als_store           new AsyncLocalStorage(
 *
 * Baseline: scripts/core-world-reads-baseline.tsv, rows
 * path<TAB>metric<TAB>count<TAB>justification (the wave that removes it, or
 * why it stays). Counts only fall:
 *   1. a count above its row (no row = 0)                        -> FAIL
 *   2. a count below its row (stale)                             -> FAIL
 *   3. a duplicate, malformed or unjustified row                 -> FAIL
 * --prune lowers stale rows to the actual count and drops rows at zero; it
 * never raises a row or adds one.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root; baseline read from
 * <root>/scripts/core-world-reads-baseline.tsv).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const BASELINE_REL = 'scripts/core-world-reads-baseline.tsv';
const ANCHOR = 'docs/architecture/topologies.md#embedded-core-planned';
export const METRICS = ['load_config', 'process_env', 'fs_import', 'module_collection', 'spawn_import', 'process_global', 'als_store'] as const;
export type Metric = (typeof METRICS)[number];

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const PROCESS_GLOBALS = new Set(['exit', 'on', 'once', 'addListener', 'prependListener', 'chdir', 'umask']);

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function isSpawnModule(spec: string): boolean {
  return CHILD_PROCESS.has(spec) || (spec.startsWith('.') && /(^|\/)spawn(\.ts)?$/.test(spec));
}

function moduleSpecifier(node: ts.Node): string | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
    return node.moduleReference.expression.text;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])
    && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
    return node.arguments[0].text;
  }
  return null;
}

function isProcessEnv(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'env' && ts.isIdentifier(node.expression)
    && (node.expression.text === 'process' || node.expression.text === 'Bun');
}

function moduleCollections(sf: ts.SourceFile): number {
  let n = 0;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isLet = (stmt.declarationList.flags & ts.NodeFlags.Let) !== 0;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (!init || !ts.isNewExpression(init) || !ts.isIdentifier(init.expression) || !COLLECTIONS.has(init.expression.text)) continue;
      if (isLet || !init.arguments || init.arguments.length === 0) n++;
    }
  }
  return n;
}

export function countFile(text: string, fileName = 'file.ts'): Record<Metric, number> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
  counts.module_collection = moduleCollections(sf);
  const visit = (node: ts.Node): void => {
    const spec = moduleSpecifier(node);
    if (spec !== null) {
      if (FS_MODULES.has(spec)) counts.fs_import++;
      if (isSpawnModule(spec)) counts.spawn_import++;
    }
    if (isProcessEnv(node)) counts.process_env++;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'loadConfig') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'loadConfig')) counts.load_config++;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'process' && PROCESS_GLOBALS.has(callee.name.text)) counts.process_global++;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'AsyncLocalStorage') counts.als_store++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return counts;
}

export function scanTree(root: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const abs of tsFiles(join(root, 'src/core'))) {
    const rel = relative(root, abs).replace(/\\/g, '/');
    const counts = countFile(readFileSync(abs, 'utf8'), abs);
    for (const m of METRICS) if (counts[m] > 0) out.set(rel + '\t' + m, counts[m]);
  }
  return out;
}

interface Row { lineNo: number; key: string; count: number; justification: string; malformed: string | null }

function parseBaseline(text: string): Row[] {
  const rows: Row[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const cols = raw.split('\t');
    const [path, metric, count, justification] = cols;
    let malformed: string | null = null;
    if (cols.length !== 4 || !path) malformed = "want 'path<TAB>metric<TAB>count<TAB>justification'";
    else if (!(METRICS as readonly string[]).includes(metric)) malformed = 'unknown metric ' + JSON.stringify(metric) + ' (one of ' + METRICS.join(', ') + ')';
    else if (!/^[1-9]\d*$/.test(count)) malformed = 'count must be a positive integer';
    else if (!justification || !justification.trim()) malformed = 'empty justification';
    rows.push({ lineNo: i + 1, key: path + '\t' + metric, count: Number(count), justification: justification ?? '', malformed });
  });
  return rows;
}

if (import.meta.main) {
  const prune = process.argv.includes('--prune');
  const baselinePath = join(ROOT, BASELINE_REL);
  if (!existsSync(baselinePath)) {
    console.error('FAIL: ' + BASELINE_REL + ':1 baseline file missing');
    console.error('Fix:  git checkout ' + BASELINE_REL);
    console.error('See:  ' + ANCHOR);
    process.exit(1);
  }
  const baselineText = readFileSync(baselinePath, 'utf8');
  const rows = parseBaseline(baselineText);
  const actual = scanTree(ROOT);
  const violations: string[] = [];
  const rewrite = new Map<number, string | null>();
  const seen = new Set<string>();

  for (const row of rows) {
    const where = BASELINE_REL + ':' + row.lineNo;
    if (row.malformed) {
      violations.push('FAIL: ' + where + ' malformed row: ' + row.malformed);
      continue;
    }
    const [path, metric] = row.key.split('\t');
    if (seen.has(row.key)) {
      rewrite.set(row.lineNo, null);
      violations.push('FAIL: ' + where + ' duplicate row for ' + path + ' ' + metric + '\n      Fix:  delete this line (or: bun scripts/check-core-world-reads.ts --prune)');
      continue;
    }
    seen.add(row.key);
    const now = actual.get(row.key) ?? 0;
    if (now > row.count) {
      violations.push('FAIL: ' + path + ' ' + metric + ': baseline ' + row.count + ', actual ' + now + '\n      Fix:  take it from engine settings (passed in by the caller) instead of the process or the machine; if it must stay, raise the row with a justification in this PR');
    } else if (now < row.count) {
      rewrite.set(row.lineNo, now === 0 ? null : [path, metric, String(now), row.justification].join('\t'));
      violations.push('FAIL: ' + where + ' stale row: ' + path + ' ' + metric + ': baseline ' + row.count + ', actual ' + now + '\n      Fix:  lower the row to ' + now + (now === 0 ? ' (delete it)' : '') + '; counts only fall (or: bun scripts/check-core-world-reads.ts --prune)');
    }
  }
  for (const [key, now] of actual) {
    if (seen.has(key)) continue;
    const [path, metric] = key.split('\t');
    violations.push('FAIL: ' + path + ' ' + metric + ': baseline 0, actual ' + now + '\n      Fix:  take it from engine settings (passed in by the caller) instead of the process or the machine; if it must stay, add a row with a justification in this PR');
  }

  if (prune) {
    const kept: string[] = [];
    baselineText.split('\n').forEach((line, i) => {
      if (!rewrite.has(i + 1)) kept.push(line);
      else if (rewrite.get(i + 1) !== null) kept.push(rewrite.get(i + 1)!);
    });
    writeFileSync(baselinePath, kept.join('\n'));
    console.log('check-core-world-reads: pruned ' + rewrite.size + ' row(s) in ' + BASELINE_REL);
    process.exit(0);
  }
  if (violations.length) {
    for (const v of violations) console.error(v);
    console.error('Why:  the embeddable core takes every setting as an argument; world reads in src/core only fall (GBRA-248).');
    console.error('See:  ' + ANCHOR);
    console.error('check-core-world-reads: ' + violations.length + ' violation(s)');
    process.exit(1);
  }
  const totals = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
  for (const [key, n] of actual) totals[key.split('\t')[1] as Metric] += n;
  console.log('check-core-world-reads: ok (' + METRICS.map((m) => m + ' ' + totals[m]).join(', ') + ')');
}
