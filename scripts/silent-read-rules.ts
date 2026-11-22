/**
 * The rule list for scripts/check-silent-read-catches.ts, and the helpers a
 * rule's matcher uses. This file is the plug-in point: a new rule is one new
 * entry in SILENT_READ_RULES (plus its fixtures and baseline rows); the scanner
 * core, the baseline format and the guards-manifest row never change.
 *
 * A rule is `{ name, metric, matcher }`:
 *   name     a stable label for output and docs.
 *   metric   the baseline column that holds this rule's counts. Rows are keyed
 *            by metric, so two rules never share a count. Unique per rule.
 *   matcher  `(site: SiteContext) => boolean`: true when the site violates the
 *            rule. The scanner calls it once for every catch clause and every
 *            `.catch(fn)` call, with everything a matcher needs:
 *              site.kind                'try-catch' | 'promise-catch'
 *              site.catchNode           the CatchClause, or the `.catch(...)` call
 *              site.handlerStatements   the handler's statements (a concise arrow body is one `return`)
 *              site.guarded             the try block, or the receiver chain of `.catch(...)`
 *              site.tryStatement        the `try` (try-catch only)
 *              site.enclosingFunction   the nearest function-like node, or the SourceFile
 *              site.errorName           the caught error's name, when the handler names it
 *              site.sourceFile          the SourceFile
 *   fix      optional one-line fix the guard prints when this rule's count rises.
 *   okMarker optional comment keyword that opts one site out (default `silent-read-ok`),
 *            written `// <okMarker>: <reason>` on the catch line or the line above.
 *            An empty reason fails the guard.
 *
 * The third rule, "a catch around a raw-SQL engine call must rethrow a capability
 * refusal before its fallback" (metric capability_refusal_swallowed, opt-out
 * `capability-refusal-ok`), lives in scripts/capability-refusal-rule.ts and is
 * added below as one entry, the way any later rule is added.
 */
import ts from 'typescript';
import { CAPABILITY_REFUSAL_RULE } from './capability-refusal-rule.ts';

export type SiteKind = 'try-catch' | 'promise-catch';

export interface SiteContext {
  kind: SiteKind;
  catchNode: ts.CatchClause | ts.CallExpression;
  handlerStatements: readonly ts.Statement[];
  guarded: ts.Node;
  tryStatement?: ts.TryStatement;
  enclosingFunction: ts.Node;
  errorName?: string;
  sourceFile: ts.SourceFile;
}

export interface SilentReadRule {
  name: string;
  metric: string;
  okMarker?: string;
  /** One line: how to fix a site this rule counts (shown when its count rises). Rules may share one. */
  fix?: string;
  matcher(site: SiteContext): boolean;
}

/** The fix for the two empty-answer rules. */
export const EMPTY_ANSWER_FIX = 'return a typed degraded marker instead of the empty value (call rethrowCapabilityRefusal(err) first); in a doctor check use checkError(name, what, err); where an empty answer is truly right, catch only that error and add `// silent-read-ok: <reason>` on the catch line or the line above';

/**
 * Engine methods that only write (or manage the connection), so a try around
 * them is not a read. ONE explicit list: a method is skipped only if it is named
 * here, never by a name prefix, so a look-alike (`setConfigLike`, `writeConfig`)
 * that is not listed still counts. One line and one reason per entry.
 */
