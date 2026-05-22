/**
 * Code Chunker — Tree-Sitter-Based Semantic Code Splitting
 *
 * Uses web-tree-sitter (WASM) to parse code files into AST, then extracts
 * semantic units (functions, classes, types, exports) as chunks.
 *
 * Each chunk includes a structured header with language, file path, line range,
 * and symbol name — so embeddings capture both context and code content.
 *
 * Supports: TypeScript, TSX, JavaScript, Python, Ruby, Go.
 * Falls back to recursive text chunker for unsupported languages.
 *
 * WASM loading (v0.19.0, Layer 2):
 * Uses Bun's embedded-asset pattern via `import ... with { type: 'file' }`.
 * WASMs live at `src/assets/wasm/` and are committed to the repo. At
 * `bun --compile` time, Bun bundles them into the binary. In dev, the
 * imports resolve to the repo paths directly. No node_modules dependency
 * at runtime.
 */

import { chunkText as recursiveChunk } from './recursive.ts';
import { buildQualifiedName } from './qualified-names.ts';

// Embed the tree-sitter runtime + per-language grammars as files.
// `with { type: 'file' }` returns a path (string) at runtime. Bun bundles
// the referenced file into the compiled binary during `bun build --compile`.
// In dev, the path resolves to the source-tree file; the compiled binary
// uses a bundler-synthesized path.
// @ts-ignore — type: 'file' import attribute is valid Bun syntax, not in lib.d.ts
import TREE_SITTER_WASM from '../../assets/wasm/tree-sitter.wasm' with { type: 'file' };
// 36 grammars total. Every grammar ships in the compiled binary — Bun's
// --compile bundles each referenced asset. Layer 5 extends the 6 baseline
// languages to all 36 tree-sitter-wasms ship.
// @ts-ignore
import G_BASH from '../../assets/wasm/grammars/tree-sitter-bash.wasm' with { type: 'file' };
// @ts-ignore
import G_C from '../../assets/wasm/grammars/tree-sitter-c.wasm' with { type: 'file' };
// @ts-ignore
import G_CSHARP from '../../assets/wasm/grammars/tree-sitter-c_sharp.wasm' with { type: 'file' };
// @ts-ignore
import G_CPP from '../../assets/wasm/grammars/tree-sitter-cpp.wasm' with { type: 'file' };
// @ts-ignore
import G_CSS from '../../assets/wasm/grammars/tree-sitter-css.wasm' with { type: 'file' };
// @ts-ignore
import G_DART from '../../assets/wasm/grammars/tree-sitter-dart.wasm' with { type: 'file' };
// @ts-ignore
import G_ELIXIR from '../../assets/wasm/grammars/tree-sitter-elixir.wasm' with { type: 'file' };
// @ts-ignore
import G_ELM from '../../assets/wasm/grammars/tree-sitter-elm.wasm' with { type: 'file' };
// @ts-ignore
import G_GO from '../../assets/wasm/grammars/tree-sitter-go.wasm' with { type: 'file' };
// @ts-ignore
import G_HTML from '../../assets/wasm/grammars/tree-sitter-html.wasm' with { type: 'file' };
// @ts-ignore
import G_JAVA from '../../assets/wasm/grammars/tree-sitter-java.wasm' with { type: 'file' };
// @ts-ignore
import G_JAVASCRIPT from '../../assets/wasm/grammars/tree-sitter-javascript.wasm' with { type: 'file' };
// @ts-ignore
import G_JSON from '../../assets/wasm/grammars/tree-sitter-json.wasm' with { type: 'file' };
// @ts-ignore
import G_KOTLIN from '../../assets/wasm/grammars/tree-sitter-kotlin.wasm' with { type: 'file' };
// @ts-ignore
import G_LUA from '../../assets/wasm/grammars/tree-sitter-lua.wasm' with { type: 'file' };
// @ts-ignore
import G_OCAML from '../../assets/wasm/grammars/tree-sitter-ocaml.wasm' with { type: 'file' };
// @ts-ignore
import G_PHP from '../../assets/wasm/grammars/tree-sitter-php.wasm' with { type: 'file' };
// @ts-ignore
import G_PYTHON from '../../assets/wasm/grammars/tree-sitter-python.wasm' with { type: 'file' };
// @ts-ignore
import G_RUBY from '../../assets/wasm/grammars/tree-sitter-ruby.wasm' with { type: 'file' };
// @ts-ignore
import G_RUST from '../../assets/wasm/grammars/tree-sitter-rust.wasm' with { type: 'file' };
// @ts-ignore
import G_SCALA from '../../assets/wasm/grammars/tree-sitter-scala.wasm' with { type: 'file' };
// @ts-ignore
import G_SOLIDITY from '../../assets/wasm/grammars/tree-sitter-solidity.wasm' with { type: 'file' };
// @ts-ignore
import G_SWIFT from '../../assets/wasm/grammars/tree-sitter-swift.wasm' with { type: 'file' };
// @ts-ignore
import G_TOML from '../../assets/wasm/grammars/tree-sitter-toml.wasm' with { type: 'file' };
// @ts-ignore
import G_TSX from '../../assets/wasm/grammars/tree-sitter-tsx.wasm' with { type: 'file' };
// @ts-ignore
import G_TYPESCRIPT from '../../assets/wasm/grammars/tree-sitter-typescript.wasm' with { type: 'file' };
// @ts-ignore
import G_VUE from '../../assets/wasm/grammars/tree-sitter-vue.wasm' with { type: 'file' };
// @ts-ignore
import G_YAML from '../../assets/wasm/grammars/tree-sitter-yaml.wasm' with { type: 'file' };
// @ts-ignore
import G_ZIG from '../../assets/wasm/grammars/tree-sitter-zig.wasm' with { type: 'file' };

