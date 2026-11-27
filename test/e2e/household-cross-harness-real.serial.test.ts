/**
 * W1a, the cross-harness outcome check for the household tools (docs/guides/household.md#check-it-across-harnesses).
 * Real agents, no judge, no published number:
 *
 *   1. Claude Code (Opus 5.5), with gbrain over MCP, records two household updates on a repo-less keyless brain
 *      seeded with the synthetic household: a new gas bill, and milk bought.
 *   2. A fresh Codex session (GPT-6.2 Sol), with gbrain over MCP, answers "what's at risk at home this week?" through
 *      household_due. Its list must be the overdue and at-risk part of the hand-computed ranking below, in order, each
 *      item cited by slug.
 *   3. The native baseline: the same two steps with gbrain disconnected, using each harness's own memory (an
 *      AGENTS.md notes file in the working directory, which Claude Code reads through CLAUDE.md and Codex reads as its
 *      project instructions). It is reported, not asserted: the log names the items it missed and added, and a model
 *      that gets every item right from its notes alone does not fail the check.
 *
 * Opt-in and paid: GBRAIN_TEST_LIVE_HOUSEHOLD=1 GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 bun test <this file>, with the claude and
 * codex commands and their keys (ANTHROPIC_API_KEY; CODEX_API_KEY or OPENAI_API_KEY). An opted-in run that is missing any
 * of them, or whose claude is older than 2.1.280 (Opus 5.5 needs it), fails instead of skipping. Every home is a temp
 * dir (HOME, CLAUDE_CONFIG_DIR and CODEX_HOME), every name is invented.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  claudeHeadlessTurn, codexExecTurn, hasClaudeAuth, resolveClaudeBinary, resolveCodexBinary, resolveGbrainServerCommand, writeGbrainMcpConfig,
} from '../helpers/agent-harness.ts';
import { householdDueIn, seedSyntheticHouseholdBrain } from '../../scripts/synthetic-household.ts';
import { AS_OF, MARKS, RECORDS, TIMEZONE } from '../fixtures/synthetic-household/household.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const CLAUDE_MODEL = process.env.GBRAIN_TEST_HOUSEHOLD_CLAUDE_MODEL || 'claude-opus-5-5';
const CODEX_MODEL = process.env.GBRAIN_TEST_HOUSEHOLD_CODEX_MODEL || 'gpt-6.2-sol';
const CODEX_KEY = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '';
const CLAUDE_BIN = resolveClaudeBinary();
const CODEX_BIN = resolveCodexBinary();
const LIVE = process.env.GBRAIN_TEST_LIVE_HOUSEHOLD === '1';
const MISSING = [
  !CLAUDE_BIN && 'the claude command', !CODEX_BIN && 'the codex command', !hasClaudeAuth() && 'ANTHROPIC_API_KEY',
  !CODEX_KEY && !existsSync(join(homedir(), '.codex', 'auth.json')) && 'CODEX_API_KEY or OPENAI_API_KEY',
].filter(Boolean);
if (LIVE && MISSING.length) {
  throw new Error(`GBRAIN_TEST_LIVE_HOUSEHOLD=1 but this run is missing ${MISSING.join(', ')}. Provider keys reach tests only with GBRAIN_TEST_KEEP_PROVIDER_KEYS=1.`);
}
const READY = LIVE && !MISSING.length;

const GAS_BILL = { title: 'Gas bill', due: '2026-12-06', amount: 40, currency: 'USD' };
const MILK_BOUGHT = '2026-11-30';

/**
 * The ranking after step 1, computed by hand from the fixture's (test/fixtures/synthetic-household/household.ts) for
 * AS_OF: Gas bill is due in 5 days, at_risk: 30-5+6 = 31, between Internet bill (32) and Coffee beans (29). Milk bought
 * 2026-11-30 on a 7d cadence is next due 2026-12-07, 6 days, upcoming: 10-6+2 = 6, between Alice birthday (7) and
 * Toothpaste (5). Everything else keeps its fixture score.
 */
