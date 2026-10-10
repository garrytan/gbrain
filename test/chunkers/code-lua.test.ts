/**
 * The `gbrain serve` hang GBRA-49's LongMemEval scoreboard hit on 0.60.106.0 (PGLite, 99.5% CPU for 9.5 h after a
 * committed put_page, stdin never read again). The page held five ChatGPT-style ```lua fences around shell commands.
 * The vendored Lua grammar (the `tree-sitter-wasms` build of Azganoth/tree-sitter-lua 2.1.3) allocated its external
 * scanner state with `malloc` and reset it only when `deserialize` was handed two bytes, so every parse after the first
 * in a process started from recycled heap: `x = 1` misparsed as an error, and the fence texts spun until the chunker's
 * 30 s timeout, five times per preparation attempt, with the event loop blocked throughout. The grammar is now
 * tree-sitter-grammars/tree-sitter-lua v0.3.0 (ABI 14), whose scanner uses `calloc` and resets on every parse.
 *
 * Forced probes: against the previous grammar, the repeated parse comes back with an ERROR root, the fence set takes
 * longer than the short timeout this test pins, and no Lua definition ever becomes a semantic chunk.
 *
 * The grammar swap re-chunks Lua files only: `GRAMMAR_REVISIONS.lua` is folded into Lua code-file hashes and into the
 * `sources.chunker_version` stamp, CHUNKER_VERSION stays 8, and the sync cost gate prices a grammar-only drift by the
 * affected language's files instead of the whole tree.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Parser from 'web-tree-sitter';
import { CHUNKER_VERSION, chunkCodeText, chunkCodeTextFull, chunkerStamp, GRAMMAR_REVISIONS } from '../../src/core/chunkers/code.ts';
import { prepareMarkdownChunks } from '../../src/core/markdown-chunks.ts';
import { estimateInlineNewTokens, grammarOnlyDrift } from '../../src/core/sync-cost-gate.ts';
import { withEnv } from '../helpers/with-env.ts';

const assets = join(import.meta.dir, '../../src/assets/wasm');
const source = `-- header comment
local M = {}
local function helper(a, b)
  return a + b
end
function M.add(x, y)
  return helper(x, y)
end
function M:method()
  return self
end
local s = [==[
long string with ]] inside
]==]
--[[ long
comment ]]
return M
`;
/** The stuck page's fences in order: shell commands a chat model labelled as Lua. */
const fences = ['sudo aa-status', 'sudo snap debug sandbox-features discord', 'sudo snap debug sandbox-features discord.discord',
  'sudo aa-status | grep snap.discord.discord', 'sudo aa-status | grep snap.discord.discord'];
/** A short per-fence parse timeout keeps the failing run of these probes bounded (production: 30 s). */
const SHORT_TIMEOUT = { GBRAIN_CHUNKER_TIMEOUT_MS: '1500' };

