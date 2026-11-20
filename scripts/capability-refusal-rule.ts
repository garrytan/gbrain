/**
 * Capability-refusal rule for the silent read-catch guard.
 *
 * A Rust brain refuses every raw-SQL statement it has not typed with the code
 * `engine_capability_missing`. A catch around that call that falls back to a
 * default turns the refusal into a quiet wrong answer: the reply looks whole,
 * but a stage, a card or a notice is missing. The rule: in a catch around a
 * raw-SQL engine call, a capability refusal must be rethrown before the
 * fallback runs (`rethrowCapabilityRefusal(err)`, `nullUnlessCapabilityRefusal`,
 * `if (isEngineCapabilityRefusal(err)) throw err`, or a plain rethrow).
 *
 * The rule is one `{ name, metric, okMarker, matcher }` entry for the guard's
 * rule list. `matcher` reads only the site fields named in
 * `CapabilityRefusalSite`, a structural subset of the guard's site context, so
 * the guard can add the entry without an adapter. Engine implementation files
 * (the engines, their SQL modules, migrations) are out of scope: Rust never
 * runs them.
 */
import ts from 'typescript';

/** The site fields the matcher reads (a subset of the guard's site context). */
export interface CapabilityRefusalSite {
  kind: 'try-catch' | 'promise-catch';
  /** The try block, or the receiver of `.catch(fn)`. */
  guarded: ts.Node;
  /** The catch block statements, or the handler body (an expression body is one return statement). */
  handlerStatements: readonly ts.Statement[];
  /** The caught error's name, when the handler binds one. */
  errorName?: string;
  sourceFile: ts.SourceFile;
}

/** Engine methods that send caller SQL; Rust refuses each statement it has not typed. */
export const RAW_SQL_METHODS: ReadonlySet<string> = new Set(['executeRaw', 'executeRawJsonb']);

/** Calls that rethrow a capability refusal and let any other error through to the fallback. */
const RETHROW_HELPERS: ReadonlySet<string> = new Set(['rethrowCapabilityRefusal', 'nullUnlessCapabilityRefusal']);

/** Files that implement an engine (Rust never runs them), relative to the repository root. */
export const ENGINE_IMPLEMENTATION_PATH =
  /(^|\/)src\/core\/(engine-sql|pglite-engine|postgres-engine|schema-migrations|rust-engine)\/|(^|\/)src\/core\/(pglite|postgres)-engine\.ts$|(^|\/)src\/core\/migrate\.ts$|\.generated\.ts$/;

/** Whether `node` runs a raw-SQL engine call itself (calls inside nested functions run elsewhere and do not count). */
export function guardsRawSqlCall(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n !== node && ts.isFunctionLike(n)) return;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && RAW_SQL_METHODS.has(n.expression.name.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

const isName = (e: ts.Expression, name: string | undefined): boolean => !!name && ts.isIdentifier(e) && e.text === name;

/** `rethrowCapabilityRefusal(err)` / `nullUnlessCapabilityRefusal(err)` on the caught error. */
function isRethrowHelperCall(e: ts.Expression, errorName: string | undefined): boolean {
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && RETHROW_HELPERS.has(e.expression.text)
    && e.arguments.length >= 1 && isName(e.arguments[0]!, errorName);
}

/** `isEngineCapabilityRefusal(err)`, optionally inside `||` / `&&` / parentheses. */
function testsCapabilityRefusal(e: ts.Expression, errorName: string | undefined): boolean {
  if (ts.isParenthesizedExpression(e)) return testsCapabilityRefusal(e.expression, errorName);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return testsCapabilityRefusal(e.left, errorName) || testsCapabilityRefusal(e.right, errorName);
  }
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'isEngineCapabilityRefusal'
    && e.arguments.length >= 1 && isName(e.arguments[0]!, errorName);
}

/** An unconditional `throw`: the caught error or a wrapper of it; either way the failure is not silent. */
function isThrow(s: ts.Statement): boolean {
  return ts.isThrowStatement(s);
}

function thenRethrows(s: ts.Statement): boolean {
  if (isThrow(s)) return true;
  return ts.isBlock(s) && s.statements.length > 0 && isThrow(s.statements[0]!);
}

/**
 * Whether the handler lets a capability refusal through before any fallback: one of its leading
 * statements, before the first return, branch or assignment, rethrows it.
 */
export function handlerRethrowsCapabilityRefusal(site: CapabilityRefusalSite): boolean {
  const { handlerStatements: body, errorName } = site;
  for (const s of body) {
    if (isThrow(s)) return true;
    if (ts.isExpressionStatement(s) && isRethrowHelperCall(s.expression, errorName)) return true;
    if (ts.isReturnStatement(s) && s.expression && isRethrowHelperCall(s.expression, errorName)) return true;
    if (ts.isIfStatement(s) && testsCapabilityRefusal(s.expression, errorName) && thenRethrows(s.thenStatement)) return true;
    // Logging, locals and other side effects may come first; the first answer or branch ends the search.
    if (ts.isReturnStatement(s) || ts.isIfStatement(s) || ts.isTryStatement(s)) return false;
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false;
  }
  return false;
}

/** True for a violation: a catch around a raw-SQL engine call whose handler can swallow a capability refusal. */
export function capabilityRefusalSwallowed(site: CapabilityRefusalSite): boolean {
  if (ENGINE_IMPLEMENTATION_PATH.test(site.sourceFile.fileName.replace(/\\/g, '/'))) return false;
  return guardsRawSqlCall(site.guarded) && !handlerRethrowsCapabilityRefusal(site);
}

export const CAPABILITY_REFUSAL_RULE = {
  name: 'capability-refusal-rethrow',
  metric: 'capability_refusal_swallowed',
  okMarker: 'capability-refusal-ok',
  matcher: (site: CapabilityRefusalSite): boolean => capabilityRefusalSwallowed(site),
} as const;