export const WRITE_ONLY_METHODS: ReadonlyMap<string, string> = new Map<string, string>([
  ['setConfig', 'writes one config key'],
  ['unsetConfig', 'deletes one config key'],
  ['putPage', 'writes a page'],
  ['putRawData', 'writes a raw-data row'],
  ['upsertChunks', 'writes chunks'],
  ['upsertFile', 'writes a file row'],
  ['upsertEventProjection', 'writes an event projection'],
  ['upsertSegmentDerivations', 'writes segment derivations'],
  ['insertFact', 'writes a fact'],
  ['insertFacts', 'writes facts'],
  ['insertLocalWriterRow', 'writes a local-writer row'],
  ['addLink', 'writes a link'],
  ['addLinksBatch', 'writes links'],
  ['addTag', 'writes a tag'],
  ['addTakesBatch', 'writes takes'],
  ['addTimelineEntry', 'writes a timeline entry'],
  ['addTimelineEntriesBatch', 'writes timeline entries'],
  ['addCodeEdges', 'writes code edges'],
  ['addPageTagsById', 'writes page tags'],
  ['addSynthesisEvidence', 'writes synthesis evidence'],
  ['removeLink', 'deletes a link'],
  ['removeLinksByPagesAndSource', 'deletes links'],
  ['removeTag', 'deletes a tag'],
  ['removeTimelineRows', 'deletes timeline rows'],
  ['deletePage', 'deletes a page'],
  ['deletePages', 'deletes pages'],
  ['deleteChunks', 'deletes chunks'],
  ['deleteChunksExcept', 'deletes chunks'],
  ['deleteCodeEdgesForChunks', 'deletes code edges'],
  ['deleteFactsForPage', 'deletes facts'],
  ['deleteTakeRows', 'deletes takes'],
  ['deleteCycleLock', 'releases a cycle lock'],
  ['deleteCycleLockIfStale', 'releases a stale cycle lock'],
  ['deleteEvalCandidatesBefore', 'deletes eval candidates'],
  ['softDeletePage', 'soft-deletes a page'],
  ['softDeletePages', 'soft-deletes pages'],
  ['purgeDeletedPages', 'purges deleted pages'],
  ['restorePage', 'restores a page'],
  ['updateSlug', 'renames a page'],
  ['updateSourceConfig', 'writes a source config'],
  ['updateTake', 'writes a take'],
  ['updateTakeEmbeddings', 'writes take embeddings'],
  ['updateTimelineDetails', 'writes timeline details'],
  ['updatePageContextualRetrievalState', 'writes page state'],
  ['replaceDerivedAliases', 'rewrites aliases'],
  ['replaceDerivedLinks', 'rewrites links'],
  ['replaceDerivedLinksBatch', 'rewrites links'],
  ['replaceWantedLinkRows', 'rewrites wanted links'],
  ['rewriteLinks', 'rewrites links'],
  ['setPageAliases', 'writes aliases'],
  ['setPageEmbeddingSignature', 'writes an embedding signature'],
  ['setEmotionalWeightBatch', 'writes emotional weights'],
  ['setChunkerVersion', 'writes the chunker version'],
  ['setBodyStagingState', 'writes body staging state'],
  ['markPagesExtractedBatch', 'marks pages extracted'],
  ['markPagesAttendanceBlocked', 'marks pages blocked'],
  ['logIngest', 'writes an ingest log row'],
  ['logEvalCandidate', 'writes an eval candidate'],
  ['logEvalCaptureFailure', 'writes an eval capture failure'],
  ['writeContradictionsRun', 'writes a contradictions run'],
  ['writeTextProjectionSeal', 'writes a projection seal'],
  ['putContradictionCacheEntry', 'writes a cache entry'],
  ['putCodeTraversalCache', 'writes a cache entry'],
  ['putDreamVerdict', 'writes a verdict'],
  ['sweepContradictionCache', 'deletes cache rows'],
  ['sweepDreamVerdicts', 'deletes verdict rows'],
  ['sweepSegments', 'deletes segments'],
  ['clearCodeTraversalCache', 'clears a cache'],
  ['acquireCycleLock', 'takes a cycle lock'],
  ['refreshCycleLock', 'refreshes a cycle lock'],
  ['releaseCycleLock', 'releases a cycle lock'],
  ['refreshPageBody', 'rewrites a page body'],
  ['refreshPageOrigin', 'rewrites a page origin'],
  ['sealChunks', 'seals chunks'],
  ['sealSegmentedPage', 'seals a page'],
  ['expireFact', 'expires a fact'],
  ['consolidateFact', 'consolidates a fact'],
  ['supersedeTake', 'supersedes a take'],
  ['resolveTake', 'resolves a take'],
  ['mergeOntologyFact', 'writes an ontology fact'],
  ['applyIdentityDecisions', 'writes identity decisions'],
  ['revertToVersion', 'restores a page version'],
  ['createVersion', 'writes a page version'],
  ['moveChunkIndexes', 'rewrites chunk indexes'],
  ['flipBodyGeneration', 'flips a body generation'],
  ['connect', 'connection lifecycle'],
  ['disconnect', 'connection lifecycle'],
  ['reconnect', 'connection lifecycle'],
  ['initSchema', 'schema setup'],
  ['runMigration', 'schema migration'],
]);

