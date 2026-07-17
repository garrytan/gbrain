/**
 * Covers RecentTranscriptOpts.onWarn.
 *
 * WHY: listRecentTranscripts swallowed a missing/unreadable corpus dir and
 * returned []. Three distinct states — no corpus dir configured, a configured
 * dir that doesn't exist, a genuinely empty dir — all produced [] and the CLI
 * printed one identical line for all three. The code comment said to run
 * `gbrain doctor`, but doctor had no corpus check at all.
 *
 * onWarn is opt-in and default-silent, so the `get_recent_transcripts` MCP op
 * (which can't act on a filesystem warning) is byte-for-byte unchanged. That
 * contract is pinned below — upstream's own
 * 'non-existent corpus dir is skipped silently' test in transcripts.test.ts
 * still passes untouched for the same reason.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { listRecentTranscripts } from '../src/core/transcripts.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const configMap = new Map<string, string | null>();
const fakeEngine = {
  async getConfig(key: string): Promise<string | null> {
    return configMap.get(key) ?? null;
  },
} as unknown as BrainEngine;

const created: string[] = [];

beforeEach(() => configMap.clear());
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'transcripts-onwarn-'));
  created.push(dir);
  return dir;
}

describe('listRecentTranscripts onWarn', () => {
  test('fires once with the path and errno for a missing dir', async () => {
    configMap.set('dream.synthesize.session_corpus_dir', '/nope/does/not/exist');
    const warnings: string[] = [];

    const result = await listRecentTranscripts(fakeEngine, { onWarn: m => warnings.push(m) });

    expect(result).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('/nope/does/not/exist');
    expect(warnings[0]).toContain('ENOENT');
  });

  test('stays silent when onWarn is omitted (the MCP contract)', async () => {
    // get_recent_transcripts passes no onWarn; behaviour must be unchanged.
    configMap.set('dream.synthesize.session_corpus_dir', '/nope/does/not/exist');
    await expect(listRecentTranscripts(fakeEngine)).resolves.toEqual([]);
  });

  test('does not fire for a readable but empty dir', async () => {
    // The state that SHOULD be quiet: the corpus is fine, there is just
    // nothing in it. Warning here would cry wolf.
    configMap.set('dream.synthesize.session_corpus_dir', scratch());
    const warnings: string[] = [];

    const result = await listRecentTranscripts(fakeEngine, { onWarn: m => warnings.push(m) });

    expect(result).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('does not fire when no corpus dir is configured', async () => {
    const warnings: string[] = [];
    await listRecentTranscripts(fakeEngine, { onWarn: m => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  test('a broken dir warns but does not suppress a readable sibling', async () => {
    // Degrade, don't fail: one bad dir must not cost the user the other one.
    const good = scratch();
    writeFileSync(join(good, 'note.txt'), 'hello from the readable dir');
    configMap.set('dream.synthesize.session_corpus_dir', '/nope/does/not/exist');
    configMap.set('dream.synthesize.meeting_transcripts_dir', good);
    const warnings: string[] = [];

    const result = await listRecentTranscripts(fakeEngine, { onWarn: m => warnings.push(m) });

    expect(warnings.length).toBe(1);
    expect(result.length).toBe(1);
    expect(result[0].path).toBe('note.txt');
  });
});
