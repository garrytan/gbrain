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
  /**
   * A `calls` edge whose callee is a member access (`obj.m()`, `self.m()`,
   * `pkg.F()`) with a receiver the extractor could not type, so `toSymbol`
   * is the bare `m`. A member call never invokes a same-file top-level
   * function, so the within-file resolver leaves these unresolved
   * (gbrain-evals N13-8: `segments.join("/")` resolved to pathe's `join`).
   */
  memberCall?: true;
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
 * from eng review — JS/TS/TSX + Python at full depth; Ruby/Go/Rust/Java/
 * Kotlin keep TODAY's bare-token call edges. Honest scope: tree-sitter
 * shapes are very different across these languages and writing+testing
 * per-language scope walkers for all of them is a v0.35 expansion.
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
 * names the child field that holds the callee expression. Grammars that
 * define no fields on their call node (Kotlin: `call_expression =
 * expression call_suffix`) set `calleeFirstNamedChild` instead — the
 * callee is positional, so namedChild(0) IS the callee.
 */
interface CallConfig {
  callNodeTypes: Set<string>;
  calleeFieldName?: string;
  /** Callee is namedChild(0) — for grammars whose call node has no fields. */
  calleeFirstNamedChild?: boolean;
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
  // tree-sitter-kotlin defines no fields on call_expression; the callee is
  // the first named child (simple_identifier for bare calls,
  // navigation_expression for `receiver.method(...)` — resolved to the
  // method name by the navigation_expression case in extractCalleeName).
  kotlin:     { callNodeTypes: new Set(['call_expression']), calleeFirstNamedChild: true },
  // #3602: tree-sitter-c-sharp calls are invocation_expression with a
  // `function` field. Bare calls hold an identifier; member calls
  // (`obj.Method(...)`) hold a member_access_expression, which
  // extractCalleeName resolves via its trailing-identifier fallback.
  c_sharp:    { callNodeTypes: new Set(['invocation_expression']), calleeFieldName: 'function' },
};

/**
 * Extract the callee's bare identifier name from a call-site node. For
 * `obj.method(args)` returns "method". For `namespace::func(args)`
 * returns "func". For bare `func(args)` returns "func". When the callee
 * is itself a complex expression (arrow-chain, indexed access) we return
 * null to skip the edge.
 */
function extractCalleeName(node: any, cfg: CallConfig): string | null {
  const callee = cfg.calleeFieldName
    ? node.childForFieldName(cfg.calleeFieldName)
    : cfg.calleeFirstNamedChild
      ? (node.namedChild?.(0) ?? null)
      : null;
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
    // navigation_expression (Kotlin): `receiver.method` — the callee is the
    // simple_identifier inside the trailing navigation_suffix. No fields on
    // this node either, so walk to the last named child's identifier.
    if (cur.type === 'navigation_expression') {
      const suffix = cur.namedChild?.(cur.namedChildCount - 1);
      const ident = suffix?.namedChild?.(0);
      if (ident) { cur = ident; continue; }
      return null;
    }
    // Fallback: read the node text and take the last identifier-looking token.
    const m = (cur.text as string).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    return m ? sanitizeIdent(m[1]!) : null;
  }
  return null;
}

const MEMBER_CALLEE_TYPES = new Set([
  'member_expression',
  'attribute',
  'field_expression',
  'selector_expression',
  'navigation_expression',
  'member_access_expression',
]);

