/**
 * X7 (D22): harness-format contract. Every recorded Codex and Claude Code
 * session fixture must parse to at least one user turn AND one assistant
 * turn through BOTH consumers of the format: the import adapter
 * (`transcripts ingest`) and the session-end hook-lane parser. #5163 shipped
 * because codex 0.153 renamed its user-turn record and both parsers quietly
 * kept the assistant side; a fixture recorded from a new host version and
 * added to this table fails here first.
 *
 * Add a fixture: record a real session from the new host version, replace
 * the text with synthetic placeholders, drop it in test/fixtures, list it
 * below, and update the adapter's dated SPEC_TARGET.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexAdapter } from '../src/core/transcripts/codex.ts';
import { claudeCodeAdapter } from '../src/core/transcripts/claude-code.ts';
import { parseCodexHookTranscript } from '../src/core/transcripts/codex-hook-lane.ts';
import { parseTranscript } from '../src/core/transcripts/claude-code-jsonl.ts';
import type { FileDiagnostics, ParsedSession, TranscriptAdapter } from '../src/core/transcripts/types.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');

interface HarnessFixture {
  harness: 'codex' | 'claude-code';
  /** Host version the fixture's line shapes were recorded from. */
  hostVersion: string;
  path: string;
}

const RECORDED: HarnessFixture[] = [
  { harness: 'codex', hostVersion: '0.99 (user_message era)', path: join(FIXTURES, 'transcripts', 'codex-rollout.jsonl') },
  { harness: 'codex', hostVersion: '0.154 / 0.159 (item_completed UserMessage)', path: join(FIXTURES, 'transcripts', 'codex-rollout-0154.jsonl') },
  { harness: 'claude-code', hostVersion: '1.0.0', path: join(FIXTURES, 'conversation-formats', 'claude-code.jsonl') },
  { harness: 'claude-code', hostVersion: 'pasted-content capture', path: join(FIXTURES, 'claude-code-paste', 'session.jsonl') },
];

const ADAPTERS: Record<HarnessFixture['harness'], TranscriptAdapter> = { codex: codexAdapter, 'claude-code': claudeCodeAdapter };
const HOOK_PARSERS: Record<HarnessFixture['harness'], (p: string) => { turns: Array<{ role: string }> }> = {
  codex: (p) => parseCodexHookTranscript(p),
  'claude-code': (p) => parseTranscript(p),
};

async function drain(gen: AsyncGenerator<ParsedSession, FileDiagnostics>) {
  const sessions: ParsedSession[] = [];
  let step = await gen.next();
  while (!step.done) {
    sessions.push(step.value);
    step = await gen.next();
  }
  return { sessions, diag: step.value };
}

describe('harness-format contract (X7): every recorded session keeps both sides', () => {
  for (const f of RECORDED) {
    test(`${f.harness} ${f.hostVersion}: import adapter yields a user and an assistant turn per session`, async () => {
      const { sessions, diag } = await drain(ADAPTERS[f.harness].parse(f.path));
      expect(sessions.length).toBeGreaterThan(0);
      for (const s of sessions) {
        expect(s.messages.some((m) => m.role === 'user')).toBe(true);
        expect(s.messages.some((m) => m.role === 'assistant')).toBe(true);
      }
      expect(diag.userTurnsMissing).toBeUndefined();
    });

    test(`${f.harness} ${f.hostVersion}: session-end hook parser yields a user and an assistant turn`, () => {
      const { turns } = HOOK_PARSERS[f.harness](f.path);
      expect(turns.some((t) => t.role === 'user')).toBe(true);
      expect(turns.some((t) => t.role === 'assistant')).toBe(true);
    });
  }

  test('every adapter fixture is detected as its own harness', () => {
    for (const f of RECORDED) {
      const sample = readFileSync(f.path).subarray(0, 64 * 1024);
      expect(ADAPTERS[f.harness].detect(f.path, sample)).toBe(true);
    }
  });
});
