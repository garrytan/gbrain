/**
 * Code edge extraction must emit the same edges while resolving member-call
 * receivers through a per-file top-level binding index, and edge-to-chunk
 * attribution must locate offsets without rescanning the file per edge.
 *
 * 1. Protects: receiver-qualified call edges (`pkg::m`, `C::m`) and their
 *    chunk attribution, and linear extraction on large code files (>200 s
 *    at 10 MB before the fix).
 * 2. Fails when: the index finds a different first binding than a full scan
 *    (differential vs the old resolver), the locator picks a different chunk
 *    than the old per-offset scan, or per-call rescans come back (the
 *    operation-count probes).
 * 3. Existing coverage: test/code-intel/scope-walker-resolution.test.ts pins
 *    the three patterns on small fixtures, not a fuzz corpus against the old
 *    resolver nor the cost shape.
 * 4. Seam: resolveReceiverType and FileBindings are exported (@internal) so
 *    the oracle compares the resolver itself on every call node.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import {
  chunkLocator,
  extractCallEdges,
  FileBindings,
  findChunkForOffset,
  resolveReceiverType,
  WALK_DEPTH_CAP,
} from '../../src/core/chunkers/edge-extractor.ts';
import type { SupportedCodeLanguage } from '../../src/core/chunkers/code.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';

let Parser: any;
const LANGS: Record<string, any> = {};

beforeAll(async () => {
  const ts = await import('web-tree-sitter');
  Parser = (ts as any).Parser ?? (ts as any).default;
  await Parser.init();
  for (const lang of ['typescript', 'javascript', 'python']) {
    LANGS[lang] = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${lang}.wasm`));
  }
});

function parse(source: string, lang: string): any {
  const p = new Parser();
  p.setLanguage(LANGS[lang]);
  const tree = p.parse(source);
  p.delete();
  return tree;
}

// ---- Oracle: resolveReceiverType before the binding index. ----
function oracleResolve(callNode: any, language: SupportedCodeLanguage, bareCallee: string): string | null {
  const callee = callNode.childForFieldName('function');
  if (!callee) return null;
  const isMemberExpr =
    callee.type === 'member_expression' || callee.type === 'field_expression' || callee.type === 'attribute';
  if (!isMemberExpr) return null;
  const receiver = callee.childForFieldName('object') ?? callee.childForFieldName('left');
  if (!receiver) return null;
  const recvText = (receiver.text ?? '') as string;
  const isThisOrSelf = recvText === 'this' || (language === 'python' && recvText === 'self');
  if (isThisOrSelf) {
    let node = callNode.parent;
    for (let i = 0; i < WALK_DEPTH_CAP && node; i++) {
      const isClass = node.type === 'class_declaration' || node.type === 'class_definition' || node.type === 'class';
      if (isClass) {
        const name = node.childForFieldName('name') ?? node.childForFieldName('class_name');
        const className = name?.text;
        if (className) return `${className}::${bareCallee}`;
      }
      node = node.parent;
    }
    return null;
  }
  if (receiver.type !== 'identifier' && receiver.type !== 'name') return null;
  const receiverName = recvText;
  if (!receiverName) return null;
  let root = callNode.parent;
  for (let i = 0; i < WALK_DEPTH_CAP && root && root.parent; i++) root = root.parent;
  if (!root) return null;
  for (const stmt of root.namedChildren ?? []) {
    if ((language === 'typescript' || language === 'tsx' || language === 'javascript') && stmt.type === 'import_statement') {
      const sourceNode = stmt.childForFieldName('source');
      const source = (sourceNode?.text ?? '').replace(/^['"]|['"]$/g, '');
      if (!source) continue;
      const importText = (stmt.text ?? '') as string;
      if (!new RegExp(`\\b${receiverName}\\b`).test(importText)) continue;
      return `${source}::${bareCallee}`;
    }
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
        const importText = (stmt.text ?? '') as string;
        if (!new RegExp(`\\b${receiverName}\\b`).test(importText)) continue;
        return `${receiverName}::${bareCallee}`;
      }
    }
    if (stmt.type === 'lexical_declaration' || stmt.type === 'variable_declaration' || stmt.type === 'assignment') {
      const stmtText = (stmt.text ?? '') as string;
      if (!new RegExp(`\\b${receiverName}\\b`).test(stmtText)) continue;
      const newMatch = stmtText.match(/=\s*new\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (newMatch) return `${newMatch[1]}::${bareCallee}`;
      if (language === 'python') {
        const pyMatch = stmtText.match(new RegExp(`${receiverName}\\s*=\\s*([A-Z][A-Za-z0-9_]*)\\s*\\(`));
        if (pyMatch) return `${pyMatch[1]}::${bareCallee}`;
      }
    }
  }
  return null;
}

// ---- Oracle: findChunkForOffset before the locator. ----
function oracleFindChunk(byteOffset: number, source: string, chunks: Array<{ startLine: number; endLine: number }>): number | null {
  let line = 1;
  for (let i = 0; i < byteOffset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
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

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

// Receiver names overlap module names, class names and each other's
// prefixes; `$svc` and `données` exercise the non-\w fallback scan.
const JS_NAMES = ['svc', 'svcs', 'db', 'Db', 'client', 'acme', 'x', '$svc', 'api_v2'];
const PY_NAMES = ['svc', 'db', 'client', 'acme', 'os', 'x', 'données', 'api_v2'];

function deepJs(depth: number, inner: string): string {
  return depth === 0 ? inner : `(() => { ${deepJs(depth - 1, inner)} })();`;
}

function randomJs(rand: () => number): string {
  const lines: string[] = [];
  const n = 2 + Math.floor(rand() * 10);
  for (let i = 0; i < n; i++) {
    const a = pick(rand, JS_NAMES);
    const b = pick(rand, JS_NAMES);
    switch (Math.floor(rand() * 11)) {
      case 0: lines.push(`import { ${a}, ${b} as other } from 'pkg-${b}';`); break;
      case 1: lines.push(`import ${a} from "acme-example/${b}";`); break;
      case 2: lines.push(`import * as ${a} from './${b}';`); break;
      case 3: lines.push(`const ${a} = new Client${i}();`); break;
      case 4: lines.push(`let ${a} = makeClient('${b}');`); break;
      case 5: lines.push(`var ${a} = new ${b.replace('$', '')}Thing(), ${b} = 1;`); break;
      case 6: lines.push(`function f${i}() { ${a}.run(); ${b}.stop(1); this.go(); }`); break;
      case 7: lines.push(`class K${i} { m() { this.m(); ${a}.ping(); } }`); break;
      case 8: lines.push(`${a}.top(${b}.inner());`); break;
      case 9: lines.push(deepJs(WALK_DEPTH_CAP + Math.floor(rand() * 4) - 2, `${a}.deep();`)); break;
      default: lines.push(`const ${a}${i} = ${b}.make();`);
    }
  }
  return lines.join('\n');
}

function randomPy(rand: () => number): string {
  const lines: string[] = [];
  const n = 2 + Math.floor(rand() * 10);
  for (let i = 0; i < n; i++) {
    const a = pick(rand, PY_NAMES);
    const b = pick(rand, PY_NAMES);
    switch (Math.floor(rand() * 9)) {
      case 0: lines.push(`from pkg_${b} import ${a}, ${b} as other`); break;
      case 1: lines.push(`import ${a}`); break;
      case 2: lines.push(`import ${a}.${b}`); break;
      case 3: lines.push(`${a} = Client${i}()`); break;
      case 4: lines.push(`${a} = make_client("${b}")`); break;
      case 5: lines.push(`def f${i}():\n    ${a}.run()\n    ${b}.stop(1)`); break;
      case 6: lines.push(`class K${i}:\n    def m(self):\n        self.m()\n        ${a}.ping()`); break;
      case 7: lines.push(`${a}.top(${b}.inner())`); break;
      default: lines.push(`${a}${i} = ${b}.make()`);
    }
  }
  return lines.join('\n');
}

function callNodes(tree: any, type: string): any[] {
  const out: any[] = [];
  const stack: any[] = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === type) out.push(node);
    for (const child of node.namedChildren) stack.push(child);
  }
  return out;
}

describe('resolveReceiverType differential (old vs new)', () => {
  const cases: Array<[SupportedCodeLanguage, string, (r: () => number) => string]> = [
    ['typescript', 'typescript', randomJs],
    ['javascript', 'javascript', randomJs],
    ['python', 'python', randomPy],
  ];
  for (const [language, grammar, gen] of cases) {
    test(`identical resolution on every call node: ${language}`, () => {
      const rand = mulberry32(language.length * 7919);
      let resolved = 0;
      let calls = 0;
      for (let k = 0; k < 300; k++) {
        const tree = parse(gen(rand), grammar);
        const bindings = new FileBindings(tree.rootNode, language);
        for (const node of callNodes(tree, language === 'python' ? 'call' : 'call_expression')) {
          const expected = oracleResolve(node, language, 'm');
          expect(resolveReceiverType(node, language, 'm', bindings)).toBe(expected);
          calls++;
          if (expected !== null) resolved++;
        }
        tree.delete();
      }
      // The corpus must reach the resolving arms, not only misses.
      expect(resolved).toBeGreaterThan(calls / 20);
    });
  }
});

describe('chunk locator differential (old vs new)', () => {
  test('identical chunk index over random sources, ranges and offsets', () => {
    const rand = mulberry32(0x10ca7e);
    const bounds = [NaN, Infinity, -Infinity, 0.5, -3];
    for (let k = 0; k < 2_000; k++) {
      let source = '';
      const len = Math.floor(rand() * 200);
      for (let i = 0; i < len; i++) source += rand() < 0.15 ? '\n' : 'a';
      const lines = source.split('\n').length;
      const chunks = Array.from({ length: Math.floor(rand() * 8) }, () => {
        const start = rand() < 0.05 ? pick(rand, bounds) : 1 + Math.floor(rand() * (lines + 2));
        const end = rand() < 0.05 ? pick(rand, bounds) : start + Math.floor(rand() * 6) - 1;
        return { startLine: start, endLine: end };
      });
      const locate = chunkLocator(source, chunks);
      for (const offset of [-1, 0, NaN, len, len + 5, ...Array.from({ length: 10 }, () => Math.floor(rand() * (len + 1)))]) {
        const expected = oracleFindChunk(offset, source, chunks);
        expect(locate(offset)).toBe(expected);
        expect(findChunkForOffset(offset, source, chunks)).toBe(expected);
      }
    }
  });
});

/** Calls of a prototype getter on web-tree-sitter nodes while `fn` runs. */
function countGetter(proto: object, name: string, fn: () => void): number {
  const desc = Object.getOwnPropertyDescriptor(proto, name)!;
  let calls = 0;
  Object.defineProperty(proto, name, { ...desc, get(this: unknown) { calls++; return desc.get!.call(this); } });
  try {
    fn();
  } finally {
    Object.defineProperty(proto, name, desc);
  }
  return calls;
}

