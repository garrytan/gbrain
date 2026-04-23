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
 */

import { chunkText as recursiveChunk } from './recursive.ts';

// Lazy-loaded tree-sitter module (v0.22.x API: Parser is default export)
let Parser: typeof import('web-tree-sitter') | null = null;

async function getParser(): Promise<typeof import('web-tree-sitter')> {
  if (!Parser) {
    Parser = (await import('web-tree-sitter')).default || await import('web-tree-sitter');
  }
  return Parser;
}

export type SupportedCodeLanguage = 'typescript' | 'tsx' | 'javascript' | 'python' | 'ruby' | 'go';

export interface CodeChunkMetadata {
  symbolName: string | null;
  symbolType: string;
  filePath: string;
  language: SupportedCodeLanguage;
  startLine: number;
  endLine: number;
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

const GRAMMAR_FILES: Record<SupportedCodeLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  go: 'tree-sitter-go.wasm',
};

const TOP_LEVEL_TYPES: Record<SupportedCodeLanguage, Set<string>> = {
  typescript: new Set([
    'function_declaration',
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'lexical_declaration',
    'variable_declaration',
    'export_statement',
  ]),
  tsx: new Set([
    'function_declaration',
    'class_declaration',
    'interface_declaration',
    'type_alias_declaration',
    'enum_declaration',
    'lexical_declaration',
    'variable_declaration',
    'export_statement',
  ]),
  javascript: new Set([
    'function_declaration',
    'class_declaration',
    'lexical_declaration',
    'variable_declaration',
    'export_statement',
  ]),
  python: new Set([
    'function_definition',
    'class_definition',
    'import_statement',
    'import_from_statement',
    'assignment',
  ]),
  ruby: new Set([
    'class',
    'module',
    'method',
    'singleton_method',
    'assignment',
  ]),
  go: new Set([
    'function_declaration',
    'method_declaration',
    'type_declaration',
    'const_declaration',
    'var_declaration',
    'import_declaration',
  ]),
};

const BODY_NODE_TYPES = new Set([
  'statement_block',
  'block',
  'class_body',
  'module_body',
  'body_statement',
  'body',
]);

let initDone = false;
let initPromise: Promise<void> | null = null;
const languageCache = new Map<SupportedCodeLanguage, any>();

// ---------- Public API ----------

export function detectCodeLanguage(filePath: string): SupportedCodeLanguage | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rb')) return 'ruby';
  if (lower.endsWith('.go')) return 'go';
  return null;
}

export async function chunkCodeText(
  source: string,
  filePath: string,
  opts: CodeChunkOptions = {},
): Promise<CodeChunk[]> {
  const language = detectCodeLanguage(filePath);
  if (!language) {
    return fallbackChunks(source, filePath, 'javascript', opts);
  }

  if (!source.trim()) return [];

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
      return fallbackChunks(source, filePath, language, opts);
    }

    const root = tree.rootNode;
    const topLevelTypes = TOP_LEVEL_TYPES[language];
    const semanticNodes = root.namedChildren.filter((n: any) => topLevelTypes.has(n.type));

    if (semanticNodes.length === 0) {
      tree.delete();
      parser.delete();
      return fallbackChunks(source, filePath, language, opts);
    }

    const chunks: CodeChunk[] = [];
    for (const node of semanticNodes) {
      const symbolName = extractSymbolName(node);
      const symbolType = normalizeSymbolType(node.type);
      const nodeText = source.slice(node.startIndex, node.endIndex).trim();
      if (!nodeText) continue;

      if (estimateTokens(nodeText) <= largeThreshold) {
        chunks.push(buildChunk({
          body: nodeText, filePath, language, symbolName, symbolType,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          index: chunks.length,
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
        }));
      }
    }

    tree.delete();
    parser.delete();

    return chunks.length > 0 ? chunks : fallbackChunks(source, filePath, language, opts);
  } catch {
    return fallbackChunks(source, filePath, language, opts);
  }
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
}): CodeChunk {
  const symbol = input.symbolName ? `${input.symbolType} ${input.symbolName}` : input.symbolType;
  const header = `[${displayLang(input.language)}] ${input.filePath}:${input.startLine}-${input.endLine} ${symbol}`;
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
    },
  };
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

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function displayLang(lang: SupportedCodeLanguage): string {
  const map: Record<SupportedCodeLanguage, string> = {
    typescript: 'TypeScript', tsx: 'TSX', javascript: 'JavaScript',
    python: 'Python', ruby: 'Ruby', go: 'Go',
  };
  return map[lang];
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
      // v0.22.x: init takes locateFile for the WASM module
      const wasmPath = new URL('../../../node_modules/web-tree-sitter/tree-sitter.wasm', import.meta.url);
      let resolved: string;
      try {
        const { fileURLToPath } = await import('url');
        resolved = fileURLToPath(wasmPath);
      } catch {
        resolved = wasmPath.pathname;
      }
      await (P as any).init({ locateFile: () => resolved });
      initDone = true;
    })();
  }
  await initPromise;
}

async function loadLanguage(language: SupportedCodeLanguage): Promise<any> {
  if (languageCache.has(language)) return languageCache.get(language);

  const P = await getParser();
  const grammarUrl = new URL(
    `../../../node_modules/tree-sitter-wasms/out/${GRAMMAR_FILES[language]}`,
    import.meta.url,
  );
  let resolved: string;
  try {
    const { fileURLToPath } = await import('url');
    resolved = fileURLToPath(grammarUrl);
  } catch {
    resolved = grammarUrl.pathname;
  }
  const lang = await (P as any).Language.load(resolved);
  languageCache.set(language, lang);
  return lang;
}
