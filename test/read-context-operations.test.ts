import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function withOperationContext<T>(
  label: string,
  fn: (ctx: OperationContext) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-read-context-operation-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn({
      engine,
      config: {} as OperationContext['config'],
      logger: console,
      dryRun: false,
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('read_context operation', () => {
  test('accepts selector-id shorthand arrays from agent tool calls', async () => {
    await withOperationContext('selector-id-shorthand', async (ctx) => {
      await importFromContent(ctx.engine, 'concepts/selector-shorthand', [
        '---',
        'type: concept',
        'title: Selector Shorthand',
        '---',
        '# Compiled Truth',
        'Selector-id shorthand should resolve to compiled truth evidence.',
      ].join('\n'), { path: 'concepts/selector-shorthand.md' });

      const result = await operationsByName.read_context!.handler(ctx, {
        selectors: ['compiled_truth:workspace:default:concepts/selector-shorthand'],
        token_budget: 200,
      }) as any;

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0].selector.slug).toBe('concepts/selector-shorthand');
      expect(result.canonical_reads[0].text).toContain('Selector-id shorthand should resolve');
    });
  });
});
