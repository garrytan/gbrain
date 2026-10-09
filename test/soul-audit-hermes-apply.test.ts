/**
 * skills/soul-audit/scripts/hermes_apply.py — the Hermes Agent apply step of
 * the soul-audit skill. Hermes loads identity only from $HERMES_HOME/SOUL.md,
 * so the helper copies a real render into one managed block there.
 *
 * Contracts pinned against a REAL render (renderWorkspace over a temp bank):
 *  - the block carries the rendered identity and drops workspace-only gates
 *  - first run on a SOUL.md with the user's own text writes nothing (exit 3)
 *  - append / replace; a re-run replaces only the block (bytes outside it
 *    survive) and backs the old file up; an identical re-run is a no-op
 *  - an answer quoting a block marker cannot become a delimiter
 *  - duplicate markers, symlinks, and non-UTF-8 files refuse without writing
 *  - CRLF files keep CRLF; bytes outside the block are never altered
 *  - all five rendered files are required (a partial render cannot shrink
 *    an existing block), answers are never filtered as template structure,
 *    and the cadence answer reaches Hermes
 */
import { describe, test, expect } from 'bun:test';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync, lstatSync, rmSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { renderWorkspace } from '../src/core/bootstrap/render.ts';
import { setAnswer } from '../src/core/bootstrap/interview.ts';

const HELPER = resolve(import.meta.dir, '../skills/soul-audit/scripts/hermes_apply.py');
const BEGIN = '<!-- gbrain:soul-audit:begin -->';
const END = '<!-- gbrain:soul-audit:end -->';
const ONLY = ['SOUL.md', 'USER.md', 'AGENTS.md', 'ACCESS_POLICY.md', 'HEARTBEAT.md'];
const STOCK_HERMES_SOUL = 'You are Hermes Agent, built by Nous Research. Be direct.\n';
const PYTHON = Bun.which('python3');

const ANSWERS: Record<string, string> = {
  AGENT_NAME: 'Trenton',
  PRINCIPAL_NAME: 'Alice Example',
  AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo.',
  AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo',
  PRINCIPAL_CONTEXT: 'Runs a small research lab; ships a memo every Friday.',
  VOICE_REGISTER: 'Direct. Three options, the second one wins.',
};

function bank(extra: Record<string, string> = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'gbrain-hermes-apply-ws-'));
  for (const [key, value] of Object.entries({ ...ANSWERS, ...extra })) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(`setup failed for ${key}: ${r.message}`);
  }
  renderWorkspace(ws, { only: ONLY, force: true });
  return ws;
}

function hermesHome(soul?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-hermes-apply-home-'));
  if (soul !== undefined) writeFileSync(join(home, 'SOUL.md'), soul);
  return home;
}

