#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const MARKER = 'engine-dynamic-import-ok';
const MARKER_TOKEN_CHAR = /[\p{ID_Continue}$-]/u;
const files = process.argv.slice(2);
const violations: string[] = [];
const readErrors: string[] = [];

for (const file of files) {
  let sourceText: string;
  try {
    sourceText = await readFile(file, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    readErrors.push(`ERROR: cannot read input file ${file}: ${detail}`);
    continue;
  }

  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = sourceText.split(/\r?\n/);
  const markerLines = new Set<number>();

  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostics = sourceFile.parseDiagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
      .join('; ');
    readErrors.push(`ERROR: cannot parse input file ${file}: ${diagnostics}`);
  }

  for (let markerPos = sourceText.indexOf(MARKER); markerPos >= 0; markerPos = sourceText.indexOf(MARKER, markerPos + MARKER.length)) {
    const before = Array.from(sourceText.slice(0, markerPos)).at(-1);
    const after = Array.from(sourceText.slice(markerPos + MARKER.length))[0];
    const standaloneMarker = (!before || !MARKER_TOKEN_CHAR.test(before))
      && (!after || !MARKER_TOKEN_CHAR.test(after));
    const token = ts.getTokenAtPosition(sourceFile, markerPos);
    const insideToken = token.getStart(sourceFile) <= markerPos && markerPos < token.end;
    if (standaloneMarker && !insideToken) {
      markerLines.add(sourceFile.getLineAndCharacterOfPosition(markerPos).line);
    }
  }

  function visit(node: ts.Node): void {
    // W0 ship-review catch: match BOTH lazy-loading forms. The guard
    // previously matched only `import(...)` call expressions, so a
    // `require(...)` on an engine-live path passed silently and its
    // engine-dynamic-import-ok marker was decorative.
    const isDynamicImport = ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequireCall = ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require';
    if (isDynamicImport || isRequireCall) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
      const sourceLine = lines[line] ?? '';
      if (!markerLines.has(line)) {
        violations.push(`  ${file}:${line + 1}:${sourceLine}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

for (const error of readErrors) console.error(error);

if (violations.length > 0) {
  console.error('ERROR: unreviewed dynamic import on an engine-live path:');
  console.error();
  console.error(violations.join('\n'));
  console.error();
  console.error('Prefer a static top-level import. If lazy loading is load-bearing,');
  console.error("append 'engine-dynamic-import-ok' to that exact line and document");
  console.error('the startup or soft-failure boundary that requires it.');
  process.exit(1);
}

if (readErrors.length > 0) process.exit(1);

console.log(`check-engine-dynamic-import: ok (${files.length} file(s) scanned)`);