// Bumped whenever chunker output shape changes (new tokenizer, merge-threshold,
// language set, etc.) so importCodeFile's content_hash re-chunks existing pages
// after a gbrain upgrade. See A2 / C2 in the v0.19.0 plan.
//
// v3: Chonkie parity (Layer 5) — 36 languages + tiktoken cl100k_base tokenizer
// + small-sibling merging. Every v0.18.0 brain with code pages re-chunks on
// next sync because the chunk sizes + symbol boundaries shift.
//
// v4 (v0.20.0 Cathedral II Layer 12): chunk-grain FTS vector + qualified
// symbol name + parent_symbol_path + doc_comment columns. Chunk_text headers
// will gain the qualified name and scope chain once Layer 5/6 lands. The
// bump + sources.chunker_version gate (in src/commands/sync.ts) forces a
// full walk on upgraded brains even when git HEAD hasn't moved, so existing
// chunks get the new columns populated. Without this, the v28 backfill
// gives every existing chunk a search_vector but subsequent Layer 5 AST
// work would silently no-op.
export const CHUNKER_VERSION = 4;

// Lazy-loaded tree-sitter module (v0.22.x API: Parser is default export)
let Parser: typeof import('web-tree-sitter') | null = null;

async function getParser(): Promise<typeof import('web-tree-sitter')> {
  if (!Parser) {
    Parser = (await import('web-tree-sitter')).default || await import('web-tree-sitter');
  }
  return Parser;
}

export type SupportedCodeLanguage =
  | 'typescript' | 'tsx' | 'javascript' | 'python' | 'ruby' | 'go'
  | 'rust' | 'java' | 'c_sharp' | 'cpp' | 'c' | 'php' | 'swift' | 'kotlin'
  | 'scala' | 'lua' | 'elixir' | 'elm' | 'ocaml' | 'dart' | 'zig' | 'solidity'
  | 'bash' | 'css' | 'html' | 'vue' | 'json' | 'yaml' | 'toml';

export interface CodeChunkMetadata {
  symbolName: string | null;
  symbolType: string;
  filePath: string;
  language: SupportedCodeLanguage;
  startLine: number;
  endLine: number;
  /**
   * v0.20.0 Cathedral II Layer 6 (A3): chain of enclosing symbols from
   * outermost to innermost. Empty for top-level nodes. `['BrainEngine',
   * 'searchKeyword']` for a nested method 2 levels deep. Pairs with the
   * chunk header which prints `(in BrainEngine.searchKeyword)` so the
   * embedding captures scope context.
   */
  parentSymbolPath?: string[];
  /**
   * v0.20.0 Cathedral II Layer 5 (A1): fully-qualified symbol identity for
   * edge matching. Built by qualified-names.ts from language + symbolType
   * + symbolName + parentSymbolPath. Examples:
   *   Ruby:   Admin::UsersController#render
   *   Python: admin.users_controller.UsersController.render
   *   TS/JS:  BrainEngine.searchKeyword
   *   Rust:   users::UsersController::render
   * Null when symbolName is missing (merged chunks, module-level fallback).
   */
  symbolNameQualified?: string | null;
}

export interface CodeChunk {
  text: string;
  index: number;
  metadata: CodeChunkMetadata;
}

export interface CodeChunkOptions {
  chunkSizeTokens?: number;
  largeChunkThresholdTokens?: number;
  fallbackChunkSizeWords?: number;
  fallbackOverlapWords?: number;
}

/**
 * v0.20.0 Cathedral II Layer 4 (B1) — LanguageEntry manifest.
 *
 * Before Cathedral II, languages were hardcoded in two places: GRAMMAR_PATHS
 * (Bun asset imports) and DISPLAY_LANG (display names). The plan's B1 tier
 * wants one manifest that supports (a) embedded grammars that ship with
 * `bun --compile` today, (b) lazy-loaded grammars resolved from
 * node_modules/tree-sitter-wasms at runtime for source-installs, and (c)
 * user-registered grammars so downstream consumers can extend coverage
 * without forking the chunker.
 *
 * v0.20.0 ships the 29 embedded grammars we already had. The lazy-loader
 * + registerLanguage hook are in place as forward-compat — a v0.20.x
 * follow-up (or user) can register additional grammars without touching
 * the chunker core.
 *
 * Structure:
 *   - `embeddedPath` → Bun asset path, takes priority when present.
 *   - `lazyLoader` → async function returning path OR Uint8Array. Used
 *     when embeddedPath is absent. Runs at most once per process
 *     (result cached alongside the parsed Language via `languageCache`).
 *   - `displayName` → human-readable name used in embedded chunk headers
 *     so both the agent and a human reader see "TypeScript", not
 *     "typescript", in the structured header line.
 */
export interface LanguageEntry {
  displayName: string;
  embeddedPath?: string;
  lazyLoader?: () => Promise<string | Uint8Array>;
}

