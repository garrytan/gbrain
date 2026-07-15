import { describe, expect, test } from 'bun:test';
import { runRollout } from '../../src/core/skillopt/rollout.ts';
import { buildWriteCaptureRegistry } from '../../src/core/skillopt/write-capture.ts';
import type { ChatToolDef, ToolLoopOpts, ToolLoopResult } from '../../src/core/ai/gateway.ts';

// v0.42 AI SDK v6 fix: both skillopt tool-schema mappers (rollout.ts AND
// write-capture.ts) previously mapped only {type,description}, silently
// dropping enum/default/items. Both now route through the canonical
// paramDefToSchema(). This pins that the dropped metadata survives in BOTH
// sites (the "fix every path or one silently diverges" class).

function findTool(defs: ChatToolDef[], name: string): ChatToolDef {
  const t = defs.find((d) => d.name === name);
  expect(t).toBeDefined();
  return t!;
}

describe('skillopt rollout tool schemas preserve ParamDef metadata', () => {
  test('rollout.ts: enum metadata survives for list_pages.sort + traverse_graph.direction', async () => {
    let captured: ChatToolDef[] = [];
    await runRollout({
      engine: {} as never,
      skillText: 'Answer the task using read-only brain tools when useful.',
      task: { task_id: 'schema-capture', task: 'noop', judge: { kind: 'rule', checks: [] } },
      targetModel: 'anthropic:claude-sonnet-4-6',
      toolLoopFn: async (opts: ToolLoopOpts): Promise<ToolLoopResult> => {
        captured = opts.tools;
        return {
          finalText: 'done',
          totalTurns: 0,
          totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
          stopReason: 'end',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
        };
      },
    });

    const listPages = findTool(captured, 'brain_list_pages');
    const sort = (listPages.inputSchema.properties as Record<string, any>).sort;
    expect(sort.enum).toContain('updated_desc');

    const traverse = findTool(captured, 'brain_traverse_graph');
    const direction = (traverse.inputSchema.properties as Record<string, any>).direction;
    expect(direction.enum).toEqual(['in', 'out', 'both']);
  });

  test('write-capture.ts: the second mapper preserves the same enum metadata', () => {
    const { defs } = buildWriteCaptureRegistry({} as never);

    const traverse = findTool(defs, 'brain_traverse_graph');
    const direction = (traverse.inputSchema.properties as Record<string, any>).direction;
    expect(direction.enum).toEqual(['in', 'out', 'both']);

    const listPages = findTool(defs, 'brain_list_pages');
    const sort = (listPages.inputSchema.properties as Record<string, any>).sort;
    expect(sort.enum).toContain('updated_desc');
  });
});
