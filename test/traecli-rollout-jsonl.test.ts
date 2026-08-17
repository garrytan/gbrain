import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  confineTraeCliTranscriptPath,
  parseTraeCliTranscript,
  TRAECLI_ROLLOUT_SPEC_TARGET,
} from '../src/core/transcripts/traecli-rollout-jsonl.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'conversation-formats', 'traecli-rollout.jsonl');
let tmp: string | null = null;
const tdir = () => (tmp = mkdtempSync(join(tmpdir(), 'gb-trae-rollout-')));
afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

describe('TraeCLI rollout spec and parsing', () => {
  test('dated target pins the verified TraeCLI format', () => {
    expect(TRAECLI_ROLLOUT_SPEC_TARGET.id).toContain('0.201.1');
    expect(TRAECLI_ROLLOUT_SPEC_TARGET.status).toBe('verified');
  });

  test('extracts typed users and one final assistant per turn without tool/reasoning noise', () => {
    const parsed = parseTraeCliTranscript(FIXTURE);
    expect(parsed.turns).toEqual([
      { role: 'user', text: 'What did alice-example decide?' },
      { role: 'assistant', text: 'alice-example chose the blue launch plan.' },
      { role: 'user', text: 'What about widget-co?' },
      { role: 'assistant', text: 'widget-co launches Thursday.' },
    ]);
    const all = parsed.turns.map((turn) => turn.text).join('\n');
    expect(all).not.toContain('I am checking');
    expect(all).not.toContain('SECRET-REASONING');
    expect(all).not.toContain('SECRET-TOOL-OUTPUT');
    expect(parsed.skippedLines).toBe(1);
  });

  test('recovers only marker-qualified gbrain developer context', () => {
    const parsed = parseTraeCliTranscript(FIXTURE);
    expect(parsed.injectedContextBlocks).toHaveLength(1);
    expect(parsed.injectedContextBlocks[0]).toContain('companies/widget-co');
    expect(parsed.injectedContextBlocks[0]).not.toContain('companies/foreign');
  });

  test('tail read retains newest conversation records', () => {
    const dir = tdir();
    const path = join(dir, 'rollout-tail.jsonl');
    let body = '';
    for (let i = 0; i < 100; i++) {
      body += JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `turn ${i}` } }) + '\n';
    }
    writeFileSync(path, body);
    const parsed = parseTraeCliTranscript(path, { maxBytes: 512 });
    expect(parsed.bytesRead).toBe(512);
    expect(parsed.turns.at(-1)).toEqual({ role: 'user', text: 'turn 99' });
    expect(parsed.skippedLines).toBeGreaterThanOrEqual(1);
  });
});

describe('TraeCLI transcript confinement', () => {
  test('accepts rollout JSONL under the sessions root', () => {
    const root = tdir();
    const day = join(root, '2026', '08', '17');
    mkdirSync(day, { recursive: true });
    const path = join(day, 'rollout-test.jsonl');
    writeFileSync(path, '{}\n');
    expect(confineTraeCliTranscriptPath(path, { root }).ok).toBe(true);
  });

  test('rejects outside paths, symlinks, wrong extensions, and oversized files', () => {
    const base = tdir();
    const root = join(base, 'sessions');
    mkdirSync(root);
    const outside = join(base, 'outside.jsonl');
    writeFileSync(outside, '{}\n');
    expect(confineTraeCliTranscriptPath(outside, { root })).toEqual({ ok: false, reason: 'outside_sessions_dir' });
    const link = join(root, 'rollout-link.jsonl');
    symlinkSync(outside, link);
    expect(confineTraeCliTranscriptPath(link, { root })).toEqual({ ok: false, reason: 'symlink' });
    const txt = join(root, 'rollout.txt');
    writeFileSync(txt, '{}\n');
    expect(confineTraeCliTranscriptPath(txt, { root })).toEqual({ ok: false, reason: 'not_jsonl' });
    const big = join(root, 'rollout-big.jsonl');
    writeFileSync(big, 'x'.repeat(32));
    expect(confineTraeCliTranscriptPath(big, { root, maxBytes: 16 })).toEqual({ ok: false, reason: 'too_large' });
  });
});
