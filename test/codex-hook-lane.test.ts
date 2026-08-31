/**
 * codex-hook-lane — the hook-lane view of codex rollouts: confinement ladder
 * (pinned root, symlink/traversal/cap refusals), ParsedTranscript-shaped
 * parsing with tool calls (observed keys only) and boundary positions, the
 * bounded discovery fallback, and the capture-spec dispatch golden rule
 * (undefined/unknown → claude spec, byte-for-byte today's behavior).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_SPECS, captureSpecFor } from '../src/core/transcripts/capture-spec.ts';
import {
  confineCodexTranscriptPath,
  discoverNewestCodexRollout,
  parseCodexHookTranscript,
} from '../src/core/transcripts/codex-hook-lane.ts';
import { mapCodexLine } from '../src/core/transcripts/codex.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-cdx-lane-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const meta = JSON.stringify({
  timestamp: 't0',
  type: 'session_meta',
  payload: { id: 'r-1', session_id: 'cdx-sess-1', timestamp: 't0', cwd: '/repo', cli_version: '0.147.0' },
});
const user = (text: string) => JSON.stringify({ timestamp: 't1', type: 'event_msg', payload: { type: 'user_message', message: text } });
const assistant = (text: string) =>
  JSON.stringify({ timestamp: 't2', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const injected = JSON.stringify({ timestamp: 't1', type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'INJECTED-NEVER' }] } });
const customCall = JSON.stringify({ timestamp: 't3', type: 'response_item', payload: { type: 'custom_tool_call', id: 'ri-4', name: 'search_brain', input: '{"query":"widget-co seed"}' } });
const fnCall = JSON.stringify({ timestamp: 't4', type: 'response_item', payload: { type: 'function_call', id: 'ri-6', call_id: 'c-1', name: 'shell', arguments: '{"command":["bash","-lc","bun test"]}' } });
const callOutput = JSON.stringify({ timestamp: 't5', type: 'response_item', payload: { type: 'custom_tool_call_output', id: 'ri-5', call_id: 'c-1', output: 'TOOL-OUTPUT-NEVER' } });
const boundary = JSON.stringify({ timestamp: 't6', type: 'compacted', payload: { message: 'compacted' } });

describe('parseCodexHookTranscript', () => {
  test('fixture parses: turns exclude injected context and tool output; calls carry observed args keys, span-stamped', () => {
    const p = join(dir, 'rollout-1.jsonl');
    writeFileSync(p, [meta, injected, user('fix the failing order tests'), customCall, callOutput, assistant('done — pushed the fix'), '{torn'].join('\n') + '\n');
    const parsed = parseCodexHookTranscript(p, { collectToolCalls: true });
    expect(parsed.sessionId).toBe('cdx-sess-1');
    expect(parsed.cwd).toBe('/repo');
    expect(parsed.turns.map((t) => t.text)).toEqual(['fix the failing order tests', 'done — pushed the fix']);
    // custom_tool_call args key is `input` (fixture-verified), a JSON string → parsed.
    expect(parsed.toolCalls).toEqual([{ name: 'search_brain', input: { query: 'widget-co seed' } }]);
    // Stamped between turn 0 and turn 1 — the slot it precedes.
    expect(parsed.toolCallTurnIndexes).toEqual([1]);
    expect(parsed.skippedLines).toBe(1); // the torn line
    // No result join: 0.147.0 persists no success flag on *_output rows.
    expect('result' in (parsed.toolCalls[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  test('function_call args key is `arguments` (source-verified); non-JSON args stay the raw string', () => {
    const p = join(dir, 'rollout-2.jsonl');
    const rawArgs = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: 'not json at all' } });
    writeFileSync(p, [meta, user('run it'), fnCall, rawArgs].join('\n') + '\n');
    const parsed = parseCodexHookTranscript(p, { collectToolCalls: true });
    // Same opt-in contract as the claude parser: the bare parse collects nothing.
    expect(parseCodexHookTranscript(p).toolCalls).toEqual([]);
    expect(parsed.toolCalls).toEqual([
      { name: 'shell', input: { command: ['bash', '-lc', 'bun test'] } },
      { name: 'shell', input: 'not json at all' },
    ]);
  });

  test('observed args are bounded by the shared cap — one receipt-size ceiling for every harness', () => {
    const p = join(dir, 'rollout-cap.jsonl');
    const body = 'C'.repeat(40_000); // over TOOL_CALL_VALUE_MAX_CHARS (32k)
    const fatCall = JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: body }) },
    });
    writeFileSync(p, [meta, user('write it'), fatCall].join('\n') + '\n');
    const parsed = parseCodexHookTranscript(p, { collectToolCalls: true });
    const input = parsed.toolCalls[0]!.input as { command: string };
    expect(input.command).toContain('…[8000 chars omitted]');
    expect(input.command.length).toBeLessThan(40_000);
  });

  test('compacted rows record boundary positions in turn space', () => {
    const p = join(dir, 'rollout-3.jsonl');
    writeFileSync(p, [meta, user('one'), boundary, user('two'), assistant('three')].join('\n') + '\n');
    const parsed = parseCodexHookTranscript(p);
    expect(parsed.compactBoundaries).toBe(1);
    expect(parsed.boundaryTurnIndexes).toEqual([1]);
    expect(parsed.turns).toHaveLength(3);
  });

  test('over-budget read keeps session_meta identity (head) and the newest turns (tail)', () => {
    const p = join(dir, 'rollout-big.jsonl');
    const lines = [meta];
    for (let i = 0; i < 2000; i++) lines.push(user(`turn-${i} ${'x'.repeat(400)}`));
    writeFileSync(p, lines.join('\n') + '\n');
    const parsed = parseCodexHookTranscript(p, { maxBytes: 128 * 1024 });
    expect(parsed.sessionId).toBe('cdx-sess-1'); // head window preserved identity
    expect(parsed.turns[parsed.turns.length - 1]!.text).toContain('turn-1999'); // newest tail kept
    expect(parsed.bytesRead).toBeLessThanOrEqual(128 * 1024);
  });
});

describe('confineCodexTranscriptPath — the S3#8 ladder on the codex root', () => {
  test('accepts a rollout inside the pinned root; refuses everything the ladder names', () => {
    const root = join(dir, 'sessions');
    const day = join(root, '2026', '08', '25');
    mkdirSync(day, { recursive: true });
    const ok = join(day, 'rollout-x.jsonl');
    writeFileSync(ok, meta + '\n');
    expect(confineCodexTranscriptPath(ok, { root })).toEqual({ ok: true, path: ok, size: expect.any(Number) });

    expect(confineCodexTranscriptPath(undefined, { root })).toEqual({ ok: false, reason: 'missing_path' });
    expect(confineCodexTranscriptPath(join(day, 'x.txt'), { root })).toEqual({ ok: false, reason: 'not_jsonl' });
    expect(confineCodexTranscriptPath(join(day, 'absent.jsonl'), { root })).toEqual({ ok: false, reason: 'unreadable' });

    const outside = join(dir, 'outside.jsonl');
    writeFileSync(outside, meta + '\n');
    expect(confineCodexTranscriptPath(outside, { root })).toEqual({ ok: false, reason: 'outside_projects_dir' });
    // Traversal out of the root is still outside after realpath.
    expect(confineCodexTranscriptPath(join(day, '..', '..', '..', '..', 'outside.jsonl'), { root })).toEqual({ ok: false, reason: 'outside_projects_dir' });

    const link = join(day, 'link.jsonl');
    symlinkSync(outside, link);
    expect(confineCodexTranscriptPath(link, { root })).toEqual({ ok: false, reason: 'symlink' });

    const fat = join(day, 'rollout-fat.jsonl');
    writeFileSync(fat, 'x'.repeat(64));
    expect(confineCodexTranscriptPath(fat, { root, maxBytes: 16 })).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('discoverNewestCodexRollout — bounded, id-matched, symlink-rejecting', () => {
  function seedStore(root: string): { newest: string; older: string } {
    const d1 = join(root, '2026', '08', '24');
    const d2 = join(root, '2026', '08', '25');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    const older = join(d1, 'rollout-2026-08-24-aaa-sess-old.jsonl');
    const newest = join(d2, 'rollout-2026-08-25-bbb-sess-new.jsonl');
    writeFileSync(older, meta + '\n');
    writeFileSync(newest, meta + '\n');
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);
    return { newest, older };
  }

  test('id match wins; degrade names the match kind; no id falls back to newest mtime', () => {
    const root = join(dir, 'store');
    const { newest, older } = seedStore(root);
    expect(discoverNewestCodexRollout('sess-old', { root })).toEqual({ path: older, degrade: 'transcript_discovered' });
    expect(discoverNewestCodexRollout('sess-new', { root })).toEqual({ path: newest, degrade: 'transcript_discovered' });
    expect(discoverNewestCodexRollout(null, { root })).toEqual({ path: newest, degrade: 'transcript_discovered_newest' });
    expect(discoverNewestCodexRollout('no-such-session', { root })).toBeNull();
    expect(discoverNewestCodexRollout('x', { root: join(dir, 'absent-store') })).toBeNull();
  });

  test('symlinked rollouts are never returned', () => {
    const root = join(dir, 'store2');
    const day = join(root, '2026', '08', '25');
    mkdirSync(day, { recursive: true });
    const target = join(dir, 'evil.jsonl');
    writeFileSync(target, meta + '\n');
    symlinkSync(target, join(day, 'rollout-linked-sess-x.jsonl'));
    expect(discoverNewestCodexRollout('sess-x', { root })).toBeNull();
  });
});

describe('captureSpecFor — the dispatch golden rule', () => {
  test('undefined/unknown/opencode resolve to the claude spec (today\'s behavior); codex resolves to codex', () => {
    expect(captureSpecFor(undefined)).toBe(CAPTURE_SPECS['claude-code']);
    expect(captureSpecFor('claude-code')).toBe(CAPTURE_SPECS['claude-code']);
    expect(captureSpecFor('opencode')).toBe(CAPTURE_SPECS['claude-code']);
    expect(captureSpecFor('anything-else')).toBe(CAPTURE_SPECS['claude-code']);
    expect(captureSpecFor('codex')).toBe(CAPTURE_SPECS.codex);
    // Only the codex lane has a discovery fallback.
    expect(captureSpecFor('codex').discover).toBeDefined();
    expect(captureSpecFor('claude-code').discover).toBeUndefined();
  });
});

describe('mapCodexLine — the shared mapper stays honest on edge shapes', () => {
  test('nameless calls, non-object lines, unknown payloads: skip, never throw', () => {
    expect(mapCodexLine(null)).toEqual({ kind: 'skip' });
    expect(mapCodexLine('str')).toEqual({ kind: 'skip' });
    expect(mapCodexLine({ type: 'response_item', payload: { type: 'custom_tool_call', input: '{}' } })).toEqual({ kind: 'skip' });
    expect(mapCodexLine({ type: 'world_state', payload: {} })).toEqual({ kind: 'skip' });
    expect(mapCodexLine({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'x' } })).toEqual({ kind: 'skip' });
  });
});
