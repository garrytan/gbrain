/**
 * Claude Code workflow-run artifacts must not read as host-format drift.
 *
 * `gbrain transcripts ingest` reported "DRIFT WARNING: 27 file(s) parsed to
 * zero sessions" on a real brain, and every one was a false positive:
 *
 *   1. 22 subagent logs at `<session>/subagents/workflows/<wf>/agent-<id>.jsonl`.
 *      isClaudeCodeSubagentFile checked the IMMEDIATE parent for `subagents`,
 *      so the workflow nesting slipped past the filter it was written for.
 *   2. 5 title/metadata-only session stubs (`last-prompt` + `custom-title`,
 *      no turn records at all). The claude-code adapter never set
 *      `expectedEmpty`, which the drift predicate
 *      (`bytesRead > 0 && sessions === 0 && !expectedEmpty`) reads.
 *
 * Both cleared `cleanScan`, which by design holds the `--since last`
 * watermark back — so the archive re-scanned them forever and the warning
 * could never clear.
 *
 * The negative cases matter as much as the positives: turn records that stop
 * yielding text, and files with unparseable lines, MUST still drift.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCodeAdapter,
  isClaudeCodeSubagentFile,
} from '../src/core/transcripts/claude-code.ts';
import type { FileDiagnostics } from '../src/core/transcripts/types.ts';

let dir: string;

/** Drain the adapter generator and hand back its FileDiagnostics return. */
async function diagnose(path: string): Promise<FileDiagnostics> {
  const gen = claudeCodeAdapter.parse(path);
  let step = await gen.next();
  while (!step.done) step = await gen.next();
  return step.value;
}

function write(name: string, lines: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-wf-drift-'));
  mkdirSync(join(dir, 'nested'), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SESS = '/Users/me/.claude/projects/-Users-me-proj/9e1f3d87-95f6-46bc-bb48-97404d8d1890';

describe('workflow-nested subagent logs are recognized', () => {
  test('agent log inside a workflow run dir is a subagent file', () => {
    expect(
      isClaudeCodeSubagentFile(`${SESS}/subagents/workflows/wf_e37e5872-c19/agent-af0c665.jsonl`),
    ).toBe(true);
  });

  test('the immediate-parent cases keep their existing behaviour', () => {
    expect(isClaudeCodeSubagentFile(`${SESS}/subagents/agent-a5364e5.jsonl`)).toBe(true);
    // A real session directly under subagents/ stays discoverable.
    expect(isClaudeCodeSubagentFile(`${SESS}/subagents/61c79e08-716f-44df.jsonl`)).toBe(false);
    // A project SLUG containing "subagents" is not a subagents segment.
    expect(
      isClaudeCodeSubagentFile('/Users/me/.claude/projects/-Users-me-subagents/agent-abc.jsonl'),
    ).toBe(false);
  });

  test('workflow journal is an artifact; a session under subagents/ is not', async () => {
    // Imported dynamically, not statically: this export does not exist before
    // the fix, and a static named import would crash the whole FILE with a
    // SyntaxError — the vacuous-failure class CONTRIBUTING.md rejects. Loading
    // the module by value lets the other tests in this file run (and fail on
    // their own assertions) against pre-fix source.
    const mod = await import('../src/core/transcripts/claude-code.ts');
    const isArtifact = mod.isClaudeCodeWorkflowArtifactFile;
    expect(typeof isArtifact).toBe('function');
    expect(isArtifact(`${SESS}/subagents/workflows/wf_e37e5872-c19/journal.jsonl`)).toBe(true);
    expect(isArtifact(`${SESS}/subagents/61c79e08-716f-44df.jsonl`)).toBe(false);
    expect(isArtifact(`${SESS}/subagents/workflows`)).toBe(false);
  });
});

describe('expectedEmpty separates understood-empty from drift', () => {
  test('a title/metadata-only stub is understood, not drift', async () => {
    const p = write('meta-only.jsonl', [
      { sessionId: 's1', type: 'last-prompt', prompt: 'hi' },
      { sessionId: 's1', type: 'custom-title', title: 'Some title' },
      { sessionId: 's1', type: 'ai-title', title: 'Another' },
    ]);
    const d = await diagnose(p);
    expect(d.sessions).toBe(0);
    expect(d.bytesRead).toBeGreaterThan(0);
    expect(d.expectedEmpty).toBe(true);
  });

  test('an all-sidechain subagent log is understood, not drift', async () => {
    const p = write('sidechain.jsonl', [
      {
        sessionId: 's2',
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: 'sub work' },
      },
      {
        sessionId: 's2',
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: 'sub reply' },
      },
    ]);
    const d = await diagnose(p);
    expect(d.sessions).toBe(0);
    expect(d.expectedEmpty).toBe(true);
  });

  test('turn records that yield no text STILL drift', async () => {
    // The real regression signal: the host kept `type: user` but changed the
    // message shape. Marking this expectedEmpty would silence exactly the
    // breakage the drift counter exists to catch.
    const p = write('shape-drift.jsonl', [
      { sessionId: 's3', type: 'last-prompt', prompt: 'hi' },
      { sessionId: 's3', type: 'user', message: null },
      { sessionId: 's3', type: 'assistant', message: null },
    ]);
    const d = await diagnose(p);
    expect(d.sessions).toBe(0);
    expect(d.expectedEmpty).toBeFalsy();
  });

  test('unparseable lines STILL drift', async () => {
    const p = join(dir, 'malformed.jsonl');
    writeFileSync(p, '{"sessionId":"s4","type":"last-prompt"}\nnot json at all\n');
    const d = await diagnose(p);
    expect(d.sessions).toBe(0);
    expect(d.skippedLines).toBeGreaterThan(0);
    expect(d.expectedEmpty).toBeFalsy();
  });

  test('a real session still imports and is not marked empty', async () => {
    const p = write('real.jsonl', [
      { sessionId: 's5', type: 'last-prompt', prompt: 'hi' },
      {
        sessionId: 's5',
        type: 'user',
        timestamp: '2026-09-08T10:00:00.000Z',
        message: { role: 'user', content: 'hello there' },
      },
      {
        sessionId: 's5',
        type: 'assistant',
        timestamp: '2026-09-08T10:00:01.000Z',
        message: { role: 'assistant', content: 'hi back' },
      },
    ]);
    const d = await diagnose(p);
    expect(d.sessions).toBe(1);
    expect(d.expectedEmpty).toBeFalsy();
  });
});