const LANGUAGE_MANIFEST: Record<SupportedCodeLanguage, LanguageEntry> = {
  typescript: { displayName: 'TypeScript', embeddedPath: G_TYPESCRIPT },
  tsx:        { displayName: 'TSX',        embeddedPath: G_TSX },
  javascript: { displayName: 'JavaScript', embeddedPath: G_JAVASCRIPT },
  python:     { displayName: 'Python',     embeddedPath: G_PYTHON },
  ruby:       { displayName: 'Ruby',       embeddedPath: G_RUBY },
  go:         { displayName: 'Go',         embeddedPath: G_GO },
  rust:       { displayName: 'Rust',       embeddedPath: G_RUST },
  java:       { displayName: 'Java',       embeddedPath: G_JAVA },
  c_sharp:    { displayName: 'C#',         embeddedPath: G_CSHARP },
  cpp:        { displayName: 'C++',        embeddedPath: G_CPP },
  c:          { displayName: 'C',          embeddedPath: G_C },
  php:        { displayName: 'PHP',        embeddedPath: G_PHP },
  swift:      { displayName: 'Swift',      embeddedPath: G_SWIFT },
  kotlin:     { displayName: 'Kotlin',     embeddedPath: G_KOTLIN },
  scala:      { displayName: 'Scala',      embeddedPath: G_SCALA },
  lua:        { displayName: 'Lua',        embeddedPath: G_LUA },
  elixir:     { displayName: 'Elixir',     embeddedPath: G_ELIXIR },
  elm:        { displayName: 'Elm',        embeddedPath: G_ELM },
  ocaml:      { displayName: 'OCaml',      embeddedPath: G_OCAML },
  dart:       { displayName: 'Dart',       embeddedPath: G_DART },
  zig:        { displayName: 'Zig',        embeddedPath: G_ZIG },
  solidity:   { displayName: 'Solidity',   embeddedPath: G_SOLIDITY },
  bash:       { displayName: 'Bash',       embeddedPath: G_BASH },
  css:        { displayName: 'CSS',        embeddedPath: G_CSS },
  html:       { displayName: 'HTML',       embeddedPath: G_HTML },
  vue:        { displayName: 'Vue',        embeddedPath: G_VUE },
  json:       { displayName: 'JSON',       embeddedPath: G_JSON },
  yaml:       { displayName: 'YAML',       embeddedPath: G_YAML },
  toml:       { displayName: 'TOML',       embeddedPath: G_TOML },
};

/**
 * Extension registry for lazy-registered languages (beyond the 29
 * embedded core). Keyed on SupportedCodeLanguage string; registrations
 * here take priority over LANGUAGE_MANIFEST on conflict so hot-fix
 * overrides during a session work without a restart.
 *
 * This is the extension point Layer 9 (Magika) uses to wire extensionless
 * language detection, and the v0.20.x+ follow-up point for full
 * tree-sitter-wasms (~165 langs) coverage. Not exposed in the MCP
 * surface — purely a developer-facing hook.
 */
const dynamicLanguages: Map<string, LanguageEntry> = new Map();

export function registerLanguage(lang: string, entry: LanguageEntry): void {
  dynamicLanguages.set(lang, entry);
}

export function unregisterLanguage(lang: string): void {
  dynamicLanguages.delete(lang);
  languageCache.delete(lang as SupportedCodeLanguage);
}

export function listRegisteredLanguages(): string[] {
  return [
    ...Object.keys(LANGUAGE_MANIFEST),
    ...Array.from(dynamicLanguages.keys()),
  ];
}

function getLanguageEntry(language: string): LanguageEntry | undefined {
  // dynamicLanguages wins on conflict (hot-fix overrides).
  return dynamicLanguages.get(language) ?? LANGUAGE_MANIFEST[language as SupportedCodeLanguage];
}

// Per-language top-level AST node types that count as semantic units.
// Languages not in this map fall through to the recursive text chunker
// when the grammar loads but no semantic nodes match — correct behavior.
const TOP_LEVEL_TYPES: Partial<Record<SupportedCodeLanguage, Set<string>>> = {
  typescript: new Set([
    'function_declaration', 'class_declaration', 'abstract_class_declaration',
    'interface_declaration', 'type_alias_declaration', 'enum_declaration',
    'lexical_declaration', 'variable_declaration', 'export_statement',
  ]),
  tsx: new Set([
    'function_declaration', 'class_declaration', 'interface_declaration',
    'type_alias_declaration', 'enum_declaration', 'lexical_declaration',
    'variable_declaration', 'export_statement',
  ]),
  javascript: new Set([
    'function_declaration', 'class_declaration', 'lexical_declaration',
    'variable_declaration', 'export_statement',
  ]),
  python: new Set([
    'function_definition', 'class_definition',
    'import_statement', 'import_from_statement', 'assignment',
  ]),
  ruby: new Set(['class', 'module', 'method', 'singleton_method', 'assignment']),
  go: new Set([
    'function_declaration', 'method_declaration', 'type_declaration',
    'const_declaration', 'var_declaration', 'import_declaration',
  ]),
  rust: new Set([
    'function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item',
    'mod_item', 'type_item', 'const_item', 'static_item', 'use_declaration',
  ]),
  java: new Set([
    'method_declaration', 'class_declaration', 'interface_declaration',
    'enum_declaration', 'record_declaration', 'import_declaration',
    'package_declaration',
  ]),
  c_sharp: new Set([
    'method_declaration', 'class_declaration', 'interface_declaration',
    'struct_declaration', 'enum_declaration', 'namespace_declaration',
    'using_directive', 'property_declaration',
  ]),
  cpp: new Set([
    'function_definition', 'class_specifier', 'struct_specifier',
    'namespace_definition', 'declaration', 'template_declaration',
  ]),
  c: new Set(['function_definition', 'struct_specifier', 'declaration', 'preproc_def', 'preproc_include']),
  php: new Set([
    'function_definition', 'class_declaration', 'interface_declaration',
    'method_declaration', 'trait_declaration',
  ]),
  swift: new Set([
    'function_declaration', 'class_declaration', 'struct_declaration',
    'protocol_declaration', 'enum_declaration', 'import_declaration',
  ]),
  kotlin: new Set(['function_declaration', 'class_declaration', 'property_declaration', 'object_declaration']),
  scala: new Set(['function_definition', 'class_definition', 'object_definition', 'trait_definition']),
  lua: new Set(['function_declaration', 'function_definition', 'local_declaration']),
  elixir: new Set(['call']),
  bash: new Set(['function_definition', 'variable_assignment']),
  solidity: new Set(['contract_declaration', 'function_definition', 'modifier_definition', 'event_definition']),
};

