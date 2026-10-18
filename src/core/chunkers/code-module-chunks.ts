/**
 * #5001 — module-level statement chunks.
 *
 * The chunker emits definition nodes (`TOP_LEVEL_TYPES` in code.ts); a call site has to fall inside a chunk with a
 * qualified symbol name or both edge writers drop its edge. A top-level `describe(...)` / `it(...)`, `app.use(...)`,
 * `print(helper())` or `RSpec.describe ... do` block is an expression statement, so no chunk covered it and every call
 * inside a test body or route registration was lost from `code-callers`.
 *
 * A top-level statement that contains a call becomes a chunk with `symbolType: 'module'`, `symbolName: '__module__'`
 * and the file-qualified identity `<file-basename>::__module__`, for JS/TS/TSX, Python and Ruby (the languages whose
 * call edges get receiver resolution or RSpec-style top-level blocks). A run of small adjacent statements may merge
 * (`mergeSmallSiblings`); the merged chunk keeps the `__module__` identity so its edges survive. Definition-only files
 * are unchanged. The chunk-inventory change is gated per language through `GRAMMAR_REVISIONS` (code.ts).
 */
import type { CodeChunk, SupportedCodeLanguage } from './code.ts';

export const MODULE_SYMBOL_NAME = '__module__';
export const MODULE_SYMBOL_TYPE = 'module';

interface ModuleStatementConfig {
  /** Top-level node types that are statements rather than definitions. */
  statementTypes: ReadonlySet<string>;
  /** Call node types (the edge extractor's `CALL_CONFIG` for the language); a statement without one emits nothing. */
  callTypes: ReadonlySet<string>;
}

const JS_CONFIG: ModuleStatementConfig = { statementTypes: new Set(['expression_statement']), callTypes: new Set(['call_expression']) };

const MODULE_STATEMENTS: Partial<Record<SupportedCodeLanguage, ModuleStatementConfig>> = {
  typescript: JS_CONFIG,
  tsx: JS_CONFIG,
  javascript: JS_CONFIG,
  python: { statementTypes: new Set(['expression_statement']), callTypes: new Set(['call']) },
  // tree-sitter-ruby has no statement wrapper: a top-level call IS the node (`require 'x'`, `RSpec.describe Thing do … end`).
  ruby: { statementTypes: new Set(['call', 'method_call']), callTypes: new Set(['call', 'method_call']) },
};

const MODULE_SYMBOL = { symbolName: MODULE_SYMBOL_NAME, symbolType: MODULE_SYMBOL_TYPE } as const;

const isModuleSymbol = (symbol: { symbolName: string | null; symbolType: string }): boolean =>
  symbol.symbolType === MODULE_SYMBOL_TYPE && symbol.symbolName === MODULE_SYMBOL_NAME;

/**
 * The `__module__` symbol for a top-level node that is a statement containing a call in `language`; null for every
 * definition node and for statements with no call (`x = 1`, a docstring), which stay unchunked as before.
 */
export function moduleStatementSymbol(node: any, language: SupportedCodeLanguage): typeof MODULE_SYMBOL | null {
  const config = MODULE_STATEMENTS[language];
  if (!config || !config.statementTypes.has(node.type)) return null;
  const stack: any[] = [node];
  while (stack.length) {
    const current = stack.pop();
    if (config.callTypes.has(current.type)) return MODULE_SYMBOL;
    for (const child of current.namedChildren) stack.push(child);
  }
  return null;
}

/**
 * `<file-basename>::__module__`, the edge identity of a file's module-level statements (`vat-review.test::__module__`);
 * null for every other symbol (a Ruby `module Foo` is `symbolType: 'module'` with its own name and keeps the ordinary
 * qualified name).
 */
export function moduleChunkQualifiedName(input: { filePath: string; symbolName: string | null; symbolType: string }): string | null {
  if (!isModuleSymbol(input)) return null;
  const base = input.filePath.split(/[\\/]/).pop() ?? input.filePath;
  return `${base.replace(/\.[^.]+$/, '') || base}::${MODULE_SYMBOL_NAME}`;
}

export function isModuleChunk(chunk: CodeChunk): boolean {
  return isModuleSymbol(chunk.metadata);
}

/**
 * Identity of a merged small-sibling run. A run never holds a named definition (#4511), so one that holds a module
 * statement is module-level code: it keeps the `__module__` identity and its call edges. Any other run is the
 * anonymous `merged` chunk it always was.
 */
export function mergedRunSymbol(group: CodeChunk[]): Pick<CodeChunk['metadata'], 'symbolName' | 'symbolType' | 'symbolNameQualified'> {
  const module = group.find(isModuleChunk);
  if (!module) return { symbolName: null, symbolType: 'merged' };
  return { ...MODULE_SYMBOL, symbolNameQualified: module.metadata.symbolNameQualified };
}
