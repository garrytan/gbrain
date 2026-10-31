#!/usr/bin/env bun
/**
 * Core ambient-read ratchet (docs/architecture/key-files/ci-health-and-test-guards.md).
 *
 * src/core/ is an engine library a host embeds. Three habits tie it to one
 * process and one home directory instead: a call to the config loader (which
 * reads the home directory's config file), a read of process.env, and a
 * module-level Map or Set (state that every engine in the process shares, so
 * two engines mounted side by side see each other's entries). Each is called
 * an ambient read here. This guard counts them per file and per kind and fails
 * when a count rises above scripts/core-ambient-reads.baseline.tsv. Counts
 * that fall are fine, with a nudge to regenerate the baseline so the ceiling
 * comes down. The baseline only goes down.
 *
 * Scope: src/core/**\/*.ts, excluding *.test.ts, *.generated.ts and .d.ts.
 * Kinds (TypeScript AST, every form):
 *   config-load        a call to loadConfig, loadConfigFileOnly or
 *                      loadConfigWithEngine (the config-reading entries
 *                      exported by src/core/config.ts), bare or as a member
 *   process-env        the expression `process.env`, however it is read:
 *                      process.env.X, process.env['X'], a destructuring, or
 *                      passing the whole object along
 *   module-collection  a top-level `const`, `let` or `var` (exported or not)
 *                      whose initializer is `new Map(`, `new Set(`,
 *                      `new WeakMap(` or `new WeakSet(`, through parentheses
 *                      and `as` casts; a declaration inside a function, class
 *                      or block is not module state and does not count
 *
 * Rules (every violation is reported, then one exit):
 *   - a file and kind with more reads than its row, or reads and no row  -> FAIL
 *   - a count equal to its row                                           -> pass
 *   - a count below its row (or a row whose file is gone)                -> pass, one nudge line
 *   - malformed, duplicate or unsorted rows, or a missing header         -> FAIL
 *
 * `--write-baseline` rewrites the baseline from the current tree, keeping its
 * comment preamble, and prints the three totals. It exists for lowering: a
 * raised or added row does not pass review; thread the value through instead.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture root; baseline read from
 * <root>/scripts/core-ambient-reads.baseline.tsv). The bash entry is
 * scripts/check-core-ambient-reads.sh, which verify dispatches.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

export const BASELINE_REL = 'scripts/core-ambient-reads.baseline.tsv';
const SCAN_DIR = 'src/core';
const HEADER = 'path\tkind\tcount';
const DOCS = 'docs/architecture/key-files/ci-health-and-test-guards.md';
const WRITE_CMD = 'bash scripts/check-core-ambient-reads.sh --write-baseline';
const DEFAULT_PREAMBLE = [
  '# Ambient reads in src/core/, per file and per kind: calls to the config loader,',
  '# reads of process.env, and module-level Map/Set declarations. Each row is a',
  '# ceiling that only comes down. Regenerate after lowering a count with:',
  `#   ${WRITE_CMD}`,
  '# Rules and blind spots: scripts/check-core-ambient-reads.ts.',
].join('\n') + '\n';

export const KINDS = ['config-load', 'process-env', 'module-collection'] as const;
export type Kind = (typeof KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(KINDS);
const CONFIG_LOADERS = new Set(['loadConfig', 'loadConfigFileOnly', 'loadConfigWithEngine']);
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const NUDGE_SHOWN = 4;

export interface AmbientRead {
  path: string;
  kind: Kind;
  line: number;
}

function strip(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
  return current;
}

/** `loadConfig(...)`, `config.loadConfig(...)` and the two sibling loaders. */
function isConfigLoad(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = strip(node.expression);
  if (ts.isIdentifier(callee)) return CONFIG_LOADERS.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && CONFIG_LOADERS.has(callee.name.text);
}

/** The expression `process.env` (or `process['env']`), whatever is done with it. */
function isProcessEnv(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return ts.isIdentifier(node.expression) && node.expression.text === 'process' && node.name.text === 'env';
  }
  return ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process'
    && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'env';
}

/** A top-level variable declaration initialized with `new Map(` / `new Set(` / `new WeakMap(` / `new WeakSet(`. */
function moduleCollections(statement: ts.VariableStatement): ts.VariableDeclaration[] {
  if (!ts.isSourceFile(statement.parent)) return [];
  return statement.declarationList.declarations.filter(declaration => {
    if (!declaration.initializer) return false;
    const init = strip(declaration.initializer);
    return ts.isNewExpression(init) && ts.isIdentifier(init.expression) && COLLECTIONS.has(init.expression.text);
  });
}

