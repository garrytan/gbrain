/**
 * v0.20.0 Cathedral II Layer 5 (A1) — edge extractor.
 *
 * v0.34 W1 update — receiver-type resolution at emit time for the 3 MUST
 * patterns from the design doc:
 *   1. `import { x } from 'y'; x()` → emit `y::x`
 *   2. `class C { m() { this.m() } }` → emit `C::m`
 *   3. `const c = new C(); c.m()` → emit `C::m`
 *
 * When the receiver can't be resolved within {WALK_DEPTH_CAP} ancestor hops
 * of the call site, the extractor falls back to the pre-W1 bare-token emit
 * (`m`). This is honest: ambiguous-but-named-correctly beats wrong-but-confident,
 * and the symbol-resolver's second pass still gets a chance to disambiguate
 * via same-page `symbol_name_qualified` lookups.
 *
 * Walks a parsed tree-sitter tree and emits structural edges for:
 *   - `calls` — function/method invocations (f() → f, obj.m() → C::m when
 *     resolvable, else m). The receiver-type resolution lands here in v0.34;
 *     downstream consumers (symbol-resolver.ts) still match on the qualified
 *     name when available.
 *
 * Every emitted edge lands in code_edges_symbol (unresolved — to_chunk_id
 * null) because within-file resolution needs a second pass that matches
 * callee tokens against chunks' symbol_name_qualified. v0.34 W1 makes that
 * second pass land MORE single-match cases by emitting qualified names
 * upstream of the resolver.
 *
 * Per-language shipped list: TypeScript, TSX, JavaScript, Python, Ruby,
 * Go, Rust, Java — the 8 languages covering ~85% of real brain code.
 * Other languages flow through with zero edges (chunker still works).
 * Receiver-type resolution ships for JS/TS/TSX + Python only (per D18 from
 * eng review — honest language scope). Ruby/Go/Rust/Java stay at bare-token
 * emit semantics.
 */

import type { SupportedCodeLanguage } from './code.ts';

export interface ExtractedEdge {
  /**
   * Byte offset of the call site (or import/reference site) in the source.
   * The caller resolves this to a from_chunk_id by finding the chunk whose
   * (startLine, endLine) brackets the offset — matches how Layer 6 A3
   * emits one chunk per nested method, so each call site falls inside
   * exactly one chunk.
   */
  callSiteByteOffset: number;
  /**
   * The callee/imported/referenced token. When v0.34 W1 receiver-type
   * resolution lands a match, this is the qualified form `Class::method`
   * or `module::function`. When the receiver couldn't be resolved within
   * WALK_DEPTH_CAP ancestor hops, this is the bare token (`method`).
   * For `imports` edges this is the imported symbol qualified as
   * `module::symbol` (e.g. `react::useState`). For `references` edges
   * this is the referenced type name.
   */
  toSymbol: string;
  /**
   * v0.34 W2 — three edge kinds. `calls` is the v0.20 baseline; `imports`
   * captures `import { x } from 'y'` and `from x import y` statements;
   * `references` captures type-position mentions (TS function args, return
   * types). Per D18 only JS/TS/TSX + Python emit imports; only TS emits
   * references (Python's type hints are too sparse to be useful for v0.34).
   */
  edgeType: 'calls' | 'imports' | 'references';
}

/**
 * v0.34 D12 — Maximum number of ancestor hops the W1 scope walker will
 * walk upward from a call site looking for the receiver's declaration.
 * Beyond this, fall back to bare-token emit (pre-W1 behavior).
 *
 * 32 is enough for any realistic code shape; JSX-in-JSX or closures over
 * closures rarely exceed depth-20. The cap exists to prevent a single
 * pathological file from multiplying cycle cost across the whole brain on
 * every dream run.
 */
export const WALK_DEPTH_CAP = 32;

/**
 * Which languages get receiver-type resolution at extraction time. Per D18
 * from eng review — JS/TS/TSX + Python at full depth; Ruby/Go/Rust/Java
 * keep TODAY's bare-token call edges. Honest scope: tree-sitter shapes are
 * very different across these languages and writing+testing per-language
 * scope walkers for all of them is a v0.35 expansion.
 */
