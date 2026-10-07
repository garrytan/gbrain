#!/usr/bin/env bun
/**
 * Engine-sql dynamic-SQL guard (refactor wave 1, A2b / CQ3 / EO8 / EO17;
 * docs/TESTING.md#engine-sql-dynamic-sql).
 *
 * In src/core/engine-sql/** every value reaches SQL as a bound parameter
 * (`sqlFragment`), and only constant text is spliced. This guard parses each
 * file (TypeScript compiler API) and fails on:
 *
 *   1. `trustedSql(arg)` where arg is not trusted text (below).
 *   2. An untagged template literal or `+` concatenation passed as the SQL
 *      argument of `.query(` / `.unsafe(` / `.executeRaw(` (first argument)
 *      or `executeRawJsonb(` (second), directly or through a local variable,
 *      with a substitution / operand that is not trusted text.
 *   3. A literal `$<digit>` (or a `$` right before a substitution) inside a
 *      composed string: a template with substitutions, any `sqlFragment`
 *      template, or an operand of a `+` concatenation. Placeholders are
 *      numbered by renderFragment; a static string passed as-is may carry them.
 *   4. An expanded list: `IN (` right before a substitution or a
 *      non-literal `+` operand. Lists bind as `= ANY($n::type[])`.
 *
 * Trusted text is: a string literal; an identifier or member / element
 * access whose root is a `const` in this file initialized with trusted text
 * or an `as const` object / array literal, or a CONSTANT_ALLOWLIST name; a
 * call to a VETTED_BUILDERS entry; a template whose substitutions are all
 * trusted or are numeric expressions the same function checked earlier with
 * `Number.isFinite(<same expression>)` (a `+` chain under the same rule); a
 * conditional whose branches are both trusted.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const SCAN_DIR = 'src/core/engine-sql';
const ANCHOR = 'docs/TESTING.md#engine-sql-dynamic-sql';

const EXEMPT_FILES: Record<string, string> = {
  'fragment.ts': 'the renderer itself: it writes the $n placeholders and splices trustedSql text by design',
};

const CONSTANT_ALLOWLIST: Record<string, string> = {
  ENRICH_ORDER_SQL: 'src/core/types.ts: ORDER BY text keyed by the EnrichCandidatesOpts order union (whitelisted enum)',
  SOURCE_CONFIG_OBJECT_SQL: 'src/core/source-config-sql.ts: static sources.config coercion expression (no input)',
  EMBED_SKIP_FILTER_FRAGMENT: 'src/core/embed-skip.ts: constant embed_skip predicate over alias p',
  QUARANTINE_FILTER_FRAGMENT: 'src/core/quarantine.ts: constant quarantine visibility predicate over the pages alias p',
  PAGE_SORT_SQL: 'src/core/types.ts: ORDER BY text keyed by the PageFilters sort union (whitelisted enum)',
  TEMPORAL_LINK_SELECT_SQL: 'src/core/link-validity.ts: constant select list over the lr_t relationship-state join',
};

const VETTED_BUILDERS: Record<string, string> = {
  pageReadFilter: 'src/core/search/read-policy-sql.ts: binds scope values as params, splices only the caller alias',
  buildRecencyComponentSql: 'src/core/search/sql-ranking.ts: inlines LIKE literals + numeric coefficients from the decay map, as master (planner behavior)',
  privatePagesFilterFragment: 'src/core/search/private-visibility.ts: constant visibility predicate over a caller alias',
  quarantineFilterFragment: 'src/core/quarantine.ts: constant quarantine predicate over a caller alias',
  currentCodeEdgeFilter: 'src/core/code-intel/read-scope.ts: constant current-edge predicate over a caller alias',
  buildCJKKeywordSql: 'src/core/search/cjk-keyword-sql.ts: binds the query as params; shared by both engines',
  currentTextProjectionFilter: 'src/core/search/safe-chunks.ts: constant projection predicate over a caller alias',
  quoteIdentifier: 'src/core/search/embedding-column.ts: double-quoted identifier (embedded quotes doubled); callers pass registry-resolved or COLUMN_NAME_REGEX-checked embedding column names',
  vectorCastSuffix: 'src/core/search/embedding-column.ts: constant ::vector / ::halfvec cast suffix from the resolved column type',
  safeChunksFilter: 'src/core/search/safe-chunks.ts: constant safe-chunk predicate over a caller alias',
  bodyWriteChunkVersion: 'src/core/search/safe-chunks.ts: constant chunker-version CASE over caller column expressions (or master\'s literal $1/$2 bind reuse); no values',
  privateLinkOriginFilterFragment: 'src/core/search/private-visibility.ts: constant link-origin visibility predicate over a caller alias',
  privateTimelineEventFilterFragment: 'src/core/search/private-visibility.ts: constant timeline-event visibility predicate over a caller alias',
  privateSnapshotFilterFragment: 'src/core/search/private-visibility.ts: constant snapshot visibility predicate over a caller alias',
  vectorLiteralSql: 'src/core/engine-sql/facts.ts: master\'s inlined vector literal; toPgVectorLiteral output (numbers joined by commas) + a ::vector/::halfvec constant',
  temporalLinkJoinSql: 'src/core/link-validity.ts: constant LEFT JOIN onto link_relationships over a caller alias; scope is one of two literals',
  relationshipFilterSql: 'src/core/link-validity.ts: relationship-state probe over a caller alias; dates pass isCalendarDate and inline as DATE literals, status/scope are literals',
};

const SQL_ARG_METHODS: Record<string, number> = { query: 0, unsafe: 0, executeRaw: 0 };
const SQL_ARG_FUNCTIONS: Record<string, number> = { executeRawJsonb: 1 };

const FIX = {
  trusted: "bind the value through sqlFragment (`${value}`), or splice only a string literal, an `as const` allowlist member, a VETTED_BUILDERS call or a Number.isFinite-checked number",
  composed: 'build the statement with sqlFragment and run it with executor.run(fragment)',
  placeholder: 'drop the hand-written $n: interpolate the value in sqlFragment and let renderFragment number it',
  list: 'bind the array as one parameter: `= ANY(${ids}::text[])` in sqlFragment (renders `= ANY($n::text[])`)',
};

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

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
    if (ts.isAsExpression(e) && isConstAssertion(e)) return e;
    e = e.expression;
  }
  return e;
}

function isConstAssertion(e: ts.AsExpression): boolean {
  return ts.isTypeReferenceNode(e.type) && ts.isIdentifier(e.type.typeName) && e.type.typeName.text === 'const';
}

function rootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let e = unwrap(expr);
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = unwrap(e.expression);
  return ts.isIdentifier(e) ? e : null;
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
  return undefined;
}

function isNumericGuarded(expr: ts.Expression, sf: ts.SourceFile): boolean {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) return true;
  if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
  const fn = enclosingFunction(e);
  if (!fn) return false;
  const target = e.getText(sf);
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found || n.getStart(sf) >= e.getStart(sf)) return;
    if (
      ts.isCallExpression(n) && n.arguments.length === 1 && n.expression.getText(sf) === 'Number.isFinite'
      && unwrap(n.arguments[0]).getText(sf) === target
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return found;
}

class FileScan {
  readonly violations: string[] = [];
  private readonly consts = new Map<string, ts.VariableDeclaration[]>();
  private readonly lets = new Map<string, ts.VariableDeclaration[]>();

  constructor(private readonly sf: ts.SourceFile, private readonly rel: string) {
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && ts.isVariableDeclarationList(n.parent)) {
        const map = n.parent.flags & ts.NodeFlags.Const ? this.consts : this.lets;
        map.set(n.name.text, [...(map.get(n.name.text) ?? []), n]);
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
  }

  private fail(node: ts.Node, what: string, fix: string): void {
    const line = this.sf.getLineAndCharacterOfPosition(node.getStart(this.sf)).line + 1;
    this.violations.push(`FAIL: ${this.rel}:${line} ${what}\n      Fix: ${fix}`);
  }

  private text(node: ts.Node): string {
    return node.getText(this.sf).replace(/\s+/g, ' ').slice(0, 80);
  }

  private declarationFor(id: ts.Identifier, map: Map<string, ts.VariableDeclaration[]>): ts.VariableDeclaration | undefined {
    const decls = map.get(id.text);
    if (!decls) return undefined;
    const scopeOf = (n: ts.Node) => enclosingFunction(n) ?? this.sf;
    const scopes: ts.Node[] = [];
    for (let s: ts.Node | undefined = scopeOf(id); s; s = s === this.sf ? undefined : scopeOf(s)) scopes.push(s);
    for (const scope of scopes) {
      const hit = decls.find((d) => scopeOf(d) === scope && d.getStart(this.sf) < id.getStart(this.sf));
      if (hit) return hit;
    }
    return undefined;
  }

  isTrusted(expr: ts.Expression, seen = new Set<ts.Node>()): boolean {
    const e = unwrap(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    if (ts.isAsExpression(e)) return ts.isObjectLiteralExpression(unwrap(e.expression)) || ts.isArrayLiteralExpression(unwrap(e.expression));
    if (ts.isConditionalExpression(e)) return this.isTrusted(e.whenTrue, seen) && this.isTrusted(e.whenFalse, seen);
    if (ts.isTemplateExpression(e)) return e.templateSpans.every((s) => this.isTrusted(s.expression, seen) || isNumericGuarded(s.expression, this.sf));
    if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text in VETTED_BUILDERS;
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return plusOperands(e).every((o) => this.isTrusted(o, seen) || isNumericGuarded(o, this.sf));
    }
    const root = rootIdentifier(e);
    if (!root || (root !== e && !ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e))) return false;
    if (root.text in CONSTANT_ALLOWLIST) return true;
    const decl = this.declarationFor(root, this.consts);
    if (!decl?.initializer || seen.has(decl)) return false;
    seen.add(decl);
    return this.isTrusted(decl.initializer, seen);
  }

  private checkComposedSql(arg: ts.Expression, call: ts.CallExpression, seen = new Set<ts.Node>()): void {
    const e = unwrap(arg);
    if (ts.isTemplateExpression(e)) {
      for (const span of e.templateSpans) {
        if (!this.isTrusted(span.expression) && !isNumericGuarded(span.expression, this.sf)) {
          this.fail(span.expression, `untrusted \${${this.text(span.expression)}} in SQL passed to ${this.text(call.expression)}()`, FIX.composed);
        }
      }
      return;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      for (const operand of plusOperands(e)) {
        if (!this.isTrusted(operand) && !isNumericGuarded(operand, this.sf)) {
          this.fail(operand, `untrusted operand '${this.text(operand)}' concatenated into SQL passed to ${this.text(call.expression)}()`, FIX.composed);
        }
      }
      return;
    }
    if (!ts.isIdentifier(e)) return;
    const decl = this.declarationFor(e, this.consts) ?? this.declarationFor(e, this.lets);
    if (!decl || seen.has(decl)) return;
    seen.add(decl);
    if (decl.initializer) this.checkComposedSql(decl.initializer, call, seen);
    const fn = enclosingFunction(decl) ?? this.sf;
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) && ts.isIdentifier(n.left) && n.left.text === e.text
        && (n.operatorToken.kind === ts.SyntaxKind.EqualsToken || n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
      ) {
        if (n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && !this.isTrusted(n.right) && !isNumericGuarded(n.right, this.sf)) {
          this.fail(n.right, `untrusted '${this.text(n.right)}' appended to SQL passed to ${this.text(call.expression)}()`, FIX.composed);
        } else this.checkComposedSql(n.right, call, seen);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
  }

  private checkTemplateText(node: ts.TemplateExpression | ts.NoSubstitutionTemplateLiteral, composed: boolean): void {
    const pieces = ts.isTemplateExpression(node) ? [node.head, ...node.templateSpans.map((s) => s.literal)] : [node];
    pieces.forEach((piece, i) => {
      const beforeSub = i < pieces.length - 1;
      if (composed && (/\$\d/.test(piece.text) || (beforeSub && piece.text.endsWith('$')))) {
        this.fail(piece, 'literal $<digit> placeholder in a composed SQL string', FIX.placeholder);
      }
      if (beforeSub && /\bIN\s*\(\s*$/i.test(piece.text)) this.fail(piece, 'expanded IN (...) list built from a substitution', FIX.list);
    });
  }

  private checkConcat(node: ts.BinaryExpression): void {
    const operands = plusOperands(node);
    operands.forEach((operand, i) => {
      if (!ts.isStringLiteral(operand) && !ts.isNoSubstitutionTemplateLiteral(operand)) return;
      if (/\$\d/.test(operand.text)) this.fail(operand, 'literal $<digit> placeholder in a concatenated SQL string', FIX.placeholder);
      const next = operands[i + 1];
      if (next && !ts.isStringLiteral(next) && !ts.isNoSubstitutionTemplateLiteral(next) && /\bIN\s*\(\s*$/i.test(operand.text)) {
        this.fail(operand, 'expanded IN (...) list built by concatenation', FIX.list);
      }
    });
  }

  run(): void {
    const visit = (n: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(n)) {
        const isFragment = ts.isIdentifier(n.tag) && n.tag.text === 'sqlFragment';
        this.checkTemplateText(n.template, isFragment);
      } else if (ts.isTemplateExpression(n) && !ts.isTaggedTemplateExpression(n.parent)) {
        this.checkTemplateText(n, true);
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken
        && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        this.checkConcat(n);
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee) && callee.text === 'trustedSql') {
          const arg = n.arguments[0];
          if (!arg || !this.isTrusted(arg)) {
            this.fail(n, `trustedSql(${arg ? this.text(arg) : ''}) splices text that is not constant`, FIX.trusted);
          }
        }
        const index = ts.isPropertyAccessExpression(callee)
          ? SQL_ARG_METHODS[callee.name.text]
          : ts.isIdentifier(callee) ? SQL_ARG_FUNCTIONS[callee.text] : undefined;
        const sqlArg = index === undefined ? undefined : n.arguments[index];
        if (sqlArg) this.checkComposedSql(sqlArg, n);
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
  }
}

function plusOperands(node: ts.Expression): ts.Expression[] {
  const e = unwrap(node);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...plusOperands(e.left), ...plusOperands(e.right)];
  return [e];
}

const files = tsFiles(join(ROOT, SCAN_DIR)).filter((abs) => !(relative(join(ROOT, SCAN_DIR), abs).replace(/\\/g, '/') in EXEMPT_FILES));
const violations: string[] = [];
for (const abs of files) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  const scan = new FileScan(ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), rel);
  scan.run();
  violations.push(...scan.violations);
}

if (violations.length) {
  for (const v of violations) console.error(v);
  console.error('Why:  engine-sql binds every value as a parameter and splices only constant text; composed $n, expanded IN lists and raw interpolation are how injection and unbounded prepared-statement caches start (CQ3 / EO8).');
  console.error(`See:  ${ANCHOR}`);
  console.error(`check-engine-sql-dynamic: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log(`check-engine-sql-dynamic: ok (${files.length} files)`);
