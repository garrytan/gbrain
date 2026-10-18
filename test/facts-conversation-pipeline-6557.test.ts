/**
 * #6557: conversation pages skip the page-write facts backstop on purpose (the
 * opt-in conversation facts backfill owns them, under its own spend caps). The
 * skip is typed (`conversation_pipeline`) and doctor's facts_extraction_health
 * names the opt-in and its caps when such pages exist and the backfill is off.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { factsExtractionEntry } from '../src/commands/doctor/checks/knowledge-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const BODY = 'Alice Example: we agreed to move the launch to Friday. Bob Example: fine, I will tell the team tomorrow morning.';
const run = async () => {
  const checks = await factsExtractionEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('facts_extraction_health names the conversation pipeline (#6557)', () => {
  test('no conversation pages: no note', async () => {
    const check = await run();
    expect(check.message).not.toContain('conversation_pipeline');
  });

  test('conversation pages with the backfill off: the note names the opt-in, its caps, and asks the user', async () => {
    await engine.putPage('conversations/2026-10-01-thread', { type: 'conversation', title: 'Thread', compiled_truth: BODY });
    await engine.putPage('meetings/2026-10-02-call', { type: 'conversation', title: 'Call', compiled_truth: BODY });
    const check = await run();
    expect(check.message).toContain('1 conversation page(s) are not read by the page-write facts backstop (conversation_pipeline)');
    expect(check.message).toContain('capped at $1.00 per source and $5.00 per cycle, 20 min per source and 30 min per cycle');
    expect(check.message).toContain('gbrain config set cycle.conversation_facts_backfill.enabled true');
    expect((check.details as Record<string, unknown>).conversation_pipeline).toMatchObject({ reason: 'conversation_pipeline', pages: 1 });
    expect(check.fix).toMatchObject({
      argv: ['gbrain', 'config', 'set', 'cycle.conversation_facts_backfill.enabled', 'true'], ask_user: true, consent: ['paid'],
    });
  });

  test('configured caps are the ones stated', async () => {
    await engine.setConfig('cycle.conversation_facts_backfill.max_cost_usd', '0.5');
    const check = await run();
    expect(check.message).toContain('capped at $0.50 per source');
    await engine.setConfig('cycle.conversation_facts_backfill.max_cost_usd', '1');
  });

  test('backfill on: no note', async () => {
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    const check = await run();
    expect(check.message).not.toContain('conversation_pipeline');
  });
});