const BODY_NODE_TYPES = new Set([
  'statement_block',
  'block',
  'class_body',
  'module_body',
  'body_statement',
  'body',
]);

/**
 * v0.20.0 Cathedral II Layer 6 (A3) — nested-chunk emission config.
 *
 * Per-language map: when a top-level AST node is `parentType`, emit each
 * child of type `childTypes` as its OWN chunk with `parentSymbolPath`
 * populated. The parent itself still emits a chunk for the class-level
 * documentation / scope overview. This lets retrieval surface individual
 * methods (with scope context "in ClassName.method") instead of returning
 * the entire class body for a symbol-specific query.
 *
 * Languages not in this map keep current behavior: top-level node → one
 * chunk. Go stays absent (methods are already top-level with receivers).
 */
interface NestedEmitConfig {
  parentTypes: Set<string>;
  childTypes: Set<string>;
}
const NESTED_EMIT_CONFIG: Partial<Record<SupportedCodeLanguage, NestedEmitConfig>> = {
  typescript: {
    parentTypes: new Set(['class_declaration', 'abstract_class_declaration', 'interface_declaration']),
    childTypes: new Set(['method_definition', 'method_signature', 'public_field_definition']),
  },
  tsx: {
    parentTypes: new Set(['class_declaration', 'interface_declaration']),
    childTypes: new Set(['method_definition', 'method_signature', 'public_field_definition']),
  },
  javascript: {
    parentTypes: new Set(['class_declaration']),
    childTypes: new Set(['method_definition', 'field_definition']),
  },
  python: {
    parentTypes: new Set(['class_definition']),
    childTypes: new Set(['function_definition']),
  },
  ruby: {
    parentTypes: new Set(['class', 'module']),
    childTypes: new Set(['method', 'singleton_method']),
  },
  rust: {
    parentTypes: new Set(['impl_item', 'trait_item']),
    childTypes: new Set(['function_item']),
  },
  java: {
    parentTypes: new Set(['class_declaration', 'interface_declaration', 'record_declaration']),
    childTypes: new Set(['method_declaration', 'constructor_declaration']),
  },
};

let initDone = false;
let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedCodeLanguage, any>();

// ---------- Public API ----------

/**
 * v0.20.0 Cathedral II Layer 1a hook: Magika-style content-based detection
 * for extension-less files (Dockerfile, Makefile, .envrc, shell scripts with
 * shebangs but no extension). Wired by Layer 9 (B2). When null, the
 * extension map result stands; when set, this is called for filenames that
 * have no recognized extension and `content` was passed.
 *
 * Left as a module-level hook rather than a dependency injection argument
 * so the chunker doesn't need a plumbing refactor for B2. Layer 9 sets it
 * via `setLanguageFallback(fn)` at bootstrap; default is null (→ recursive
 * chunker fallback, today's behavior for extension-less files).
 */
export type LanguageFallback = (filePath: string, content: string) => SupportedCodeLanguage | null;
let languageFallback: LanguageFallback | null = null;

/** Register a content-based language fallback (Layer 9 Magika). */
export function setLanguageFallback(fn: LanguageFallback | null): void {
  languageFallback = fn;
}

export function detectCodeLanguage(filePath: string, content?: string): SupportedCodeLanguage | null {
  const lower = filePath.toLowerCase();
  // TSX + JSX take precedence over their base language.
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rb')) return 'ruby';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.cs')) return 'c_sharp';
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx') || lower.endsWith('.hpp') || lower.endsWith('.hxx') || lower.endsWith('.hh')) return 'cpp';
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  if (lower.endsWith('.php')) return 'php';
  if (lower.endsWith('.swift')) return 'swift';
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) return 'kotlin';
  if (lower.endsWith('.scala') || lower.endsWith('.sc')) return 'scala';
  if (lower.endsWith('.lua')) return 'lua';
  if (lower.endsWith('.ex') || lower.endsWith('.exs')) return 'elixir';
  if (lower.endsWith('.elm')) return 'elm';
  if (lower.endsWith('.ml') || lower.endsWith('.mli')) return 'ocaml';
  if (lower.endsWith('.dart')) return 'dart';
  if (lower.endsWith('.zig')) return 'zig';
  if (lower.endsWith('.sol')) return 'solidity';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'bash';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.vue')) return 'vue';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.toml')) return 'toml';
  // v0.20.0 Cathedral II Layer 1a fallback hook. Layer 9 (B2 Magika) wires
  // this in to detect extensionless files (Dockerfile, Makefile, shell
  // shebangs). try/catch because the fallback may itself fail on first-run
  // model-load — we never want chunker init to throw; recursive chunker
  // is always an acceptable default.
  if (languageFallback && content !== undefined) {
    try {
      return languageFallback(filePath, content);
    } catch {
      return null;
    }
  }
  return null;
}