/** Receiver names (the last name in `a.b.c.method()`) that mean an engine or database handle. */
const IO_RECEIVERS = new Set(['engine', 'tx', 'exec', 'brain', 'db', 'sql', 'store', 'client', 'conn', 'pg', 'eng', 'pool']);
/** Receivers whose read-verb-named methods are never a brain read. */
const NON_IO_RECEIVERS = new Set(['path', 'Object', 'Promise', 'Array', 'JSON', 'Math', 'Number', 'String', 'Buffer', 'process', 'console', 'Date', 'URL', 'Reflect', 'util', 'crypto']);
/** Method names too common on Maps, Sets, arrays and `path` to mean a read unless the receiver is an engine. */
const AMBIGUOUS_VERBS = new Set(['get', 'has', 'find', 'resolve', 'search', 'select', 'list', 'count', 'read', 'exists']);
const READ_VERB = /^(?:read|readdir|readdirSync|readlink|load|get|list|find|count|search|fetch|query|select|lookup|resolve|has|exists|executeRaw|traverse|hybrid)(?:[A-Z0-9_]|$)/;

export function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)
    || ts.isTypeAssertionExpression(cur) || ts.isAwaitExpression(cur)) cur = cur.expression;
  return cur;
}

function receiverName(e: ts.Expression): string {
  const x = unwrap(e);
  if (ts.isIdentifier(x)) return x.text;
  if (ts.isPropertyAccessExpression(x)) return x.name.text;
  if (x.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  return '';
}

/** Is this one call a read: an engine/db receiver, or a read-verb name, and not a listed write-only method. */
function isReadCall(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    if (WRITE_ONLY_METHODS.has(method) || method === 'catch' || method === 'then' || method === 'finally') return false;
    const recv = receiverName(callee.expression);
    if (IO_RECEIVERS.has(recv)) return true;
    if (NON_IO_RECEIVERS.has(recv) || AMBIGUOUS_VERBS.has(method)) return false;
    return READ_VERB.test(method);
  }
  if (ts.isIdentifier(callee)) {
    return !AMBIGUOUS_VERBS.has(callee.text) && !WRITE_ONLY_METHODS.has(callee.text) && READ_VERB.test(callee.text);
  }
  return false;
}

/** Does the node contain a read call? Callbacks (arrow and function expressions) are searched; declarations are not. */
function containsRead(node: ts.Node): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isCallExpression(n) && isReadCall(n)) { hit = true; return; }
    if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** The latest `const|let name = init` declared in `fn` (not in nested functions) that ends before `before`. */
function findBinding(fn: ts.Node, name: string, before: number): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.end <= before) found = n;
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

/** Is the guarded code read-shaped. A receiver that is a plain local (`p.catch(...)`) is judged by its initializer. */
export function isReadShaped(site: SiteContext): boolean {
  if (containsRead(site.guarded)) return true;
  if (site.kind === 'promise-catch' && ts.isExpression(site.guarded)) {
    const recv = unwrap(site.guarded);
    if (ts.isIdentifier(recv)) {
      const decl = findBinding(site.enclosingFunction, recv.text, site.catchNode.pos);
      if (decl?.initializer) return containsRead(decl.initializer);
    }
  }
  return false;
}

function isStatusOk(e: ts.Expression): boolean {
  const x = unwrap(e);
  return ts.isObjectLiteralExpression(x) && x.properties.some(p => ts.isPropertyAssignment(p)
    && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'status'
    && ts.isStringLiteral(p.initializer) && p.initializer.text === 'ok');
}

