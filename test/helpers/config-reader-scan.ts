/**
 * Source scan behind test/config-reader-keys-registered.test.ts (#6780).
 *
 * Finds every `getConfig(<arg>)` call under a root and resolves its argument
 * syntactically: a string literal, a template literal (to its static prefix),
 * a const in scope (same file, named import, or a destructured dynamic
 * import), a const object's property, both arms of `?:`/`??`/`||`, or a
 * key-builder function whose returns resolve. Anything else (a parameter, a
 * `let`, a computed call) is reported unresolved with its source text.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';

export type ConfigReadTarget =
  | { kind: 'keys'; keys: string[] }
  | { kind: 'template'; prefix: string }
  | { kind: 'unresolved'; via: 'parameter' | 'other' };

export interface ConfigRead { file: string; line: number; expr: string; target: ConfigReadTarget }

const MAX_DEPTH = 8;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

export function scanConfigReads(root: string, subdir = 'src'): ConfigRead[] {
  const sources = new Map<string, ts.SourceFile>();
  const source = (path: string): ts.SourceFile => {
    let sf = sources.get(path);
    if (!sf) {
      sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      sources.set(path, sf);
    }
    return sf;
  };
  const moduleFile = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null;
    const base = resolve(dirname(from), spec);
    for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* next candidate */ }
    }
    return null;
  };

  type Decl = ts.Expression | ts.FunctionLikeDeclaration | ts.ParameterDeclaration | ts.ForOfStatement | null;

  const exported = (file: string, name: string, depth: number): Decl => {
    if (depth > MAX_DEPTH) return null;
    for (const stmt of source(file).statements) {
      const found = declaredIn(stmt, name, file, depth);
      if (found !== undefined) return found;
      if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.name.text !== name) continue;
          const target = moduleFile(file, (stmt.moduleSpecifier as ts.StringLiteral).text);
          return target ? exported(target, (el.propertyName ?? el.name).text, depth + 1) : null;
        }
      }
    }
    return null;
  };

  const importedDecl = (file: string, spec: string, name: string, depth: number): Decl => {
    const target = moduleFile(file, spec);
    return target ? exported(target, name, depth + 1) : null;
  };

  const dynamicImportSpec = (init: ts.Expression | undefined): string | null => {
    let e = init;
    while (e && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
    if (e && ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword && e.arguments[0] && ts.isStringLiteralLike(e.arguments[0])) {
      return e.arguments[0].text;
    }
    return null;
  };

  /** undefined = not declared by this statement; null = declared but not a const value. */
  const declaredIn = (stmt: ts.Node, name: string, file: string, depth: number): Decl | undefined => {
    if (ts.isVariableStatement(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) {
          if (!isConst || !d.initializer) return null;
          return d.initializer;
        }
        if (ts.isObjectBindingPattern(d.name)) {
          for (const el of d.name.elements) {
            if (!ts.isIdentifier(el.name) || el.name.text !== name) continue;
            const spec = isConst ? dynamicImportSpec(d.initializer) : null;
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name;
            return spec ? importedDecl(file, spec, prop, depth) : null;
          }
        }
      }
      return undefined;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
    if (ts.isImportDeclaration(stmt) && stmt.importClause?.namedBindings && ts.isNamedImports(stmt.importClause.namedBindings)) {
      for (const el of stmt.importClause.namedBindings.elements) {
        if (el.name.text === name) return importedDecl(file, (stmt.moduleSpecifier as ts.StringLiteral).text, (el.propertyName ?? el.name).text, depth);
      }
    }
    return undefined;
  };

  const bindsName = (b: ts.BindingName, name: string): boolean => ts.isIdentifier(b)
    ? b.text === name
    : b.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, name));

  /** Lexical lookup from a use site outward to the file's top level. */
  const lookup = (id: ts.Identifier, file: string, depth: number): Decl => {
    for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
      if (ts.isFunctionLike(node)) {
        const param = node.parameters.find((p) => bindsName(p.name, id.text));
        if (param) return param;
      }
      if ((ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) && node.initializer && ts.isVariableDeclarationList(node.initializer)
        && node.initializer.declarations.some((d) => bindsName(d.name, id.text))) {
        return ts.isForOfStatement(node) && ts.isIdentifier(node.initializer.declarations[0].name) ? node : null;
      }
      if (ts.isCatchClause(node) && node.variableDeclaration && bindsName(node.variableDeclaration.name, id.text)) return null;
      if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
        for (const stmt of node.statements) {
          const found = declaredIn(stmt, id.text, file, depth);
          if (found !== undefined) return found;
        }
      }
    }
    return null;
  };

  const strip = (e: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    return e;
  };

  const fileOf = (n: ts.Node): string => n.getSourceFile().fileName;

  const OTHER: ConfigReadTarget = { kind: 'unresolved', via: 'other' };

  /** A parameter typed as a union of string literals resolves to those literals. */
  const literalUnion = (type: ts.TypeNode | undefined): string[] | null => {
    if (!type) return null;
    const members = ts.isUnionTypeNode(type) ? type.types : [type];
    const out: string[] = [];
    for (const m of members) {
      if (!ts.isLiteralTypeNode(m) || !ts.isStringLiteral(m.literal)) return null;
      out.push(m.literal.text);
    }
    return out;
  };

  const resolveDecl = (decl: Decl, depth: number): ConfigReadTarget => {
    if (!decl) return OTHER;
    if (ts.isParameter(decl as ts.Node)) {
      const keys = literalUnion((decl as ts.ParameterDeclaration).type);
      return keys ? { kind: 'keys', keys } : { kind: 'unresolved', via: 'parameter' };
    }
    if (ts.isForOfStatement(decl as ts.Node)) return elementsOf((decl as ts.ForOfStatement).expression, depth + 1);
    if (ts.isFunctionLike(decl as ts.Node)) return OTHER;
    return resolveExpr(decl as ts.Expression, depth + 1);
  };

  /** `for (const k of X)`: X a const array literal, or Object.keys/values of a const object literal. */
  const elementsOf = (raw: ts.Expression, depth: number): ConfigReadTarget => {
    if (depth > MAX_DEPTH) return OTHER;
    const e = strip(raw);
    if (ts.isArrayLiteralExpression(e)) {
      const parts = e.elements.map((el) => ts.isSpreadElement(el) ? elementsOf(el.expression, depth + 1) : resolveExpr(el, depth + 1));
      return parts.length > 0 ? merge(parts) : OTHER;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)
      && e.expression.expression.text === 'Object' && e.arguments[0]) {
      const obj = objectLiteral(e.arguments[0], depth + 1);
      const assignments = obj?.properties.filter(ts.isPropertyAssignment) ?? [];
      if (assignments.length === 0) return OTHER;
      if (e.expression.name.text === 'keys') {
        return { kind: 'keys', keys: assignments.map((p) => ts.isStringLiteral(p.name) || ts.isIdentifier(p.name) ? p.name.text : p.name.getText()) };
      }
      if (e.expression.name.text === 'values') return merge(assignments.map((p) => resolveExpr(p.initializer, depth + 1)));
      return OTHER;
    }
    if (ts.isIdentifier(e)) {
      const decl = lookup(e, fileOf(e), depth);
      return decl && !ts.isParameter(decl as ts.Node) && !ts.isFunctionLike(decl as ts.Node) && !ts.isForOfStatement(decl as ts.Node)
        ? elementsOf(decl as ts.Expression, depth + 1) : OTHER;
    }
    return OTHER;
  };

  const objectLiteral = (e: ts.Expression, depth: number): ts.ObjectLiteralExpression | null => {
    const s = strip(e);
    if (ts.isObjectLiteralExpression(s)) return s;
    if (ts.isCallExpression(s) && ts.isPropertyAccessExpression(s.expression) && s.expression.name.text === 'freeze' && s.arguments[0]) return objectLiteral(s.arguments[0], depth);
    if (ts.isIdentifier(s) && depth <= MAX_DEPTH) {
      const decl = lookup(s, fileOf(s), depth);
      if (decl && !ts.isFunctionLike(decl as ts.Node) && !ts.isParameter(decl as ts.Node) && !ts.isForOfStatement(decl as ts.Node)) return objectLiteral(decl as ts.Expression, depth + 1);
    }
    return null;
  };

  const merge = (targets: ConfigReadTarget[]): ConfigReadTarget => {
    if (targets.some((t) => t.kind !== 'keys')) {
      return targets.length === 1 ? targets[0] : (targets.find((t) => t.kind === 'unresolved') ?? targets.find((t) => t.kind === 'template')!);
    }
    return { kind: 'keys', keys: [...new Set(targets.flatMap((t) => (t as { keys: string[] }).keys))] };
  };

  const returnsOf = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body as ts.Expression];
    const out: ts.Expression[] = [];
    const visit = (n: ts.Node) => {
      if (n !== fn.body && ts.isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return out;
  };

  const resolveExpr = (raw: ts.Expression, depth: number): ConfigReadTarget => {
    if (depth > MAX_DEPTH) return OTHER;
    const e = strip(raw);
    if (ts.isStringLiteralLike(e)) return { kind: 'keys', keys: [e.text] };
    if (ts.isTemplateExpression(e)) {
      let keys = [e.head.text];
      for (const span of e.templateSpans) {
        const part = resolveExpr(span.expression, depth + 1);
        if (part.kind !== 'keys' || keys.length * part.keys.length > 16) {
          return keys.length === 1 ? { kind: 'template', prefix: keys[0] } : OTHER;
        }
        keys = keys.flatMap((k) => part.keys.map((p) => k + p + span.literal.text));
      }
      return { kind: 'keys', keys };
    }
    if (ts.isConditionalExpression(e)) return merge([resolveExpr(e.whenTrue, depth + 1), resolveExpr(e.whenFalse, depth + 1)]);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return merge([resolveExpr(e.left, depth + 1), resolveExpr(e.right, depth + 1)]);
    }
    if (ts.isIdentifier(e)) return resolveDecl(lookup(e, fileOf(e), depth), depth);
    if (ts.isPropertyAccessExpression(e)) {
      const obj = objectLiteral(e.expression, depth + 1);
      const prop = obj?.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === e.name.text) as ts.PropertyAssignment | undefined;
      return prop ? resolveExpr(prop.initializer, depth + 1) : OTHER;
    }
    if (ts.isElementAccessExpression(e)) {
      const obj = objectLiteral(e.expression, depth + 1);
      const values = obj?.properties.filter(ts.isPropertyAssignment).map((p) => resolveExpr(p.initializer, depth + 1)) ?? [];
      return values.length > 0 ? merge(values) : OTHER;
    }
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
      const decl = lookup(e.expression, fileOf(e), depth);
      let fn: ts.FunctionLikeDeclaration | null = null;
      if (decl && ts.isFunctionLike(decl as ts.Node)) fn = decl as ts.FunctionLikeDeclaration;
      else if (decl && !ts.isParameter(decl as ts.Node) && !ts.isForOfStatement(decl as ts.Node) && (ts.isArrowFunction(strip(decl as ts.Expression)) || ts.isFunctionExpression(strip(decl as ts.Expression)))) fn = strip(decl as ts.Expression) as ts.ArrowFunction;
      const returns = fn ? returnsOf(fn) : [];
      return returns.length > 0 ? merge(returns.map((r) => resolveExpr(r, depth + 1))) : OTHER;
    }
    return OTHER;
  };

  const reads: ConfigRead[] = [];
  for (const path of walk(join(root, subdir), [])) {
    const sf = source(path);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const callee = n.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
        if (name === 'getConfig') {
          const arg = n.arguments[0];
          reads.push({
            file: relative(root, path),
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            expr: arg.getText().replace(/\s+/g, ' '),
            target: resolveExpr(arg, 0),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return reads;
}
