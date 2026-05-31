import { describe, expect, test } from 'bun:test';
import { runRollout } from '../../src/core/skillopt/rollout.ts';
import type { ChatToolDef, ToolLoopOpts, ToolLoopResult } from '../../src/core/ai/gateway.ts';

describe('skillopt rollout tool schemas', () => {
  test('preserves ParamDef enum/default/items metadata from brain operations', async () => {
    let capturedTools: ChatToolDef[] = [];

    await runRollout({
      engine: {} as never,
      skillText: 'Answer the task using read-only brain tools when useful.',
      task: { task_id: 'schema-capture', task: 'noop', judge: { kind: 'rule', checks: [] } },
      targetModel: 'anthropic:claude-sonnet-4-6',
      toolLoopFn: async (opts: ToolLoopOpts): Promise<ToolLoopResult> => {
        capturedTools = opts.tools;
        return {
          finalText: 'done',
          totalTurns: 0,
          totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
          stopReason: 'end',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
        };
      },
    });

    const listPages = capturedTools.find((tool) => tool.name === 'brain_list_pages');
    expect(listPages).toBeDefined();
    const listPagesProps = listPages!.inputSchema.properties as Record<string, any>;
    expect(listPagesProps.sort.enum).toContain('updated_desc');

    const traverseGraph = capturedTools.find((tool) => tool.name === 'brain_traverse_graph');
    expect(traverseGraph).toBeDefined();
    const traverseProps = traverseGraph!.inputSchema.properties as Record<string, any>;
    expect(traverseProps.direction.enum).toEqual(['in', 'out', 'both']);
  });
});