export async function chunkCodeText(
  source: string,
  filePath: string,
  opts: CodeChunkOptions = {},
): Promise<CodeChunk[]> {
  const result = await chunkCodeTextFull(source, filePath, opts);
  return result.chunks;
}

/**
 * v0.20.0 Cathedral II Layer 5 (A1): chunker + edge-extractor joint API.
 * Returns chunks + per-file call-site edges. importCodeFile uses this
 * shape so we don't re-parse the tree twice. Existing callers keep using
 * chunkCodeText (backward-compatible wrapper above).
 */
export interface ChunkAndEdgeResult {
  chunks: CodeChunk[];
  /** Raw call edges — byte-offset resolution + chunk mapping happens in import-file.ts. */
  edges: import('./edge-extractor.ts').ExtractedEdge[];
}

export async function chunkCodeTextFull(
  source: string,
  filePath: string,
  opts: CodeChunkOptions = {},
): Promise<ChunkAndEdgeResult> {
  const language = detectCodeLanguage(filePath);
  if (!language) {
    return { chunks: fallbackChunks(source, filePath, 'javascript', opts), edges: [] };
  }

  if (!source.trim()) return { chunks: [], edges: [] };

  const largeThreshold = opts.largeChunkThresholdTokens ?? 1000;
  const chunkTarget = opts.chunkSizeTokens ?? 300;

  try {
    await ensureInit();
    const P = await getParser();
    const parser = new (P as any)();
    const grammar = await loadLanguage(language);
    parser.setLanguage(grammar);

    const tree = parser.parse(source);
    if (!tree) {
      parser.delete();
      return { chunks: fallbackChunks(source, filePath, language, opts), edges: [] };
    }

    const root = tree.rootNode;
    const topLevelTypes = TOP_LEVEL_TYPES[language];
    const semanticNodes = topLevelTypes
      ? root.namedChildren.filter((n: any) => topLevelTypes.has(n.type))
      : [];

    if (semanticNodes.length === 0) {
      tree.delete();
      parser.delete();
      return { chunks: fallbackChunks(source, filePath, language, opts), edges: [] };
    }

    const chunks: CodeChunk[] = [];
    const nestedConfig = NESTED_EMIT_CONFIG[language];

    for (const node of semanticNodes) {
      const nodeText = source.slice(node.startIndex, node.endIndex).trim();
      if (!nodeText) continue;

      // v0.20.0 Cathedral II Layer 6 (A3): for class/module/impl nodes,
      // emit the parent AND each child method as its own chunk with
      // parentSymbolPath populated. Retrieval then surfaces individual
      // methods when a query targets one, instead of returning the whole
      // class body. The parent chunk still ships so class-level docs /
      // scope overview stay queryable.
      //
      // For Ruby (`module Admin { class UsersController { ... } }`) and
      // Java (nested classes) the expansion is recursive: a nested class
      // inside a module itself emits its methods with the full parent
      // path [Admin, UsersController].
      //
      // TS/JS `export class Foo {...}` wraps the class in an
      // `export_statement`. Unwrap one level to find the nestable
      // declaration; top-level chunk still uses the outer node's range
      // so the header shows the `export` keyword for completeness.
      const nestableNode = findNestableParent(node, nestedConfig);
      const symbolName = extractSymbolName(nestableNode ?? node);
      const symbolType = normalizeSymbolType((nestableNode ?? node).type);

      if (nestableNode && symbolName && nestedConfig) {
        const before = chunks.length;
        emitNestedScoped(nestableNode, [], source, filePath, language, nestedConfig, chunks);
        if (chunks.length > before) continue;
      }

      if (estimateTokens(nodeText) <= largeThreshold) {
        chunks.push(buildChunk({
          body: nodeText, filePath, language, symbolName, symbolType,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          index: chunks.length,
          parentSymbolPath: [],
        }));
        continue;
      }

      // Split very large nodes at nested block boundaries
      const subRanges = splitLargeNode(node, source, chunkTarget);
      if (subRanges.length === 0) {
        chunks.push(buildChunk({
          body: nodeText, filePath, language, symbolName, symbolType,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          index: chunks.length,
          parentSymbolPath: [],
        }));
        continue;
      }

      for (const range of subRanges) {
        const body = source.slice(range.startIndex, range.endIndex).trim();
        if (!body) continue;
        chunks.push(buildChunk({
          body, filePath, language, symbolName, symbolType,
          startLine: range.startLine, endLine: range.endLine,
          index: chunks.length,
          parentSymbolPath: [],
        }));
      }
    }

    // v0.20.0 Cathedral II Layer 5 (A1): harvest call-graph edges from the
    // tree before we delete it. The extractor is iterative (no recursion);
    // cost is ~O(n) on node count so adding this pass does not regress
    // chunker throughput measurably.
    let rawEdges: import('./edge-extractor.ts').ExtractedEdge[] = [];
    try {
      const { extractCallEdges } = await import('./edge-extractor.ts');
      rawEdges = extractCallEdges(tree, language);
    } catch {
      // Edge extraction is best-effort — failure here must not break
      // chunking. Syntactically invalid code or a grammar quirk should
      // still get chunks.
      rawEdges = [];
    }

    tree.delete();
    parser.delete();

    if (chunks.length === 0) {
      return { chunks: fallbackChunks(source, filePath, language, opts), edges: rawEdges };
    }
    return { chunks: mergeSmallSiblings(chunks, chunkTarget), edges: rawEdges };
  } catch {
    return { chunks: fallbackChunks(source, filePath, language, opts), edges: [] };
  }
}

