/**
 * #5001: a cross-file call is never resolved (the symbol resolver is within-file), so code-callers and
 * code-callees label it "unresolved (cross-file, matched by name)" instead of a bare "unresolved".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { importCodeFile } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCodeCallers } from '../src/commands/code-callers.ts';
import { runCodeCallees } from '../src/commands/code-callees.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importCodeFile(engine, 'src/helper-example.ts', 'export function helperExample(n: number) {\n  return n + 1;\n}\n', { noEmbed: true });
  await importCodeFile(engine, 'src/use-example.ts', "import { helperExample } from './helper-example.ts';\nexport function useExample() {\n  return helperExample(1);\n}\n", { noEmbed: true });
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

async function captured(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { await run(); } finally { console.log = original; }
  return lines.join('\n');
}

describe('#5001 cross-file call label', () => {
  test('code-callers labels a cross-file caller as matched by name', async () => {
    const out = await captured(() => runCodeCallers(engine, ['helperExample', '--all-sources', '--no-json']));
    expect(out).toContain('useExample  → helperExample  [unresolved (cross-file, matched by name)]');
  });

  test('code-callees labels the same edge the same way', async () => {
    const out = await captured(() => runCodeCallees(engine, ['useExample', '--all-sources', '--no-json']));
    expect(out).toContain('useExample  → helperExample  [unresolved (cross-file, matched by name)]');
  });
});
