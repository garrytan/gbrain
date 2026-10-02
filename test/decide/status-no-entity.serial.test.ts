/**
 * #5836 `gbrain decide status`: the conflict slot reports the 7-day share of
 * conflict receipts skipped with reason `no_entity` (facts the sweep cannot
 * judge until they are linked) as JSON (`no_entity_7d`) and, when non-zero,
 * as a human line with the `gbrain facts relink --dry-run` hint. Receipts of
 * other slots and older than 7 days do not count.
 * Serial: captures console.log.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runDecideCommand } from '../../src/commands/decide.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function receipt(slot: string, outcome: string, reason: string | null, daysAgo = 0) {
  await engine.executeRaw(
    `INSERT INTO decision_receipts (decision_id, created_at, slot, mode, provider, outcome, error_reason, call_site, lane)
     VALUES (md5(random()::text), now() - ($4::int * interval '1 day'), $1, 'on', 'typesafe:jev-1.13.0', $2, $3, 'sweep', 'background')`,
    [slot, outcome, reason, daysAgo]);
}

async function status(args: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  try { expect(await runDecideCommand(engine, ['status', ...args])).toBe(0); } finally { console.log = log; }
  return out.join('\n');
}

describe('decide status: conflict no_entity share', () => {
  test('JSON field and human hint count only 7-day conflict no_entity skips', async () => {
    for (let i = 0; i < 3; i++) await receipt('conflict', 'skipped', 'no_entity');
    await receipt('conflict', 'skipped', 'no_embedding');
    await receipt('conflict', 'proposal', null);
    await receipt('conflict', 'skipped', 'no_entity', 8);
    await receipt('evidence', 'skipped', 'no_entity');
    const json = JSON.parse(await status(['--json']));
    const conflict = json.slots.find((s: { slot: string }) => s.slot === 'conflict');
    expect(conflict.no_entity_7d).toEqual({ skipped: 3, receipts: 5, share: 0.6 });
    expect(json.slots.filter((s: Record<string, unknown>) => 'no_entity_7d' in s).map((s: { slot: string }) => s.slot)).toEqual(['conflict']);
    const human = await status([]);
    expect(human).toContain('60.0% of conflict receipts in 7 days (3 of 5) skipped a fact with no entity (no_entity); link them: gbrain facts relink --dry-run');
  });

  test('zero no_entity skips: JSON reports zero and no hint line is printed', async () => {
    await receipt('conflict', 'proposal', null);
    const json = JSON.parse(await status(['--json']));
    expect(json.slots.find((s: { slot: string }) => s.slot === 'conflict').no_entity_7d).toEqual({ skipped: 0, receipts: 1, share: 0 });
    expect(await status([])).not.toContain('facts relink');
  });
});