/** True when the call goes through a receiver: `obj.m()`, `self.m()`, Java `o.m()`, Ruby `o.m`. */
function isMemberCall(node: any, cfg: CallConfig): boolean {
  if (node.childForFieldName?.('object') || node.childForFieldName?.('receiver')) return true;
  const callee = cfg.calleeFieldName
    ? node.childForFieldName(cfg.calleeFieldName)
    : cfg.calleeFirstNamedChild
      ? (node.namedChild?.(0) ?? null)
      : null;
  return !!callee && MEMBER_CALLEE_TYPES.has(callee.type);
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
 * @param fileBindings  the file's top-level binding index, shared by every
 *                      call site of one tree
 *
 * @internal exported for the differential test; production callers go
 *   through extractCallEdges.
 */
export function resolveReceiverType(
  callNode: any,
  language: SupportedCodeLanguage,
  bareCallee: string,
  fileBindings: FileBindings,
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
  // (`obj`); walk up to the file root, then look among top-level statements
  // for `import {obj} from 'pkg'` (pattern 1) or `const obj = new C()`
  // (pattern 3).
  if (receiver.type !== 'identifier' && receiver.type !== 'name') return null;
  const receiverName = recvText;
  if (!receiverName) return null;

  // Find the program/module root by walking up.
  let root = callNode.parent;
  for (let i = 0; i < WALK_DEPTH_CAP && root && root.parent; i++) root = root.parent;
  if (!root) return null;

  // A call nested deeper than the walk cap stops at an inner ancestor, not
  // the file root: scan that ancestor's children directly, as before.
  const prefix = root.parent
    ? scanBindingPrefix(root.namedChildren ?? [], language, receiverName)
    : fileBindings.prefixFor(receiverName);
  return prefix === null ? null : `${prefix}::${bareCallee}`;
}

/**
 * Patterns 1 and 3 for one top-level statement: the qualifier (`pkg`,
 * `module`, `ClassName`) when `stmt` binds `receiverName`, else null.
 */
function statementBindingPrefix(stmt: any, language: SupportedCodeLanguage, receiverName: string): string | null {
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
    if (!source) return null;
    // Check named imports + default + namespace imports for receiverName.
    const importText = (stmt.text ?? '') as string;
    // Cheap pre-filter: must mention receiverName as an identifier.
    if (!mentionsWord(importText, receiverName)) return null;
    return source;
  }
  // Pattern 1 (Python): `from pkg import obj` / `import pkg`
  if (language === 'python') {
    if (stmt.type === 'import_from_statement') {
      const moduleNode = stmt.childForFieldName('module_name');
      const module = moduleNode?.text;
      const importText = (stmt.text ?? '') as string;
      if (!module) return null;
      if (!mentionsWord(importText, receiverName)) return null;
      return module;
    }
    if (stmt.type === 'import_statement') {
      // `import pkg` — receiver matches module name directly.
      const importText = (stmt.text ?? '') as string;
      if (!mentionsWord(importText, receiverName)) return null;
      return receiverName;
    }
  }
  // Pattern 3: `const obj = new C()` / `obj = ClassName(...)` (python)
  if (
    stmt.type === 'lexical_declaration' ||
    stmt.type === 'variable_declaration' ||
    stmt.type === 'assignment'
  ) {
    const stmtText = (stmt.text ?? '') as string;
    if (!mentionsWord(stmtText, receiverName)) return null;
    // Look for `new ClassName(...)` (JS/TS) or `ClassName(...)` (Python).
    const newMatch = stmtText.match(/=\s*new\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (newMatch) return newMatch[1]!;
    // Python: `obj = ClassName(...)`
    if (language === 'python') {
      const pyMatch = stmtText.match(new RegExp(`${receiverName}\\s*=\\s*([A-Z][A-Za-z0-9_]*)\\s*\\(`));
      if (pyMatch) return pyMatch[1]!;
    }
  }
  return null;
}

/** The first statement in `stmts` that binds `receiverName`, as its qualifier. */
function scanBindingPrefix(stmts: readonly any[], language: SupportedCodeLanguage, receiverName: string): string | null {
  for (const stmt of stmts) {
    const prefix = statementBindingPrefix(stmt, language, receiverName);
    if (prefix !== null) return prefix;
  }
  return null;
}

const BINDING_STATEMENT_TYPES = new Set([
  'import_statement', 'import_from_statement', 'lexical_declaration', 'variable_declaration', 'assignment',
]);
const WORD_NAME = /^\w+$/;

function isWordChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isWordBoundary(text: string, at: number): boolean {
  const before = at > 0 && isWordChar(text.charCodeAt(at - 1));
  const after = at < text.length && isWordChar(text.charCodeAt(at));
  return before !== after;
}

/**
 * True when `name` occurs in `text` with a word boundary on both sides (JS
 * `\b`, ASCII word characters). The receiver name comes from indexed source,
 * so it is matched literally instead of being compiled into a RegExp.
 *
 * @internal exported for tests.
 */
export function mentionsWord(text: string, name: string): boolean {
  if (name.length === 0) return false;
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    if (isWordBoundary(text, i) && isWordBoundary(text, i + name.length)) return true;
  }
  return false;
}

