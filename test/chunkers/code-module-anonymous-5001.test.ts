/**
 * #5001 residual: a call edge needs a chunk with a qualified symbol around its call site, and #7409 gave top-level
 * expression statements the file's `__module__` chunk. Calls in every other top-level shape that names no definition
 * were still dropped, and their text was never indexed (so code-refs missed it too):
 *   - anonymous default exports: `export default function () {…}`, `export default async (req) => …`,
 *     `export default { fetch(req) {…} }`, `export default defineConfig({…})`
 *   - top-level control flow: a TS `if`/`for`/`try`, Python's `if __name__ == "__main__": main()`
 *   - a merged run of small declarations whose values are calls (`const app = createApp(); const db = openDb();`)
 * Each now lands on `<file>::__module__`, through the real chunker, edge extractor, edge mapping and resolver.
 * Defect 2 (resolved:false for TS defs) is pinned here too: within-file resolution matches `export statement` and
 * `lexical declaration` definitions; only cross-file calls stay unresolved, and the CLI labels them so.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../../src/core/chunkers/symbol-resolver.ts';
import { chunkCodeTextFull } from '../../src/core/chunkers/code.ts';

let engine: PGLiteEngine;

const FILES: Record<string, string> = {
  'src/handler-example.ts': [
    "export const helperExample = (n: number) => n + 1;",
    "export default async (req: { n: number }) => helperExample(req.n);",
  ].join('\n'),
  'src/worker-example.ts': [
    "export function handleExample(req: unknown) { return req; }",
    "export default { fetch(req: unknown) { return handleExample(req); } };",
  ].join('\n'),
  'src/boot-example.ts': [
    "export function startExample() { return 1; }",
    "export function reportExample(e: unknown) { return e; }",
    "if (process.env.EXAMPLE) { startExample(); }",
    "try { startExample(); } catch (e) { reportExample(e); }",
  ].join('\n'),
  'src/app-example.ts': [
    "export function createAppExample() { return {}; }",
    "export function openDbExample() { return {}; }",
    "const app = createAppExample();",
    "const db = openDbExample();",
  ].join('\n'),
  'tools/cli_example.py': [
    "def main_example():",
    "    return 1",
    "",
    "if __name__ == '__main__':",
    "    main_example()",
  ].join('\n'),
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [path, content] of Object.entries(FILES)) await importCodeFile(engine, path, content, { noEmbed: true });
  await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

async function callers(symbol: string) {
  return (await engine.getCallersOf(symbol, { allSources: true }))
    .filter(e => e.edge_type === 'calls')
    .map(e => ({ from: e.from_symbol_qualified, resolved: e.resolved }));
}

describe('#5001 calls in top-level code that names no definition', () => {
  test('an anonymous default-export arrow attributes its calls to the module', async () => {
    expect(await callers('helperExample')).toEqual([{ from: 'handler-example::__module__', resolved: true }]);
  });

  test('a method of an anonymous default-export object attributes its calls to the module', async () => {
    expect(await callers('handleExample')).toEqual([{ from: 'worker-example::__module__', resolved: true }]);
  });

  test('top-level if and try blocks attribute their calls to the module', async () => {
    expect(await callers('startExample')).toEqual([{ from: 'boot-example::__module__', resolved: true }]);
    expect(await callers('reportExample')).toEqual([{ from: 'boot-example::__module__', resolved: true }]);
  });

  test('a merged run of call-valued declarations keeps the module identity', async () => {
    expect(await callers('createAppExample')).toEqual([{ from: 'app-example::__module__', resolved: true }]);
    expect(await callers('openDbExample')).toEqual([{ from: 'app-example::__module__', resolved: true }]);
  });

  test('Python main guard attributes main() to the module and indexes its text', async () => {
    expect(await callers('main_example')).toEqual([{ from: 'cli_example::__module__', resolved: true }]);
    const { chunks } = await chunkCodeTextFull(FILES['tools/cli_example.py']!, 'tools/cli_example.py');
    expect(chunks.some(c => c.metadata.symbolName === '__module__' && c.text.includes("if __name__ == '__main__':"))).toBe(true);
  });

  test('a named definition keeps its own chunk and name', async () => {
    const { chunks } = await chunkCodeTextFull(FILES['src/boot-example.ts']!, 'src/boot-example.ts');
    expect(chunks.find(c => c.metadata.symbolName === 'startExample')?.metadata.symbolType).toBe('export statement');
  });
});

describe('#5001 defect 2: within-file resolution of TS export-statement and lexical-declaration definitions', () => {
  test('a same-file call to an export-statement or lexical-declaration def is resolved', async () => {
    const source = [
      "const rowByKey = (rows: string[], k: string) => rows.find(r => r === k);",
      "export function breakdownExample(rows: string[]) { return rowByKey(rows, 'a'); }",
      "export function usesExample() { return breakdownExample([]); }",
    ].join('\n');
    await importCodeFile(engine, 'src/review-example.ts', source, { noEmbed: true });
    await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
    expect(await callers('rowByKey')).toEqual([{ from: 'breakdownExample', resolved: true }]);
    expect(await callers('breakdownExample')).toEqual([{ from: 'usesExample', resolved: true }]);
  });
});
