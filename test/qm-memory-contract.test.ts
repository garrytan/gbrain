/**
 * GST-359 D: the QM memory-provider contract fixture (docs/contracts/qm-memory-provider/v1.json).
 *
 * 1. Protects: the committed fixture QM vendors equals what the live registry, actor model and error registry produce,
 *    and it pins the r3 contract values (actor id pattern, stateless session, success codes in structuredContent).
 * 2. Fails when: a tool's arguments, a limit, an error code or reason, the header or the deferred list changes without
 *    regenerating the fixture, or an actor_not_attested reason has no fix row.
 * 3. Existing coverage: none; test/qm-memory-tools.test.ts pins the behaviour the fixture describes.
 * 4. Real seams: the operation registry and paramDefToSchema (the served tool schema); no engine.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ACTOR_REASON_FIXES, QM_CONTRACT_PATH, renderQmMemoryContract } from '../scripts/build-qm-memory-contract.ts';
import { CODES } from '../src/core/error-registry.ts';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { unlinkedRecallResult } from '../src/core/ops/qm-memory.ts';

describe('QM memory-provider contract v1', () => {
  const fixture = JSON.parse(readFileSync(QM_CONTRACT_PATH, 'utf8'));

  test('the committed fixture matches the live registry (regenerate with bun scripts/build-qm-memory-contract.ts)', () => {
    expect(readFileSync(QM_CONTRACT_PATH, 'utf8')).toBe(renderQmMemoryContract());
  });

  test('it pins the r3 contract values', () => {
    expect(fixture.actor.header).toBe('x-qm-actor');
    expect(fixture.actor.actor_id.pattern).toBe('^[\\x21-\\x7e]{1,256}$');
    expect(fixture.transport).toMatchObject({ session: 'stateless', success_codes_in: 'structuredContent' });
    expect(fixture.unlinked_recall).toEqual({ isError: false, ...unlinkedRecallResult() });
    expect(fixture.unlinked_recall.structuredContent).toEqual({ facts: [], truncated: false, code: 'actor_unlinked' });
    expect(fixture.memory_recall.limits.max_chars).toEqual({ min: 200, max: 12000, default: 6000, whole_number: true });
    expect(fixture.memory_write.limits.facts).toEqual({ min: 1, max: 20 });
    expect(fixture.actor.deferred_ops).not.toContain('forget');
    expect(fixture.actor.deferred_ops).not.toContain('forget_fact');
  });

  test('the tool schemas are the ones MCP serves', () => {
    const served = buildToolDefs(operations.filter(o => o.name === 'memory_recall' || o.name === 'memory_write'));
    for (const tool of fixture.tools) {
      const def = served.find(d => d.name === tool.name)!;
      expect({ description: tool.description, ...tool.input_schema }).toEqual({ description: def.description, ...def.inputSchema });
    }
  });

  test('every actor_not_attested reason carries its fix, and every listed code is registered', () => {
    expect(Object.keys(ACTOR_REASON_FIXES).sort()).toEqual([...(CODES.actor_not_attested.reasons ?? [])].sort());
    const attested = fixture.errors.codes.find((c: { code: string }) => c.code === 'actor_not_attested');
    for (const r of attested.reasons) expect(r.fix.length).toBeGreaterThan(10);
    for (const c of fixture.errors.codes) expect(CODES[c.code as keyof typeof CODES]).toBeDefined();
  });
});
