/**
 * Refactor wave 1 (W0, EO11): static extraction of the doctor check registry.
 *
 * Walks `buildChecks` in src/commands/doctor.ts (or another root such as
 * `doctorReportRemote`) with the TypeScript compiler
 * API and lists, in source order, every check name the function can push,
 * independent of which checks fire at runtime. Push arguments are resolved
 * statically:
 *
 * - object literals shaped like a Check (a `name` plus `status` or a spread);
 * - calls to named functions, followed through static imports, destructured
 *   dynamic imports and re-exports into the peeled doctor modules (and any
 *   other src module), then into callees whose declared return type mentions
 *   `Check`;
 * - local identifiers, through their initializer and later assignments;
 * - `for (const x of <iterable>) checks.push(x.check)` loops, through the
 *   iterable;
 * - `runWaveChecks(engine, { only, remote })`, whose names are data: the
 *   `id` of every `WAVE_CHECKS` entry matching the same filter runWaveChecks
 *   applies (`registration === only`, no `hostOnly` when remote). The
 *   `name: spec.id` literals inside wave-checks.ts are those same ids and
 *   are not recorded a second time as a template.
 *
 * Dynamic names are recorded as templates (`${expr}` kept verbatim). A name
 * is recorded at its first reachable occurrence. `early_returns_after` lists
 * the last name reachable before each early `return` inside buildChecks.
 *
 * Registry walk (W4 doctor): a root that calls `runDoctorRegistry(...)` is
 * followed into `DOCTOR_CHECK_REGISTRY`, in array order. Each entry's `run`
 * function is walked exactly like a root (its `checks.push(...)` calls), and
 * a `return STOP_DOCTOR` inside it is an early return: the runner stops
 * there, which is where master's `buildChecks` returned early.
 */
import ts from 'typescript';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

export interface DoctorRegistry {
  names: string[];
  /** Every reachable name in walk order, repeats kept (one entry per emit site). */
  sequence: string[];
  early_returns_after: string[];
  unresolved: string[];
}

const sourceCache = new Map<string, ts.SourceFile>();

function parse(file: string): ts.SourceFile {
  let sf = sourceCache.get(file);
  if (!sf) {
    // test-reads-source-ok[structural]: the registry golden pins buildChecks' static check order, which only the AST shows.
    sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sourceCache.set(file, sf);
  }
  return sf;
}

function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

type FnNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;
interface FnRef {
  file: string;
  name: string;
  node: FnNode;
}

function topLevelFunction(sf: ts.SourceFile, name: string): FnNode | null {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          const init = d.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
        }
      }
    }
  }
  return null;
}

/** Static + destructured dynamic imports of a file: local name -> (file, exported name). */
function importMap(sf: ts.SourceFile): Map<string, { file: string; name: string }> {
  const map = new Map<string, { file: string; name: string }>();
  const add = (local: string, spec: string, imported: string) => {
    const file = resolveModule(sf.fileName, spec);
    if (file && !map.has(local)) map.set(local, { file, name: imported });
  };
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) add(el.name.text, st.moduleSpecifier.text, (el.propertyName ?? el.name).text);
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      let init: ts.Expression = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        init.arguments[0] &&
        ts.isStringLiteral(init.arguments[0])
      ) {
        for (const el of node.name.elements) {
          if (ts.isIdentifier(el.name)) {
            const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            add(el.name.text, init.arguments[0].text, imported);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

const importCache = new Map<string, Map<string, { file: string; name: string }>>();
function importsOf(file: string) {
  let m = importCache.get(file);
  if (!m) {
    m = importMap(parse(file));
    importCache.set(file, m);
  }
  return m;
}

function resolveExport(file: string, name: string, seen = new Set<string>()): FnRef | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const sf = parse(file);
  const local = topLevelFunction(sf, name);
  if (local) return { file, name, node: local };
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = resolveModule(file, st.moduleSpecifier.text);
    if (!target) continue;
    if (!st.exportClause) {
      const r = resolveExport(target, name, seen);
      if (r) return r;
    } else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === name) return resolveExport(target, (el.propertyName ?? el.name).text, seen);
      }
    }
  }
  const imp = importsOf(file).get(name);
  return imp ? resolveExport(imp.file, imp.name, seen) : null;
}