/**
 * Top-level bindings of one file, built on first use. Every binding pattern
 * requires `\b<name>\b` in the statement text, which for a `\w+` name means
 * the name is one of the text's maximal `\w+` runs, so a word index narrows
 * the candidates to statements mentioning the receiver; each candidate then
 * runs the full per-statement check in file order, so the first match is
 * the same statement a full scan would find. Results are memoized per name.
 * Before this index every member call rescanned (and re-marshaled out of
 * WASM) every top-level statement: O(calls x statements).
 *
 * @internal exported for the differential test.
 */
export class FileBindings {
  private stmts: any[] | null = null;
  private byWord = new Map<string, number[]>();
  private memo = new Map<string, string | null>();

  constructor(private readonly root: any, private readonly language: SupportedCodeLanguage) {}

  prefixFor(receiverName: string): string | null {
    const cached = this.memo.get(receiverName);
    if (cached !== undefined) return cached;
    const stmts = this.statements();
    let prefix: string | null = null;
    if (WORD_NAME.test(receiverName)) {
      for (const i of this.byWord.get(receiverName) ?? []) {
        prefix = statementBindingPrefix(stmts[i], this.language, receiverName);
        if (prefix !== null) break;
      }
    } else {
      prefix = scanBindingPrefix(stmts, this.language, receiverName);
    }
    this.memo.set(receiverName, prefix);
    return prefix;
  }