const EXPECTED = [
  'Water bill', 'Permission slip', 'Field trip form', 'Electric bill', 'Winter boots return', 'Internet bill', 'Gas bill', 'Coffee beans',
  'Library books', 'Dog food', 'Car service', 'Bob birthday', 'Store credit', 'Dentist cleaning', 'Alice birthday', 'Milk', 'Toothpaste',
];
const EXPECTED_COUNTS = { overdue: 2, at_risk: 12, upcoming: 3, ok: 21, unknown: 1, invalid: 0 };
/** The answer to "what's at risk this week": the overdue and at-risk items, which rank ahead of every upcoming one. */
const AT_RISK = EXPECTED.slice(0, EXPECTED_COUNTS.overdue + EXPECTED_COUNTS.at_risk);

const QUESTION = "What's at risk at home this week?";
const TODAY = `Today is ${AS_OF} (${TIMEZONE}).`;

function gitDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

/** A hermetic ~/.codex with only the model, the API-key login and (for the gbrain arm) the gbrain server. */
function codexHome(prefix: string, gbrainHome?: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(home, '.codex');
  mkdirSync(dir, { recursive: true });
  for (const f of ['AGENTS.md', 'SOUL.md']) writeFileSync(join(dir, f), '<!-- hermetic test placeholder -->\n');
  const lines = [`model = ${JSON.stringify(CODEX_MODEL)}`];
  if (gbrainHome) {
    const server = resolveGbrainServerCommand(REPO_ROOT, ['--surface', 'full']);
    lines.push('', '[mcp_servers.gbrain]', `command = ${JSON.stringify(server.command)}`, `args = ${JSON.stringify(server.args)}`,
      'startup_timeout_sec = 60', `env = { GBRAIN_HOME = ${JSON.stringify(gbrainHome)}, GBRAIN_SOURCE = "default" }`);
  }
  writeFileSync(join(dir, 'config.toml'), lines.join('\n') + '\n');
  return home;
}

const codexEnv = (home: string): Record<string, string> => ({ CODEX_HOME: join(home, '.codex'), ...(CODEX_KEY ? { CODEX_API_KEY: CODEX_KEY } : {}) });

/** Numbered lines of an answer: `<n>. <title>` with an optional ` — <slug>` citation. */
function listed(text: string): Array<{ title: string; slug: string | null }> {
  const out: Array<{ title: string; slug: string | null }> = [];
  for (const line of text.split('\n')) {
    const m = line.replace(/\*\*/g, '').match(/^\s*\d+[.)]\s+(.+?)\s*$/);
    if (!m) continue;
    const cited = m[1]!.match(/^(.+?)\s+[—–-]+\s+`?([a-z0-9][\w/.-]*)`?$/i);
    out.push(cited ? { title: cited[1]!.trim(), slug: cited[2]!.trim() } : { title: m[1]!.trim(), slug: null });
  }
  return out;
}

/** The fixture as the notes a person keeps by hand: every record and every event, nothing computed. */
function householdNotes(): string {
  const record = (r: Record<string, unknown>) => {
    const parts = [`- ${r.title} (${r.kind})`];
    if (r.due) parts.push(`due ${r.due}`);
    if (r.recurs) parts.push(`repeats ${r.recurs}`);
    if (r.on) parts.push(`every year on ${r.on}`);
    if (r.amount !== undefined) parts.push(`${r.amount} ${r.currency}`);
    if (r.cadence) parts.push(`restock or repeat every ${r.cadence}`);
    if (r.last_done) parts.push(`last done ${r.last_done}`);
    if (r.lead_days !== undefined) parts.push(`needs ${r.lead_days} days' notice`);
    if (r.school) parts.push('school');
    if (Array.isArray(r.about)) parts.push(`about ${(r.about as string[]).map(s => s.split('/').pop()).join(', ')}`);
    return parts.join(', ');
  };
  return ['# Household notes', '', 'Our shared household memory. Keep it current.', '', '## Records', '', ...RECORDS.map(record), '',
    '## Log', '', ...MARKS.map(m => `- ${m.on}: ${m.title}: ${m.event.replace('_', ' ')}`), ''].join('\n');
}