/**
 * Post-pass that merges adjacent small chunks into larger chunks up to
 * `chunkTarget` tokens. Mirrors Chonkie's bisect_left approach: scan
 * chunks left-to-right, extend the current merge group with the next
 * chunk if doing so stays under the budget, otherwise close the group.
 *
 * Why: tree-sitter emits one chunk per top-level node. For languages
 * with many tiny declarations (Go imports, Python from-imports, JS
 * top-level consts), each chunk ends up 5-20 tokens and the embedding
 * cost dominates without any retrieval quality benefit. Merging lets
 * the chunker respect the user's chunkSizeTokens budget instead of
 * letting the file's AST dictate it.
 *
 * Merged chunks lose their individual symbolName (set to null) and
 * get symbolType='merged'. The header shows the line range of the
 * merged group. Single-chunk groups pass through unchanged.
 */
function mergeSmallSiblings(chunks: CodeChunk[], chunkTarget: number): CodeChunk[] {
  if (chunks.length <= 1) return chunks;
  // 15% of chunk target is "tiny". The intent is to catch runs of single-
  // line declarations (imports, const exports, typedefs) without collapsing
  // substantive classes/functions. A 3-method class body is typically
  // 80-200 tokens, well above 15% of 300 = 45 tokens → stays independent.
  const mergeThreshold = Math.floor(chunkTarget * 0.15);
  // v0.20.0 Cathedral II Layer 6 (A3): never merge chunks that carry
  // parent-scope metadata. They were emitted for a reason — retrieval
  // wants to surface them individually, not roll them up into a single
  // anonymous "merged" chunk. Skip applies both to the parent scope
  // header (empty parent path, but holds the class declaration) and to
  // nested leaves (non-empty parent path).
  const hasScopedChunks = chunks.some(c => (c.metadata.parentSymbolPath ?? []).length > 0);
  const merged: CodeChunk[] = [];
  let i = 0;
  while (i < chunks.length) {
    const current = chunks[i]!;
    const currentTokens = estimateTokens(current.text);
    const currentIsScoped = (current.metadata.parentSymbolPath ?? []).length > 0;
    // If ANY chunk in this file participates in parent-scope emission, the
    // scope chunks + their siblings all pass through verbatim. A Python
    // class body's 3 × 10-token methods are each their own chunk on
    // purpose — merging would erase the (in ClassName) scope header
    // Layer 6 just added.
    if (currentTokens >= mergeThreshold || hasScopedChunks || currentIsScoped) {
      merged.push({ ...current, index: merged.length });
      i++;
      continue;
    }
    // Accumulate adjacent small chunks
    const group: CodeChunk[] = [current];
    let groupTokens = currentTokens;
    let j = i + 1;
    while (j < chunks.length) {
      const next = chunks[j]!;
      const nextTokens = estimateTokens(next.text);
      if (groupTokens + nextTokens > chunkTarget) break;
      group.push(next);
      groupTokens += nextTokens;
      j++;
    }
    if (group.length === 1) {
      merged.push({ ...current, index: merged.length });
    } else {
      merged.push(buildMergedChunk(group, merged.length));
    }
    i = j;
  }
  return merged;
}

function buildMergedChunk(group: CodeChunk[], index: number): CodeChunk {
  const first = group[0]!;
  const last = group[group.length - 1]!;
  // Strip each chunk's structured header line when merging so the combined
  // body reads like the original source. Header is always "[Lang] path:N-M symbol".
  const bodies = group.map((c) => c.text.replace(/^\[[^\]]+\] [^\n]+\n\n/, ''));
  const mergedBody = bodies.join('\n\n');
  const header = `[${displayLang(first.metadata.language)}] ${first.metadata.filePath}:${first.metadata.startLine}-${last.metadata.endLine} merged (${group.length} siblings)`;
  return {
    index,
    text: `${header}\n\n${mergedBody}`,
    metadata: {
      symbolName: null,
      symbolType: 'merged',
      filePath: first.metadata.filePath,
      language: first.metadata.language,
      startLine: first.metadata.startLine,
      endLine: last.metadata.endLine,
      parentSymbolPath: [],
    },
  };
}

// ---------- Internals ----------

function fallbackChunks(
  source: string,
  filePath: string,
  language: SupportedCodeLanguage,
  opts: CodeChunkOptions,
): CodeChunk[] {
  const size = opts.fallbackChunkSizeWords ?? 300;
  const overlap = opts.fallbackOverlapWords ?? 50;
  return recursiveChunk(source, { chunkSize: size, chunkOverlap: overlap }).map((chunk, index) =>
    buildChunk({
      body: chunk.text, filePath, language,
      symbolName: null, symbolType: 'module',
      startLine: 1, endLine: countLines(chunk.text),
      index,
    }),
  );
}

function buildChunk(input: {
  body: string;
  filePath: string;
  language: SupportedCodeLanguage;
  symbolName: string | null;
  symbolType: string;
  startLine: number;
  endLine: number;
  index: number;
  /** v0.20.0 Cathedral II Layer 6: non-empty when nested inside a parent. */
  parentSymbolPath?: string[];
}): CodeChunk {
  const symbol = input.symbolName ? `${input.symbolType} ${input.symbolName}` : input.symbolType;
  const parentPath = input.parentSymbolPath && input.parentSymbolPath.length > 0
    ? ` (in ${input.parentSymbolPath.join('.')})`
    : '';
  const header = `[${displayLang(input.language)}] ${input.filePath}:${input.startLine}-${input.endLine} ${symbol}${parentPath}`;
  // v0.20.0 Cathedral II Layer 5 (A1): fold the qualified name into
  // metadata so edge extraction has a stable identity key.
  const qualified = buildQualifiedName({
    language: input.language,
    symbolName: input.symbolName,
    symbolType: input.symbolType,
    parentSymbolPath: input.parentSymbolPath ?? [],
  });
  return {
    index: input.index,
    text: `${header}\n\n${input.body}`,
    metadata: {
      symbolName: input.symbolName,
      symbolType: input.symbolType,
      filePath: input.filePath,
      language: input.language,
      startLine: input.startLine,
      endLine: input.endLine,
      parentSymbolPath: input.parentSymbolPath ?? [],
      symbolNameQualified: qualified,
    },
  };
}

