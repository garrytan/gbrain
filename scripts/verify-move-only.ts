#!/usr/bin/env bun
/**
 * E3 / EO19 move-only verifier (refactor wave 1).
 *
 * Proves a commit tagged `Move-Only: yes` (or `Mechanical-Rename: yes` with a
 * rename map) moves code without editing it: every top-level statement of every
 * touched TypeScript file on the base side reappears, token for token, on the
 * head side, and nothing else appears. Tokens come from the shared normalizer
 * (`scripts/lib/normalize-tokens.ts`), so whitespace, comments and
 * re-indentation are ignored while string, template and SQL contents are exact.
 *
 * Allowed without failing (listed in the report): import declarations,
 * `export ... from` re-exports, bare `export { x }` / `export type { x }` lists,
 * and adding or removing the `export` / `default` modifier on a moved statement.
 *
 * Modes:
 *   --wrapper migration  W3 wrapper: head-side `export const vNNN: Migration = <expr>;`
 *                        definitions are inlined where the registry references them,
 *                        so the generated registry array must reproduce the original
 *                        MIGRATIONS array (same literals, same order).
 *   --wrapper doctor-entry  W4 doctor peel: head-side `run<Topic>(ctx: DoctorContext): Promise<Check[]>`
 *                        functions are inlined where `buildChecks` calls them
 *                        (`checks.push(...(await runX(ctx)));`) after dropping their
 *                        wrapper (leading `const ... = ctx;` / `const engine =
 *                        connectedEngine(ctx);` / `const checks: Check[] = [];`, trailing
 *                        `return checks;`), and the `const ctx: DoctorContext = {...};`
 *                        glue is dropped, so buildChecks must reproduce the original body.
 *                        Relative `import()` / `require()` specifiers on both sides are
 *                        resolved to repo paths, so re-rooting a moved block is not an edit.
 *   --rename-map <json>  identifier rewrites applied to the BASE side before comparing,
 *                        e.g. {"pullFailed": "run.pullFailed"} for Mechanical-Rename commits.
 *
 * Usage:
 *   bun scripts/verify-move-only.ts [<base>..<head> | <commit>] [--wrapper migration|doctor-entry] [--rename-map f.json]
 * Default range: HEAD~1..HEAD. Exit 0 = move-only, 1 = edited tokens, 2 = usage error.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';
import { normalizeTokens } from './lib/normalize-tokens.ts';

export interface VerifyOptions {
  wrapper?: 'migration' | 'doctor-entry';
  renameMap?: Readonly<Record<string, string>>;
}

export interface SideFile {
  path: string;
  text: string;
}

interface Stmt {
  path: string;
  line: number;
  tokens: string[];
  key: string;
  exported: boolean;
}

export interface VerifyResult {
  ok: boolean;
  statements: number;
  files: string[];
  ignored: { path: string; line: number; kind: string }[];
  exportToggles: number;
  wrappedDefinitions: number;
  removed: Stmt[];
  added: Stmt[];
  problems: string[];
}

const SEE = 'See:  docs/TESTING.md#move-only-verifier';

function isSourcePath(p: string): boolean {
  return /\.(ts|tsx|mts|cts|js|mjs)$/.test(p) && !p.endsWith('.d.ts');
}

function stripExport(tokens: string[]): { tokens: string[]; toggled: boolean } {
  let i = 0;
  while (tokens[i] === 'export' || tokens[i] === 'default') i++;
  return { tokens: i === 0 ? tokens : tokens.slice(i), toggled: i > 0 };
}

function ignorableKind(stmt: ts.Statement): string | undefined {
  if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) return 'import';
  if (ts.isExportDeclaration(stmt)) return stmt.moduleSpecifier ? 're-export' : 'export-list';
  return undefined;
}

const MIGRATION_WRAPPER_NAME = /^v\d{3,}$/;

function migrationWrapper(stmt: ts.Statement, sf: ts.SourceFile): { name: string; expr: ts.Expression } | undefined {
  if (!ts.isVariableStatement(stmt)) return undefined;
  const exported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const decls = stmt.declarationList.declarations;
  if (!exported || decls.length !== 1) return undefined;
  const d = decls[0]!;
  if (!ts.isIdentifier(d.name) || !MIGRATION_WRAPPER_NAME.test(d.name.text) || !d.initializer) return undefined;
  if (!d.type || d.type.getText(sf) !== 'Migration') return undefined;
  return { name: d.name.text, expr: d.initializer };
}

const DOCTOR_ENTRY_NAME = /^run[A-Z]\w*$/;
const DOCTOR_ENTRY_PROLOGUE = /^const (\{[^}]*\} = ctx|engine = connectedEngine\(ctx\)|checks: Check\[\] = \[\]);$/;

/** Head-side `run<Topic>(ctx)` entry: the tokens of its body without the wrapper. */
function doctorEntryWrapper(stmt: ts.Statement, sf: ts.SourceFile, path: string): { name: string; tokens: string[] } | undefined {
  if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body || !DOCTOR_ENTRY_NAME.test(stmt.name.text)) return undefined;
  const [param] = stmt.parameters;
  if (stmt.parameters.length !== 1 || param!.name.getText(sf) !== 'ctx' || param!.type?.getText(sf) !== 'DoctorContext') return undefined;
  if (stmt.type?.getText(sf) !== 'Promise<Check[]>') return undefined;
  const body = [...stmt.body.statements];
  let start = 0;
  while (start < body.length && DOCTOR_ENTRY_PROLOGUE.test(body[start]!.getText(sf))) start++;
  if (body.at(-1)?.getText(sf) !== 'return checks;') return undefined;
  const tokens = body.slice(start, -1).flatMap((st) => resolveSpecifiers(normalizeTokens(st.getText(sf)), path));
  return { name: stmt.name.text, tokens };
}

