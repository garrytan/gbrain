/**
 * Finds every driver-accessor use that can run inside an engine transaction.
 *
 * A driver accessor is `.sql` (the postgres.js client a PostgresEngine holds) or `.db` (the PGlite handle a
 * PGLiteEngine holds) read off anything but `this`: `tx.sql`, `(tx as PostgresEngine).sql`,
 * `(tx as unknown as { sql: any }).sql`, `(tx as any)['db']`, `const { sql } = tx as ...`, an alias of a cast,
 * or a typed field (`routed.sql` where `sql?: Sql`). A statement sent through one goes straight to the database:
 * the shadow wrapper sees only BrainEngine method calls, so it neither records the statement nor can its own
 * pre-read rollback be ordered around it.
 *
 * Roots are the callbacks handed to an engine's `transaction` / `transactionDirect` (the members the shadow
 * wrapper wraps), and the callbacks handed to a transaction wrapper: a function that runs one of its own
 * parameters inside a transaction (`topologyTransaction(engine, run)`), found to a fixpoint. From each root the scan follows every call whose callee resolves to a function body in the
 * scanned program (helpers in other files included), so a helper that casts the engine it is given is seen.
 * Calls through the BrainEngine interface stop there: that is the boundary the wrapper intercepts. `this.sql`
 * inside an engine class is the engine's own implementation, below that boundary, and is not reported.
 *
 * Known limit: a function stored in an object or a field and called from there later is not followed, because
 * the checker cannot tell which value the field holds; a function passed straight to a wrapper is.
 */
import ts from 'typescript';
import { relative } from 'node:path';

export const ACCESSOR_NAMES: ReadonlySet<string> = new Set(['sql', 'db']);

export interface AccessorSite {
  /** Path relative to the scan root. */
  file: string;
  line: number;
  /** Enclosing function, `Class.method` for class members. */
  fn: string;
  /** The accessor expression as written. */
  text: string;
  /** Root transaction callback, then each followed function, ending at the accessor's function. */
  chain: string[];
}

function unwrap(expr: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isTypeAssertionExpression(expr)
      || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) expr = expr.expression;
    else return expr;
  }
}

/** `Class.method`, `function`, the variable or property an arrow is assigned to, or `<module>`. */
export function enclosingName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    const owner = at.parent && ts.isClassLike(at.parent) && at.parent.name ? `${at.parent.name.text}.` : '';
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isGetAccessor(at) || ts.isSetAccessor(at)) && at.name) return `${owner}${at.name.getText()}`;
    if (ts.isConstructorDeclaration(at)) return `${owner}constructor`;
    if ((ts.isArrowFunction(at) || ts.isFunctionExpression(at)) && at.parent) {
      const holder = at.parent;
      if ((ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) && holder.name) {
        const cls = ts.isPropertyDeclaration(holder) && ts.isClassLike(holder.parent) && holder.parent.name ? `${holder.parent.name.text}.` : '';
        return `${cls}${holder.name.getText()}`;
      }
    }
  }
  return '<module>';
}

type Body = ts.FunctionLikeDeclaration & { body: ts.Node };

/** `node` lies within `outer` (a parameter of a function declared inside the argument itself is not the caller's). */
function isInside(node: ts.Node, outer: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at; at = at.parent) if (at === outer) return true;
  return false;
}

function bodyOf(decl: ts.Declaration | undefined): Body | undefined {
  if (!decl) return undefined;
  let fn: ts.Node = decl;
  if (ts.isVariableDeclaration(decl) && decl.initializer) fn = unwrap(decl.initializer);
  if (ts.isPropertyAssignment(decl) || ts.isPropertyDeclaration(decl)) fn = decl.initializer ? unwrap(decl.initializer) : decl;
  return ts.isFunctionLike(fn) && (fn as ts.FunctionLikeDeclaration).body ? fn as Body : undefined;
}

