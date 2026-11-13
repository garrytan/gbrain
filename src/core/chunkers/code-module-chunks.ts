/**
 * #5001 — module-level statement chunks.
 *
 * The chunker emits definition nodes (`TOP_LEVEL_TYPES` in code.ts); a call site has to fall inside a chunk with a
 * qualified symbol name or both edge writers drop its edge. A top-level `describe(...)` / `it(...)`, `app.use(...)`,
 * `print(helper())` or `RSpec.describe ... do` block is an expression statement, so no chunk covered it and every call
 * inside a test body or route registration was lost from `code-callers`.
 *
 * A top-level node that contains a call but names no definition becomes a chunk with `symbolType: 'module'`,
 * `symbolName: '__module__'` and the file-qualified identity `<file-basename>::__module__`, for JS/TS/TSX, Python and
 * Ruby (the languages whose call edges get receiver resolution or RSpec-style top-level blocks). That covers statements
 * (`describe(...)`, a top-level `if`/`for`/`try`, Python's `if __name__ == "__main__": main()`) and anonymous
 * definitions (`export default () => …`, `export default { fetch() { … } }`, `const { a } = useThing()`). A run of small adjacent statements may merge
 * (`mergeSmallSiblings`); the merged chunk keeps the `__module__` identity so its edges survive. Definition-only files
 * are unchanged. The chunk-inventory change is gated per language through `GRAMMAR_REVISIONS` (code.ts).
 */
import type { CodeChunk, SupportedCodeLanguage } from './code.ts';

export const MODULE_SYMBOL_NAME = '__module__';
export const MODULE_SYMBOL_TYPE = 'module';

const JS_CALL_TYPES: ReadonlySet<string> = new Set(['call_expression']);

/**
 * Call node types per language (the edge extractor's `CALL_CONFIG`); a node without one emits nothing. tree-sitter-ruby
 * has no statement wrapper: a top-level call IS the node (`require 'x'`, `RSpec.describe Thing do … end`).
 */
const MODULE_CALL_TYPES: Partial<Record<SupportedCodeLanguage, ReadonlySet<string>>> = {
  typescript: JS_CALL_TYPES,
  tsx: JS_CALL_TYPES,
  javascript: JS_CALL_TYPES,
  python: new Set(['call']),
  ruby: new Set(['call', 'method_call']),
  // #7080: every Elixir construct is a `call`; a top-level one that defines no module or function is module-level code.
  elixir: new Set(['call']),
};

const MODULE_SYMBOL = { symbolName: MODULE_SYMBOL_NAME, symbolType: MODULE_SYMBOL_TYPE } as const;

const isModuleSymbol = (symbol: { symbolName: string | null; symbolType: string }): boolean =>
  symbol.symbolType === MODULE_SYMBOL_TYPE && symbol.symbolName === MODULE_SYMBOL_NAME;

/**
 * The `__module__` symbol for a top-level node that contains a call in `language` and is not a `named` definition;
 * null for a named definition and for nodes with no call (`x = 1`, a docstring, an import), which stay unchunked.
 */
export function moduleStatementSymbol(node: any, language: SupportedCodeLanguage, named: boolean): typeof MODULE_SYMBOL | null {
  const callTypes = MODULE_CALL_TYPES[language];
  if (!callTypes || named) return null;
  const stack: any[] = [node];
  while (stack.length) {
    const current = stack.pop();
    if (callTypes.has(current.type)) return MODULE_SYMBOL;
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
 * statement or a call (`const app = express();`, flagged `holdsCall`) is module-level code: it keeps the
 * `__module__` identity and its call edges. Any other run is the anonymous `merged` chunk it always was.
 */
export function mergedRunSymbol(group: CodeChunk[]): Pick<CodeChunk['metadata'], 'symbolName' | 'symbolType' | 'symbolNameQualified'> {
  if (!group.some(c => isModuleChunk(c) || c.metadata.holdsCall)) return { symbolName: null, symbolType: 'merged' };
  return { ...MODULE_SYMBOL, symbolNameQualified: moduleChunkQualifiedName({ filePath: group[0]!.metadata.filePath, ...MODULE_SYMBOL }) };
}
