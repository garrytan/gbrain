/**
 * pi import adapter (`gbrain transcripts ingest`): store-scoped detection
 * (pi shares its session header with another agent's format), active-branch
 * import, gbrain's own injected context never re-imported, and discovery of
 * pi's session store.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piAdapter, isInPiSessionStore } from '../src/core/transcripts/pi.ts';
import { detectAdapter, harnessRoots } from '../src/core/transcripts/detect.ts';
import { discoverTranscriptFiles } from '../src/core/transcripts/discover.ts';
import type { FileDiagnostics, ParsedSession } from '../src/core/transcripts/types.ts';
import { PI_CONTEXT_CUSTOM_TYPE } from '../src/core/bootstrap/host-specs.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gb-pi-import-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>) {
  const sessions: ParsedSession[] = [];
  let s = await gen.next();
  while (!s.done) { sessions.push(s.value); s = await gen.next(); }
  return { sessions, diag: s.value };
}

const header = (id: string) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-07T10:00:00.000Z', cwd: '/home/user/project' });
const msg = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, ts = '2026-10-07T10:00:01.000Z') =>
  JSON.stringify({ type: 'message', id, parentId, timestamp: ts, message: { role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { model: 'claude-opus-4-8' } : {}) } });

function write(dir: string, name: string, lines: string[]): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

describe('pi detection is scoped to pi\'s own session store', () => {
  test('a session file inside the store is pi; the same bytes elsewhere are not', async () => {
    const store = tmp(); const elsewhere = tmp();
    const lines = [header('s-1'), msg('a', null, 'user', 'hi'), msg('b', 'a', 'assistant', 'hello')];
    const inside = write(join(store, '--home-user-project--'), '2026-10-07T10-00-00-000Z_s-1.jsonl', lines);
    const outside = write(elsewhere, 's-1.jsonl', lines);
    await withEnv({ PI_CODING_AGENT_SESSION_DIR: store }, async () => {
      expect(isInPiSessionStore(inside)).toBe(true);
      expect(isInPiSessionStore(outside)).toBe(false);
      const a = detectAdapter(inside); expect(a.ok && a.adapter.format).toBe('pi');
      const b = detectAdapter(outside); expect(b.ok && b.adapter.format).not.toBe('pi');
    });
  });
  test('--format pi imports a pi file from anywhere', () => {
    const p = write(tmp(), 'exported.jsonl', [header('s-2'), msg('a', null, 'user', 'hi')]);
    const r = detectAdapter(p, { explicitFormat: 'pi' });
    expect(r.ok && r.adapter.format).toBe('pi');
  });
  test('a non-session JSONL inside the store is not claimed', async () => {
    const store = tmp();
    const p = write(store, 'notes.jsonl', [JSON.stringify({ hello: 'world' })]);
    await withEnv({ PI_CODING_AGENT_SESSION_DIR: store }, async () => {
      expect(piAdapter.detect(p, Buffer.from(JSON.stringify({ hello: 'world' })))).toBe(false);
    });
  });
});

describe('pi parse', () => {
  test('only the active branch is imported; the abandoned /tree branch is not', async () => {
    // root a → b (assistant) → c (user, abandoned) → d (assistant, abandoned)
    //                        ↘ e (user, rewound here) → f (assistant, newest)
    const p = write(tmp(), 's.jsonl', [
      header('s-3'),
      msg('a', null, 'user', 'start'),
      msg('b', 'a', 'assistant', 'ok'),
      msg('c', 'b', 'user', 'ABANDONED draft'),
      msg('d', 'c', 'assistant', 'ABANDONED answer'),
      msg('e', 'b', 'user', 'kept question'),
      msg('f', 'e', 'assistant', 'kept answer'),
    ]);
    const { sessions } = await drain(piAdapter.parse(p));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.messages.map((m) => m.text)).toEqual(['start', 'ok', 'kept question', 'kept answer']);
  });
  test("gbrain's own injected context, tool results and thinking are not imported", async () => {
    const p = write(tmp(), 's.jsonl', [
      header('s-4'),
      msg('a', null, 'user', 'question'),
      JSON.stringify({ type: 'custom_message', id: 'ctx', parentId: 'a', timestamp: 't', customType: PI_CONTEXT_CUSTOM_TYPE, content: 'RETRIEVED BRAIN CONTEXT', display: false }),
      JSON.stringify({ type: 'message', id: 'b', parentId: 'ctx', timestamp: '2026-10-07T10:00:02.000Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: [
        { type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: 'the answer' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
      ] } }),
      JSON.stringify({ type: 'message', id: 'c', parentId: 'b', timestamp: 't', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'TOOL OUTPUT' }] } }),
    ]);
    const { sessions } = await drain(piAdapter.parse(p));
    const texts = sessions[0]!.messages.map((m) => m.text).join('\n');
    expect(texts).toBe('question\nthe answer');
  });
  test('session meta: harness pi, header id, cwd, start time, model; source timestamps kept', async () => {
    const p = write(tmp(), 's.jsonl', [header('s-5'), msg('a', null, 'user', 'q', '2026-10-07T10:00:01.000Z'), msg('b', 'a', 'assistant', 'r', '2026-10-07T10:00:05.000Z')]);
    const { sessions, diag } = await drain(piAdapter.parse(p));
    expect(sessions[0]!.meta).toMatchObject({ harness: 'pi', sessionId: 's-5', cwd: '/home/user/project', startedAt: '2026-10-07T10:00:00.000Z', model: 'claude-opus-4-8' });
    expect(sessions[0]!.messages.map((m) => m.timestamp)).toEqual(['2026-10-07T10:00:01.000Z', '2026-10-07T10:00:05.000Z']);
    expect(diag).toMatchObject({ sessions: 1, skippedLines: 0, truncated: false });
  });
  test('an assistant-only file reports userTurnsMissing (format-drift signal)', async () => {
    const p = write(tmp(), 's.jsonl', [header('s-6'), msg('a', null, 'assistant', 'only me')]);
    const { diag } = await drain(piAdapter.parse(p));
    expect(diag.userTurnsMissing).toBe(true);
  });
  test('a header-only file yields no session and explains why', async () => {
    const { sessions, diag } = await drain(piAdapter.parse(write(tmp(), 's.jsonl', [header('s-7')])));
    expect(sessions).toHaveLength(0);
    expect(diag.zeroSessionsReason).toContain('active branch');
  });
});

describe('discovery', () => {
  test("pi's session store is a discovery root and its files are found as pi", async () => {
    const store = tmp();
    write(join(store, '--home-user-project--'), '2026-10-07T10-00-00-000Z_s-8.jsonl', [header('s-8'), msg('a', null, 'user', 'hi')]);
    await withEnv({ PI_CODING_AGENT_SESSION_DIR: store }, async () => {
      const root = harnessRoots().find((r) => r.format === 'pi');
      expect(root?.root).toBe(store);
      const found = discoverTranscriptFiles([root!]);
      expect(found.map((f) => f.format)).toEqual(['pi']);
    });
  });
});