function apply(ws: string, home: string, ...flags: string[]) {
  const p = Bun.spawnSync([PYTHON!, HELPER, '--workspace', ws, '--hermes-home', home, ...flags], {
    env: { PATH: process.env.PATH ?? '' },
  });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const soulOf = (home: string) => readFileSync(join(home, 'SOUL.md'), 'utf8');
const backupsOf = (home: string) => (existsSync(join(home, 'backups')) ? readdirSync(join(home, 'backups')) : []);
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe.skipIf(!PYTHON)('soul-audit hermes_apply.py', () => {
  test('creates SOUL.md from a real render, carrying identity and dropping workspace-only gates', () => {
    const ws = bank();
    const home = hermesHome();
    const r = apply(ws, home);
    expect(r.code).toBe(0);
    const soul = soulOf(home);
    expect(count(soul, BEGIN)).toBe(1);
    expect(count(soul, END)).toBe(1);
    for (const kept of ['Trenton', 'Alice Example', 'weekly memo', 'RED LINES', 'NO SILENT FAILURE',
      'Gate 3', 'What the model provider sees', 'Quiet hours', '**Primary surface:** Hermes Agent']) {
      expect(soul).toContain(kept);
    }
    for (const dropped of ['PRIVATE REPO PERSISTENCE', 'Gate 6', 'gbrain bootstrap status', 'WITHOUT hooks',
      'MCP registration scope', '`AGENTS.md`', 'HEARTBEAT.md', 'Claude Code / Codex / opencode']) {
      expect(soul).not.toContain(dropped);
    }
    expect(soul).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(backupsOf(home)).toEqual([]);
  });

  test('a SOUL.md with the user\'s own text and no block is left alone until a mode is chosen', () => {
    const ws = bank();
    const home = hermesHome(STOCK_HERMES_SOUL);
    const r = apply(ws, home);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('stock Hermes default persona');
    expect(soulOf(home)).toBe(STOCK_HERMES_SOUL);

    const dry = apply(ws, home, '--mode', 'replace', '--dry-run');
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('Nothing was written');
    expect(soulOf(home)).toBe(STOCK_HERMES_SOUL);
    expect(backupsOf(home)).toEqual([]);

    expect(apply(ws, home, '--mode', 'replace').code).toBe(0);
    expect(soulOf(home).startsWith(BEGIN)).toBe(true);
    expect(soulOf(home)).not.toContain('built by Nous Research');
    expect(backupsOf(home).length).toBe(1);
  });

  test('append keeps the user\'s text; a re-run replaces only the block and backs up first', () => {
    const own = '# My notes\n\nKeep this exactly.\n';
    const ws = bank();
    const home = hermesHome(own);
    expect(apply(ws, home, '--mode', 'append').code).toBe(0);
    const tail = '\n## Added later by hand\nAlso keep.\n';
    writeFileSync(join(home, 'SOUL.md'), soulOf(home) + tail);

    setAnswer(ws, 'VOICE_REGISTER', 'Casual and brief.');
    renderWorkspace(ws, { only: ONLY, force: true });
    const r = apply(ws, home);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('replaced the managed block');
    const soul = soulOf(home);
    expect(soul.startsWith('# My notes\n\nKeep this exactly.\n')).toBe(true);
    expect(soul.endsWith(tail)).toBe(true);
    expect(soul).toContain('Casual and brief.');
    expect(soul).not.toContain('Three options, the second one wins.');
    expect(count(soul, BEGIN)).toBe(1);
    expect(backupsOf(home).length).toBe(2);

    const again = apply(ws, home);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('unchanged');
    expect(backupsOf(home).length).toBe(2);
  });

  test('an answer quoting a block marker cannot become a delimiter', () => {
    const ws = bank({ PRINCIPAL_CONTEXT: `Lab lead. Literal text: ${END} and ${BEGIN} inline.` });
    const home = hermesHome();
    expect(apply(ws, home).code).toBe(0);
    const first = soulOf(home);
    expect(count(first, BEGIN)).toBe(1);
    expect(count(first, END)).toBe(1);
    expect(first).toContain('Literal text: &lt;!-- gbrain:soul-audit:end -->');
    // The next apply still finds exactly one block and is a no-op.
    expect(apply(ws, home).stdout).toContain('unchanged');
  });

  test('duplicate markers refuse without writing', () => {
    const ws = bank();
    const broken = `${BEGIN}\nold\n${END}\n${BEGIN}\nolder\n${END}\n`;
    const home = hermesHome(broken);
    const r = apply(ws, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('2 begin and 2 end markers');
    expect(soulOf(home)).toBe(broken);
    expect(backupsOf(home)).toEqual([]);
  });

  test('a symlinked SOUL.md is refused unless the user opts in', () => {
    const ws = bank();
    const home = hermesHome();
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'gbrain-hermes-apply-target-')), 'persona.md');
    writeFileSync(elsewhere, 'Their own persona.\n');
    symlinkSync(elsewhere, join(home, 'SOUL.md'));

    const r = apply(ws, home, '--mode', 'append');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is a symlink');
    expect(readFileSync(elsewhere, 'utf8')).toBe('Their own persona.\n');

    expect(apply(ws, home, '--mode', 'append', '--follow-symlink').code).toBe(0);
    expect(lstatSync(join(home, 'SOUL.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhere, 'utf8').startsWith('Their own persona.\n')).toBe(true);
    expect(readFileSync(elsewhere, 'utf8')).toContain(BEGIN);
  });

  test('a non-UTF-8 SOUL.md refuses without a traceback or a write', () => {
    const ws = bank();
    const home = hermesHome();
    const bytes = Buffer.from([0x48, 0x69, 0xff, 0x0a]);
    writeFileSync(join(home, 'SOUL.md'), bytes);
    const r = apply(ws, home, '--mode', 'append');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is not UTF-8');
    expect(r.stderr).not.toContain('Traceback');
    expect(readFileSync(join(home, 'SOUL.md')).equals(bytes)).toBe(true);
  });

  test('CRLF files keep CRLF line endings', () => {
    const ws = bank();
    const home = hermesHome('# Mine\r\nKeep.\r\n');
    expect(apply(ws, home, '--mode', 'append').code).toBe(0);
    const soul = soulOf(home);
    expect(soul.startsWith('# Mine\r\nKeep.\r\n')).toBe(true);
    expect(soul.replace(/\r\n/g, '')).not.toContain('\n');
  });

  test('refuses the Hermes home as the bank workspace, and a workspace that was never rendered', () => {
    const home = hermesHome();
    const same = apply(home, home);
    expect(same.code).toBe(1);
    expect(same.stderr).toContain('must not be the Hermes home');

    const empty = mkdtempSync(join(tmpdir(), 'gbrain-hermes-apply-empty-'));
    mkdirSync(join(empty, 'state'));
    const r = apply(empty, home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Render all five first');
    expect(existsSync(join(home, 'SOUL.md'))).toBe(false);
  });

  test('a partial render refuses and leaves an existing complete block intact', () => {
    const ws = bank();
    const home = hermesHome();
    expect(apply(ws, home).code).toBe(0);
    const complete = soulOf(home);
    for (const name of ['AGENTS.md', 'ACCESS_POLICY.md', 'USER.md', 'HEARTBEAT.md']) {
      const partial = bank();
      rmSync(join(partial, name));
      const r = apply(partial, home);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`${name} missing`);
      expect(soulOf(home)).toBe(complete);
    }
    expect(complete).toContain('RED LINES');
    expect(complete).toContain('What the model provider sees');
  });

  test('an answer that looks like a workspace-only gate is kept, not filtered', () => {
    const sentinel = '\u26d4 **PRIVATE REPO PERSISTENCE.** REDLINE_SENTINEL: Never publish the private identity.';
    const ws = bank({ SAFETY_RED_LINES: sentinel, AGENT_NON_JOBS: '**Gate 6 \u2014 Skill routing.** NONJOB_SENTINEL' });
    const home = hermesHome();
    expect(apply(ws, home).code).toBe(0);
    const soul = soulOf(home);
    expect(soul).toContain('REDLINE_SENTINEL: Never publish the private identity.');
    expect(soul).toContain('NONJOB_SENTINEL');
    expect(soul).not.toContain('This workspace is the durable self');
  });

  test('an answer that copies a workspace-only template paragraph word for word is never removed', () => {
    const paragraph = '\u26d4 **PRIVATE REPO PERSISTENCE.** This workspace is the durable self: identity,\n'
      + 'memory, brain, skills, schedules. After meaningful changes, ensure it reaches the\n'
      + 'private remote (`gbrain sources push` does this with a secret scan; it refuses\n'
      + 'public remotes). Never let valuable work exist only on one machine. If something\n'
      + 'seems broken, the one command to run is `gbrain doctor`.';
    const ws = bank({ SAFETY_RED_LINES: `- Never leak the bank.\n\n${paragraph}` });
    const home = hermesHome();
    expect(apply(ws, home).code).toBe(0);
    // Ambiguous (two copies): the helper leaves both rather than guess which is the user's.
    expect(count(soulOf(home), 'This workspace is the durable self')).toBe(2);
    expect(soulOf(home)).toContain('Never leak the bank.');
  });

  test('the check-in cadence answer reaches the block', () => {
    const ws = bank({ HEARTBEAT_CADENCE: 'CADENCE_SENTINEL: brief me Tuesday mornings at 7.' });
    const home = hermesHome();
    expect(apply(ws, home).code).toBe(0);
    const soul = soulOf(home);
    expect(soul).toContain('## Check-in cadence');
    expect(soul).toContain('CADENCE_SENTINEL: brief me Tuesday mornings at 7.');
    expect(soul).toContain('This block creates none.');
    expect(soul).not.toContain('heartbeat-state.local.json');
  });

  test('bytes outside the block survive exactly: trailing whitespace on append, mixed endings on update', () => {
    const ws = bank();
    const prefix = '# Mine  \r\nlf line\n\n\n';
    const home = hermesHome(prefix);
    expect(apply(ws, home, '--mode', 'append').code).toBe(0);
    expect(soulOf(home).startsWith(prefix)).toBe(true);

    const suffix = '\r\ntail with CRLF\r\nand LF\n  ';
    writeFileSync(join(home, 'SOUL.md'), soulOf(home) + suffix);
    setAnswer(ws, 'VOICE_REGISTER', 'Casual and brief.');
    renderWorkspace(ws, { only: ONLY, force: true });
    expect(apply(ws, home).code).toBe(0);
    const soul = soulOf(home);
    expect(soul.startsWith(prefix)).toBe(true);
    expect(soul.endsWith(END + '\n' + suffix)).toBe(true);
    expect(soul).toContain('Casual and brief.');
  });

  test('a workspace path containing a block marker cannot add a delimiter', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-hermes-apply-path-'));
    const odd = join(parent, `ws ${END} x`);
    mkdirSync(odd);
    const ws = bank();
    for (const name of [...ONLY, 'state']) cpSync(join(ws, name), join(odd, name), { recursive: true });
    const home = hermesHome();
    expect(apply(odd, home).code).toBe(0);
    expect(count(soulOf(home), END)).toBe(1);
    expect(apply(odd, home).stdout).toContain('unchanged');
  });
});
