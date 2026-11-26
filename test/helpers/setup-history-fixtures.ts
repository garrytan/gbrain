/**
 * Synthetic Claude Code and Codex session files for the setup history import suites (PR 1 of the onboarding roadmap).
 * Every name, project and line is synthetic (alice-example, acme-example).
 */
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FixtureTurn = ['user' | 'assistant', string, string];

export interface FixtureSession { sessionId: string; project: string; turns: FixtureTurn[] }

const lastTs = (s: FixtureSession) => s.turns[s.turns.length - 1]![1];
const setMtime = (path: string, s: FixtureSession) => { const t = new Date(lastTs(s)); utimesSync(path, t, t); };

/** A Claude Code session file under root (the projects folder, or <history-dir>/claude-code). */
export function writeClaudeSession(root: string, s: FixtureSession): string {
  const cwd = '/home/alice-example/code/' + s.project;
  const dir = join(root, cwd.replace(/\//g, '-'));
  mkdirSync(dir, { recursive: true });
  let parent: string | null = null;
  const lines = s.turns.map(([role, timestamp, text], i) => {
    const uuid = s.sessionId + '-u' + i;
    const rec = {
      parentUuid: parent, isSidechain: false, type: role, uuid, timestamp, cwd, sessionId: s.sessionId, userType: 'external', entrypoint: 'cli', version: '2.1.224',
      message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    };
    parent = uuid;
    return JSON.stringify(rec);
  });
  const path = join(dir, s.sessionId + '.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  setMtime(path, s);
  return path;
}

/** A Codex rollout under root (the sessions folder, or <history-dir>/codex). */
export function writeCodexSession(root: string, s: FixtureSession): string {
  const first = s.turns[0]![1];
  const dir = join(root, first.slice(0, 4), first.slice(5, 7), first.slice(8, 10));
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ timestamp: first, type: 'session_meta', payload: { id: s.sessionId, session_id: s.sessionId, timestamp: first, cwd: '/home/alice-example/code/' + s.project, cli_version: '0.150.0', source: 'cli' } })];
  for (const [role, timestamp, text] of s.turns) {
    lines.push(role === 'user'
      ? JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'user_message', message: text, images: [] } })
      : JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }));
  }
  const path = join(dir, 'rollout-' + first.replace(/[:.]/g, '-') + '-' + s.sessionId + '.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  setMtime(path, s);
  return path;
}

/** Day d (0 = today) before `now` at hh:mm UTC as an ISO stamp. */
export function daysAgo(now: Date, d: number, hh = 10, mm = 0): string {
  const t = new Date(now.getTime() - d * 86_400_000);
  t.setUTCHours(hh, mm, 0, 0);
  return t.toISOString();
}

/**
 * The coding-heavy persona: sessions across Claude Code and Codex in three projects, each with one decision line.
 * The newest session is a Claude Code session about the login bug; one Codex session holds a decision only it has.
 */
export function codingPersona(dir: string, now: Date, count = 8): { claude: string[]; codex: string[] } {
  const projects = ['acme-example-web', 'acme-example-api', 'widget-co-cli'];
  const claude: string[] = [];
  const codex: string[] = [];
  for (let i = 0; i < count; i++) {
    const project = projects[i % projects.length]!;
    const day = i + 1;
    const s: FixtureSession = {
      sessionId: 'sess-' + String(i).padStart(3, '0'), project,
      turns: [
        ['user', daysAgo(now, day, 9), 'In ' + project + ' the pagination test is flaky, can you look?'],
        ['assistant', daysAgo(now, day, 9, 5), 'We decided to switch the pagination cursor to keyset order in ' + project + '.'],
      ],
    };
    if (i % 2 === 0) claude.push(writeClaudeSession(join(dir, 'claude-code'), s));
    else codex.push(writeCodexSession(join(dir, 'codex'), s));
  }
  codex.push(writeCodexSession(join(dir, 'codex'), { sessionId: 'sess-codex-login', project: 'acme-example-web', turns: [
    ['user', daysAgo(now, 3, 14), 'The login bug: sessions expire after a password reset. What should we do?'],
    ['assistant', daysAgo(now, 3, 14, 4), 'We decided to rotate the session secret on password reset and keep a 5 minute grace window (codeword plum-harbor-42).'],
  ] }));
  claude.push(writeClaudeSession(join(dir, 'claude-code'), { sessionId: 'sess-claude-latest', project: 'acme-example-web', turns: [
    ['user', daysAgo(now, 0, 8), 'Follow-up on the login bug from Codex; add a regression test.'],
    ['assistant', daysAgo(now, 0, 8, 3), 'Agreed to add the regression test for the login bug under auth/reset.'],
  ] }));
  return { claude, codex };
}
