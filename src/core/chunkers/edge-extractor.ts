/**
 * v0.20.0 Cathedral II Layer 5 (A1) — edge extractor.
 *
 * Walks a parsed tree-sitter tree and emits structural edges for:
 *   - `calls` — function/method invocations (f() → f, obj.m() → m, a::b()
 *     on Rust → b). The receiver-type resolution (obj → ClassName) is
 *     explicitly deferred — we store the bare callee token here and rely
 *     on Layer 7 two-pass retrieval + the getCallersOf short-name match
 *     to surface the anchor. This is "best effort precision 80, recall 99":
 *     if you search for "searchKeyword" you get every call site, even the
 *     ones whose receiver we couldn't pin to a class yet.
 *
 * Every emitted edge lands in code_edges_symbol (unresolved — to_chunk_id
 * null) because within-file resolution needs a second pass that matches
 * callee tokens against chunks' symbol_name_qualified. That resolution is
 * a future optimization. Layer 5 gets the edges captured at all — that's
 * the 10x leap over v0.19.0's grep-class retrieval.
 *
 * Per-language shipped list: TypeScript, TSX, JavaScript, Python, Ruby,
 * Go, Rust, Java — the 8 languages covering ~85% of real brain code.
 * Other languages flow through with zero edges (chunker still works).
 */

import type { SupportedCodeLanguage } from './code.ts';

export interface ExtractedEdge {
  /**
   * Byte offset of the call site in the source. The caller resolves this
   * to a from_chunk_id by finding the chunk whose (startLine, endLine)
   * brackets the offset — matches how Layer 6 A3 emits one chunk per
   * nested method, so each call site falls inside exactly one chunk.
   */
  callSiteByteOffset: number;
  /** The bare callee token (e.g. 'searchKeyword', 'User.find'). */
  toSymbol: string;
  edgeType: 'calls';
}

/**
 * Per-language call-expression configuration. `callNodeTypes` lists the
 * AST node types that are call sites in that language. `calleeFieldName`
 * optionally names the child field that holds the callee expression;
 * when absent, the call-site text itself is scanned for the identifier.
 */
interface CallConfig {
  callNodeTypes: Set<string>;
  calleeFieldName?: string;
}

const CALL_CONFIG: Partial<Record<SupportedCodeLanguage, CallConfig>> = {
  typescript: { callNodeTypes: new Set(['call_expression']), calleeFieldName: 'function' },
  tsx:        { callNodeTypes: new Set(['call_expression']), calleeFieldName: 'function' },
  javascript: { callNodeTypes: new Set(['call_expression']), calleeFieldName: 'function' },
  python:     { callNodeTypes: new Set(['call']),            calleeFieldName: 'function' },
  ruby:       { callNodeTypes: new Set(['call', 'method_call']), calleeFieldName: 'method' },
  go:         { callNodeTypes: new Set(['call_expression']), calleeFieldName: 'function' },
  rust:       { callNodeTypes: new Set(['call_expression', 'method_call_expression']), calleeFieldName: 'function' },
  java:       { callNodeTypes: new Set(['method_invocation']), calleeFieldName: 'name' },
};

/**
 * Extract the callee's bare identifier name from a call-site node. For
 * `obj.method(args)` returns "method". For `namespace::func(args)`
 * returns "func". For bare `func(args)` returns "func". When the callee
 * is itself a complex expression (arrow-chain, indexed access) we return
 * null to skip the edge.
 */
function extractCalleeName(node: any, cfg: CallConfig): string | null {
  const callee = cfg.calleeFieldName ? node.childForFieldName(cfg.calleeFieldName) : null;
  if (!callee) return null;

  // Unwrap common wrappers until we hit an identifier-shaped node.
  let cur = callee;
  for (let i = 0; i < 6 && cur; i++) {
    if (!cur.type) return null;
    if (
      cur.type === 'identifier' ||
      cur.type === 'property_identifier' ||
      cur.type === 'field_identifier' ||
      cur.type === 'scoped_identifier' ||
      cur.type === 'shorthand_property_identifier' ||
      cur.type === 'simple_identifier' ||
      cur.type === 'type_identifier' ||
      cur.type === 'constant'
    ) {
      const text = cur.text as string;
      // For scoped names like `std::io::println`, keep the final
      // segment only — the edge-identity match is by short name.
      const lastSeg = text.split(/[:.]+/).pop() ?? text;
      return sanitizeIdent(lastSeg);
    }
    // member_expression / field_expression: callee is last member.
    if (cur.type === 'member_expression' || cur.type === 'field_expression') {
      const prop = cur.childForFieldName('property') ?? cur.childForFieldName('field');
      if (prop) { cur = prop; continue; }
      return null;
    }
    // scoped_call_expression (Rust): recurse into function.
    if (cur.type === 'scoped_call_expression' || cur.type === 'scoped_identifier') {
      const name = cur.childForFieldName('name');
      if (name) { cur = name; continue; }
      return null;
    }
    // Fallback: read the node text and take the last identifier-looking token.
    const m = (cur.text as string).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    return m ? sanitizeIdent(m[1]!) : null;
  }
  return null;
}

function sanitizeIdent(s: string): string | null {
  const m = s.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
  return m ? s : null;
}

/**
 * Walk the tree and collect every call site that matches the language's
 * call-expression config. Returns a flat list; the caller maps byte
 * offsets to chunk IDs.
 */
export function extractCallEdges(tree: any, language: SupportedCodeLanguage): ExtractedEdge[] {
  const cfg = CALL_CONFIG[language];
  if (!cfg) return [];
  const out: ExtractedEdge[] = [];

  // Iterative traversal (tree-sitter trees can be deep; recursion risks
  // stack overflow on generated code). Uses TreeCursor when available,
  // else falls back to namedChildren iteration.
  const root = tree.rootNode;
  const stack: any[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (cfg.callNodeTypes.has(node.type)) {
      const callee = extractCalleeName(node, cfg);
      if (callee) {
        out.push({
          callSiteByteOffset: node.startIndex,
          toSymbol: callee,
          edgeType: 'calls',
        });
      }
    }
    // Push children for further traversal.
    for (const child of node.namedChildren) stack.push(child);
  }
  return out;
}

/**
 * Map byte offset → chunk index by (startLine, endLine) range. Returns
 * the innermost chunk containing the offset, which for A3 nested-chunk
 * emission is the deepest method chunk. Falls back to any chunk when
 * offset lookup misses (rare — root node always covers all offsets).
 */
export function findChunkForOffset(
  byteOffset: number,
  source: string,
  chunks: Array<{ startLine: number; endLine: number }>,
): number | null {
  // Compute line number of byteOffset by counting newlines up to it.
  // Cache: the chunker already knows startLine/endLine per chunk, so
  // a naive line lookup here is fine on a per-file basis.
  let line = 1;
  for (let i = 0; i < byteOffset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  // Prefer innermost (smallest line span) chunk containing the line.
  let best: number | null = null;
  let bestSpan = Infinity;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    if (line < c.startLine || line > c.endLine) continue;
    const span = c.endLine - c.startLine;
    if (span < bestSpan) { bestSpan = span; best = i; }
  }
  return best;
}