/**
 * v0.20.0 Cathedral II Layer 6 (A3) helper: find the nestable-parent
 * node to expand. Returns `node` itself when it matches config.parentTypes,
 * or its first descendant that does — unwraps TS/JS `export_statement`,
 * `export_default_declaration`, etc. Returns null when nothing nestable
 * found.
 */
function findNestableParent(node: any, config: NestedEmitConfig | undefined): any | null {
  if (!config) return null;
  if (config.parentTypes.has(node.type)) return node;
  // One-level unwrap — TS export_statement wraps a class_declaration.
  // We don't go deeper because that would accidentally treat a method
  // inside a class as a top-level parent.
  for (const child of node.namedChildren) {
    if (config.parentTypes.has(child.type)) return child;
  }
  return null;
}

/**
 * v0.20.0 Cathedral II Layer 6 (A3) helper: collect immediate nested
 * children matching the language's nested-emit config. Descends only
 * through body-style wrappers (class_body, module_body, etc.) which are
 * grammar-level container nodes, not symbols themselves.
 */
function collectImmediateNestedChildren(node: any, config: NestedEmitConfig): {
  parents: any[]; // children that are themselves parentTypes (recurse)
  leaves: any[];  // children that are childTypes (methods)
} {
  const parents: any[] = [];
  const leaves: any[] = [];
  const scan = (n: any) => {
    for (const child of n.namedChildren) {
      if (config.parentTypes.has(child.type)) parents.push(child);
      else if (config.childTypes.has(child.type)) leaves.push(child);
      if (BODY_NODE_TYPES.has(child.type) || child.type.endsWith('_body')) {
        scan(child);
      }
    }
  };
  scan(node);
  return { parents, leaves };
}

/**
 * v0.20.0 Cathedral II Layer 6 (A3): recursively emit a nested parent
 * node and its children. Walks the parent chain, pushing chunks onto
 * `chunks` as it goes. Call with parentPath=[] at the top level.
 *
 * Each parent gets a slim "scope header" chunk (declaration line +
 * member list). Each leaf (method) gets its own chunk with the full
 * parentPath populated. Nested parents recurse with the parent chain
 * extended by the enclosing parent's name.
 */
function emitNestedScoped(
  node: any,
  parentPath: string[],
  source: string,
  filePath: string,
  language: SupportedCodeLanguage,
  config: NestedEmitConfig,
  chunks: CodeChunk[],
): void {
  const name = extractSymbolName(node);
  if (!name) return;
  const symbolType = normalizeSymbolType(node.type);
  const { parents, leaves } = collectImmediateNestedChildren(node, config);

  // Parent scope-header chunk: declaration + member digest.
  const digestNames = [
    ...parents.map(p => extractSymbolName(p)).filter((n): n is string => Boolean(n)),
    ...leaves.map(l => extractSymbolName(l)).filter((n): n is string => Boolean(n)),
  ];
  chunks.push(buildChunk({
    body: buildScopeHeaderBody(node, source, digestNames),
    filePath, language, symbolName: name, symbolType,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    index: chunks.length,
    parentSymbolPath: [...parentPath],
  }));

  const newParentPath = [...parentPath, name];

  // Recursively expand nested parents (e.g. module Admin → class Users).
  for (const p of parents) {
    emitNestedScoped(p, newParentPath, source, filePath, language, config, chunks);
  }

  // Leaf children: methods / functions / fields.
  for (const leaf of leaves) {
    const leafName = extractSymbolName(leaf);
    const leafType = normalizeSymbolType(leaf.type);
    const leafText = source.slice(leaf.startIndex, leaf.endIndex).trim();
    if (!leafText) continue;
    chunks.push(buildChunk({
      body: leafText, filePath, language,
      symbolName: leafName, symbolType: leafType,
      startLine: leaf.startPosition.row + 1,
      endLine: leaf.endPosition.row + 1,
      index: chunks.length,
      parentSymbolPath: newParentPath,
    }));
  }
}

/**
 * Build a slim scope-header body for a parent chunk. The full method
 * bodies land in their own nested chunks, so the parent just needs the
 * declaration line + a digest of member names so class-level queries
 * still hit something.
 */
function buildScopeHeaderBody(node: any, source: string, memberNames: string[]): string {
  const full = source.slice(node.startIndex, node.endIndex);
  const firstLineBreak = full.indexOf('\n');
  const declaration = firstLineBreak > 0 ? full.slice(0, firstLineBreak) : full.slice(0, 120);
  if (memberNames.length === 0) return declaration;
  return `${declaration}\n\n// Members: ${memberNames.slice(0, 20).join(', ')}`;
}