function resolveCallee(file: string, callee: ts.Expression): FnRef | null {
  if (ts.isPropertyAccessExpression(callee)) {
    const target = unwrap(callee.expression);
    if (
      ts.isCallExpression(target) &&
      target.expression.kind === ts.SyntaxKind.ImportKeyword &&
      target.arguments[0] &&
      ts.isStringLiteral(target.arguments[0])
    ) {
      const mod = resolveModule(file, target.arguments[0].text);
      return mod ? resolveExport(mod, callee.name.text) : null;
    }
    return null;
  }
  if (!ts.isIdentifier(callee)) return null;
  const local = topLevelFunction(parse(file), callee.text);
  if (local) return { file, name: callee.text, node: local };
  const imp = importsOf(file).get(callee.text);
  return imp ? resolveExport(imp.file, imp.name) : null;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
    } else if (ts.isSpreadElement(e)) {
      e = e.expression;
    } else {
      return e;
    }
  }
}

function templateText(expr: ts.TemplateExpression): string {
  let out = expr.head.text;
  for (const span of expr.templateSpans) out += '${' + span.expression.getText() + '}' + span.literal.text;
  return out;
}

class Extractor {
  names: string[] = [];
  sequence: string[] = [];
  unresolved: string[] = [];
  lastAdded: string | null = null;
  private seenNames = new Set<string>();
  private active = new Set<string>();
  /** Call-site string arguments bound to the walked function's parameters (name-forwarding helpers such as `checkError(name, …)`). */
  private paramBindings = new Map<string, string>();

  add(name: string) {
    this.lastAdded = name;
    this.sequence.push(name);
    if (this.seenNames.has(name)) return;
    this.seenNames.add(name);
    this.names.push(name);
  }

  /** The string a `name` property value evaluates to, or a template. */
  nameValue(expr: ts.Expression, file: string): string | null {
    const e = unwrap(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) return templateText(e);
    if (ts.isIdentifier(e)) {
      const bound = this.paramBindings.get(e.text);
      if (bound !== undefined && isParameterOfEnclosingFunction(e)) return bound;
      const decl = findDeclaration(e);
      if (decl?.initializer) return this.nameValue(decl.initializer, file);
    }
    return '${' + e.getText() + '}';
  }