/** Every ambient read in one source file, in source order. */
export function findAmbientReads(path: string, text: string): AmbientRead[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: AmbientRead[] = [];
  const at = (node: ts.Node, kind: Kind) => found.push({ path, kind, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  const visit = (node: ts.Node): void => {
    if (isConfigLoad(node)) at(node, 'config-load');
    if (isProcessEnv(node)) at(node, 'process-env');
    if (ts.isVariableStatement(node)) for (const declaration of moduleCollections(node)) at(declaration, 'module-collection');
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const rowKey = (path: string, kind: string) => `${path}\t${kind}`;

function countReads(reads: AmbientRead[]): Map<string, AmbientRead[]> {
  const byRow = new Map<string, AmbientRead[]>();
  for (const read of reads) {
    const key = rowKey(read.path, read.kind);
    byRow.set(key, [...(byRow.get(key) ?? []), read]);
  }
  return byRow;
}

export interface Comparison {
  /** Rows the tree exceeds, and rows the baseline file itself gets wrong. The check fails when any exist. */
  problems: string[];
  /** Rows the tree sits under, as `path kind allowed -> count`; the check passes and nudges. */
  below: string[];
}

/** Compares per-file, per-kind counts with the baseline text. */
export function compareBaseline(reads: AmbientRead[], baselineText: string): Comparison {
  const problems: string[] = [];
  const rows = new Map<string, number>();
  let sawHeader = false;
  let prev = '';
  baselineText.split('\n').forEach((raw, i) => {
    if (!raw.trim() || raw.startsWith('#')) return;
    if (raw === HEADER) { sawHeader = true; return; }
    const cols = raw.split('\t');
    const count = Number(cols[2]);
    if (cols.length !== 3 || !cols[0] || !KIND_SET.has(cols[1] ?? '') || !/^\d+$/.test(cols[2] ?? '') || count < 1) {
      problems.push(`FAIL: ${BASELINE_REL}:${i + 1} malformed row (want path<TAB>kind<TAB>count, kind one of ${KINDS.join('|')}, count >= 1)`);
      return;
    }
    const key = rowKey(cols[0], cols[1]!);
    if (rows.has(key)) problems.push(`FAIL: ${BASELINE_REL}:${i + 1} duplicate row for ${cols[0]} ${cols[1]}`);
    if (prev && key < prev) problems.push(`FAIL: ${BASELINE_REL}:${i + 1} rows must be sorted by path, then kind`);
    prev = key;
    rows.set(key, count);
  });
  if (!sawHeader) problems.push(`FAIL: ${BASELINE_REL} is missing the header line "path<TAB>kind<TAB>count"`);

  const below: string[] = [];
  const byRow = countReads(reads);
  for (const [key, sites] of [...byRow.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [path, kind] = key.split('\t') as [string, Kind];
    const allowed = rows.get(key) ?? 0;
    if (sites.length > allowed) {
      problems.push(`FAIL: ${path} has ${sites.length} ${kind} read(s), over its baseline of ${allowed}\n`
        + `      sites: ${sites.map(site => `${path}:${site.line}`).join(', ')}`);
    } else if (sites.length < allowed) {
      below.push(`${path} ${kind} ${allowed} -> ${sites.length}`);
    }
  }
  for (const [key, allowed] of rows) {
    if (byRow.has(key)) continue;
    const [path, kind] = key.split('\t');
    below.push(`${path} ${kind} ${allowed} -> 0`);
  }
  below.sort();
  return { problems, below };
}

/** The baseline for `reads`: preamble, header, then one `path<TAB>kind<TAB>count` row per file and kind, sorted. */
export function formatBaseline(reads: AmbientRead[], preamble = DEFAULT_PREAMBLE): string {
  const rows = [...countReads(reads).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, sites]) => `${key}\t${sites.length}`);
  return preamble + [HEADER, ...rows].join('\n') + '\n';
}

/** Per-kind totals as one line, in KINDS order. */
export function totals(reads: AmbientRead[]): string {
  return KINDS.map(kind => `${kind} ${reads.filter(read => read.kind === kind).length}`).join(', ');
}

function coreFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.generated.ts') && !entry.endsWith('.d.ts')) {
        out.push(relative(root, full).split('\\').join('/'));
      }
    }
  };
  walk(join(root, SCAN_DIR));
  return out;
}

function main(): number {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = process.env.GBRAIN_GUARD_ROOT ?? (git.status === 0 ? git.stdout.trim() : process.cwd());
  const baselinePath = join(root, BASELINE_REL);
  const files = coreFiles(root);
  const reads = files.flatMap(file => findAmbientReads(file, readFileSync(join(root, file), 'utf8')));
  const summary = `${reads.length} read(s) in ${new Set(reads.map(read => read.path)).size} of ${files.length} file(s): ${totals(reads)}`;
  const baselineText = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf8') : null;

  if (process.argv.includes('--write-baseline')) {
    const lines = (baselineText ?? '').split('\n');
    const firstRow = lines.findIndex(line => !line.startsWith('#'));
    const preamble = baselineText !== null && firstRow > 0 ? lines.slice(0, firstRow).join('\n') + '\n' : DEFAULT_PREAMBLE;
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, formatBaseline(reads, preamble));
    console.log(`wrote ${BASELINE_REL}: ${summary}; review the diff (rows only come down)`);
    return 0;
  }
  if (baselineText === null) {
    console.error(`FAIL: ${BASELINE_REL} not found under ${root}`);
    console.error(`Fix:  ${WRITE_CMD}`);
    return 1;
  }
  const { problems, below } = compareBaseline(reads, baselineText);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error('Why:  src/core/ is an engine library a host embeds. A config load, a process.env read or a module-level');
    console.error('      Map/Set ties it to one process and one home directory, and two engines in one process share that');
    console.error('      state; the baseline only comes down.');
    console.error('Fix:  take the value as a parameter or from the engine the caller already holds (its config, its options),');
    console.error('      and keep per-engine state on the engine instance. After lowering a count, run');
    console.error(`      ${WRITE_CMD}. Raising or adding a row does not pass review.`);
    console.error(`See:  ${DOCS}`);
    console.error(`core-ambient-reads: ${problems.length} violation(s); ${summary}`);
    return 1;
  }
  console.log(`OK: core ambient reads within ${BASELINE_REL} (${summary})`);
  if (below.length) {
    const shown = below.slice(0, NUDGE_SHOWN).join(', ') + (below.length > NUDGE_SHOWN ? `, and ${below.length - NUDGE_SHOWN} more` : '');
    console.log(`note: ${below.length} row(s) sit above the tree (${shown}); run ${WRITE_CMD} so the ceiling comes down`);
  }
  return 0;
}

if (import.meta.main) process.exit(main());