interface SplitRange {
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

function splitLargeNode(node: any, source: string, chunkTarget: number): SplitRange[] {
  const body =
    node.childForFieldName('body') ||
    node.namedChildren.find((c: any) => BODY_NODE_TYPES.has(c.type)) ||
    null;

  if (!body || body.namedChildren.length < 2) return [];

  const children = body.namedChildren.filter((c: any) => !c.isExtra);
  if (children.length < 2) return [];

  const ranges: SplitRange[] = [];
  let curStart = children[0].startIndex;
  let curStartLine = children[0].startPosition.row + 1;
  let curEnd = children[0].endIndex;
  let curEndLine = children[0].endPosition.row + 1;
  let curTokens = estimateTokens(source.slice(curStart, curEnd));

  for (let i = 1; i < children.length; i++) {
    const child = children[i];
    const childTokens = estimateTokens(source.slice(child.startIndex, child.endIndex));

    if (curTokens + childTokens > Math.ceil(chunkTarget * 1.5)) {
      ranges.push({ startIndex: curStart, endIndex: curEnd, startLine: curStartLine, endLine: curEndLine });
      curStart = child.startIndex;
      curStartLine = child.startPosition.row + 1;
      curEnd = child.endIndex;
      curEndLine = child.endPosition.row + 1;
      curTokens = childTokens;
    } else {
      curEnd = child.endIndex;
      curEndLine = child.endPosition.row + 1;
      curTokens += childTokens;
    }
  }
  ranges.push({ startIndex: curStart, endIndex: curEnd, startLine: curStartLine, endLine: curEndLine });
  return ranges;
}

function extractSymbolName(node: any): string | null {
  const directName = node.childForFieldName('name');
  if (directName?.text?.trim()) return sanitize(directName.text);

  const declaration = node.childForFieldName('declaration');
  if (declaration) {
    const nested = extractSymbolName(declaration);
    if (nested) return nested;
  }

  for (const child of node.namedChildren) {
    if (child.type.endsWith('identifier') || child.type === 'constant') {
      const v = sanitize(child.text);
      if (v) return v;
    }
  }
  return null;
}

function normalizeSymbolType(type: string): string {
  if (type.includes('function') || type === 'method' || type === 'singleton_method') return 'function';
  if (type.includes('class')) return 'class';
  if (type.includes('interface')) return 'interface';
  if (type.includes('type_alias')) return 'type';
  if (type.includes('enum')) return 'enum';
  if (type.includes('module')) return 'module';
  if (type.includes('import')) return 'import';
  return type.replace(/_/g, ' ');
}

function sanitize(name: string): string {
  return name.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// v0.19.0 (Layer 5): accurate token count via @dqbd/tiktoken cl100k_base,
// the same encoder text-embedding-3-large uses. The old len/4 heuristic was
// 2-3x off for code. Lazy-init so dev and compiled-binary both only pay
// the init cost once. Falls back to the heuristic if the encoder fails
// to load (vanishingly unlikely but keeps the chunker available).
let tiktokenEncoder: { encode: (s: string) => Uint32Array; free: () => void } | null = null;
let tiktokenInitialized = false;

// v0.20.0 Cathedral II Layer 8 (D1) — exported so commands/sync.ts can
// estimate embed cost before a --all sync blows a surprise OpenAI bill.
// Same cl100k_base tokenizer the embedding path actually uses, so cost
// estimates match actual billing within tokenizer noise.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  if (!tiktokenInitialized) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require('@dqbd/tiktoken');
      tiktokenEncoder = m.get_encoding('cl100k_base');
    } catch {
      tiktokenEncoder = null;
    }
    tiktokenInitialized = true;
  }
  if (tiktokenEncoder) {
    return tiktokenEncoder.encode(text).length;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

// v0.20.0 Cathedral II Layer 4: display name derived from the language
// manifest. Single source of truth — adding a new language via
// registerLanguage() automatically exposes its displayName to chunk
// headers without a parallel DISPLAY_LANG edit.
function displayLang(lang: SupportedCodeLanguage): string {
  const entry = getLanguageEntry(lang);
  return entry?.displayName ?? lang;
}

function countLines(text: string): number {
  return text ? text.split('\n').length : 0;
}

// ---------- Tree-sitter init ----------

async function ensureInit(): Promise<void> {
  if (initDone) return;
  if (!initPromise) {
    initPromise = (async () => {
      const P = await getParser();
      // v0.22.x: init takes locateFile for the WASM module.
      // TREE_SITTER_WASM is a path resolved by Bun's embedded-file loader — it
      // points at the real file in dev, and the bundler-synthesized path in
      // the compiled binary. Either way tree-sitter can read it.
      await (P as any).init({ locateFile: () => TREE_SITTER_WASM });
      initDone = true;
    })();
  }
  await initPromise;
}

async function loadLanguage(language: SupportedCodeLanguage): Promise<any> {
  if (languageCache.has(language)) return languageCache.get(language);
  const entry = getLanguageEntry(language);
  if (!entry) {
    throw new Error(`No grammar entry for language: ${language}`);
  }
  const P = await getParser();
  // Resolve grammar source: embedded path wins if set (zero-cost path for
  // the 29 core grammars that ship in every bun --compile binary). Lazy
  // loader fallback for registered-at-runtime languages (tree-sitter-wasms
  // npm resolution, user extensions via registerLanguage).
  let grammarSource: string | Uint8Array;
  if (entry.embeddedPath) {
    grammarSource = entry.embeddedPath;
  } else if (entry.lazyLoader) {
    grammarSource = await entry.lazyLoader();
  } else {
    throw new Error(`Language entry for ${language} has neither embeddedPath nor lazyLoader`);
  }
  const lang = await (P as any).Language.load(grammarSource);
  languageCache.set(language, lang);
  return lang;
}
