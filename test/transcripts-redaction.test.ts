/**
 * ENG-8 — handlers that clip, collapse or summarize stored text redact the
 * whole source field FIRST. A credential cut by a summary cap (or a key whose
 * lines are collapsed onto one line) no longer matches the scanner, so a
 * clip-then-redact order leaks the fragment that survives the cut.
 *
 * Covers `listRecentTranscripts` (250-char summary head and 100 KB full-read
 * cap, the `get_recent_transcripts` op) and `safeSynopsis` (160-char
 * `clip(collapse(...))`, the entity-card / reflex pointer summary).
 * Fixtures are assembled at runtime from random parts (CEO-10).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRecentTranscripts } from '../src/core/transcripts.ts';
import { safeSynopsis, type PageRow } from '../src/core/context/retrieval-reflex.ts';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function rand(n: number): string {
  let out = '';
  for (const b of randomBytes(n)) out += ALNUM[b % ALNUM.length];
  return out;
}
const vendorToken = () => ['gh', 'p_'].join('') + rand(36);

let dir: string;
const fakeEngine = {
  async getConfig(key: string): Promise<string | null> {
    return key === 'dream.synthesize.session_corpus_dir' ? dir : null;
  },
} as unknown as Parameters<typeof listRecentTranscripts>[0];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-transcripts-redaction-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write one transcript into a fresh corpus dir and read it back. */
async function transcript(name: string, content: string, summary: boolean) {
  rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'gbrain-transcripts-redaction-'));
  writeFileSync(join(dir, name), content);
  const [t] = await listRecentTranscripts(fakeEngine, { days: 3650, summary });
  expect(t!.path).toBe(name);
  return t!;
}

describe('transcripts redact before the summary and full-read caps cut', () => {
  test('a token crossing the 250-char summary boundary leaves no fragment', async () => {
    const token = vendorToken();
    // The token starts 20 chars before the cap, so a clip-first summary keeps
    // `ghp_` plus 16 random chars: too short to match, still a real fragment.
    const t = await transcript('2026-09-30-summary.txt', `Session notes\n${'x'.repeat(229)} ${token} trailing words\n`, true);
    expect(t.summary).toContain('Session notes');
    expect(t.summary.includes(token.slice(4, 16))).toBe(false);
  });

  test('a token crossing the 100 KB full-read cap leaves no fragment', async () => {
    const token = vendorToken();
    const t = await transcript('2026-09-30-full.txt', `Session notes\n${'y'.repeat(100 * 1024 - 14 - 21)} ${token} tail\n`, false);
    expect(t.summary.length).toBeGreaterThan(100 * 1024 - 64);
    expect(t.summary.includes(token.slice(4, 16))).toBe(false);
  });
});

describe('safeSynopsis redacts the whole source field before collapse and clip', () => {
  const row = (frontmatter: Record<string, unknown> | null, compiled_truth: string): PageRow =>
    ({ slug: 'people/alice-example', source_id: 'default', title: 'Alice', type: 'person', frontmatter, compiled_truth });

  test('a multiline private key in a frontmatter summary leaves no body fragment', () => {
    const fence = '-'.repeat(5);
    const label = ['PRIVATE', 'KEY'].join(' ');
    const body = Array.from({ length: 4 }, () => randomBytes(48).toString('base64'));
    const summary = [`${fence}BEGIN ${label}${fence}`, ...body, `${fence}END ${label}${fence}`].join('\n');
    const out = safeSynopsis(row({ summary }, ''), { maxLen: 600 });
    for (const line of body) expect(out.includes(line.slice(0, 16))).toBe(false);
    expect(out).toContain('<REDACTED:private_key_pem>');
  });

  test('a token crossing the 160-char clip in the first prose line leaves no fragment', () => {
    const token = vendorToken();
    const out = safeSynopsis(row(null, `# Alice\n\n${'z'.repeat(139)} ${token} more prose.`));
    expect(out.includes(token.slice(4, 16))).toBe(false);
  });
});
