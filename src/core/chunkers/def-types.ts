/**
 * Definition-shaped symbol types (normalized, post-`normalizeSymbolType`) —
 * the ONE list shared by `gbrain code-def`'s lookup allowlist
 * (src/commands/code-def.ts re-exports DEF_TYPES from here) and the chunker's
 * merge guard (#4511), so the two can't drift: a symbol type code-def can
 * resolve must never have its `symbol_name` erased by small-sibling merging.
 */

// v0.41 D2: SQL DDL targets (table/view/index/procedure/schema/database/
// trigger) are first-class definitions in the SQL sense. The chunker's
// normalizeSymbolType maps create_table → 'table' etc, so adding the SQL
// kinds here is what makes `gbrain code-def users` work against SQL.
// Method-level + member definitions. normalizeSymbolType only canonicalizes
// some node types; the rest fall through `type.replace(/_/g, ' ')`, so
// tree-sitter's method_declaration → 'method declaration', struct_specifier →
// 'struct specifier', protocol_declaration → 'protocol declaration', etc.
// Without these, code-def is blind to every method, constructor, field, C
// struct, and Swift protocol — which is most of an OO codebase. The plain
// 'struct' entry above never matched for the same reason (C emits the
// 'struct specifier' fallback form).
export const DEF_TYPES = [
  'function', 'class', 'interface', 'type', 'enum', 'struct', 'trait', 'module', 'contract',
  'table', 'view', 'index', 'procedure', 'schema', 'database', 'trigger',
  'method declaration', 'method definition', 'constructor declaration',
  'field declaration', 'field definition', 'struct specifier', 'protocol declaration',
  // Dart: normalizeSymbolType has no rule for these four, so they arrive as
  // the node type with underscores replaced. class_definition/enum_declaration/
  // type_alias/function_signature already normalize into the list above.
  'mixin declaration', 'extension declaration',
  'getter signature', 'setter signature',
  // #3789 residual audit — every remaining definition-shaped fallthrough of
  // normalizeSymbolType across TOP_LEVEL_TYPES + NESTED_EMIT_CONFIG. Without
  // these, symbols the chunker HAS indexed are invisible to code-def (Java
  // records, C#/Kotlin properties, Rust structs/traits, Go type declarations,
  // Solidity contracts — the bare 'contract'/'trait'/'struct' entries above
  // are never produced by normalizeSymbolType, only these fallthrough forms).
  'property declaration', 'record declaration',            // C#/Kotlin, Java
  'struct declaration', 'object declaration',              // C#/Swift, Kotlin
  'namespace declaration', 'file scoped namespace declaration', // C#
  'trait declaration',                                     // PHP
  'trait definition', 'object definition',                 // Scala
  'contract declaration', 'modifier definition', 'event definition', // Solidity
  'namespace definition', 'template declaration', 'declaration', 'preproc def', // C/C++
  'type declaration', 'const declaration', 'var declaration', // Go
  'struct item', 'trait item', 'impl item', 'mod item',    // Rust
  'type item', 'const item', 'static item',                // Rust
  'lexical declaration', 'variable declaration',           // TS/JS top-level const/let/var
  'local declaration',                                     // Lua
];

/**
 * #4511 — DEF_TYPES entries that stay MERGEABLE: the small-declaration RUN
 * forms `mergeSmallSiblings` exists for (import runs, const/var runs, C
 * `#define`/prototype runs, Kotlin top-level `val` runs). Everything else in
 * DEF_TYPES names a substantive definition whose `symbol_name` must survive
 * chunk merging, or code-def can never find it again.
 */
const MERGEABLE_RUN_TYPES = new Set([
  'lexical declaration', 'variable declaration', // TS/JS const/let/var
  'const declaration', 'var declaration',        // Go
  'local declaration',                           // Lua
  'declaration', 'preproc def',                  // C/C++ prototypes, globals, #define
  'property declaration',                        // Kotlin top-level val/var
]);

/**
 * #4511 — symbol types `mergeSmallSiblings` must never fold into an anonymous
 * `symbolType: 'merged'` chunk (merging nulls out `symbol_name`, and code-def
 * resolves names against chunk rows, so a merged definition is unreachable).
 * Derived view of DEF_TYPES (minus the run forms above) plus the two wrapper
 * forms code-def also resolves: 'export statement' (TS/JS export wrapper, in
 * findCodeDef's SQL allowlist) and 'decorated definition' (Python decorator
 * wrapper — normally unwrapped to function/class, kept as a belt-and-braces
 * entry should the unwrap miss).
 */
export const MERGE_PROTECTED_SYMBOL_TYPES: ReadonlySet<string> = new Set([
  ...DEF_TYPES.filter((t) => !MERGEABLE_RUN_TYPES.has(t)),
  'export statement',
  'decorated definition',
]);