/** `import('./x.ts')` / `require('../y.ts')` specifiers rewritten to repo-relative paths. */
function resolveSpecifiers(tokens: string[], path: string): string[] {
  const out = [...tokens];
  for (let i = 0; i + 2 < out.length; i++) {
    if ((out[i] !== 'import' && out[i] !== 'require') || out[i + 1] !== '(') continue;
    const m = /^(['"])(\.\.?\/.*)\1$/.exec(out[i + 2]!);
    if (m) out[i + 2] = `'<repo>/${posix.normalize(posix.join(posix.dirname(path), m[2]!))}'`;
  }
  return out;
}

/** Inline `checks.push(...(await runX(ctx)));` call sites and drop the `const ctx: DoctorContext = {...};` glue. */
function expandDoctorEntries(tokens: string[], wrapped: Map<string, string[]>, used: Set<string>, where: string, problems: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const call = ['checks', '.', 'push', '(', '...', '(', 'await'];
    const name = tokens[i + 7];
    if (call.every((t, k) => tokens[i + k] === t) && name && wrapped.has(name) && ['(', 'ctx', ')', ')', ')', ';'].every((t, k) => tokens[i + 8 + k] === t)) {
      if (used.has(name)) problems.push(`FAIL: ${where} entry ${name} is called more than once`);
      used.add(name);
      out.push(...wrapped.get(name)!);
      i += 13;
      continue;
    }
    if (['const', 'ctx', ':', 'DoctorContext', '='].every((t, k) => tokens[i + k] === t)) {
      let depth = 0;
      let j = i + 5;
      for (; j < tokens.length; j++) {
        if (tokens[j] === '{' || tokens[j] === '(' || tokens[j] === '[') depth++;
        else if (tokens[j] === '}' || tokens[j] === ')' || tokens[j] === ']') depth--;
        else if (tokens[j] === ';' && depth === 0) break;
      }
      i = j;
      continue;
    }
    out.push(tokens[i]!);
  }
  return out;
}

function collect(
  files: SideFile[],
  opts: VerifyOptions,
  side: 'base' | 'head',
  result: VerifyResult,
): Stmt[] {
  const out: Stmt[] = [];
  const wrapped = new Map<string, string[]>();
  const pending: { path: string; line: number; text: string }[] = [];
  const rename = side === 'base' ? opts.renameMap : undefined;
  for (const f of files) {
    const sf = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, f.path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const stmt of sf.statements) {
      const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
      const kind = ignorableKind(stmt);
      if (kind) {
        result.ignored.push({ path: f.path, line, kind: `${side} ${kind}` });
        continue;
      }
      if (side === 'head' && opts.wrapper === 'doctor-entry') {
        const w = doctorEntryWrapper(stmt, sf, f.path);
        if (w) {
          if (wrapped.has(w.name)) result.problems.push(`FAIL: ${f.path}:${line} entry ${w.name} is defined twice`);
          wrapped.set(w.name, w.tokens);
          result.wrappedDefinitions++;
          continue;
        }
      }
      if (side === 'head' && opts.wrapper === 'migration') {
        const w = migrationWrapper(stmt, sf);
        if (w) {
          if (wrapped.has(w.name)) result.problems.push(`FAIL: ${f.path}:${line} wrapper ${w.name} is defined twice`);
          wrapped.set(w.name, normalizeTokens(w.expr.getText(sf)));
          result.wrappedDefinitions++;
          continue;
        }
      }
      pending.push({ path: f.path, line, text: stmt.getText(sf) });
    }
  }
  const used = new Set<string>();
  for (const p of pending) {
    let tokens = normalizeTokens(p.text, rename ? { renameMap: rename } : {});
    if (opts.wrapper === 'doctor-entry') {
      tokens = resolveSpecifiers(tokens, p.path);
      if (side === 'head') tokens = expandDoctorEntries(tokens, wrapped, used, `${p.path}:${p.line}`, result.problems);
    } else if (wrapped.size > 0) {
      const expanded: string[] = [];
      for (const t of tokens) {
        const def = wrapped.get(t);
        if (def) {
          if (used.has(t)) result.problems.push(`FAIL: ${p.path}:${p.line} wrapper ${t} is referenced more than once`);
          used.add(t);
          expanded.push(...def);
        } else {
          expanded.push(t);
        }
      }
      tokens = expanded;
    }
    const stripped = stripExport(tokens);
    out.push({ path: p.path, line: p.line, tokens: stripped.tokens, key: stripped.tokens.join(' '), exported: stripped.toggled });
  }
  for (const name of wrapped.keys()) {
    if (used.has(name)) continue;
    result.problems.push(
      opts.wrapper === 'doctor-entry'
        ? `FAIL: entry ${name} is defined but never called from buildChecks (a moved block is missing)`
        : `FAIL: wrapper ${name} is defined but never referenced (a moved migration is missing from the registry)`,
    );
  }
  return out;
}

