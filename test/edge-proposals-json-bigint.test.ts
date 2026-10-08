/**
 * #6193: `edge-proposals list/show --json` must not crash when the driver
 * returns BigInt ids (Postgres `bigint` columns). The CLI normalizes ids at
 * the row boundary: a safe integer becomes a number, anything larger a string.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { runEdgeProposals } from '../src/commands/edge-proposals.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function row(id: bigint) {
  return {
    id, status: 'proposed', link_type: 'works_at', subject: 'people/alice-example',
    a_target: 'companies/acme-example', b_target: 'companies/widget-example', ending: 'companies/acme-example',
    close_date: '2024-05-01', born_closed: false, model: 'test-model', confidence: 0.9,
    generated_line: 'left [Acme](companies/acme-example)', created_at: new Date('2026-10-01T00:00:00Z'),
  };
}

function fakeEngine(rows: Array<ReturnType<typeof row>>): BrainEngine {
  return { kind: 'postgres', executeRaw: async () => rows } as unknown as BrainEngine;
}

async function capture(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runEdgeProposals(engine, args);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return lines.join('\n');
}

beforeEach(() => { _resetCliExitVerdictForTests(); });
afterEach(() => { _resetCliExitVerdictForTests(); process.exitCode = 0; });

describe('#6193 edge-proposals --json with BigInt ids', () => {
  test('list --json parses and keeps a safe id numeric', async () => {
    const out = await capture(fakeEngine([row(1n)]), ['list', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(1);
    expect(currentExitCode()).toBe(0);
  });

  test('show <id> --json parses and keeps a safe id numeric', async () => {
    const out = await capture(fakeEngine([row(1n)]), ['show', '1', '--json']);
    expect(JSON.parse(out).id).toBe(1);
  });

  test('an id beyond the safe integer range becomes an exact string', async () => {
    const out = await capture(fakeEngine([row(9007199254740993n)]), ['list', '--json']);
    expect(JSON.parse(out)[0].id).toBe('9007199254740993');
  });

  test('text mode prints the normalized id', async () => {
    const out = await capture(fakeEngine([row(7n)]), ['list']);
    expect(out).toContain('#7 [proposed]');
  });
});