describe.skipIf(!READY)('household outcome across Claude Code and Codex (W1a, live)', () => {
  const temps: string[] = [];
  const temp = (dir: string) => (temps.push(dir), dir);
  let gbrainHome = '';

  beforeAll(async () => {
    const version = spawnSync(CLAUDE_BIN!, ['--version'], { encoding: 'utf8' }).stdout ?? '';
    const [major = 0, minor = 0, patch = 0] = (version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? []).map(Number);
    if (CLAUDE_MODEL === 'claude-opus-5-5' && (major * 1e6 + minor * 1e3 + patch) < 2_001_280) {
      throw new Error(`Claude Code ${version.trim() || '(unknown)'} cannot run ${CLAUDE_MODEL}; install 2.1.280 or newer.`);
    }
    gbrainHome = temp(mkdtempSync(join(tmpdir(), 'gb-w1a-brain-')));
    await seedSyntheticHouseholdBrain(gbrainHome);
  }, 300_000);

  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  test('with gbrain: Claude Code records the updates and a fresh Codex session gives the hand-computed ranking, cited', async () => {
    const before = await householdDueIn(gbrainHome, { as_of: AS_OF });
    const cwd = temp(gitDir('gb-w1a-claude-'));
    const home = temp(mkdtempSync(join(tmpdir(), 'gb-w1a-claude-home-')));
    const mcpConfigPath = join(home, 'mcp.json');
    writeGbrainMcpConfig({ path: mcpConfigPath, server: resolveGbrainServerCommand(REPO_ROOT, ['--surface', 'full']), gbrainHome, sourceId: 'default' });
    const record = `${TODAY} Record two household updates with the gbrain household tools (household_add and household_mark), not in files: ` +
      `1) a new bill titled "${GAS_BILL.title}", due ${GAS_BILL.due}, amount ${GAS_BILL.amount} ${GAS_BILL.currency}. ` +
      `2) Milk was bought on ${MILK_BOUGHT}: find the Milk record with household_due (as_of "${AS_OF}", include "all") and mark it bought on ${MILK_BOUGHT}. ` +
      'Reply "done" once both are recorded.';
    let after: any = before;
    let evidence = '';
    for (let attempt = 1; attempt <= 2 && after === before; attempt++) {
      const turn = await claudeHeadlessTurn({ prompt: record, cwd, home, claudeConfigDir: join(home, '.claude'), mcpConfigPath, model: CLAUDE_MODEL, timeoutMs: 300_000 });
      const now = await householdDueIn(gbrainHome, { as_of: AS_OF });
      evidence = `[step 1 claude attempt ${attempt}] model=${CLAUDE_MODEL} exit=${turn.exitCode} timedOut=${turn.timedOut} tools=${JSON.stringify(turn.toolCalls)}\n${turn.finalText.slice(0, 600)}`;
      console.log(evidence);
      if (JSON.stringify(now) !== JSON.stringify(before)) after = now;
    }
    expect(after.items.map((i: any) => i.title), evidence).toEqual(EXPECTED);
    expect(after.counts).toEqual(EXPECTED_COUNTS);
    const gas = after.items.find((i: any) => i.title === GAS_BILL.title);
    expect(gas).toMatchObject({ kind: 'bill', next_due: GAS_BILL.due });
    const slugs = after.items.slice(0, AT_RISK.length).map((i: any) => i.slug as string);

    const codexCwd = temp(gitDir('gb-w1a-codex-'));
    const chome = temp(codexHome('gb-w1a-codex-home-', gbrainHome));
    const ask = `${TODAY} ${QUESTION} Answer only from the gbrain household_due tool, called with as_of "${AS_OF}". ` +
      'List every item it returns as overdue or at risk, in the order it returns them, one per line exactly as "<n>. <title> — <slug>", and nothing else.';
    let passed = false;
    for (let attempt = 1; attempt <= 2 && !passed; attempt++) {
      const turn = await codexExecTurn({ prompt: ask, cwd: codexCwd, home: chome, timeoutMs: 300_000, extraEnv: codexEnv(chome), waitForMcpStartup: true,
        mcpToolApprovals: [{ server: 'gbrain', tools: ['household_due', 'whoami'] }] });
      const raw = turn.rawLines.join('\n');
      const called = /"type"\s*:\s*"mcp_tool_call"[^\n]*"server"\s*:\s*"gbrain"[^\n]*"tool"\s*:\s*"household_due"/.test(raw)
        || turn.mcpToolCalls.some(c => c.server === 'gbrain' && c.tool === 'household_due');
      const lines = listed(turn.finalText);
      const titles = lines.map(l => l.title);
      const cited = lines.map(l => l.slug);
      passed = called && JSON.stringify(titles) === JSON.stringify(AT_RISK) && JSON.stringify(cited) === JSON.stringify(slugs);
      evidence = `[step 2 codex attempt ${attempt}] model=${CODEX_MODEL} exit=${turn.exitCode} timedOut=${turn.timedOut} household_due=${called} matches=${passed} calls=${raw.split('\n').filter(l => l.includes('"mcp_tool_call"') && l.includes('item.completed')).map(l => JSON.stringify(JSON.parse(l).item?.arguments ?? null)).join(' ')}\n${turn.finalText.slice(0, 2000)}\nstderr=${turn.stderrText.slice(-600)}`;
      console.log(evidence);
    }
    expect(passed, evidence).toBe(true);
  }, 1_500_000);

  test('native baseline: the same two steps with gbrain disconnected, reported against the ranking', async () => {
    const cwd = temp(gitDir('gb-w1a-native-'));
    writeFileSync(join(cwd, 'AGENTS.md'), householdNotes());
    writeFileSync(join(cwd, 'CLAUDE.md'), '@AGENTS.md\n');
    const home = temp(mkdtempSync(join(tmpdir(), 'gb-w1a-native-claude-')));
    const record = `${TODAY} Record two household updates in our household notes in AGENTS.md (our shared household memory): ` +
      `1) a new bill titled "${GAS_BILL.title}", due ${GAS_BILL.due}, amount ${GAS_BILL.amount} ${GAS_BILL.currency}. 2) Milk was bought on ${MILK_BOUGHT}. ` +
      'Reply "done" once both are recorded.';
    const turn = await claudeHeadlessTurn({ prompt: record, cwd, home, claudeConfigDir: join(home, '.claude'), model: CLAUDE_MODEL, timeoutMs: 300_000 });
    const notes = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    console.log(`[baseline step 1 claude] exit=${turn.exitCode} tools=${JSON.stringify(turn.toolCalls)}\n${turn.finalText.slice(0, 400)}`);
    expect(notes).toContain(GAS_BILL.title);
    expect(notes).not.toBe(householdNotes());

    const chome = temp(codexHome('gb-w1a-native-codex-'));
    const ask = `${TODAY} ${QUESTION} Answer from our household notes in AGENTS.md. ` +
      'List every item that is overdue or at risk this week, most urgent first, one per line exactly as "<n>. <title>", and nothing else.';
    const answer = await codexExecTurn({ prompt: ask, cwd, home: chome, timeoutMs: 300_000, extraEnv: codexEnv(chome), sandbox: 'read-only' });
    const titles = listed(answer.finalText).map(l => l.title.toLowerCase());
    const missing = AT_RISK.filter(t => !titles.includes(t.toLowerCase()));
    const extra = titles.filter(t => !AT_RISK.some(e => e.toLowerCase() === t));
    const sameOrder = JSON.stringify(titles) === JSON.stringify(AT_RISK.map(t => t.toLowerCase()));
    console.log(`[baseline step 2 codex] exit=${answer.exitCode} listed=${titles.length} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} sameOrder=${sameOrder}\n${answer.finalText.slice(0, 2000)}`);
    expect(titles.length, answer.finalText).toBeGreaterThan(0);
  }, 900_000);
});