describe('edge extraction cost probes', () => {
  test('member calls read top-level statement text O(statements + calls) times', () => {
    // N top-level bindings and N member calls on distinct receivers. The old
    // resolver read every top-level statement's text for every member call.
    const N = 400;
    const lines: string[] = [];
    for (let i = 0; i < N; i++) lines.push(`const svc${i} = new Client${i}();`);
    lines.push('function run() {');
    for (let i = 0; i < N; i++) lines.push(`  svc${N - 1 - i}.ping();`);
    lines.push('}');
    const tree = parse(lines.join('\n'), 'typescript');
    const proto = Object.getPrototypeOf(tree.rootNode);
    let edges: ReturnType<typeof extractCallEdges> = [];
    const reads = countGetter(proto, 'text', () => { edges = extractCallEdges(tree, 'typescript'); });
    expect(edges.filter(e => /^Client\d+::ping$/.test(e.toSymbol)).length).toBe(N);
    expect(reads).toBeLessThanOrEqual(10 * (2 * N));
    tree.delete();
  });

  test('edge attribution examines O(file) characters, not O(edges x file)', () => {
    const source = 'x();\n'.repeat(20_000);
    const chunks = Array.from({ length: 200 }, (_, i) => ({ startLine: i * 100 + 1, endLine: i * 100 + 100 }));
    const offsets = Array.from({ length: 20_000 }, (_, i) => i * 5);
    const charCodeAt = String.prototype.charCodeAt;
    let examined = 0;
    String.prototype.charCodeAt = function (this: string, i: number): number { examined++; return charCodeAt.call(this, i); };
    try {
      const locate = chunkLocator(source, chunks);
      for (const o of offsets) locate(o);
    } finally {
      String.prototype.charCodeAt = charCodeAt;
    }
    // The old per-offset scan made ~offsets x file / 2 = 1e9 charCodeAt calls.
    expect(examined).toBeLessThanOrEqual(source.length);
  });
});
