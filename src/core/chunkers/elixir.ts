/** Elixir definitions are macro calls, not declaration-shaped tree-sitter nodes (#7080). */
const MODULE_MACROS = new Set(['defmodule', 'defprotocol', 'defimpl']);
const FUNCTION_MACROS = new Set(['def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate']);

function macroName(node: any): string | null {
  if (node.type !== 'call') return null;
  const target = node.childForFieldName('target');
  return target?.type === 'identifier' ? target.text : null;
}

/** null for ordinary calls: config, if, alias, case, and user macros are not definitions. */
export function elixirDefinition(node: any): { name: string; type: 'module' | 'function' } | null {
  const macro = macroName(node);
  if (!macro || (!MODULE_MACROS.has(macro) && !FUNCTION_MACROS.has(macro))) return null;
  let head = node.namedChildren.find((c: any) => c.type === 'arguments')?.namedChild(0);
  if (MODULE_MACROS.has(macro)) return head?.type === 'alias' ? { name: head.text.replace(/^Elixir\./, ''), type: 'module' } : null;
  if (head?.type === 'binary_operator' && head.childForFieldName('operator')?.text === 'when') head = head.childForFieldName('left');
  if (head?.type === 'call') head = head.childForFieldName('target');
  return head?.type === 'identifier' ? { name: head.text, type: 'function' } : null;
}

/** Flatten module bodies, retaining scope and full function ranges (including guarded/keyword bodies). */
export function elixirDefinitionChunks(node: any, source: string, parents: string[] = []): Array<{
  body: string; symbolName: string; symbolType: 'module' | 'function'; parentSymbolPath: string[]; startLine: number; endLine: number;
}> {
  const definition = elixirDefinition(node);
  if (!definition) return [];
  const body = node.namedChildren.find((c: any) => c.type === 'do_block');
  const children = definition.type === 'module' ? (body?.namedChildren ?? []) : [];
  const members = children.filter((c: any) => elixirDefinition(c));
  const text = source.slice(node.startIndex, node.endIndex);
  const header = text.split('\n')[0]!;
  // Keep module attributes, docs, aliases and executable statements in the scope chunk.
  const context = children.filter((c: any) => !elixirDefinition(c)).map((c: any) => c.text).join('\n');
  const chunks = [{
    body: definition.type === 'module' && members.length
      ? `${header}\n${context}\n# Members: ${members.map((c: any) => elixirDefinition(c)!.name).join(', ')}` : text,
    symbolName: definition.name, symbolType: definition.type, parentSymbolPath: parents,
    startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
  }];
  for (const child of members) chunks.push(...elixirDefinitionChunks(child, source, [...parents, definition.name]));
  return chunks;
}

/** A definition's head looks like a call too; exclude it, not calls in guards, defaults or bodies. */
export function isElixirDefinitionCall(node: any): boolean {
  if (elixirDefinition(node)) return true;
  if (['alias', 'import', 'require'].includes(macroName(node) ?? '')) return true;
  if (node.parent?.type === 'unary_operator' && node.parent.childForFieldName('operator')?.text === '@') return true;
  let head = node;
  if (head.parent?.type === 'binary_operator' && head.parent.childForFieldName('operator')?.text === 'when'
    && head.parent.childForFieldName('left')?.id === head.id) head = head.parent;
  const args = head.parent;
  return args?.type === 'arguments' && args.namedChild(0)?.id === head.id && !!elixirDefinition(args.parent);
}
