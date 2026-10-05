/**
 * transcripts-cursor.test.ts — the Cursor agent-transcript adapter.
 *
 * Protects: Cursor conversations import as text-turn sessions with the real
 * per-prompt times Cursor writes into each user row; discovery and directory
 * expansion pick up conversations and nothing else from Cursor's project
 * store; a host-format change lands in the drift lane instead of silently
 * advancing the --since watermark. No existing owner: before this adapter
 * the format was `unknown format` everywhere.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cursorAdapter,
  isCursorConversationFile,
  isCursorNonConversationFile,
  mapCursorLine,
  parseCursorTimestamp,
} from '../src/core/transcripts/cursor.ts';
import { detectAdapter, readSample } from '../src/core/transcripts/detect.ts';
import { buildStatusRows, discoverTranscriptFiles } from '../src/core/transcripts/discover.ts';
import { runTranscriptsIngest } from '../src/core/transcripts/ingest.ts';
import type { FileDiagnostics, ParsedSession } from '../src/core/transcripts/types.ts';
import { expandPaths } from '../src/commands/transcripts.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'cursor-agent-transcript.jsonl');
const CLAUDE_CODE_FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'claude-code.jsonl');
const CODEX_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'codex-rollout.jsonl');
const GROK_FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'grok-session', 'chat_history.jsonl');
const CONVERSATION_ID = '0b7c4f3e-5d2a-4c1b-9e8f-112233445566';
const SLUG = 'home-alice-example-agent-workspace';

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-cursor-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

async function drain(
  gen: AsyncGenerator<ParsedSession, FileDiagnostics>,
): Promise<{ sessions: ParsedSession[]; diag: FileDiagnostics }> {
  const sessions: ParsedSession[] = [];
  let r = await gen.next();
  while (!r.done) {
    sessions.push(r.value);
    r = await gen.next();
  }
  return { sessions, diag: r.value };
}

/** A Cursor project store under `<root>/.cursor/projects/<slug>/`, as Cursor lays it out. */
function writeCursorStore(root: string, opts: { body?: string; extras?: boolean } = {}): string {
  const project = join(root, '.cursor', 'projects', SLUG);
  const convDir = join(project, 'agent-transcripts', CONVERSATION_ID);
  mkdirSync(convDir, { recursive: true });
  const p = join(convDir, `${CONVERSATION_ID}.jsonl`);
  writeFileSync(p, opts.body ?? readFileSync(FIXTURE, 'utf8'));
  if (opts.extras) {
    mkdirSync(join(convDir, 'subagents'), { recursive: true });
    writeFileSync(join(convDir, 'subagents', 'aa11bb22-0000-4000-8000-000000000001.jsonl'), readFileSync(FIXTURE, 'utf8'));
    mkdirSync(join(project, 'mcps', 'gbrain', 'tools'), { recursive: true });
    writeFileSync(join(project, 'mcps', 'gbrain', 'tools', 'search.json'), '{"name":"search"}');
    writeFileSync(join(project, 'mcps', 'gbrain', 'SERVER_METADATA.json'), '{"server":"gbrain"}');
    mkdirSync(join(project, 'agent-tools'), { recursive: true });
    writeFileSync(join(project, 'agent-tools', 'call-1.txt'), 'tool output');
  }
  return p;
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function userRow(ts: string | null, query: string): string {
  const head = ts === null ? '' : `<timestamp>${ts}</timestamp>\n`;
  return line({ role: 'user', message: { content: [{ type: 'text', text: `${head}<user_query>\n${query}\n</user_query>` }] } });
}

function assistantRow(text: string): string {
  return line({ role: 'assistant', message: { content: [{ type: 'text', text }] } });
}

describe('parseCursorTimestamp', () => {
  test('the shapes Cursor writes become UTC instants', () => {
    expect(parseCursorTimestamp('Friday, Sep 18, 2026, 10:48 AM (UTC+1)')).toBe('2026-09-18T09:48:00.000Z');
    expect(parseCursorTimestamp('Thursday, Sep 17, 2026, 8:39 PM (UTC+1)')).toBe('2026-09-17T19:39:00.000Z');
    expect(parseCursorTimestamp('Wednesday, Sep 16, 2026, 3:37 PM (UTC-4)')).toBe('2026-09-16T19:37:00.000Z');
    expect(parseCursorTimestamp('Tuesday, Jun 2, 2026, 11:20 AM (UTC+8)')).toBe('2026-06-02T03:20:00.000Z');
    expect(parseCursorTimestamp('Monday, Mar 2, 2026, 9:05 AM (UTC+5:30)')).toBe('2026-03-02T03:35:00.000Z');
    expect(parseCursorTimestamp('Monday, Mar 2, 2026, 21:05 (UTC)')).toBe('2026-03-02T21:05:00.000Z');
    expect(parseCursorTimestamp('Monday, March 2, 2026, 9:05:07 PM (UTC+0)')).toBe('2026-03-02T21:05:07.000Z');
    // 12 AM is midnight, 12 PM is noon; the offset can move the UTC date.
    expect(parseCursorTimestamp('Friday, Jan 1, 2027, 12:15 AM (UTC+2)')).toBe('2026-12-31T22:15:00.000Z');
    expect(parseCursorTimestamp('Friday, Jan 1, 2027, 12:15 PM (UTC-2)')).toBe('2027-01-01T14:15:00.000Z');
  });

  test('anything else is never guessed into a time', () => {
    for (const raw of [
      '',
      'yesterday',
      '2026-09-18T09:48:00Z', // not the shape Cursor writes; no guessing
      'Friday, Sep 18, 2026, 10:48 AM', // no offset: the instant is unknowable
      'Friday, Feb 30, 2026, 10:48 AM (UTC+1)', // not a calendar day
      'Friday, Sep 18, 2026, 13:48 PM (UTC+1)',
      'Friday, Sep 18, 2026, 24:00 (UTC+1)',
      'Friday, Sep 18, 2026, 10:60 AM (UTC+1)',
      'Friday, Sepx 18, 2026, 10:48 AM (UTC+1)',
      'Friday, Sep 18, 2026, 10:48 AM (UTC+15)',
    ]) {
      expect(parseCursorTimestamp(raw)).toBe('');
    }
  });
});

describe('mapCursorLine [SPEC_TARGET cursor-agent-transcripts-2026-10]', () => {
  test('a typed prompt is the <user_query> text, stamped from its <timestamp> tag', () => {
    const r = mapCursorLine(JSON.parse(userRow('Friday, Sep 18, 2026, 10:48 AM (UTC+1)', 'ship the fix')));
    expect(r).toEqual({
      kind: 'message',
      message: { role: 'user', timestamp: '2026-09-18T09:48:00.000Z', text: 'ship the fix' },
    });
    // Other wrappers around the query never reach the archive.
    const withImages = mapCursorLine({
      role: 'user',
      message: { content: [{ type: 'text', text: '<image_files>\n/tmp/shot.png\n</image_files>\n<user_query>look at this</user_query>' }] },
    });
    expect(withImages).toEqual({ kind: 'message', message: { role: 'user', timestamp: '', text: 'look at this' } });
  });

  test('injected context and text-free rows are typed; undecodable human rows are malformed', () => {
    const injected = { role: 'user', message: { content: [{ type: 'text', text: '<dynamic_tools>\n<id>x</id>\n</dynamic_tools>' }] } };
    expect(mapCursorLine(injected).kind).toBe('typed');
    expect(mapCursorLine({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Friday, Sep 18, 2026, 10:48 AM (UTC+1)</timestamp>' }] } }).kind).toBe('typed');
    expect(mapCursorLine({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] } }).kind).toBe('typed');
    expect(mapCursorLine({ role: 'assistant', message: { content: [{ type: 'text', text: '[REDACTED]' }, { type: 'tool_use', name: 'Read', input: {} }] } }).kind).toBe('typed');
    expect(mapCursorLine({ role: 'assistant', message: { content: [{ type: 'turn_ended', status: 'success' }] } }).kind).toBe('typed');
    expect(mapCursorLine({ role: 'system', message: { content: 'x' } }).kind).toBe('typed');

    expect(mapCursorLine({ role: 'user' }).kind).toBe('malformed');
    expect(mapCursorLine({ role: 'user', message: { content: 42 } }).kind).toBe('malformed');
    expect(mapCursorLine({ role: 'user', message: { content: ['bare string block'] } }).kind).toBe('malformed');
    expect(mapCursorLine({ role: 'assistant', message: { content: [{ type: 'text', body: 'moved' }] } }).kind).toBe('malformed');
    expect(mapCursorLine({ role: 'assistant', message: { text: 'moved off content' } }).kind).toBe('malformed');

    expect(mapCursorLine({ type: 'user', text: 'no role at all' }).kind).toBe('skip');
    expect(mapCursorLine('not an object').kind).toBe('skip');
  });

  test('bare-string content, unwrapped prompts and an unterminated <user_query> still import', () => {
    expect(mapCursorLine({ role: 'user', message: { content: 'plain older prompt' } })).toEqual({
      kind: 'message',
      message: { role: 'user', timestamp: '', text: 'plain older prompt' },
    });
    expect(mapCursorLine({ role: 'assistant', message: { content: 'plain answer' } })).toEqual({
      kind: 'message',
      message: { role: 'assistant', timestamp: '', text: 'plain answer' },
    });
    const cut = mapCursorLine({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>\nhalf a prompt' }] } });
    expect(cut).toEqual({ kind: 'message', message: { role: 'user', timestamp: '', text: 'half a prompt' } });
  });
});

describe('cursorAdapter.parse', () => {
  test('fixture: typed prompts and assistant text only; tool traffic, injected rows and placeholders never leak', async () => {
    const { sessions, diag } = await drain(cursorAdapter.parse(FIXTURE));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.meta.harness).toBe('cursor');
    expect(s.meta.sessionId).toBe('cursor-agent-transcript');
    expect(s.meta.startedAt).toBe('2026-08-08T10:00:00.000Z');
    expect(s.meta.raw?.timestamp_source).toBe('timestamp_tags');
    expect(s.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Which fund led the widget-co seed round?'],
      ['assistant', "I'll check the brain for the widget-co seed."],
      ['assistant', 'fund-a led the widget-co seed; fund-b participated.'],
      ['user', 'Great. Note that the bridge check-in is every Thursday.'],
      ['assistant', 'Noted: bridge check-in every Thursday.'],
    ]);
    const all = s.messages.map((m) => m.text).join('\n');
    expect(all).not.toContain('TOOL-INPUT-ONLY-TEXT');
    expect(all).not.toContain('INJECTED-ONLY-TEXT');
    expect(all).not.toContain('[REDACTED]');
    expect(all).not.toContain('<timestamp>');
    expect(all).not.toContain('<user_query>');
    // Each reply carries the time of the prompt it answers; the final reply
    // takes the file's last write (later than its prompt).
    expect(s.messages.slice(0, 4).map((m) => m.timestamp)).toEqual([
      '2026-08-08T10:00:00.000Z',
      '2026-08-08T10:00:00.000Z',
      '2026-08-08T10:00:00.000Z',
      '2026-08-08T10:04:00.000Z',
    ]);
    expect(s.messages[4].timestamp).toBe(statSync(FIXTURE).mtime.toISOString());
    expect(diag).toEqual({
      bytesRead: statSync(FIXTURE).size,
      skippedLines: 0,
      truncated: false,
      sessions: 1,
      expectedEmpty: false,
      zeroSessionsReason: undefined,
    });
  });

  test('the store layout names the session after the conversation directory and keeps the project slug', async () => {
    const p = writeCursorStore(tdir());
    const { sessions } = await drain(cursorAdapter.parse(p));
    expect(sessions[0].meta.sessionId).toBe(CONVERSATION_ID);
    expect(sessions[0].meta.raw?.project_slug).toBe(SLUG);
    expect(sessions[0].meta.raw?.source_path).toBe(p);
  });

  test('a reply still being written when ingest ran is not filtered out by the --since watermark it set', async () => {
    // Cursor stamps only prompts. Ingest mid-reply sets the watermark at the
    // last time it saw; if that were the prompt time, the finished reply
    // (same prompt time) would be `<= since` on every later run and never
    // import. The last line's write time keeps the session moving forward.
    const body =
      userRow('Saturday, Aug 8, 2026, 11:00 AM (UTC+1)', 'draft the recap') + assistantRow('Working on it');
    const p = writeCursorStore(tdir(), { body });
    const firstWrite = new Date('2026-08-08T10:00:30.000Z');
    utimesSync(p, firstWrite, firstWrite);
    const first = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(first.maxSessionTs).toBe('2026-08-08T10:00:30.000Z');

    writeFileSync(p, body + assistantRow('Here is the finished recap.'));
    const secondWrite = new Date('2026-08-08T10:02:10.000Z');
    utimesSync(p, secondWrite, secondWrite);
    const second = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
      sinceIso: first.maxSessionTs,
    });
    expect(second.sessionsFiltered).toBe(0);
    expect(second.sessionsSeen).toBe(1);
    expect(second.pages.planned).toBe(1);
  });

  test('a file whose mtime predates the last prompt keeps the prompt time (never moves a reply backwards)', async () => {
    const body = userRow('Saturday, Aug 8, 2026, 11:00 AM (UTC+1)', 'q') + assistantRow('a');
    const p = writeCursorStore(tdir(), { body });
    const earlier = new Date('2026-08-01T00:00:00.000Z');
    utimesSync(p, earlier, earlier);
    const { sessions } = await drain(cursorAdapter.parse(p));
    expect(sessions[0].messages.map((m) => m.timestamp)).toEqual([
      '2026-08-08T10:00:00.000Z',
      '2026-08-08T10:00:00.000Z',
    ]);
  });

  test('no parseable <timestamp> tag → every message takes the file mtime, stamped as such; still imports', async () => {
    const body = userRow(null, 'hello there') + assistantRow('hi');
    const p = writeCursorStore(tdir(), { body });
    const mtimeIso = statSync(p).mtime.toISOString();
    const { sessions, diag } = await drain(cursorAdapter.parse(p));
    expect(sessions[0].meta.startedAt).toBe(mtimeIso);
    expect(sessions[0].meta.raw?.timestamp_source).toBe('file_mtime');
    expect(sessions[0].messages.every((m) => m.timestamp === mtimeIso)).toBe(true);
    expect(diag.sessions).toBe(1);
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.erroredFiles).toBe(0);
    expect(r.sessionsErrored).toBe(0);
    expect(r.driftFiles).toBe(0);
    expect(r.pages.planned).toBe(1);
  });

  test('a tool-only conversation is an understood empty, not drift', async () => {
    const body =
      line({ role: 'user', message: { content: [{ type: 'text', text: '<dynamic_tools>x</dynamic_tools>' }] } }) +
      line({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell', input: { command: 'ls' } }] } });
    const p = writeCursorStore(tdir(), { body });
    const { sessions, diag } = await drain(cursorAdapter.parse(p));
    expect(sessions).toHaveLength(0);
    expect(diag.expectedEmpty).toBe(true);
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.driftFiles).toBe(0);
    expect(r.files[0].drift).toBe(false);
  });

  test('malformed lines are skipped and the rest of the conversation still imports', async () => {
    const body = readFileSync(FIXTURE, 'utf8') + '{"role":"assistant","message":{"content":[{"type":"te\n';
    const p = writeCursorStore(tdir(), { body });
    const { sessions, diag } = await drain(cursorAdapter.parse(p));
    expect(sessions[0].messages).toHaveLength(5);
    expect(diag.skippedLines).toBe(1);
  });

  test('rejects (never truncates) a transcript over the byte cap', async () => {
    await expect(drain(cursorAdapter.parse(FIXTURE, { maxBytes: 64 }))).rejects.toThrow(/too large/);
  });
});