/** Compare two sides of a change. Pure: no git, used by the unit test. */
export function verifyMoveOnly(base: SideFile[], head: SideFile[], opts: VerifyOptions = {}): VerifyResult {
  const result: VerifyResult = {
    ok: false,
    statements: 0,
    files: [...new Set([...base, ...head].map((f) => f.path))].sort(),
    ignored: [],
    exportToggles: 0,
    wrappedDefinitions: 0,
    removed: [],
    added: [],
    problems: [],
  };
  const b = collect(base, opts, 'base', result);
  const h = collect(head, opts, 'head', result);
  const pool = new Map<string, Stmt[]>();
  for (const s of b) {
    const list = pool.get(s.key);
    if (list) list.push(s);
    else pool.set(s.key, [s]);
  }
  for (const s of h) {
    const list = pool.get(s.key);
    if (list && list.length > 0) {
      const same = list.findIndex((c) => c.exported === s.exported);
      if (same < 0) result.exportToggles++;
      list.splice(same < 0 ? list.length - 1 : same, 1);
      result.statements++;
    } else {
      result.added.push(s);
    }
  }
  for (const list of pool.values()) result.removed.push(...list);
  result.ok = result.removed.length === 0 && result.added.length === 0 && result.problems.length === 0;
  return result;
}

function firstDifference(a: string[], b: string[]): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (t: string[]) => t.slice(Math.max(0, i - 6), i + 6).join(' ');
  return `first difference at token ${i}: base \`${ctx(a)}\` vs head \`${ctx(b)}\``;
}