  checkObjectName(obj: ts.ObjectLiteralExpression, file: string): string | null {
    let name: string | null = null;
    let shaped = false;
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name') {
        if (p.initializer.getText() === 'spec.id' && file.endsWith('wave-checks.ts')) return null;
        name = this.nameValue(p.initializer, file);
      }
      else if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'name') name = this.nameValue(p.name, file);
      else if (
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'status'
      ) {
        shaped = true;
      } else if (ts.isSpreadAssignment(p)) shaped = true;
    }
    return shaped ? name : null;
  }

  /** Names produced by a push argument (or anything that flows into one). */
  fromExpr(expr: ts.Expression, file: string) {
    const e = unwrap(expr);
    if (ts.isObjectLiteralExpression(e)) {
      const n = this.checkObjectName(e, file);
      if (n) this.add(n);
      else this.unresolved.push(`${relative(REPO_ROOT, file)}: object without check name: ${e.getText().slice(0, 60)}`);
      return;
    }
    if (ts.isConditionalExpression(e)) {
      this.fromExpr(e.whenTrue, file);
      this.fromExpr(e.whenFalse, file);
      return;
    }
    if (
      ts.isBinaryExpression(e) &&
      (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      this.fromExpr(e.left, file);
      this.fromExpr(e.right, file);
      return;
    }
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression) && e.expression.text === 'runWaveChecks') {
        for (const id of waveCheckIds(e, file)) this.add(id);
        return;
      }
      const fn = resolveCallee(file, e.expression);
      if (fn) this.fromFunction(fn, e.arguments, file);
      else this.unresolved.push(`${relative(REPO_ROOT, file)}: unresolved call ${e.expression.getText()}`);
      return;
    }
    if (ts.isIdentifier(e)) {
      const loop = forOfBinding(e);
      if (loop) {
        this.fromExpr(loop.expression, file);
        return;
      }
      const decl = findDeclaration(e);
      if (!decl) {
        this.unresolved.push(`${relative(REPO_ROOT, file)}: unresolved identifier ${e.text}`);
        return;
      }
      if (decl.initializer) this.fromExpr(decl.initializer, file);
      for (const rhs of assignmentsTo(decl, e.text)) this.fromExpr(rhs, file);
      return;
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      this.fromExpr(e.expression, file);
      return;
    }
    this.unresolved.push(`${relative(REPO_ROOT, file)}: unsupported push argument ${e.getText().slice(0, 60)}`);
  }

  /** Every check a function can emit: Check-shaped literals + Check-returning callees, in source order. */
  fromFunction(fn: FnRef, args: readonly ts.Expression[] = [], argFile = fn.file) {
    const key = `${fn.file}#${fn.name}`;
    if (this.active.has(key)) return;
    this.active.add(key);
    const saved = this.paramBindings;
    const bindings = new Map<string, string>();
    fn.node.parameters.forEach((p, i) => {
      if (!ts.isIdentifier(p.name) || !args[i]) return;
      const v = this.nameValue(args[i], argFile);
      if (v !== null && !v.startsWith('${')) bindings.set(p.name.text, v);
    });
    this.paramBindings = bindings;
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const n = this.checkObjectName(node, fn.file);
        if (n) this.add(n);
      } else if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === 'runWaveChecks') {
          for (const id of waveCheckIds(node, fn.file)) this.add(id);
        } else {
          const callee = resolveCallee(fn.file, node.expression);
          if (callee && returnsCheck(callee.node)) this.fromFunction(callee, node.arguments, fn.file);
        }
      }
      ts.forEachChild(node, visit);
    };
    if (fn.node.body) visit(fn.node.body);
    this.paramBindings = saved;
    this.active.delete(key);
  }
}

/** True when `id` names a parameter of the function it appears in (and no closer local shadows it). */
function isParameterOfEnclosingFunction(id: ts.Identifier): boolean {
  if (findDeclaration(id)) return false;
  let n: ts.Node | undefined = id.parent;
  while (n && !ts.isFunctionLike(n)) n = n.parent;
  return !!n && (n as ts.SignatureDeclaration).parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text);
}

function returnsCheck(fn: FnNode): boolean {
  return !!fn.type && /\bCheck\b|CheckResult\b/.test(fn.type.getText());
}

/** Nearest declaration of `id` in an enclosing scope, declared before the use. */
function findDeclaration(id: ts.Identifier): ts.VariableDeclaration | null {
  let scope: ts.Node | undefined = id.parent;
  while (scope) {
    let best: ts.VariableDeclaration | null = null;
    const statements: readonly ts.Statement[] | undefined =
      ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) ? scope.statements : ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : undefined;
    if (statements) {
      for (const st of statements) {
        if (st.pos > id.pos) break;
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === id.text) best = d;
        }
      }
    }
    if (best) return best;
    scope = scope.parent;
  }
  return null;
}

function forOfBinding(id: ts.Identifier): ts.ForOfStatement | null {
  let n: ts.Node | undefined = id.parent;
  while (n) {
    if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) if (ts.isIdentifier(d.name) && d.name.text === id.text) return n;
    }
    if (ts.isFunctionLike(n)) return null;
    n = n.parent;
  }
  return null;
}