describe('Lua grammar: sound across parses, no spin on mislabelled shell fences', () => {
  test('the vendored grammar is the ABI-14 release and has no unresolved normal-path libc imports', async () => {
    // test-reads-source-ok[structural]: the vendored grammar binary's imports and ABI are the shipped artifact under test, not source text.
    const runtime = await WebAssembly.compile(readFileSync(join(assets, 'tree-sitter.wasm')));
    const exports = new Set(WebAssembly.Module.exports(runtime).map(e => e.name));
    // test-reads-source-ok[structural]: same artifact check for the Lua grammar binary.
    const grammar = await WebAssembly.compile(readFileSync(join(assets, 'grammars/tree-sitter-lua.wasm')));
    const missing = WebAssembly.Module.imports(grammar).filter(i => i.module === 'env' && i.kind === 'function' && !exports.has(i.name) && !exports.has('_' + i.name));
    expect(missing.map(i => i.name)).toEqual([]);
    await Parser.init({ locateFile: () => join(assets, 'tree-sitter.wasm') });
    const language = await Parser.Language.load(join(assets, 'grammars/tree-sitter-lua.wasm'));
    expect(language.version).toBe(14);
  });

  test('forced probe: the same text parses the same way on every parser instance, not only the first in the process', async () => {
    await Parser.init({ locateFile: () => join(assets, 'tree-sitter.wasm') });
    const language = await Parser.Language.load(join(assets, 'grammars/tree-sitter-lua.wasm'));
    const trees: string[] = [];
    for (let i = 0; i < 4; i++) {
      const parser = new Parser();
      try {
        parser.setLanguage(language);
        const tree = parser.parse('x = 1');
        try { trees.push(tree.rootNode.toString()); expect(tree.rootNode.hasError).toBe(false); } finally { tree.delete(); }
      } finally { parser.delete(); }
    }
    expect(new Set(trees).size).toBe(1);
  });

  test('forced probe: the stuck page\'s five Lua fences chunk in well under one timeout each', () => withEnv(SHORT_TIMEOUT, async () => {
    const started = performance.now();
    for (const fence of fences) {
      const chunks = await chunkCodeText(fence, 'fence.lua');
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    }
    // Before the fix three of the five fences each ran to the 1.5 s timeout pinned here (30 s in production).
    expect(performance.now() - started).toBeLessThan(1_000);
  }));

  test('a conversation page with the mislabelled fences prepares in one short pass', () => withEnv(SHORT_TIMEOUT, async () => {
    const page = fences.map((fence, i) => `Step ${i + 1}:\n\`\`\`lua\n${fence}\n\`\`\``).join('\n');
    const started = performance.now();
    const chunks = await prepareMarkdownChunks({ compiled_truth: page });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(chunks.filter(c => c.chunk_source === 'fenced_code')).toHaveLength(fences.length);
  }));

  test('Lua definitions become semantic chunks (function, method and local function), repeatedly', async () => {
    for (let i = 0; i < 2; i++) {
      const { chunks } = await chunkCodeTextFull(source, 'module.lua');
      const names = chunks.map(c => c.metadata.symbolName);
      expect(names).toEqual(['helper', 'M.add', 'M:method']);
      expect(chunks.every(c => c.metadata.symbolType === 'function' && c.metadata.language === 'lua')).toBe(true);
      expect(chunks.find(c => c.metadata.symbolName === 'helper')?.text).toContain('return a + b');
    }
  });
});

describe('the grammar swap re-chunks Lua files only', () => {
  test('CHUNKER_VERSION is unchanged and the stamp carries the Lua grammar revision', () => {
    expect(CHUNKER_VERSION).toBe(8);
    expect(GRAMMAR_REVISIONS.lua).toBe(1);
    expect(chunkerStamp()).toBe('8;lua=1');
  });

  test('grammarOnlyDrift names the languages whose revision moved, and nothing on a version bump or a fresh source', () => {
    expect(grammarOnlyDrift('8', '8;lua=1')).toEqual(new Set(['lua']));
    expect(grammarOnlyDrift('8;lua=1', '8;lua=1')).toEqual(new Set());
    expect(grammarOnlyDrift('8;lua=1', '8;lua=2;zig=1')).toEqual(new Set(['lua', 'zig']));
    expect(grammarOnlyDrift('7', '8;lua=1')).toBeNull();
    expect(grammarOnlyDrift(null, '8;lua=1')).toBeNull();
  });

  test('the sync cost gate prices a grammar-only drift by the affected language\'s files, not the whole tree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-lua-drift-'));
    try {
      mkdirSync(join(repo, 'src'));
      writeFileSync(join(repo, 'src/big.ts'), `export const words = ${JSON.stringify('lorem ipsum '.repeat(2000))};\n`);
      writeFileSync(join(repo, 'src/init.lua'), source);
      const sources = [{ local_path: repo, config: { strategy: 'code' as const }, last_commit: null, chunker_version: '8' }];
      const grammar = estimateInlineNewTokens(sources, '8;lua=1');
      const version = estimateInlineNewTokens(sources, '9');
      expect(grammar.ceilingReasons).toEqual(['grammar_drift']);
      expect(version.ceilingReasons).toEqual(['chunker_drift']);
      expect(grammar.tokens).toBeGreaterThan(0);
      expect(grammar.tokens).toBeLessThan(version.tokens / 10);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
