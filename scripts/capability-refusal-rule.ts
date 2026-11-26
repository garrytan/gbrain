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
 *
 * Not counted: a `.then(ok, onError)` second argument, a named `.catch(handler)` and a promise held in a
 * variable before `.catch` (the scanner builds only try/catch and inline `.catch(fn)` sites).
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
export const RAW_SQL_METHODS: ReadonlySet<string> = new Set(['executeRaw', 'executeRawDirect', 'executeRawJsonb']);

/**
 * Calls that rethrow a capability refusal and let any other error through to the fallback.
 * `nullUnlessCapabilityRefusal` is defined in `src/core/engine-capability-refusal.ts` on the Rust engine branch;
 * until that lands here, only `rethrowCapabilityRefusal` has a definition in `src/`.
 */
const RETHROW_HELPERS: ReadonlySet<string> = new Set(['rethrowCapabilityRefusal', 'nullUnlessCapabilityRefusal']);

/** Files that implement an engine (Rust never runs them), relative to the repository root. */
export const ENGINE_IMPLEMENTATION_PATH =
  /(^|\/)src\/core\/(engine-sql|pglite-engine|postgres-engine|schema-migrations|rust-engine)\/|(^|\/)src\/core\/(pglite|postgres)-engine\.ts$|(^|\/)src\/core\/migrate\.ts$|\.generated\.ts$/;

/** Bare helpers that send caller SQL on an engine passed as their first argument. */
export const RAW_SQL_FUNCTIONS: ReadonlySet<string> = new Set(['executeRawJsonb']);

const isRawSqlCall = (n: ts.CallExpression): boolean =>
  (ts.isPropertyAccessExpression(n.expression) && RAW_SQL_METHODS.has(n.expression.name.text))
  || (ts.isIdentifier(n.expression) && RAW_SQL_FUNCTIONS.has(n.expression.text));

/**
 * Whether `node` runs a raw-SQL engine call whose failure reaches the catch. A function declaration or a
 * callback nothing awaits runs elsewhere and does not count. A callback inside an awaited call
 * (`await tx(async t => t.executeRaw(..))`, `await Promise.all(xs.map(x => e.executeRaw(..)))`) does:
 * its rejection rejects the awaited call. `awaited` starts true when `node` is the receiver of a
 * `.catch(fn)`, since the whole chain rejects into the handler.
 */
export function guardsRawSqlCall(node: ts.Node, awaited = false): boolean {
  let found = false;
  const visit = (n: ts.Node, inAwait: boolean): void => {
    if (found) return;
    if (n !== node && ts.isFunctionLike(n) && !(inAwait && (ts.isArrowFunction(n) || ts.isFunctionExpression(n)))) return;
    if (ts.isCallExpression(n) && isRawSqlCall(n)) {
      found = true;
      return;
    }
    // A callback body starts a fresh scope: what it awaits counts, what it merely starts does not.
    const next = n !== node && ts.isFunctionLike(n) ? false : inAwait || ts.isAwaitExpression(n);
    ts.forEachChild(n, c => visit(c, next));
  };
  visit(node, awaited);
  return found;
}

const isName = (e: ts.Expression, name: string | undefined): boolean => !!name && ts.isIdentifier(e) && e.text === name;

/** `rethrowCapabilityRefusal(err)` / `nullUnlessCapabilityRefusal(err)` on the caught error. */
function isRethrowHelperCall(e: ts.Expression, errorName: string | undefined): boolean {
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && RETHROW_HELPERS.has(e.expression.text)
    && e.arguments.length >= 1 && isName(e.arguments[0]!, errorName);
}

/** `isEngineCapabilityRefusal(err)`, optionally inside `||` or parentheses (`&&` and `!` are not recognised). */
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
    if (ts.isReturnStatement(s) || ts.isIfStatement(s) || ts.isSwitchStatement(s) || ts.isTryStatement(s)) return false;
    if (ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) return false;
  }
  return false;
}

/** True for a violation: a catch around a raw-SQL engine call whose handler can swallow a capability refusal. */
export function capabilityRefusalSwallowed(site: CapabilityRefusalSite): boolean {
  if (ENGINE_IMPLEMENTATION_PATH.test(site.sourceFile.fileName.replace(/\\/g, '/'))) return false;
  return guardsRawSqlCall(site.guarded, site.kind === 'promise-catch') && !handlerRethrowsCapabilityRefusal(site);
}

export const CAPABILITY_REFUSAL_RULE = {
  name: 'capability-refusal-rethrow',
  metric: 'capability_refusal_swallowed',
  okMarker: 'capability-refusal-ok',
  matcher: (site: CapabilityRefusalSite): boolean => capabilityRefusalSwallowed(site),
} as const;