/** Right-hand sides of `name = <expr>` assignments inside the declaring block. */
function assignmentsTo(decl: ts.VariableDeclaration, name: string): ts.Expression[] {
  const out: ts.Expression[] = [];
  const block = decl.parent.parent.parent;
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      out.push(node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  return out;
}

/** `runWaveChecks(engine, { only: 'wave' })` → ids of WAVE_CHECKS entries registered as 'wave'. */
function waveCheckIds(call: ts.CallExpression, file: string): string[] {
  const opts = call.arguments[1];
  let only: string | null = null;
  let remote = false;
  if (opts && ts.isObjectLiteralExpression(opts)) {
    for (const p of opts.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
      if (p.name.text === 'only' && ts.isStringLiteral(p.initializer)) only = p.initializer.text;
      if (p.name.text === 'remote' && p.initializer.kind === ts.SyntaxKind.TrueKeyword) remote = true;
    }
  }
  const imp = importsOf(file).get('runWaveChecks');
  const waveFile = imp?.file ?? file;
  const sf = parse(waveFile);
  const ids: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'WAVE_CHECKS' && node.initializer) {
      const arr = unwrap(node.initializer);
      if (ts.isArrayLiteralExpression(arr)) {
        for (const el of arr.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue;
          let id: string | null = null;
          let reg: string | null = null;
          let hostOnly = false;
          for (const p of el.properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'hostOnly') hostOnly = true;
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name) || !ts.isStringLiteral(p.initializer)) continue;
            if (p.name.text === 'id') id = p.initializer.text;
            if (p.name.text === 'registration') reg = p.initializer.text;
          }
          if (id && (!only || reg === only) && !(remote && hostOnly)) ids.push(id);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (ids.length === 0) throw new Error(`WAVE_CHECKS not found in ${relative(REPO_ROOT, waveFile)}`);
  return ids;
}

function isChecksPush(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'push' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'checks'
  );
}

export interface DoctorRegistryEntry {
  /** Exported entry binding, e.g. `rlsEntry`. */
  entry: string;
  /** Repo-relative module holding the entry. */
  file: string;
  /** The entry's `name` literal. */
  name: string;
  /** The entry's `emits` literals, in source order. */
  emits: string[];
  /** Check names its `run` function can push, in walk order (first occurrence). */
  names: string[];
  /** True when `run` can return STOP_DOCTOR. */
  stops: boolean;
}

function stringArray(expr: ts.Expression | undefined): string[] {
  const e = expr && unwrap(expr);
  if (!e || !ts.isArrayLiteralExpression(e)) return [];
  return e.elements.filter((el): el is ts.StringLiteral => ts.isStringLiteral(el)).map((el) => el.text);
}

function isStopReturn(node: ts.Node): boolean {
  return ts.isReturnStatement(node) && !!node.expression && ts.isIdentifier(node.expression) && node.expression.text === 'STOP_DOCTOR';
}

interface ResolvedEntry {
  entry: string;
  file: string;
  name: string;
  emits: string[];
  run: FnRef;
}

