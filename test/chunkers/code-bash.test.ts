import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Parser from 'web-tree-sitter';
import { CHUNKER_VERSION, chunkCodeText, chunkCodeTextFull } from '../../src/core/chunkers/code.ts';

const assets = join(import.meta.dir, '../../src/assets/wasm');
const source = `#!/usr/bin/env bash
dispatch() {
  case "$1" in
    start|stop) printf '%s\\n' "$1" ;;
    *) printf '%s\\n' 'unknown command' ;;
  esac
}

print_help() {
  cat <<'HELP'
Usage: example.sh start|stop
HELP
}

for action in start stop; do
  dispatch "$action"
done
`;

describe('Bash case statements retain semantic chunks (#5082)', () => {
  test('the vendored grammar has no unresolved normal-path libc imports', async () => {
    const runtime = await WebAssembly.compile(readFileSync(join(assets, 'tree-sitter.wasm')));
    const exports = new Set(WebAssembly.Module.exports(runtime).map(e => e.name));
    const grammar = await WebAssembly.compile(readFileSync(join(assets, 'grammars/tree-sitter-bash.wasm')));
    const missingFunctions = WebAssembly.Module.imports(grammar).filter(i =>
      i.module === 'env' && i.kind === 'function' &&
      !exports.has(i.name) && !exports.has('_' + i.name));
    expect(missingFunctions.map(i => i.name)).toEqual(['__assert_fail']);
  });

  test('the pinned runtime parses case, heredoc and loop syntax without errors', async () => {
    await Parser.init({ locateFile: () => join(assets, 'tree-sitter.wasm') });
    const language = await Parser.Language.load(join(assets, 'grammars/tree-sitter-bash.wasm'));
    expect(language.version).toBe(14);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(source);
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.descendantsOfType('case_statement')).toHaveLength(1);
        expect(tree.rootNode.descendantsOfType('heredoc_body')).toHaveLength(1);
        expect(tree.rootNode.descendantsOfType('for_statement')).toHaveLength(1);
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  });

  for (const path of ['example.sh', 'example.bash']) {
    test(`${path} keeps functions and their bodies instead of whole-file text fallback`, async () => {
      const chunks = await chunkCodeText(source, path);
      expect(chunks.find(c => c.metadata.symbolName === 'dispatch')?.metadata.symbolType).toBe('function');
      expect(chunks.find(c => c.metadata.symbolName === 'dispatch')?.text).toContain('case "$1" in');
      expect(chunks.find(c => c.metadata.symbolName === 'print_help')?.text).toContain('Usage: example.sh');
      expect(chunks.every(c => c.metadata.symbolType !== 'text')).toBe(true);
    });
  }

  test('the full chunk-and-edge entrypoint preserves Bash symbols', async () => {
    const { chunks } = await chunkCodeTextFull(source, 'example.sh');
    expect(chunks.find(c => c.metadata.symbolName === 'dispatch')?.metadata.language).toBe('bash');
    expect(chunks.find(c => c.metadata.symbolName === 'print_help')).toBeDefined();
  });

  test('existing indexes are invalidated to recover lost Bash symbols', () => {
    expect(CHUNKER_VERSION).toBeGreaterThanOrEqual(7);
  });
});
