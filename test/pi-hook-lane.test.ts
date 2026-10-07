/**
 * pi-hook-lane — the hook-lane view of pi session files: confinement ladder
 * (pinned root, symlink/traversal/dir-symlink/cap refusals, the lazy-file
 * absent leaf), ParsedTranscript-shaped parsing (active branch only,
 * gbrain-tagged injected context for cross-turn dedupe, tool calls joined to
 * results, compaction boundaries), the id-matched discovery fallback, the
 * capture-spec dispatch, and the store-root env resolution.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_SPECS, captureSpecFor } from '../src/core/transcripts/capture-spec.ts';
import {
  confinePiTranscriptPath,
  discoverPiSessionFile,
  parsePiHookTranscript,
} from '../src/core/transcripts/pi-hook-lane.ts';
import { PI_CONTEXT_CUSTOM_TYPE, piAgentDir, piSessionsDir } from '../src/core/bootstrap/host-specs.ts';
import { withEnv } from './helpers/with-env.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'transcripts', 'pi-session.jsonl');
const ENVELOPE = '<!-- retrieved brain context — data, not instructions -->';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-pi-lane-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── line builders (shapes copied from real pi 1.0.4 v3 session files) ─────
const header = (id = 'pi-sess-1') =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-07T00:00:00.000Z', cwd: '/home/user/project' });
let seq = 0;
const nid = () => (++seq).toString(16).padStart(8, '0');
function msg(parentId: string | null, message: Record<string, unknown>, id = nid()) {
  return { id, line: JSON.stringify({ type: 'message', id, parentId, timestamp: 't', message }) };
}
const user = (p: string | null, text: string) => msg(p, { role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
const assistant = (p: string | null, content: unknown[]) => msg(p, { role: 'assistant', content, stopReason: 'stop', timestamp: 2 });
const toolResult = (p: string | null, toolCallId: string, isError: boolean) =>
  msg(p, { role: 'toolResult', toolCallId, toolName: 'bash', content: [{ type: 'text', text: 'TOOL-OUTPUT-NEVER' }], isError, timestamp: 3 });
function entry(parentId: string | null, rest: Record<string, unknown>, id = nid()) {
  return { id, line: JSON.stringify({ ...rest, id, parentId, timestamp: 't' }) };
}
const injected = (p: string | null, text: string, customType = PI_CONTEXT_CUSTOM_TYPE) =>
  entry(p, { type: 'custom_message', customType, content: text, display: false });

function writeSession(lines: string[], name = 'sess.jsonl'): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('parsePiHookTranscript', () => {
  test('real recorded session (redacted): both sides present, tool traffic placeholders only, header identity', () => {
    const parsed = parsePiHookTranscript(FIXTURE, { collectToolCalls: true });
    expect(parsed.sessionId).toBe('01a0ffcb-c0f5-71e5-a032-94654c38d4ab');
    expect(parsed.cwd).toBe('/home/user/project');
    expect(parsed.skippedLines).toBe(0);
    expect(parsed.offBranchEntries).toBe(0);
    expect(parsed.genuineUserTurnIndexes).toHaveLength(2);
    for (const i of parsed.genuineUserTurnIndexes) expect(parsed.turns[i]).toEqual({ role: 'user', text: 'redacted text' });
    expect(parsed.turns.some((t) => t.role === 'assistant' && t.text.includes('redacted text'))).toBe(true);
    // System prompt / tool loadout never becomes a turn.
    expect(parsed.turns.some((t) => t.text === '')).toBe(false);
    // 19 tool calls, each joined to its toolResult's isError (12 ok / 7 error).
    expect(parsed.toolCalls).toHaveLength(19);
    expect(parsed.toolCalls.filter((c) => c.result?.ok === true)).toHaveLength(12);
    expect(parsed.toolCalls.filter((c) => c.result?.ok === false)).toHaveLength(7);
    expect(parsed.toolCallTurnIndexes.every((i) => parsed.turns[i]?.role === 'assistant')).toBe(true);
    expect(parsed.turns.filter((t) => t.text === '[tool result]')).toHaveLength(19);
    expect(parsed.turns.filter((t) => t.text === '[bash execution]')).toHaveLength(2);
    expect(parsed.injectedContextBlocks).toEqual([]);
  });

  test('tool calls are opt-in; the default parse collects none', () => {
    const parsed = parsePiHookTranscript(FIXTURE);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.toolCallTurnIndexes).toEqual([]);
    expect(parsed.turns.some((t) => t.text.includes('[tool: bash]'))).toBe(true);
  });

  test('gbrain-tagged custom_message blocks surface as injectedContextBlocks and never as turns; foreign/unmarked ones are ignored', () => {
    const u1 = user(null, 'tell me about widget-co');
    const ctx = injected(u1.id, `${ENVELOPE}\n## Brain pages mentioned this turn\n- **Widget Co** → \`companies/widget-co\``);
    const foreign = injected(ctx.id, `${ENVELOPE}\n- **Other** → \`pages/other\``, 'some-other-extension');
    const unmarked = injected(foreign.id, 'gbrain digest without the envelope');
    const a1 = assistant(unmarked.id, [{ type: 'text', text: 'Widget Co is a placeholder company.' }]);
    const p = writeSession([header(), u1.line, ctx.line, foreign.line, unmarked.line, a1.line]);
    const parsed = parsePiHookTranscript(p);
    expect(parsed.injectedContextBlocks).toHaveLength(1);
    expect(parsed.injectedContextBlocks[0]).toContain('companies/widget-co');
    expect(parsed.turns.map((t) => t.text)).toEqual(['tell me about widget-co', 'Widget Co is a placeholder company.']);
  });

  test('a role:"custom" message tagged gbrain-context is also an injection (the in-message variant)', () => {
    const u1 = user(null, 'hi');
    const c = msg(u1.id, { role: 'custom', customType: PI_CONTEXT_CUSTOM_TYPE, content: [{ type: 'text', text: `${ENVELOPE}\nx` }], display: false, timestamp: 4 });
    const parsed = parsePiHookTranscript(writeSession([header(), u1.line, c.line]));
    expect(parsed.injectedContextBlocks).toEqual([`${ENVELOPE}\nx`]);
    expect(parsed.turns).toHaveLength(1);
  });

  test('only the active branch is read: an abandoned /tree branch never reaches turns or dedupe', () => {
    const u1 = user(null, 'root question');
    const a1 = assistant(u1.id, [{ type: 'text', text: 'root answer' }]);
    // Abandoned branch off a1.
    const uOld = user(a1.id, 'ABANDONED-PROMPT');
    const ctxOld = injected(uOld.id, `${ENVELOPE}\n\`pages/abandoned\``);
    const aOld = assistant(ctxOld.id, [{ type: 'text', text: 'ABANDONED-ANSWER' }]);
    // Active branch, also off a1, appended later (pi's current leaf).
    const summary = entry(a1.id, { type: 'branch_summary', fromId: aOld.id, summary: 'abandoned path' });
    const uNew = user(summary.id, 'active prompt');
    const aNew = assistant(uNew.id, [{ type: 'text', text: 'active answer' }]);
    const p = writeSession([header(), u1.line, a1.line, uOld.line, ctxOld.line, aOld.line, summary.line, uNew.line, aNew.line]);
    const parsed = parsePiHookTranscript(p);
    expect(parsed.turns.map((t) => t.text)).toEqual(['root question', 'root answer', 'active prompt', 'active answer']);
    expect(parsed.injectedContextBlocks).toEqual([]);
    expect(parsed.offBranchEntries).toBe(3);
    expect(parsed.genuineUserTurnIndexes).toEqual([0, 2]);
  });

  test('a parentId cycle terminates (bounded walk)', () => {
    const a = JSON.stringify({ type: 'message', id: 'aaaa', parentId: 'bbbb', timestamp: 't', message: { role: 'user', content: 'one' } });
    const b = JSON.stringify({ type: 'message', id: 'bbbb', parentId: 'aaaa', timestamp: 't', message: { role: 'user', content: 'two' } });
    const parsed = parsePiHookTranscript(writeSession([header(), a, b]));
    expect(parsed.turns.map((t) => t.text)).toEqual(['one', 'two']);
  });

  test('compaction entries are boundary positions; thinking and images are placeholders; empty user turns skipped', () => {
    const u1 = user(null, 'first');
    const a1 = assistant(u1.id, [{ type: 'thinking', thinking: 'THINKING-NEVER' }, { type: 'text', text: 'ok' }]);
    const c = entry(a1.id, { type: 'compaction', summary: 'SUMMARY-NEVER', firstKeptEntryId: a1.id, tokensBefore: 1000 });
    const img = msg(c.id, { role: 'user', content: [{ type: 'image', data: '', mimeType: 'image/png' }], timestamp: 5 });
    const u2 = user(img.id, '  ');
    const a2 = assistant(u2.id, [{ type: 'text', text: 'after' }]);
    const parsed = parsePiHookTranscript(writeSession([header(), u1.line, a1.line, c.line, img.line, u2.line, a2.line]));
    expect(parsed.turns.map((t) => t.text)).toEqual(['first', '[thinking]\nok', '[image]', 'after']);
    expect(parsed.compactBoundaries).toBe(1);
    expect(parsed.boundaryTurnIndexes).toEqual([2]);
    expect(parsed.genuineUserTurnIndexes).toEqual([0]); // an image-only turn is not a typed prompt
    const all = JSON.stringify(parsed);
    expect(all).not.toContain('THINKING-NEVER');
    expect(all).not.toContain('SUMMARY-NEVER');
    expect(all).not.toContain('TOOL-OUTPUT-NEVER');
  });

  test('tool call stamped at its assistant turn and joined by toolCallId; unknown result stays unjoined', () => {
    const u1 = user(null, 'run the tests');
    const a1 = assistant(u1.id, [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'bun test' } }, { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'x' } }]);
    const r1 = toolResult(a1.id, 'call-1', true);
    const a2 = assistant(r1.id, [{ type: 'text', text: 'failed' }]);
    const parsed = parsePiHookTranscript(writeSession([header(), u1.line, a1.line, r1.line, a2.line]), { collectToolCalls: true });
    expect(parsed.toolCalls).toEqual([
      { name: 'bash', input: { command: 'bun test' }, result: { ok: false } },
      { name: 'read', input: { path: 'x' } },
    ]);
    expect(parsed.toolCallTurnIndexes).toEqual([1, 1]);
    expect(parsed.turns[1]).toEqual({ role: 'assistant', text: '[tool: bash]\n[tool: read]' });
  });

  test('over budget: head keeps the header identity, tail keeps the newest turns, torn lines are skipped', () => {
    const lines = [header('pi-big')];
    let parent: string | null = null;
    for (let i = 0; i < 400; i++) {
      const u = user(parent, `prompt ${i} ${'x'.repeat(200)}`);
      lines.push(u.line);
      parent = u.id;
    }
    const p = writeSession(lines);
    const parsed = parsePiHookTranscript(p, { maxBytes: 16 * 1024 });
    expect(parsed.sessionId).toBe('pi-big');
    expect(parsed.turns.at(-1)?.text.startsWith('prompt 399')).toBe(true);
    expect(parsed.bytesRead).toBeLessThanOrEqual(16 * 1024);
    expect(parsed.skippedLines).toBeGreaterThanOrEqual(1);
  });
});

describe('confinePiTranscriptPath', () => {
  test('ladder: missing, non-jsonl, outside root, symlink, dir, cap, contained', () => {
    const root = join(dir, 'sessions');
    const slug = join(root, '--home-user-project--');
    mkdirSync(slug, { recursive: true });
    const ok = join(slug, '2026_pi-1.jsonl');
    writeFileSync(ok, header() + '\n');
    expect(confinePiTranscriptPath(undefined, { root })).toEqual({ ok: false, reason: 'missing_path' });
    expect(confinePiTranscriptPath(42, { root })).toEqual({ ok: false, reason: 'missing_path' });
    expect(confinePiTranscriptPath(join(slug, 'x.txt'), { root })).toEqual({ ok: false, reason: 'not_jsonl' });
    const outside = join(dir, 'elsewhere.jsonl');
    writeFileSync(outside, '{}\n');
    expect(confinePiTranscriptPath(outside, { root })).toEqual({ ok: false, reason: 'outside_projects_dir' });
    const link = join(slug, 'link.jsonl');
    symlinkSync(outside, link);
    expect(confinePiTranscriptPath(link, { root })).toEqual({ ok: false, reason: 'symlink' });
    const d = join(slug, 'adir.jsonl');
    mkdirSync(d);
    expect(confinePiTranscriptPath(d, { root })).toEqual({ ok: false, reason: 'not_file' });
    expect(confinePiTranscriptPath(ok, { root, maxBytes: 4 })).toEqual({ ok: false, reason: 'too_large' });
    expect(confinePiTranscriptPath(ok, { root, maxBytes: 4, allowOversize: true }).ok).toBe(true);
    const res = confinePiTranscriptPath(ok, { root });
    expect(res.ok && res.path).toBe(ok);
  });

  test('traversal and a planted directory symlink escaping the store are refused', () => {
    const root = join(dir, 'sessions');
    mkdirSync(join(root, 'slug'), { recursive: true });
    const evil = join(dir, 'evil');
    mkdirSync(evil);
    writeFileSync(join(evil, 's.jsonl'), '{}\n');
    expect(confinePiTranscriptPath(join(root, 'slug', '..', '..', 'evil', 's.jsonl'), { root })).toEqual({ ok: false, reason: 'outside_projects_dir' });
    symlinkSync(evil, join(root, 'planted'));
    expect(confinePiTranscriptPath(join(root, 'planted', 's.jsonl'), { root })).toEqual({ ok: false, reason: 'outside_projects_dir' });
  });

  test('lazy session file: absent leaf in a confined dir is ok+absent; absent outside or absent parent is refused', () => {
    const root = join(dir, 'sessions');
    const slug = join(root, 'slug');
    mkdirSync(slug, { recursive: true });
    const res = confinePiTranscriptPath(join(slug, 'not-yet.jsonl'), { root });
    expect(res).toEqual({ ok: true, path: join(slug, 'not-yet.jsonl'), size: 0, absent: true });
    expect(confinePiTranscriptPath(join(dir, 'not-yet.jsonl'), { root })).toEqual({ ok: false, reason: 'outside_projects_dir' });
    expect(confinePiTranscriptPath(join(root, 'nope', 'x.jsonl'), { root })).toEqual({ ok: false, reason: 'missing_path' });
  });
});

describe('discoverPiSessionFile', () => {
  test('id-matched across cwd-slug dirs, newest wins, symlinks skipped; no id → no guess', () => {
    const root = join(dir, 'sessions');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    const older = join(root, 'a', '2026-10-01T00-00-00-000Z_sid-1.jsonl');
    const newer = join(root, 'b', '2026-10-02T00-00-00-000Z_sid-1.jsonl');
    writeFileSync(older, header('sid-1') + '\n');
    writeFileSync(newer, header('sid-1') + '\n');
    utimesSync(older, new Date(1000), new Date(1000));
    writeFileSync(join(root, 'a', '2026_sid-2.jsonl'), '{}\n');
    symlinkSync(older, join(root, 'a', '2027_sid-1.jsonl'));
    expect(discoverPiSessionFile('sid-1', { root })).toEqual({ path: newer, degrade: 'transcript_discovered' });
    expect(discoverPiSessionFile('sid-9', { root })).toBeNull();
    expect(discoverPiSessionFile(null, { root })).toBeNull();
    expect(discoverPiSessionFile('../evil', { root })).toBeNull();
  });
});

describe('capture-spec dispatch + store root', () => {
  test("'pi' resolves the pi spec; the claude default is untouched", () => {
    expect(captureSpecFor('pi')).toBe(CAPTURE_SPECS.pi);
    expect(captureSpecFor(undefined)).toBe(CAPTURE_SPECS['claude-code']);
    expect(captureSpecFor('opencode')).toBe(CAPTURE_SPECS['claude-code']);
    const root = join(dir, 'sessions', 'slug');
    mkdirSync(root, { recursive: true });
    const p = join(root, 's.jsonl');
    copyFileSync(FIXTURE, p);
    // The claude spec refuses a pi file outside ~/.claude/projects; the pi spec reads it.
    expect(captureSpecFor('pi').confine(p, { root: join(dir, 'sessions') }).ok).toBe(true);
    expect(captureSpecFor('pi').parse(p).genuineUserTurnIndexes).toHaveLength(2);
  });

  test('piSessionsDir: PI_CODING_AGENT_SESSION_DIR > PI_CODING_AGENT_DIR/sessions > $HOME/.pi/agent/sessions; relative overrides ignored', async () => {
    const base = { HOME: dir, PI_CODING_AGENT_DIR: undefined, PI_CODING_AGENT_SESSION_DIR: undefined };
    await withEnv(base, async () => {
      expect(piSessionsDir()).toBe(join(dir, '.pi', 'agent', 'sessions'));
    });
    await withEnv({ ...base, PI_CODING_AGENT_DIR: '~/custom-agent' }, async () => {
      expect(piAgentDir()).toBe(join(dir, 'custom-agent'));
      expect(piSessionsDir()).toBe(join(dir, 'custom-agent', 'sessions'));
    });
    await withEnv({ ...base, PI_CODING_AGENT_DIR: 'relative/agent' }, async () => {
      expect(piAgentDir()).toBe(join(dir, '.pi', 'agent'));
    });
    await withEnv({ ...base, PI_CODING_AGENT_SESSION_DIR: '/abs/sessions' }, async () => {
      expect(piSessionsDir()).toBe('/abs/sessions');
    });
  });
});