export function formatReport(r: VerifyResult, label: string): string {
  const lines: string[] = [];
  if (r.ok) {
    lines.push(`OK: ${label} is move-only: ${r.statements} top-level statements across ${r.files.length} files preserved token for token.`);
    lines.push(`    ignored: ${r.ignored.length} import/re-export statements; export-modifier toggles: ${r.exportToggles}; wrapped definitions: ${r.wrappedDefinitions}`);
    return lines.join('\n');
  }
  lines.push(...r.problems);
  const pairs = Math.min(r.removed.length, r.added.length);
  for (let i = 0; i < pairs; i++) {
    const a = r.removed[i]!;
    const b = r.added[i]!;
    lines.push(`FAIL: ${b.path}:${b.line} statement differs from ${a.path}:${a.line} (${firstDifference(a.tokens, b.tokens)})`);
  }
  for (const s of r.removed.slice(pairs)) lines.push(`FAIL: ${s.path}:${s.line} statement removed: ${s.tokens.slice(0, 16).join(' ')}`);
  for (const s of r.added.slice(pairs)) lines.push(`FAIL: ${s.path}:${s.line} statement added: ${s.tokens.slice(0, 16).join(' ')}`);
  lines.push(`Why:  ${label} is tagged move-only, so every token must survive the move; ${r.removed.length} base statements and ${r.added.length} head statements have no identical counterpart.`);
  lines.push('Fix:  move behavior edits into a separate commit, or drop the Move-Only trailer; pass --wrapper migration for the W3 split, --wrapper doctor-entry for the W4 doctor peel, or --rename-map <json> for a Mechanical-Rename commit.');
  lines.push(SEE);
  return lines.join('\n');
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}

function readAt(rev: string, path: string): string | undefined {
  try {
    return git(['show', `${rev}:${path}`]);
  } catch {
    return undefined;
  }
}

function main(argv: string[]): number {
  const opts: VerifyOptions = {};
  let range: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--wrapper') {
      const v = argv[++i];
      if (v !== 'migration' && v !== 'doctor-entry') {
        console.error(`unknown --wrapper ${v ?? ''} (supported: migration, doctor-entry)`);
        return 2;
      }
      opts.wrapper = v;
    } else if (a === '--rename-map') {
      opts.renameMap = JSON.parse(readFileSync(argv[++i]!, 'utf8')) as Record<string, string>;
    } else if (a === '--help' || a === '-h') {
      console.log('usage: bun scripts/verify-move-only.ts [<base>..<head> | <commit>] [--wrapper migration|doctor-entry] [--rename-map f.json]');
      return 0;
    } else if (!range) {
      range = a;
    } else {
      console.error(`unexpected argument ${a}`);
      return 2;
    }
  }
  let base: string;
  let head: string;
  if (!range) {
    base = 'HEAD~1';
    head = 'HEAD';
  } else if (range.includes('..')) {
    [base, head] = range.split('..') as [string, string];
  } else {
    base = `${range}~1`;
    head = range;
  }
  const touched = git(['diff', '--name-only', '--no-renames', base, head]).split('\n').filter(Boolean);
  const nonSource = touched.filter((p) => !isSourcePath(p));
  const source = touched.filter(isSourcePath);
  const baseFiles: SideFile[] = [];
  const headFiles: SideFile[] = [];
  for (const p of source) {
    const b = readAt(base, p);
    const h = readAt(head, p);
    if (b !== undefined) baseFiles.push({ path: p, text: b });
    if (h !== undefined) headFiles.push({ path: p, text: h });
  }
  const result = verifyMoveOnly(baseFiles, headFiles, opts);
  if (nonSource.length > 0) {
    result.ok = false;
    for (const p of nonSource) result.problems.push(`FAIL: ${p} is not a TypeScript/JavaScript source file, so the token proof cannot cover it`);
  }
  const label = `${base}..${head}`;
  const report = formatReport(result, label);
  if (result.ok) console.log(report);
  else console.error(report);
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
