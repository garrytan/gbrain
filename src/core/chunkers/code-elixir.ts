/**
 * #7080 — Elixir definitions and call edges.
 *
 * tree-sitter-elixir parses every construct as a `call`: `defmodule Foo.Bar do … end` is a call whose `target` is the
 * identifier `defmodule`, `def run(a) when … do … end` a call to `def`. The node-type tables in code.ts and
 * edge-extractor.ts cannot tell a module or a function from any other call, so the macro name decides here:
 *   - `defmodule` / `defprotocol` / `defimpl` name a module from their first argument (`Foo.Bar`; an impl is
 *     `Protocol.Target`), symbol type `module`;
 *   - `def` / `defp` / `defmacro` / `defmacrop` / `defguard` / `defguardp` / `defdelegate` name a function from
 *     the head's call target (`run` in `run(a)`, the left side of a `when` guard, or a bare `zero`), type `function`;
 *   - every other call (`config`, `if`, `alias`, `use`) is not a definition.
 * Call edges skip the definition macros themselves, each definition's head, directives and Kernel special forms,
 * module attributes (`@doc`, `@spec …`) and field reads (`s.side`), so what remains are real invocations, emitted as
 * bare tokens like Ruby's.
 */
import type { ExtractedEdge } from './edge-extractor.ts';

export interface ElixirDefinition {
  name: string;
  type: 'module' | 'function';
  /** A module nests definitions (a parent); a function is a leaf. */
  role: 'parent' | 'leaf';
}

const MODULE_MACROS = new Set(['defmodule', 'defprotocol', 'defimpl']);
const FUNCTION_MACROS = new Set(['def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate']);
const NON_CALL_TARGETS = new Set([
  ...MODULE_MACROS, ...FUNCTION_MACROS, 'defstruct', 'defexception', 'defoverridable',
  'alias', 'import', 'require', 'use',
  'if', 'unless', 'case', 'cond', 'with', 'for', 'receive', 'try', 'quote', 'unquote', 'raise',
]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*[?!]?$/;

function macroName(node: any): string | null {
  if (node?.type !== 'call') return null;
  const target = node.childForFieldName('target');
  return target?.type === 'identifier' ? target.text : null;
}

function argumentList(node: any): any | null {
  return node.namedChildren.find((child: any) => child.type === 'arguments') ?? null;
}

/** The head of a function definition: `run(a)` in `def run(a) when is_integer(a)`, or a bare `zero`. */
function definitionHead(node: any): any | null {
  if (!FUNCTION_MACROS.has(macroName(node) ?? '')) return null;
  const first = argumentList(node)?.namedChild(0);
  if (first?.type === 'binary_operator' && first.childForFieldName('operator')?.text === 'when') return first.childForFieldName('left');
  return first ?? null;
}

function implTarget(args: any): string | null {
  for (const keywords of args.namedChildren.filter((child: any) => child.type === 'keywords')) {
    for (const pair of keywords.namedChildren) {
      const value = pair.childForFieldName('value') ?? pair.namedChild(1);
      if (pair.namedChild(0)?.text.trim() === 'for:' && value?.type === 'alias') return value.text;
    }
  }
  return null;
}

/** The module or function a top-level or nested `call` defines; null for every other node. */
export function elixirDefinition(node: any): ElixirDefinition | null {
  const macro = macroName(node);
  if (!macro) return null;
  if (MODULE_MACROS.has(macro)) {
    const args = argumentList(node);
    const first = args?.namedChild(0);
    if (first?.type !== 'alias') return null;
    const target = macro === 'defimpl' ? implTarget(args) : null;
    return { name: target ? `${first.text}.${target}` : first.text, type: 'module', role: 'parent' };
  }
  const head = definitionHead(node);
  const name = head?.type === 'call' ? macroName(head) : head?.type === 'identifier' ? head.text : null;
  return name && NAME.test(name) ? { name, type: 'function', role: 'leaf' } : null;
}

/** `helper(a)` → helper, `Baz.go()` → go; `s.side` (no parentheses, variable receiver) is a field read, not a call. */
function calleeName(call: any): string | null {
  const target = call.childForFieldName('target');
  const remote = target?.type === 'dot' && target.childForFieldName('right')?.type === 'identifier'
    && (argumentList(call) !== null || target.childForFieldName('left')?.type === 'alias');
  const name = target?.type === 'identifier' ? target.text : remote ? target.childForFieldName('right').text : null;
  return name && NAME.test(name) && !NON_CALL_TARGETS.has(name) ? name : null;
}

export function extractElixirCallEdges(tree: any): ExtractedEdge[] {
  const out: ExtractedEdge[] = [];
  const heads = new Set<number>();
  const stack: any[] = tree?.rootNode ? [tree.rootNode] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === 'unary_operator' && node.childForFieldName('operator')?.text === '@') continue;
    if (node.type === 'call') {
      const head = definitionHead(node);
      if (head) heads.add(head.id);
      const callee = heads.has(node.id) ? null : calleeName(node);
      if (callee) out.push({ callSiteByteOffset: node.startIndex, toSymbol: callee, edgeType: 'calls' });
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return out;
}