/** The value says "nothing here": `[]`, `{}`, null, undefined, 0, false, 'ok', `{status:'ok'}`, `new Map()`, `new Set()`, or a bounded local fallback. */
export function isEmptyAnswer(e: ts.Expression | undefined, site: SiteContext): boolean {
  if (!e) return true;
  const x = unwrap(e);
  if (x.kind === ts.SyntaxKind.NullKeyword || x.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isArrayLiteralExpression(x)) return x.elements.length === 0;
  if (ts.isObjectLiteralExpression(x)) return x.properties.length === 0 || isStatusOk(x);
  if (ts.isNumericLiteral(x)) return x.text === '0';
  if (ts.isStringLiteral(x)) return x.text === 'ok';
  if (ts.isVoidExpression(x)) return true;
  if (ts.isNewExpression(x)) {
    return ts.isIdentifier(x.expression) && (x.expression.text === 'Map' || x.expression.text === 'Set')
      && (!x.arguments || x.arguments.length === 0);
  }
  if (ts.isIdentifier(x)) {
    if (x.text === 'undefined') return true;
    return isLocalEmptyFallback(x.text, site);
  }
  return false;
}

/**
 * A local that was initialized to an empty answer in the same function before the try: the handler
 * returns it, so the caller gets the empty fallback (`const m = new Map(); try {...} catch { return m }`).
 */
function isLocalEmptyFallback(name: string, site: SiteContext): boolean {
  const decl = findBinding(site.enclosingFunction, name, (site.tryStatement ?? site.catchNode).pos);
  if (!decl?.initializer) return false;
  const init = unwrap(decl.initializer);
  if (ts.isIdentifier(init)) return false;
  return isEmptyAnswer(init, site);
}

/** `rethrowX(err);` or `return rethrowX(err);` (an inline `.catch(err => rethrowX(err))` body is the second form): the helper rethrows a typed refusal and returns undefined for any other failure. */
function isRethrowCall(st: ts.Statement): boolean {
  const expr = ts.isReturnStatement(st) ? st.expression : ts.isExpressionStatement(st) ? st.expression : undefined;
  if (!expr) return false;
  const e = unwrap(expr);
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text.startsWith('rethrow');
}

/** One statement that hands back an empty answer: `return <empty>`, `x = <empty>`, `list.push({ status: 'ok', ... })`. */
function isEmptyAnswerStatement(st: ts.Statement, site: SiteContext): boolean {
  if (ts.isReturnStatement(st)) return isEmptyAnswer(st.expression, site);
  if (!ts.isExpressionStatement(st)) return false;
  const e = unwrap(st.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) return isEmptyAnswer(e.right, site);
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'push') {
    return e.arguments.some(isStatusOk);
  }
  return false;
}

/**
 * The handler answers nothing: it is empty, or it returns / assigns / pushes an empty answer as its last
 * statement. Before that it may only rethrow a typed refusal, declare a local, or assign other empty answers.
 */
export function handlerAnswersEmpty(site: SiteContext): boolean {
  const stmts = site.handlerStatements;
  if (stmts.length === 0) return true;
  const last = stmts[stmts.length - 1];
  for (const st of stmts.slice(0, -1)) {
    if (isRethrowCall(st) || ts.isVariableStatement(st) || isEmptyAnswerStatement(st, site)) continue;
    return false;
  }
  return isRethrowCall(last) || isEmptyAnswerStatement(last, site);
}

/** The rules. The first two: a failed read answers nothing, one per form so the baseline counts them apart. */
export const SILENT_READ_RULES: readonly SilentReadRule[] = [
  {
    name: 'silent-read-try-catch',
    metric: 'catch_empty',
    fix: EMPTY_ANSWER_FIX,
    matcher: site => site.kind === 'try-catch' && isReadShaped(site) && handlerAnswersEmpty(site),
  },
  {
    name: 'silent-read-promise-catch',
    metric: 'promise_catch_empty',
    fix: EMPTY_ANSWER_FIX,
    matcher: site => site.kind === 'promise-catch' && isReadShaped(site) && handlerAnswersEmpty(site),
  },
  // A Rust brain refuses untyped raw SQL by name; a catch must not turn that refusal into a quiet fallback.
  {
    ...CAPABILITY_REFUSAL_RULE,
    fix: 'let the refusal through before the fallback: `rethrowCapabilityRefusal(err)` as the handler\'s first statement, or `if (isEngineCapabilityRefusal(err)) throw err`; where the fallback is right on every engine, add `// capability-refusal-ok: <reason>` on the catch line or the line above',
  },
];