describe('drift alarm', () => {
  test('rows whose text moved off message.content are malformed: zero sessions, driftFiles=1', async () => {
    const body = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const row = JSON.parse(l) as { role: string; message: { content: unknown } };
        return JSON.stringify({ role: row.role, message: { parts: row.message.content } });
      })
      .join('\n');
    const p = writeCursorStore(tdir(), { body });
    const { sessions, diag } = await drain(cursorAdapter.parse(p));
    expect(sessions).toHaveLength(0);
    expect(diag.expectedEmpty).toBe(false);
    expect(diag.zeroSessionsReason).toBe('no user/assistant text turns in cursor transcript (8 malformed user/assistant row(s))');
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.driftFiles).toBe(1);
    expect(r.erroredFiles).toBe(0);
    expect(r.files[0].drift).toBe(true);
  });

  test('a transcript-directory file in an unrecognised row shape stays in the cursor drift lane', async () => {
    // Cursor renames `role` → `type`: the head sniff no longer matches, but the
    // file still lives under agent-transcripts/, so it routes here and fires
    // the drift alarm instead of an anonymous unknown-format error.
    const body = line({ type: 'user', text: 'moved' }) + line({ type: 'assistant', text: 'moved too' });
    const p = writeCursorStore(tdir(), { body });
    const detected = detectAdapter(p);
    expect(detected.ok && detected.adapter.format).toBe('cursor');
    const r = await runTranscriptsIngest({} as never, {
      paths: [p],
      dryRun: true,
      sourceId: 'default',
      userPatternsPath: '/nonexistent',
    });
    expect(r.driftFiles).toBe(1);
    expect(r.erroredFiles).toBe(0);
    expect(r.files[0].drift).toBe(true);
  });
});

