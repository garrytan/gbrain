/**
 * expandPaths grok-sidecar scoping (#4751 review follow-up).
 *
 * grok.ts's own doc says the bare-UUID sidecar heuristic must be
 * FORMAT-SCOPED (discovery applies it only under the grok root), but
 * expandPaths applied the broad isGrokSessionSidecar to EVERY user-supplied
 * path — an explicit session file that merely lived under a UUID-named
 * directory was silently dropped from ingestion. The command now routes
 * through isGrokSessionSidecarStrict, which only claims a path when a real
 * grok session log (chat_history.jsonl) is actually present in the tree.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { expandPaths, expandTilde } from '../src/commands/transcripts.ts';
import { homedir } from 'node:os';
import { isGrokSessionSidecarStrict } from '../src/core/transcripts/grok.ts';
import { isClaudeCodeRemoteControlStateFile } from '../src/core/transcripts/claude-code.ts';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

let tmp: string | null = null;
function tdir(): string {
  tmp = mkdtempSync(join(tmpdir(), 'gb-expand-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('expandPaths grok-sidecar scoping', () => {
  test('an explicit session under a bare-UUID dir OUTSIDE a grok tree is NOT dropped', async () => {
    const d = tdir();
    const dir = join(d, UUID);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'claude-session.jsonl');
    writeFileSync(
      p,
      JSON.stringify({ sessionId: 's1', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    expect(isGrokSessionSidecarStrict(p)).toBe(false);
    expect(await expandPaths([p])).toEqual([p]);
  });

  test('a REAL grok sidecar (chat_history.jsonl present) is still dropped from dir expansion', async () => {
    const d = tdir();
    const dir = join(d, 'sessions', encodeURIComponent('/tmp/proj'), UUID);
    mkdirSync(dir, { recursive: true });
    const session = join(dir, 'chat_history.jsonl');
    writeFileSync(session, '{"type":"system","content":"x"}\n');
    const sidecar = join(dir, 'updates.jsonl');
    writeFileSync(sidecar, '{"t":1}\n');
    expect(isGrokSessionSidecarStrict(sidecar)).toBe(true);
    expect(isGrokSessionSidecarStrict(session)).toBe(false);
    expect(await expandPaths([dir])).toEqual([session]);
    // Even when named explicitly, a proven sidecar never imports.
    expect(await expandPaths([sidecar])).toEqual([]);
  });

  test('nested scratch under a PROVEN grok session dir is a sidecar; the same shape without evidence is not', async () => {
    const d = tdir();
    const grokDir = join(d, 'grok', UUID);
    mkdirSync(join(grokDir, 'terminal'), { recursive: true });
    writeFileSync(join(grokDir, 'chat_history.jsonl'), '{"type":"system","content":"x"}\n');
    const nested = join(grokDir, 'terminal', 'call-1.jsonl');
    writeFileSync(nested, '{"t":1}\n');
    expect(isGrokSessionSidecarStrict(nested)).toBe(true);

    const bareDir = join(d, 'bare', UUID, 'terminal');
    mkdirSync(bareDir, { recursive: true });
    const bareNested = join(bareDir, 'call-1.jsonl');
    writeFileSync(bareNested, '{"t":1}\n');
    expect(isGrokSessionSidecarStrict(bareNested)).toBe(false);
    expect(await expandPaths([bareNested])).toEqual([bareNested]);
  });

  test('prompt_history.jsonl drops only when a sibling <uuid>/chat_history.jsonl proves the grok tree', async () => {
    const d = tdir();
    const cwdDir = join(d, 'sessions', 'enc-cwd');
    mkdirSync(join(cwdDir, UUID), { recursive: true });
    writeFileSync(join(cwdDir, UUID, 'chat_history.jsonl'), '{"type":"system","content":"x"}\n');
    const ph = join(cwdDir, 'prompt_history.jsonl');
    writeFileSync(ph, '{"p":1}\n');
    expect(isGrokSessionSidecarStrict(ph)).toBe(true);

    // The same filename with no grok evidence anywhere is a legitimate file.
    const other = join(d, 'notgrok');
    mkdirSync(other, { recursive: true });
    const ph2 = join(other, 'prompt_history.jsonl');
    writeFileSync(ph2, '{"p":1}\n');
    expect(isGrokSessionSidecarStrict(ph2)).toBe(false);
    expect(await expandPaths([ph2])).toEqual([ph2]);
  });
});

describe('expandPaths Claude Code Remote Control state files (#5597)', () => {
  const SESSION = '18c0ffee-1234-4321-9999-abcdefabcdef';

  test('the predicate claims the two Remote Control names on either path separator', () => {
    expect(isClaudeCodeRemoteControlStateFile(`/home/u/.claude/projects/proj/${SESSION}.ccr-tip.json`)).toBe(true);
    expect(isClaudeCodeRemoteControlStateFile(`C:\\Users\\u\\.claude\\projects\\proj\\bridge-pointer.json`)).toBe(true);
    // A session file, and a consumer export, are never claimed.
    expect(isClaudeCodeRemoteControlStateFile(`/home/u/.claude/projects/proj/${SESSION}.jsonl`)).toBe(false);
    expect(isClaudeCodeRemoteControlStateFile('/home/u/exports/conversations.json')).toBe(false);
    // Near-miss names stay legitimate.
    expect(isClaudeCodeRemoteControlStateFile('/home/u/.claude/projects/proj/ccr-tip.json')).toBe(false);
    expect(isClaudeCodeRemoteControlStateFile('/home/u/.claude/projects/proj/bridge-pointer.jsonl')).toBe(false);
  });

  test('directory expansion drops ccr-tip.json + bridge-pointer.json and keeps sessions + exports', async () => {
    const d = tdir();
    const proj = join(d, '.claude', 'projects', 'proj-slug');
    mkdirSync(proj, { recursive: true });
    const session = join(proj, `${SESSION}.jsonl`);
    writeFileSync(
      session,
      JSON.stringify({ sessionId: 's1', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
    );
    const tip = join(proj, `${SESSION}.ccr-tip.json`);
    writeFileSync(tip, '{"tip":true}');
    const bridge = join(proj, 'bridge-pointer.json');
    writeFileSync(bridge, '{"bridge":true}');
    const exportJson = join(proj, 'conversations.json');
    writeFileSync(exportJson, '[]');
    // Glob order is filesystem order — compare as sets.
    expect((await expandPaths([proj])).sort()).toEqual([session, exportJson].sort());
  });

  test('even when named explicitly, a Remote Control state file never imports', async () => {
    const d = tdir();
    const proj = join(d, '.claude', 'projects', 'proj-slug');
    mkdirSync(proj, { recursive: true });
    const tip = join(proj, `${SESSION}.ccr-tip.json`);
    writeFileSync(tip, '{"tip":true}');
    const bridge = join(proj, 'bridge-pointer.json');
    writeFileSync(bridge, '{"bridge":true}');
    expect(await expandPaths([tip])).toEqual([]);
    expect(await expandPaths([bridge])).toEqual([]);
  });
});

describe('expandPaths Claude Code sessions-index.json (#9115)', () => {
  test('directory expansion drops the per-project sessions index and keeps the session; a near-miss name stays', async () => {
    const d = tdir();
    const proj = join(d, '.claude', 'projects', 'proj-slug');
    mkdirSync(proj, { recursive: true });
    const session = join(proj, '18c0ffee-1234-4321-9999-abcdefabcdef.jsonl');
    writeFileSync(session, JSON.stringify({ sessionId: 's1', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
    writeFileSync(join(proj, 'sessions-index.json'), '{"version":1,"entries":[]}');
    const nearMiss = join(proj, 'my-sessions-index.json');
    writeFileSync(nearMiss, '[]');
    expect((await expandPaths([proj])).sort()).toEqual([session, nearMiss].sort());
    expect(await expandPaths([join(proj, 'sessions-index.json')])).toEqual([]);
  });
});

describe('expandPaths tilde expansion', () => {
  test('expandTilde: bare ~ and ~/x resolve to the home dir; a mid-string ~ is untouched', () => {
    expect(expandTilde('~')).toBe(homedir());
    expect(expandTilde('~/sessions/x.jsonl')).toBe(join(homedir(), 'sessions', 'x.jsonl'));
    expect(expandTilde('~\\sessions')).toBe(homedir() + '\\sessions');
    expect(expandTilde('a~b.jsonl')).toBe('a~b.jsonl');
    expect(expandTilde('/abs/~/x.jsonl')).toBe('/abs/~/x.jsonl');
    expect(expandTilde('~alice/x.jsonl')).toBe('~alice/x.jsonl'); // ~user is not expanded
    expect(expandTilde('')).toBe('');
  });

  test('expandPaths resolves a ~/ spec against the home dir (unmatched specs are kept, expanded)', async () => {
    const spec = `~/gb-expand-tilde-${process.pid}-${Date.now()}.jsonl`;
    expect(await expandPaths([spec])).toEqual([join(homedir(), spec.slice(2))]);
  });

  test('expandPaths leaves a mid-string ~ file path alone', async () => {
    const d = tdir();
    const p = join(d, 'a~b.jsonl');
    writeFileSync(p, '{"type":"system","content":"x"}\n');
    expect(await expandPaths([p])).toEqual([p]);
  });
});