export function scanDriverAccessors(program: ts.Program, opts: { root: string; inScope: (file: string) => boolean; txMembers: readonly string[] }): AccessorSite[] {
  const checker = program.getTypeChecker();
  const txMembers = new Set(opts.txMembers);
  const scanned = (sf: ts.SourceFile) => !sf.isDeclarationFile && opts.inScope(sf.fileName);
  const resolve = (node: ts.Node): ts.Symbol | undefined => {
    const sym = checker.getSymbolAtLocation(node);
    return sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  };
  const ownerName = (decl: ts.Declaration): string | undefined => {
    const parent = decl.parent;
    return parent && (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent)) && parent.name ? parent.name.text : undefined;
  };

  /** A transaction member of an engine: declared on BrainEngine, an engine class, or unresolved (an `any` receiver). */
  const isEngineTransaction = (call: ts.CallExpression): boolean => {
    const callee = unwrap(call.expression);
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
    if (!name || !txMembers.has(name)) return false;
    const sym = resolve(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    if (!sym?.declarations?.length) return true;
    return sym.declarations.some(decl => /Engine$/.test(ownerName(decl) ?? ''));
  };

  /** An engine value: its type (or one constituent) has a `transaction` member, as BrainEngine and every engine class do. */
  const isEngine = (type: ts.Type): boolean => (type.isUnionOrIntersection() ? type.types : [type])
    .some(part => checker.getPropertyOfType(checker.getApparentType(part), 'transaction') !== undefined);

  /**
   * `receiver.<name>` reads a driver handle when the receiver is a cast (the cast is the escape from BrainEngine,
   * whatever type it claims), the receiver is an engine, the property is declared on an engine class, or the value
   * is `any` / `unknown` / a postgres.js or PGlite type.
   */
  const accessorType = (node: ts.Node, receiver: ts.Expression | undefined, sym: ts.Symbol | undefined): boolean => {
    if (receiver) {
      let inner = receiver;
      while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
      if (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner) || ts.isSatisfiesExpression(inner)) return true;
      if (isEngine(checker.getTypeAtLocation(receiver))) return true;
    }
    if (sym?.declarations?.some(decl => /Engine$/.test(ownerName(decl) ?? ''))) return true;
    const type = checker.getTypeAtLocation(node);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    return /\b(Sql|TransactionSql|ReservedSql|PGlite|PGliteInterface)\b/.test(checker.typeToString(checker.getNonNullableType(type)));
  };

  /** The accessor text when `node` reads a driver handle off something other than `this`. */
  const accessorAt = (node: ts.Node): string | undefined => {
    if (ts.isPropertyAccessExpression(node) && ACCESSOR_NAMES.has(node.name.text)) {
      if (unwrap(node.expression).kind === ts.SyntaxKind.ThisKeyword) return undefined;
      return accessorType(node, node.expression, resolve(node.name)) ? node.getText() : undefined;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && ACCESSOR_NAMES.has(node.argumentExpression.text)) {
      if (unwrap(node.expression).kind === ts.SyntaxKind.ThisKeyword) return undefined;
      return accessorType(node, node.expression, resolve(node)) ? node.getText() : undefined;
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName && (ts.isIdentifier(node.propertyName) || ts.isStringLiteralLike(node.propertyName)) ? node.propertyName.text
        : !node.propertyName && ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (!key || !ACCESSOR_NAMES.has(key)) return undefined;
      const decl = node.parent.parent;
      if (ts.isVariableDeclaration(decl) && decl.initializer && unwrap(decl.initializer).kind === ts.SyntaxKind.ThisKeyword) return undefined;
      return accessorType(node, ts.isVariableDeclaration(decl) ? decl.initializer : undefined, resolve(node.name)) ? `{ ${node.getText()} } = ${ts.isVariableDeclaration(decl) && decl.initializer ? decl.initializer.getText() : '<parameter>'}` : undefined;
    }
    return undefined;
  };

  const sites = new Map<string, AccessorSite>();
  const visited = new Set<ts.Node>();

  const walk = (fn: Body, chain: string[]): void => {
    if (visited.has(fn)) return;
    visited.add(fn);
    const visit = (node: ts.Node): void => {
      const text = accessorAt(node);
      if (text) {
        const sf = node.getSourceFile();
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const file = relative(opts.root, sf.fileName);
        const key = `${file}:${line}:${node.getStart()}`;
        if (!sites.has(key)) sites.set(key, { file, line, fn: enclosingName(node), text, chain });
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = unwrap(node.expression);
        const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
        for (const decl of resolve(target)?.declarations ?? []) {
          const next = bodyOf(decl);
          if (next && scanned(next.getSourceFile())) walk(next, [...chain, `${relative(opts.root, next.getSourceFile().fileName)}#${enclosingName(next.body)}`]);
        }
        // A function passed by name (`transaction(work)`, `items.map(write)`) runs inside the call too.
        for (const arg of node.arguments ?? []) {
          const plain = unwrap(arg);
          if (!ts.isIdentifier(plain) && !ts.isPropertyAccessExpression(plain)) continue;
          for (const decl of resolve(ts.isPropertyAccessExpression(plain) ? plain.name : plain)?.declarations ?? []) {
            const next = bodyOf(decl);
            if (next && scanned(next.getSourceFile())) walk(next, [...chain, `${relative(opts.root, next.getSourceFile().fileName)}#${enclosingName(next.body)}`]);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
  };

  // Every call in scope, once; transaction wrappers are found over this list.
  const calls: ts.CallExpression[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!scanned(sf)) continue;
    const collect = (node: ts.Node): void => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, collect); };
    collect(sf);
  }
  const calleeBodies = new Map<ts.CallExpression, Body[]>();
  const calleesOf = (call: ts.CallExpression): Body[] => {
    let bodies = calleeBodies.get(call);
    if (!bodies) {
      const callee = unwrap(call.expression);
      const target = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      bodies = (resolve(target)?.declarations ?? []).map(bodyOf).filter((b): b is Body => !!b && scanned(b.getSourceFile()));
      calleeBodies.set(call, bodies);
    }
    return bodies;
  };

  /**
   * A transaction wrapper runs one of its own parameters inside a transaction (`topologyTransaction(engine, run)`
   * calls `engine.transaction(tx => scoped(engine, tx, run))`). Its parameter positions are transaction slots,
   * like a `transaction` callback: a function passed there is a root too. Found to a fixpoint, so a wrapper of a
   * wrapper counts.
   */
  const wrappers = new Map<Body, Set<number>>();
  /** Names a wrapper can be called by, so a call to any other name skips the checker. */
  const wrapperNames = new Set<string>();
  const namesOf = (fn: Body): string[] => {
    const holder = fn.parent;
    const own = fn.name && (ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name)) ? [fn.name.text] : [];
    const held = holder && (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) && ts.isIdentifier(holder.name) ? [holder.name.text] : [];
    return [...own, ...held];
  };
  const engineTx = new Map<ts.CallExpression, boolean>();
  const slotsOf = (call: ts.CallExpression): number[] => {
    let tx = engineTx.get(call);
    if (tx === undefined) { tx = isEngineTransaction(call); engineTx.set(call, tx); }
    if (tx) return call.arguments.map((_, i) => i);
    const callee = unwrap(call.expression);
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : undefined;
    if (!name || !wrapperNames.has(name)) return [];
    const out = new Set<number>();
    for (const body of calleesOf(call)) for (const i of wrappers.get(body) ?? []) out.add(i);
    return [...out];
  };
  const paramRefs = new Map<ts.Node, ts.ParameterDeclaration[]>();
  const paramsReferencedBy = (arg: ts.Expression): ts.ParameterDeclaration[] => {
    let refs = paramRefs.get(arg);
    if (!refs) {
      refs = [];
      // Only names of the enclosing functions' parameters can resolve to one; skip the checker for the rest.
      const names = new Set<string>();
      for (let at: ts.Node | undefined = arg.parent; at; at = at.parent) {
        if (ts.isFunctionLike(at)) for (const param of at.parameters) if (ts.isIdentifier(param.name)) names.add(param.name.text);
      }
      const seen = new Set<ts.ParameterDeclaration>();
      const note = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && names.has(node.text)) {
          const decl = checker.getSymbolAtLocation(node)?.valueDeclaration;
          if (decl && ts.isParameter(decl) && !seen.has(decl)) { seen.add(decl); refs!.push(decl); }
        }
        ts.forEachChild(node, note);
      };
      note(arg);
      paramRefs.set(arg, refs);
    }
    return refs;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const call of calls) {
      for (const i of slotsOf(call)) {
        const arg = call.arguments[i];
        if (!arg) continue;
        for (const param of paramsReferencedBy(arg)) {
          const owner = param.parent;
          if (!ts.isFunctionLike(owner) || !(owner as ts.FunctionLikeDeclaration).body || arg === owner || isInside(owner, arg)) continue;
          const index = owner.parameters.indexOf(param);
          const set = wrappers.get(owner as Body) ?? new Set<number>();
          if (!set.has(index)) {
            set.add(index); wrappers.set(owner as Body, set); changed = true;
            for (const name of namesOf(owner as Body)) wrapperNames.add(name);
          }
        }
      }
    }
  }

  for (const call of calls) {
    const slots = slotsOf(call);
    if (!slots.length) continue;
    const sf = call.getSourceFile();
    const label = `${relative(opts.root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(call.getStart()).line + 1}#${enclosingName(call)}`;
    for (const i of slots) {
      const arg = call.arguments[i];
      if (!arg) continue;
      const plain = unwrap(arg);
      const direct = ts.isFunctionLike(plain) && (plain as ts.FunctionLikeDeclaration).body ? plain as Body : undefined;
      const named = !direct && (ts.isIdentifier(plain) || ts.isPropertyAccessExpression(plain))
        ? (resolve(ts.isPropertyAccessExpression(plain) ? plain.name : plain)?.declarations ?? []).map(bodyOf).find(Boolean) : undefined;
      const fn = direct ?? named;
      if (fn) walk(fn, [label]);
    }
  }
  return [...sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