describe('detection, discovery and directory expansion', () => {
  test('auto-detect picks cursor by head shape and by store path; other harness fixtures are not claimed', () => {
    const r = detectAdapter(FIXTURE);
    expect(r.ok && r.adapter.format).toBe('cursor');
    for (const other of [CLAUDE_CODE_FIXTURE, CODEX_FIXTURE, GROK_FIXTURE]) {
      expect(cursorAdapter.detect(other, readSample(other))).toBe(false);
    }
    const p = writeCursorStore(tdir());
    const r2 = detectAdapter(p);
    expect(r2.ok && r2.adapter.format).toBe('cursor');
  });

  test('a claude-code session filed under an agent-transcripts directory still detects as claude-code', () => {
    const d = tdir();
    const p = join(d, 'agent-transcripts', 'claude-session.jsonl');
    mkdirSync(join(d, 'agent-transcripts'), { recursive: true });
    writeFileSync(p, readFileSync(CLAUDE_CODE_FIXTURE, 'utf8'));
    const r = detectAdapter(p);
    expect(r.ok && r.adapter.format).toBe('claude-code');
  });

  test('discovery keeps the conversation and drops sub-agent runs and project-store files; status gap matches the id', () => {
    const root = tdir();
    const p = writeCursorStore(root, { extras: true });
    const roots = [{ format: 'cursor' as const, root: join(root, '.cursor', 'projects'), extension: '.jsonl' as const }];
    const discovered = discoverTranscriptFiles(roots);
    expect(discovered.map((d) => d.path)).toEqual([p]);
    const imported = { byHarness: new Map([['cursor', new Set([CONVERSATION_ID])]]), pagesScanned: 1 };
    const row = buildStatusRows(discovered, imported, roots).find((x) => x.format === 'cursor')!;
    expect(row).toEqual({ format: 'cursor', found: 1, importedSessions: 1, gapFiles: 0 });
    const empty = { byHarness: new Map<string, Set<string>>(), pagesScanned: 0 };
    expect(buildStatusRows(discovered, empty, roots).find((x) => x.format === 'cursor')!.gapFiles).toBe(1);
  });

  test('ingesting the whole project store expands to the conversation only', async () => {
    const root = tdir();
    const p = writeCursorStore(root, { extras: true });
    expect(await expandPaths([join(root, '.cursor', 'projects')])).toEqual([p]);
  });

  test('the path rules are anchored: other trees with similar names are untouched', () => {
    expect(isCursorConversationFile('/x/.cursor/projects/s/agent-transcripts/id/id.jsonl')).toBe(true);
    expect(isCursorConversationFile('/x/.cursor/projects/s/agent-transcripts/id/subagents/sub.jsonl')).toBe(false);
    expect(isCursorNonConversationFile('/x/.cursor/projects/s/agent-transcripts/id/subagents/sub.jsonl')).toBe(true);
    expect(isCursorNonConversationFile('/x/.cursor/projects/s/mcps/srv/tools/t.json')).toBe(true);
    expect(isCursorNonConversationFile('/x/.cursor/projects/s/agent-transcripts/id/id.jsonl')).toBe(false);
    // A `subagents` directory outside agent-transcripts, or a projects tree
    // outside .cursor, is someone else's layout.
    expect(isCursorNonConversationFile('/x/.claude/projects/s/subagents/a.jsonl')).toBe(false);
    expect(isCursorNonConversationFile('/x/work/projects/s/mcps/t.json')).toBe(false);
  });
});
