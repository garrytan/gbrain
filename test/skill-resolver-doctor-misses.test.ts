/**
 * Doctor's deadline-miss warning for the hook lane (src/commands/doctor/checks/skill-resolver.ts).
 *
 * 1. Protects: a Claude Code, Codex or Hermes host whose turns keep missing the
 *    lane deadline hears about it from doctor, the way an OpenClaw host does.
 * 2. Fails when: doctor stays ok while a harness misses more than 5% of at
 *    least 20 turns, skips a miss the resolver itself logs as an error, counts
 *    turns it never ranked, lets one harness's misses warn for another, or
 *    warns on a handful of turns.
 * 3. Writes a scratch home's lane log; no network.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillResolverCheck, skillResolverView } from '../src/commands/doctor/checks/skill-resolver.ts';
import { logsDir } from '../src/core/skills/resolver/paths.ts';
import { dailyLogFile, LANE_LOG } from '../src/core/skills/resolver/daily-log.ts';

const scratch: string[] = [];
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

type Line = { harness: string; outcome: string; code?: string };
const turns = (harness: string, n: number, outcome: string, code?: string): Line[] => Array.from({ length: n }, () => ({ harness, outcome, ...(code ? { code } : {}) }));

async function doctorOver(lines: Line[]) {
  const h = mkdtempSync(join(tmpdir(), 'sklane-doctor-'));
  scratch.push(h);
  const now = Date.now();
  mkdirSync(logsDir(h), { recursive: true });
  const text = lines.map((l, i) => JSON.stringify({ at: new Date(now - (lines.length - i) * 1000).toISOString(), event: 'user-prompt', ms: 1, ...l })).join('\n');
  writeFileSync(join(logsDir(h), dailyLogFile(LANE_LOG, now)), `${text}\n`);
  return skillResolverCheck(await skillResolverView(h))!;
}

describe('doctor and hook-lane deadline misses', () => {
  test('a harness missing more than 5% of its turns warns with skill_resolve_timeout and names the harness', async () => {
    const c = await doctorOver([...turns('hermes', 30, 'delivered'), ...turns('hermes', 10, 'timeout', 'skill_resolve_timeout')]);
    expect(c.status).toBe('warn');
    expect((c.details as any).code).toBe('skill_resolve_timeout');
    expect(c.message).toContain('hermes');
    expect(c.message).toContain('25.0%');
    expect(c.fix?.docs).toBe('docs/guides/skill-resolver.md#skill_resolve_timeout');
  });

  test('the resolver running out of time counts as a miss too', async () => {
    const c = await doctorOver([...turns('hermes', 30, 'delivered'), ...turns('hermes', 10, 'error', 'skill_resolve_timeout')]);
    expect(c.status).toBe('warn');
    expect((c.details as any).code).toBe('skill_resolve_timeout');
  });

  test('turns the lane never ranked do not dilute the rate', async () => {
    const c = await doctorOver([...turns('hermes', 200 - 26, 'empty'), ...turns('hermes', 20, 'delivered'), ...turns('hermes', 6, 'timeout', 'skill_resolve_timeout')]);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('23.1%');
  });

  test('one harness missing does not warn about another, and few turns or a low rate stay ok', async () => {
    const mixed = await doctorOver([...turns('codex', 40, 'delivered'), ...turns('hermes', 39, 'delivered'), ...turns('hermes', 1, 'timeout', 'skill_resolve_timeout')]);
    expect(mixed.status).toBe('ok');
    const few = await doctorOver([...turns('codex', 10, 'delivered'), ...turns('codex', 5, 'timeout', 'skill_resolve_timeout')]);
    expect(few.status).toBe('ok');
  });
});
