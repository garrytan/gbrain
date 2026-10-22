/**
 * #7246: find_anomalies (and `gbrain anomalies --json`) returned every slug
 * of an anomalous cohort, so a bulk-import day put tens of thousands of slugs
 * in one response. Each row now carries at most 20 slugs and
 * `page_slugs_complete: false` when it left some out; the count still covers
 * the whole cohort. `--all` keeps every slug on the local CLI.
 *
 * Authoring gate: protects the output-size contract of a remote-reachable op;
 * fails if the cap is dropped; no existing test covers the slug list size.
 */
import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { runAnomalies } from '../src/commands/anomalies.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const slugs = Array.from({ length: 500 }, (_, i) => `people/p-${i}`);
const row = { cohort_kind: 'type' as const, cohort_value: 'person', count: 500, baseline_mean: 1, baseline_stddev: 1, sigma_observed: 499 };
const engine = { kind: 'pglite', findAnomalies: async () => [{ ...row, page_slugs: [...slugs] }] } as unknown as BrainEngine;
const op = operations.find(o => o.name === 'find_anomalies')!;
const ctx = (remote: boolean) => ({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote }) as never;

async function cliJson(args: string[]) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try {
    await runAnomalies(engine, ['--json', ...args]);
  } finally {
    console.log = original;
  }
  return JSON.parse(lines.join('\n'));
}

describe('find_anomalies bounded slug lists (#7246)', () => {
  test('the op caps page_slugs at 20 by default and marks the row incomplete', async () => {
    const [out] = await op.handler(ctx(true), {}) as Array<Record<string, unknown>>;
    expect(out!.page_slugs).toEqual(slugs.slice(0, 20));
    expect(out!.page_slugs_complete).toBe(false);
    expect(out!.count).toBe(500);
  });

  test('a cohort that fits the cap is returned whole with no completeness flag', async () => {
    const small = { kind: 'pglite', findAnomalies: async () => [{ ...row, count: 3, page_slugs: slugs.slice(0, 3) }] } as unknown as BrainEngine;
    const [out] = await op.handler({ ...(ctx(true) as object), engine: small } as never, {}) as Array<Record<string, unknown>>;
    expect(out!.page_slugs).toEqual(slugs.slice(0, 3));
    expect(out!.page_slugs_complete).toBeUndefined();
  });

  test('gbrain anomalies --json is capped by default and --all keeps every slug', async () => {
    const [capped] = await cliJson([]);
    expect(capped.page_slugs).toHaveLength(20);
    expect(capped.page_slugs_complete).toBe(false);
    const [all] = await cliJson(['--all']);
    expect(all.page_slugs).toHaveLength(500);
    expect(all.page_slugs_complete).toBeUndefined();
  });
});
