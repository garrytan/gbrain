/**
 * Whitespace- and comment-insensitive token normalizer (refactor wave 1, CQ7).
 *
 * One definition shared by the two move proofs:
 * - the migrations full-record golden (`test/migrations-golden.test.ts`), which
 *   hashes the normalized source of every handler / verify body and the helpers
 *   they reference, never `Function.prototype.toString()` (coverage
 *   instrumentation and re-indentation change that text);
 * - `scripts/verify-move-only.ts`, which proves a move-only commit keeps the
 *   same token stream.
 *
 * Normal form: the TypeScript scanner's token stream with trivia (whitespace,
 * newlines, comments, shebang) dropped, each token rendered as its exact source
 * text and joined with a single space. Template literal and string contents are
 * kept byte for byte, so SQL inside a template literal is never normalized.
 * An optional rename map rewrites identifiers (for `Mechanical-Rename: yes`
 * commits such as `pullFailed -> run.pullFailed`).
 */

import ts from 'typescript';

export interface NormalizeOptions {
  /** Identifier rewrites applied to identifier tokens, e.g. `{ pullFailed: 'run.pullFailed' }`. */
  renameMap?: Readonly<Record<string, string>>;
  /** Parse as TSX when true. Default false. */
  jsx?: boolean;
}

/** Return the normalized token texts of `sourceText`. */
export function normalizeTokens(sourceText: string, opts: NormalizeOptions = {}): string[] {
  const sourceFile = ts.createSourceFile(
    opts.jsx ? 'input.tsx' : 'input.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    opts.jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken) {
      pushToken(node, sourceFile, tokens, opts);
      return;
    }
    if (isLiteralLike(node)) {
      pushToken(node, sourceFile, tokens, opts);
      return;
    }
    const children = node.getChildren(sourceFile);
    for (const child of children) visit(child);
  };
  for (const child of sourceFile.getChildren(sourceFile)) visit(child);
  return tokens.filter((t) => t.length > 0);
}

/** Normalized source text: tokens joined by one space. */
export function normalizeSource(sourceText: string, opts: NormalizeOptions = {}): string {
  return normalizeTokens(sourceText, opts).join(' ');
}

/** Normalized text of one node of an already-parsed source file. */
export function normalizeNode(node: ts.Node, sourceFile: ts.SourceFile, opts: NormalizeOptions = {}): string {
  return normalizeSource(node.getText(sourceFile), opts);
}

function isLiteralLike(node: ts.Node): boolean {
  return (
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node) ||
    ts.isJsxText(node)
  );
}

function pushToken(node: ts.Node, sourceFile: ts.SourceFile, out: string[], opts: NormalizeOptions): void {
  if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
  const text = node.getText(sourceFile);
  if (opts.renameMap && ts.isIdentifier(node) && Object.prototype.hasOwnProperty.call(opts.renameMap, text)) {
    out.push(...normalizeTokens(opts.renameMap[text]!));
    return;
  }
  out.push(text);
}