/** Entries of `DOCTOR_CHECK_REGISTRY` in `registryFile`, in array order. */
function registryEntries(registryFile: string): ResolvedEntry[] {
  const sf = parse(registryFile);
  let arr: ts.ArrayLiteralExpression | null = null;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === 'DOCTOR_CHECK_REGISTRY' && d.initializer) {
        const init = unwrap(d.initializer);
        if (ts.isArrayLiteralExpression(init)) arr = init;
      }
    }
  }
  if (!arr) throw new Error(`DOCTOR_CHECK_REGISTRY not found in ${relative(REPO_ROOT, registryFile)}`);
  return arr.elements.map((el) => {
    if (!ts.isIdentifier(el)) throw new Error(`registry element is not an identifier: ${el.getText()}`);
    const imp = importsOf(registryFile).get(el.text);
    if (!imp) throw new Error(`registry entry ${el.text} is not imported in ${relative(REPO_ROOT, registryFile)}`);
    const esf = parse(imp.file);
    let obj: ts.ObjectLiteralExpression | null = null;
    for (const st of esf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === imp.name && d.initializer && ts.isObjectLiteralExpression(unwrap(d.initializer))) {
          obj = unwrap(d.initializer) as ts.ObjectLiteralExpression;
        }
      }
    }
    if (!obj) throw new Error(`entry ${imp.name} not found in ${relative(REPO_ROOT, imp.file)}`);
    const prop = (key: string) =>
      obj!.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key)?.initializer;
    const nameExpr = prop('name');
    const runExpr = prop('run');
    if (!nameExpr || !ts.isStringLiteral(nameExpr)) throw new Error(`entry ${imp.name}: name must be a string literal`);
    if (!runExpr || !ts.isIdentifier(runExpr)) throw new Error(`entry ${imp.name}: run must name a top-level function`);
    const node = topLevelFunction(esf, runExpr.text);
    if (!node) throw new Error(`entry ${imp.name}: run function ${runExpr.text} not found`);
    return { entry: imp.name, file: imp.file, name: nameExpr.text, emits: stringArray(prop('emits')), run: { file: imp.file, name: runExpr.text, node } };
  });
}

/** Walk one root function: `checks.push(...)` arguments, early returns, and a nested registry run. */
function walkRoot(x: Extractor, fn: FnRef, earlyReturnsAfter: string[], stopsOnly: boolean): void {
  const body = fn.node.body;
  if (!body) return;
  const visit = (node: ts.Node) => {
    if (node !== fn.node && ts.isFunctionLike(node)) return;
    if (isChecksPush(node)) {
      for (const arg of node.arguments) x.fromExpr(arg, fn.file);
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runDoctorRegistry') {
      const runner = resolveCallee(fn.file, node.expression);
      if (!runner) throw new Error(`runDoctorRegistry not resolvable from ${relative(REPO_ROOT, fn.file)}`);
      for (const e of registryEntries(runner.file)) walkRoot(x, e.run, earlyReturnsAfter, true);
      return;
    }
    if (stopsOnly ? isStopReturn(node) : ts.isReturnStatement(node) && node.parent !== body) {
      earlyReturnsAfter.push(x.lastAdded ?? '<start>');
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
}

/**
 * Every entry of the doctor check registry with the names its `run` can push
 * (walked in isolation, so a name shared by two entries is listed by both).
 */
export function extractDoctorRegistryEntries(rel = 'src/commands/doctor/registry.ts'): DoctorRegistryEntry[] {
  return registryEntries(join(REPO_ROOT, rel)).map((e) => {
    const x = new Extractor();
    const stops: string[] = [];
    walkRoot(x, e.run, stops, true);
    return { entry: e.entry, file: relative(REPO_ROOT, e.file), name: e.name, emits: e.emits, names: x.names, stops: stops.length > 0 };
  });
}

/**
 * @param rel root file relative to the repo, e.g. 'src/commands/doctor.ts'
 * @param fnName top-level function whose `checks.push(...)` calls are walked
 */
export function extractDoctorRegistry(rel = 'src/commands/doctor.ts', fnName = 'buildChecks'): DoctorRegistry {
  const rootFile = join(REPO_ROOT, rel);
  const fn = topLevelFunction(parse(rootFile), fnName);
  if (!fn?.body) throw new Error(`${fnName} not found in ${rel}`);
  const x = new Extractor();
  const earlyReturnsAfter: string[] = [];
  walkRoot(x, { file: rootFile, name: fnName, node: fn }, earlyReturnsAfter, false);
  return { names: x.names, sequence: x.sequence, early_returns_after: earlyReturnsAfter, unresolved: x.unresolved };
}