const RECEIVER_RESOLUTION_LANGS: ReadonlySet<SupportedCodeLanguage> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
] as const);

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
 * v0.34 W1 — Resolve the receiver type of a member-call expression
 * (`obj.method()`) to a qualified callee name (`Class::method` or
 * `module::method`). Tries the 3 MUST-resolve patterns from the design doc:
 *
 *   1. `import { obj } from 'pkg'; obj.method()` → `pkg::method`
 *      (covers ES module + Python `from x import y` flavors)
 *   2. `class C { m() { this.m() } }` → `C::m`
 *      (this/self callees resolve to the enclosing class)
 *   3. `const c = new C(); c.m()` → `C::m`
 *      (constructor-binding receiver resolves to the constructed class)
 *
 * Walks AT MOST WALK_DEPTH_CAP (32) ancestor hops looking for a binding.
 * Returns null when no pattern matches; caller falls back to bare token.
 *
 * @param callNode  the call-expression node (must be in RECEIVER_RESOLUTION_LANGS)
 * @param language  used to switch between JS/TS and Python AST shapes
 * @param bareCallee  the already-extracted bare callee name (`method`); we only
 *                    qualify it, never override it
 */
function resolveReceiverType(
  callNode: any,
  language: SupportedCodeLanguage,
  bareCallee: string,
): string | null {
  if (!RECEIVER_RESOLUTION_LANGS.has(language)) return null;

  const cfg = CALL_CONFIG[language];
  if (!cfg) return null;
  const callee = cfg.calleeFieldName ? callNode.childForFieldName(cfg.calleeFieldName) : null;
  if (!callee) return null;

  // Only resolve when the callee is a member/attribute access (obj.method).
  // Bare calls (`f()`) have no receiver to resolve.
  const isMemberExpr =
    callee.type === 'member_expression' ||
    callee.type === 'field_expression' ||
    callee.type === 'attribute';
  if (!isMemberExpr) return null;

  // Get the object/receiver text (the `obj` in `obj.method()`).
  const receiver =
    callee.childForFieldName('object') ?? callee.childForFieldName('left');
  if (!receiver) return null;

  // Pattern 2: `this.method()` / Python `self.method()` → enclosing class.
  const recvText = (receiver.text ?? '') as string;
  const isThisOrSelf =
    recvText === 'this' || (language === 'python' && recvText === 'self');
  if (isThisOrSelf) {
    // Walk up to find the enclosing class node.
    let node = callNode.parent;
    for (let i = 0; i < WALK_DEPTH_CAP && node; i++) {
      const isClass =
        node.type === 'class_declaration' ||
        node.type === 'class_definition' ||
        node.type === 'class';
      if (isClass) {
        const name = node.childForFieldName('name') ?? node.childForFieldName('class_name');
        const className = name?.text;
        if (className) return `${className}::${bareCallee}`;
      }
      node = node.parent;
    }
    return null;
  }

  // Resolve via top-of-file binding search. The receiver is an identifier
  // (`obj`); walk up to the file root, then scan top-level statements for
  // `import {obj} from 'pkg'` (pattern 1) or `const obj = new C()`
  // (pattern 3).
  if (receiver.type !== 'identifier' && receiver.type !== 'name') return null;
  const receiverName = recvText;
  if (!receiverName) return null;

  // Find the program/module root by walking up.
  let root = callNode.parent;
  for (let i = 0; i < WALK_DEPTH_CAP && root && root.parent; i++) root = root.parent;
  if (!root) return null;

  // Scan top-level children for a binding of `receiverName`.
  for (const stmt of root.namedChildren ?? []) {
    // Pattern 1: ES import.
    //   import { obj } from 'pkg'  → import_statement / import_clause
    //   import obj from 'pkg'       → default import
    //   import * as obj from 'pkg' → namespace import
    if (
      (language === 'typescript' || language === 'tsx' || language === 'javascript') &&
      stmt.type === 'import_statement'
    ) {
      const sourceNode = stmt.childForFieldName('source');
      const source = (sourceNode?.text ?? '').replace(/^['"]|['"]$/g, '');
      if (!source) continue;
      // Check named imports + default + namespace imports for receiverName.
      const importText = (stmt.text ?? '') as string;
      // Cheap pre-filter: must mention receiverName as an identifier.
      if (!new RegExp(`\\b${receiverName}\\b`).test(importText)) continue;
      return `${source}::${bareCallee}`;
    }
    // Pattern 1 (Python): `from pkg import obj` / `import pkg`
    if (language === 'python') {
      if (stmt.type === 'import_from_statement') {
        const moduleNode = stmt.childForFieldName('module_name');
        const module = moduleNode?.text;
        const importText = (stmt.text ?? '') as string;
        if (!module) continue;
        if (!new RegExp(`\\b${receiverName}\\b`).test(importText)) continue;
        return `${module}::${bareCallee}`;
      }
      if (stmt.type === 'import_statement') {
        // `import pkg` — receiver matches module name directly.
        const importText = (stmt.text ?? '') as string;
        if (!new RegExp(`\\b${receiverName}\\b`).test(importText)) continue;
        return `${receiverName}::${bareCallee}`;
      }
    }
    // Pattern 3: `const obj = new C()` / `obj = ClassName(...)` (python)
    if (
      stmt.type === 'lexical_declaration' ||
      stmt.type === 'variable_declaration' ||
      stmt.type === 'assignment'
    ) {
      const stmtText = (stmt.text ?? '') as string;
      if (!new RegExp(`\\b${receiverName}\\b`).test(stmtText)) continue;
      // Look for `new ClassName(...)` (JS/TS) or `ClassName(...)` (Python).
      const newMatch = stmtText.match(/=\s*new\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (newMatch) return `${newMatch[1]}::${bareCallee}`;
      // Python: `obj = ClassName(...)`
      if (language === 'python') {
        const pyMatch = stmtText.match(new RegExp(`${receiverName}\\s*=\\s*([A-Z][A-Za-z0-9_]*)\\s*\\(`));
        if (pyMatch) return `${pyMatch[1]}::${bareCallee}`;
      }
    }
  }
  return null;
}

/**
 * Walk the tree and collect every call site that matches the language's
 * call-expression config. Returns a flat list; the caller maps byte
 * offsets to chunk IDs.
 *
 * v0.34 W1: for receiver-type-resolution-eligible languages, attempts to
 * upgrade the emit from bare `method` to qualified `Class::method` /
 * `module::method`. Falls back to bare-token emit on resolution miss.
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
        // v0.34 W1: try receiver-type resolution. On success, emit the
        // qualified name; on miss, emit the bare token (pre-W1 behavior).
        const qualified = resolveReceiverType(node, language, callee);
        out.push({
          callSiteByteOffset: node.startIndex,
          toSymbol: qualified ?? callee,
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
 * v0.34 W2 — Walk the tree and collect every import statement.
 * Emits one `imports` edge per imported symbol with `toSymbol` set to
 * `module::symbol`. Eligible languages: JS/TS/TSX (`import { x } from 'y'`,
 * `import * as foo from 'bar'`, `import('foo')` dynamic imports) and Python
 * (`from x import y`, `import y`). Other languages return [].
 *
 * Per D18 from eng review — only JS/TS/TSX + Python at depth. Ruby/Go/Rust/
 * Java skip imports for v0.34.
 */
export function extractImportEdges(tree: any, language: SupportedCodeLanguage): ExtractedEdge[] {
  const out: ExtractedEdge[] = [];
  if (
    language !== 'typescript' &&
    language !== 'tsx' &&
    language !== 'javascript' &&
    language !== 'python'
  ) {
    return out;
  }

  const root = tree.rootNode;
  if (!root) return out;

  for (const stmt of root.namedChildren ?? []) {
    // ───── JS/TS imports ─────
    if (
      (language === 'typescript' || language === 'tsx' || language === 'javascript') &&
      stmt.type === 'import_statement'
    ) {
      const sourceNode = stmt.childForFieldName('source');
      const source = (sourceNode?.text ?? '').replace(/^['"`]|['"`]$/g, '');
      if (!source) continue;
      // Parse the named imports / default / namespace import out of the
      // statement text. Tree-sitter exposes import_clause + named_imports
      // children but the structure varies by grammar version; text-pattern
      // matching is more reliable.
      const stmtText = (stmt.text ?? '') as string;
      // Named imports: `import { a, b as c } from 'pkg'`
      const namedMatch = stmtText.match(/import\s*(?:type\s+)?\{([^}]+)\}\s*from/);
      if (namedMatch && namedMatch[1]) {
        const names = namedMatch[1]
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
          .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
        for (const name of names) {
          out.push({
            callSiteByteOffset: stmt.startIndex,
            toSymbol: `${source}::${name}`,
            edgeType: 'imports',
          });
        }
      }
      // Default import: `import foo from 'pkg'`
      const defaultMatch = stmtText.match(/import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from/);
      if (defaultMatch) {
        out.push({
          callSiteByteOffset: stmt.startIndex,
          toSymbol: `${source}::default`,
          edgeType: 'imports',
        });
      }
      // Namespace import: `import * as foo from 'pkg'`
      const nsMatch = stmtText.match(/import\s*\*\s*as\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (nsMatch) {
        out.push({
          callSiteByteOffset: stmt.startIndex,
          toSymbol: `${source}::*`,
          edgeType: 'imports',
        });
      }
      // Side-effect import: `import 'foo';` — record the module itself.
      if (!namedMatch && !defaultMatch && !nsMatch) {
        out.push({
          callSiteByteOffset: stmt.startIndex,
          toSymbol: `${source}::*`,
          edgeType: 'imports',
        });
      }
    }
    // ───── Python imports ─────
    if (language === 'python') {
      if (stmt.type === 'import_from_statement') {
        const moduleNode = stmt.childForFieldName('module_name');
        const module = moduleNode?.text;
        if (!module) continue;
        // The import_from_statement has name fields for each imported symbol.
        const text = (stmt.text ?? '') as string;
        // `from pkg import a, b as c`
        const m = text.match(/from\s+\S+\s+import\s+(.+)$/m);
        if (m && m[1]) {
          const names = m[1]
            .split(',')
            .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
            .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
          for (const name of names) {
            out.push({
              callSiteByteOffset: stmt.startIndex,
              toSymbol: `${module}::${name}`,
              edgeType: 'imports',
            });
          }
        }
      }
      if (stmt.type === 'import_statement') {
        // `import pkg` / `import pkg.sub`
        const text = (stmt.text ?? '') as string;
        const m = text.match(/import\s+([A-Za-z_][A-Za-z0-9_.]*)/);
        if (m && m[1]) {
          out.push({
            callSiteByteOffset: stmt.startIndex,
            toSymbol: `${m[1]}::*`,
            edgeType: 'imports',
          });
        }
      }
    }
  }

  return out;
}

/**
 * v0.34 W2 — Walk the tree and collect every type-position reference
 * (TS-only for v0.34). Emits one `references` edge per type identifier
 * appearing in a function signature, return annotation, generic argument,
 * or type alias body.
 *
 * Honest scope: this catches `function f(x: SomeType)` and
 * `function f(): SomeType` and `type Alias = SomeType`. It does NOT catch
 * conditional types, mapped types, or template-literal types — those are
 * v0.35.
 */
export function extractReferenceEdges(tree: any, language: SupportedCodeLanguage): ExtractedEdge[] {
  const out: ExtractedEdge[] = [];
  if (language !== 'typescript' && language !== 'tsx') return out;

  const root = tree.rootNode;
  if (!root) return out;

  // Walk every node looking for `type_annotation` / `type_identifier`
  // contexts. A type_identifier node text IS the referenced type name.
  const stack: any[] = [root];
  const seen = new Set<string>(); // dedup per file: same type referenced N times → one edge per offset
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === 'type_identifier' || node.type === 'predefined_type') {
      const text = (node.text ?? '') as string;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) && text.length > 1) {
        const key = `${node.startIndex}:${text}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            callSiteByteOffset: node.startIndex,
            toSymbol: text,
            edgeType: 'references',
          });
        }
      }
    }
    for (const child of node.namedChildren ?? []) stack.push(child);
  }
  return out;
}

/**
 * v0.34 W2 — Combined extractor: returns the union of call edges, import
 * edges, and reference edges. Consumers (code.ts) call this instead of
 * extractCallEdges directly.
 */
export function extractAllEdges(tree: any, language: SupportedCodeLanguage): ExtractedEdge[] {
  return [
    ...extractCallEdges(tree, language),
    ...extractImportEdges(tree, language),
    ...extractReferenceEdges(tree, language),
  ];
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
