/**
 * Doctor's hook-lane timeout warning (src/commands/doctor/checks/skill-resolver.ts).
 *
 * 1. Protects: a Claude Code, Codex or Hermes host whose prompts keep running
 *    past the lane's deadline (skill_resolve_timeout, so no skills block) hears
 *    it from doctor, with the counts in the message, instead of reading ok.
 * 2. Fails when: doctor stays ok while one harness that is on times out on 20%
 *    or more of at least 20 recent prompts, counts SessionStart lines or
 *    another harness's lines toward it, or warns on a mostly delivered log, a
 *    handful of prompts or a harness that is off.
 * 3. Writes a scratch home's lane log; builds the harness part of the view by
 *    hand; no network.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillResolverCheck, skillResolverView, type SkillResolverHarnessView } from '../src/commands/doctor/checks/skill-resolver.ts';
import { logsDir } from '../src/core/skills/resolver/paths.ts';
import { dailyLogFile, LANE_LOG } from '../src/core/skills/resolver/daily-log.ts';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

interface Line { harness: string; outcome: string; code?: string; event?: string }
const lines = (n: number, l: Line): Line[] => Array.from({ length: n }, () => l);
const delivered = (harness: string, n: number) => lines(n, { harness, outcome: 'delivered' });
const timedOut = (harness: string, n: number) => lines(n, { harness, outcome: 'timeout', code: 'skill_resolve_timeout' });
const on = (harness: 'claude-code' | 'codex' | 'hermes', isOn = true): SkillResolverHarnessView =>
  ({ harness, on: isOn, hook: 'wired', catalogs: [{ name: `${harness}-user`, fresh: true, stale_reason: null, skills: 3 }] });

async function doctorOver(log: Line[], harnesses = [on('hermes'), on('codex')]) {
  const home = mkdtempSync(join(tmpdir(), 'sklane-doctor-timeouts-'));
  scratch.push(home);
  const now = Date.now();
  mkdirSync(logsDir(home), { recursive: true });
  const text = log.map((l, i) => JSON.stringify({ at: new Date(now - (log.length - i) * 1000).toISOString(), event: 'user-prompt', ms: 1, ...l })).join('\n');
  writeFileSync(join(logsDir(home), dailyLogFile(LANE_LOG, now)), `${text}\n`);
  const view = (await skillResolverView(home))!;
  return { view, check: skillResolverCheck({ ...view, harnesses })! };
}

describe('doctor and hook-lane timeouts', () => {
  test('a harness timing out on a large share of recent prompts warns with the counts and skill_resolve_timeout', async () => {
    const { view, check } = await doctorOver([...delivered('hermes', 30), ...timedOut('hermes', 10), ...lines(15, { harness: 'codex', outcome: 'delivered', event: 'session-start' })]);
    expect(view.recent.prompts).toEqual({ hermes: { turns: 40, timeouts: 10 } });
    expect(check.status).toBe('warn');
    expect((check.details as { code?: string }).code).toBe('skill_resolve_timeout');
    expect(check.message).toContain('hermes: 10 of the last 40 prompts (25%)');
    expect(check.fix?.docs).toBe('docs/guides/skill-resolver.md#skill_resolve_timeout');
  });

  test('the resolver running out of time inside the turn counts as a timeout too', async () => {
    const { check } = await doctorOver([...delivered('codex', 16), ...lines(4, { harness: 'codex', outcome: 'error', code: 'skill_resolve_timeout' })]);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('codex: 4 of the last 20 prompts (20%)');
  });

  test('a mostly delivered log, a handful of prompts, another harness\'s timeouts or a harness that is off stay ok', async () => {
    expect((await doctorOver([...delivered('hermes', 38), ...timedOut('hermes', 2)])).check.status).toBe('ok');
    expect((await doctorOver([...delivered('hermes', 9), ...timedOut('hermes', 10)])).check.status).toBe('ok');
    expect((await doctorOver([...delivered('hermes', 40), ...timedOut('codex', 1), ...delivered('codex', 30)])).check.status).toBe('ok');
    expect((await doctorOver([...delivered('hermes', 30), ...timedOut('hermes', 10)], [on('hermes', false)])).check.status).toBe('ok');
  });
});