  private statements(): any[] {
    if (this.stmts) return this.stmts;
    this.stmts = this.root?.namedChildren ?? [];
    this.stmts!.forEach((stmt: any, i: number) => {
      if (!BINDING_STATEMENT_TYPES.has(stmt.type)) return;
      for (const word of new Set(((stmt.text ?? '') as string).match(/\w+/g) ?? [])) {
        const list = this.byWord.get(word);
        if (list) list.push(i);
        else this.byWord.set(word, [i]);
      }
    });
    return this.stmts!;
  }
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
/**
 * Dart call sites, which `CALL_CONFIG` cannot describe.
 *
 * Every language in CALL_CONFIG has a call NODE whose callee is a field or
 * the first named child. tree-sitter-dart has no call node at all: an
 * invocation is a FLAT RUN OF SIBLINGS, where an argument-bearing node marks
 * the call and the callee is written to its LEFT.
 *
 *   bare(1)        identifier "bare" · selector(argument_part)
 *   obj.method(2)  identifier "obj"  · selector(unconditional_assignable_selector
 *                                       identifier "method") · selector(argument_part)
 *   obj?.method(3) same, conditional_assignable_selector
 *   a.b().c()      one identifier, then alternating selector pairs
 *   obj..m()       cascade_section(cascade_selector identifier "m", argument_part)
 *   new Widget(2)  new_expression(type_identifier "Widget", arguments)
 *
 * So the rule is positional, not structural: find the argument list, then
 * read the nearest name to its left. Emitted as bare tokens — Dart is not in
 * RECEIVER_RESOLUTION_LANGS, matching the Ruby/Go/Rust/Java/Kotlin scope.
 */
function dartCalleeNode(argBearing: any): any | null {
  // Walk left across siblings; the first name-carrying one wins.
  let prev = argBearing.previousNamedSibling;
  while (prev) {
    if (prev.type === 'selector') {
      const inner = prev.namedChild?.(0);
      if (
        inner &&
        (inner.type === 'unconditional_assignable_selector' ||
          inner.type === 'conditional_assignable_selector')
      ) {
        // `.method` / `?.method` — the method name is the call target.
        const id = inner.namedChild?.(0);
        return id?.type?.endsWith('identifier') ? id : null;
      }
      // A selector that names nothing means the thing being invoked is not a
      // named symbol — `a()()` calls the RESULT of `a()`, and `list[0]()`
      // calls an element. Emitting the nearest name to the left would
      // double-count `a` for a single definition of it. Stop instead.
      return null;
    }
    if (prev.type.endsWith('identifier')) return prev;
    prev = prev.previousNamedSibling;
  }
  return null;
}

export function extractDartCallEdges(tree: any): ExtractedEdge[] {
  const out: ExtractedEdge[] = [];
  const root = tree?.rootNode;
  if (!root) return out;

  const stack: any[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;

    // `new Widget(2)` — the one shape that does carry its own callee.
    if (node.type === 'new_expression') {
      const id = node.namedChildren.find((c: any) => c.type.endsWith('identifier'));
      if (id) out.push({ callSiteByteOffset: id.startIndex, toSymbol: id.text, edgeType: 'calls' });
    }

    // `obj..method()` — argument_part sits beside cascade_selector, not in a selector.
    if (node.type === 'cascade_section') {
      const hasArgs = node.namedChildren.some((c: any) => c.type === 'argument_part');
      const sel = node.namedChildren.find((c: any) => c.type === 'cascade_selector');
      const id = sel?.namedChildren?.find((c: any) => c.type.endsWith('identifier'));
      if (hasArgs && id) {
        out.push({ callSiteByteOffset: id.startIndex, toSymbol: id.text, edgeType: 'calls' });
      }
    }

    // The general shape: a selector holding the argument list.
    if (
      node.type === 'selector' &&
      node.namedChildren.some((c: any) => c.type === 'argument_part')
    ) {
      const id = dartCalleeNode(node);
      if (id) out.push({ callSiteByteOffset: id.startIndex, toSymbol: id.text, edgeType: 'calls' });
    }

    for (const child of node.namedChildren) stack.push(child);
  }
  return out;
}

export function extractCallEdges(tree: any, language: SupportedCodeLanguage): ExtractedEdge[] {
  // Dart has no call node for CALL_CONFIG to name — see extractDartCallEdges.
  if (language === 'dart') return extractDartCallEdges(tree);
  const cfg = CALL_CONFIG[language];
  if (!cfg) return [];
  const out: ExtractedEdge[] = [];

  // Iterative traversal (tree-sitter trees can be deep; recursion risks
  // stack overflow on generated code). Uses TreeCursor when available,
  // else falls back to namedChildren iteration.
  const root = tree.rootNode;
  const fileBindings = new FileBindings(root, language);
  const stack: any[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (cfg.callNodeTypes.has(node.type)) {
      const callee = extractCalleeName(node, cfg);
      if (callee) {
        // v0.34 W1: try receiver-type resolution. On success, emit the
        // qualified name; on miss, emit the bare token (pre-W1 behavior).
        const qualified = resolveReceiverType(node, language, callee, fileBindings);
        out.push({
          callSiteByteOffset: node.startIndex,
          toSymbol: qualified ?? callee,
          edgeType: 'calls',
          ...(!qualified && isMemberCall(node, cfg) ? { memberCall: true as const } : {}),
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
  return chunkLocator(source, chunks)(byteOffset);
}

/**
 * findChunkForOffset for many offsets into one file. The offset's line is
 * 1 + the newlines before it (binary search over the newline positions),
 * and each line's answer is painted once: chunks in decreasing span order,
 * ties by decreasing index, so the last painter of a line is the smallest
 * span containing it with the lowest index — the chunk a per-offset scan
 * picks. Before, every edge rescanned the file up to its offset and every
 * chunk: O(edges x (file + chunks)).
 */
export function chunkLocator(
  source: string,
  chunks: Array<{ startLine: number; endLine: number }>,
): (byteOffset: number) => number | null {
  const newlines: number[] = [];
  for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) newlines.push(i);
  const lineCount = newlines.length + 1;
  const best = new Int32Array(lineCount + 1).fill(-1);
  // A non-finite span (NaN or infinite line bounds) never wins a per-offset scan.
  const order = chunks.map((_, i) => i).filter((i) => chunks[i]!.endLine - chunks[i]!.startLine < Infinity).sort((a, b) => {
    const spanA = chunks[a]!.endLine - chunks[a]!.startLine;
    const spanB = chunks[b]!.endLine - chunks[b]!.startLine;
    return spanB - spanA || b - a;
  });
  for (const i of order) {
    const c = chunks[i]!;
    const from = Math.max(1, Math.ceil(c.startLine));
    const to = Math.min(lineCount, Math.floor(c.endLine));
    for (let line = from; line <= to; line++) best[line] = i;
  }
  return (byteOffset: number) => {
    const end = Math.min(byteOffset, source.length);
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (newlines[mid]! < end) lo = mid + 1;
      else hi = mid;
    }
    const found = best[lo + 1]!;
    return found === -1 ? null : found;
  };
}
