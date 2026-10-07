/**
 * #5887 — corpus window planner and `.progress` compare-and-set, engine-free.
 *
 * Protects: windows open with their `[role]` header and fit the extractor's
 * 8,000-char ceiling; pastes are stripped per whole turn before windowing;
 * a split turn resumes from its continuation offset without losing or
 * repeating a character (including astral and multi-byte text); progress
 * advances only under the matching generation and lease; the per-sweep
 * total knob validates its input. The sweep-level behavior (multi-sweep
 * convergence, rewrites, races, harvest) lives in sweep-corpus-windows.test.ts.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CORPUS_WINDOWS_PER_SWEEP_TOTAL,
  __resetCorpusWindowsWarningForTests,
  corpusFileStat,
  parseCorpusTurns,
  planCorpusWindows,
  readCorpusProgress,
  resolveCorpusWindowsPerSweepTotal,
  resumePoint,
  runCorpusWindows,
} from '../src/core/context/corpus-windows.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const corpus = (turns: Array<['user' | 'assistant', string]>): string =>
  toCorpusText(turns.map(([role, text]) => ({ role, text })));
const filler = (tag: string, n: number): string => {
  let s = `${tag} `;
  while (s.length < n) s += `${tag.toLowerCase()} detail words\n`;
  return s.slice(0, n);
};
const empty = { inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [] };

describe('planCorpusWindows', () => {
  test('every window opens with a role header and fits 8,000 chars; a split turn repeats its header', () => {
    const raw = corpus([
      ['user', filler('U0', 3000)],
      ['assistant', filler('A1', 20_000)],
      ['user', filler('U2', 500)],
    ]);
    const windows = planCorpusWindows(parseCorpusTurns(raw), { turn: 0, offset: 0 });
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(windows.filter((w) => w.text.includes('[assistant]\n')).length).toBeGreaterThanOrEqual(3);
    for (const w of windows) {
      expect(w.text.length).toBeLessThanOrEqual(8000);
      expect(w.text).toMatch(/^\[(user|assistant)\]\n/);
    }
    const assistantText = windows
      .flatMap((w) => w.text.split(/\n\n(?=\[(?:user|assistant)\]\n)/))
      .filter((part) => part.startsWith('[assistant]\n'))
      .map((part) => part.slice('[assistant]\n'.length))
      .join('');
    expect(assistantText).toBe(filler('A1', 20_000).trim());
    // No assistant chunk ever rides under a user header.
    for (const w of windows) {
      for (const part of w.text.split(/\n\n(?=\[(?:user|assistant)\]\n)/)) {
        if (part.startsWith('[user]\n')) expect(part).not.toContain('a1 detail');
      }
    }
  });

  test('a paste crossing every window boundary never reaches a window (strip per turn, then window)', () => {
    const paste = `<pasted_content id="9">\n${filler('PASTEMARK', 20_000)}\n</pasted_content id="9">`;
    const raw = corpus([
      ['user', `${filler('OWNHEAD', 6000)} ${paste} ${filler('OWNTAIL', 6000)}`],
      ['assistant', 'Noted.'],
    ]);
    const windows = planCorpusWindows(parseCorpusTurns(raw), { turn: 0, offset: 0 });
    const all = windows.map((w) => w.text).join('\n');
    expect(all).not.toContain('PASTEMARK');
    expect(all).not.toContain('pasted_content');
    expect(all).toContain('OWNHEAD');
    expect(all).toContain('OWNTAIL');
    for (const w of windows) expect(w.text.length).toBeLessThanOrEqual(8000);
  });

  test('only exact toCorpusText markers start turns; a bracket mid-line does not', () => {
    const raw = corpus([['user', 'see [assistant] in prose\nand\n[user] at a line start']]);
    const turns = parseCorpusTurns(raw);
    expect(turns.length).toBe(1);
    expect(turns[0].role).toBe('user');
  });

  test('turn byte offsets index the raw UTF-8 file', () => {
    const raw = corpus([['user', 'héllo 😀 wörld'], ['assistant', 'ok']]);
    const turns = parseCorpusTurns(raw);
    const buf = Buffer.from(raw, 'utf8');
    expect(buf.subarray(turns[1].start, turns[1].end).toString('utf8').trimEnd()).toBe('[assistant]\nok');
    expect(buf.subarray(turns[0].start, turns[0].end).toString('utf8')).toBe('[user]\nhéllo 😀 wörld');
  });
});

describe('resumePoint', () => {
  test('a compaction remainder resumes after its last recorded turn', () => {
    const full = corpus([['user', 'one'], ['assistant', 'two'], ['user', 'three'], ['assistant', 'four']]);
    const turns = parseCorpusTurns(full);
    const progress = {
      version: 1 as const, generation: 3, turns: turns.map(({ start, end, sha256 }) => ({ start, end, sha256 })),
      continuation: null, windows_done: 1, finished: null, totals: { inserted: 0, duplicate: 0, superseded: 0 },
      entity_slugs: [], lease: null,
    };
    const remainder = parseCorpusTurns(corpus([['user', 'three'], ['assistant', 'four'], ['user', 'five']]));
    expect(resumePoint(remainder, progress)).toEqual({ turn: 2, offset: 0 });
  });
});

describe('runCorpusWindows', () => {
  function tmpFile(name: string, raw: string): { full: string; stat: ReturnType<typeof corpusFileStat> } {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-corpus-windows-'));
    dirs.push(dir);
    const full = join(dir, name);
    writeFileSync(full, raw);
    return { full, stat: corpusFileStat(statSync(full)) };
  }

  test('a restart inside a multi-byte split turn resumes at the continuation without losing a character', async () => {
    const body = '漢字テキスト😀'.repeat(2500);
    const raw = corpus([['user', body]]);
    const { full, stat } = tmpFile('mb.txt', raw);
    const seen: string[] = [];
    const extract = async (text: string) => { seen.push(text); return empty; };
    const ctl = new AbortController();
    const first = await runCorpusWindows({ full, raw, fileStat: stat, maxWindows: 1, extract, overBudget: () => false, signal: ctl.signal });
    expect(first.status).toBe('partial');
    const mid = await readCorpusProgress(full);
    expect(mid?.continuation?.stripped_offset).toBeGreaterThan(0);
    const second = await runCorpusWindows({ full, raw, fileStat: stat, maxWindows: 99, extract, overBudget: () => false, signal: ctl.signal });
    expect(second.status).toBe('complete');
    const rebuilt = seen.map((t) => {
      expect(t.startsWith('[user]\n')).toBe(true);
      expect(t.length).toBeLessThanOrEqual(8000);
      expect(/[\uD800-\uDBFF]$/.test(t) || /^\[user\]\n[\uDC00-\uDFFF]/.test(t)).toBe(false);
      return t.slice('[user]\n'.length);
    }).join('');
    expect(rebuilt).toBe(body);
  });

  test('a live lease held by another extractor refuses the run with zero extraction', async () => {
    const raw = corpus([['user', filler('X', 9000)]]);
    const { full, stat } = tmpFile('leased.txt', raw);
    writeFileSync(full + '.progress', JSON.stringify({
      version: 1, generation: 4, turns: [], continuation: null, windows_done: 0, finished: null,
      totals: { inserted: 0, duplicate: 0, superseded: 0 }, entity_slugs: [], lease: { owner: 'other:1', at: Date.now() },
    }));
    let calls = 0;
    const run = await runCorpusWindows({
      full, raw, fileStat: stat, maxWindows: 8, overBudget: () => false, signal: new AbortController().signal,
      extract: async () => { calls++; return empty; },
    });
    expect(run.status).toBe('contended');
    expect(calls).toBe(0);
    expect(JSON.parse(readFileSync(full + '.progress', 'utf8')).generation).toBe(4);
  });

  test('progress moved by someone else during a window is never overwritten backwards', async () => {
    const raw = corpus([['user', filler('A', 6000)], ['assistant', filler('B', 6000)], ['user', filler('C', 6000)]]);
    const { full, stat } = tmpFile('cas.txt', raw);
    let calls = 0;
    const run = await runCorpusWindows({
      full, raw, fileStat: stat, maxWindows: 8, overBudget: () => false, signal: new AbortController().signal,
      extract: async () => {
        calls++;
        // Another writer replaces progress mid-window (a stale-lease takeover).
        const cur = JSON.parse(readFileSync(full + '.progress', 'utf8'));
        writeFileSync(full + '.progress', JSON.stringify({ ...cur, generation: cur.generation + 10, lease: { owner: 'other:2', at: Date.now() } }));
        return empty;
      },
    });
    expect(run.status).toBe('contended');
    expect(calls).toBe(1);
    const after = JSON.parse(readFileSync(full + '.progress', 'utf8'));
    expect(after.lease.owner).toBe('other:2');
    expect(after.turns).toEqual([]);
  });

  test('an aborted window records nothing', async () => {
    const raw = corpus([['user', filler('A', 6000)], ['assistant', filler('B', 6000)]]);
    const { full, stat } = tmpFile('abort.txt', raw);
    const ctl = new AbortController();
    const run = await runCorpusWindows({
      full, raw, fileStat: stat, maxWindows: 8, overBudget: () => false, signal: ctl.signal,
      extract: async () => { ctl.abort(); return { ...empty, inserted: 1 }; },
    });
    expect(run.status).toBe('aborted');
    const p = await readCorpusProgress(full);
    expect(p?.turns).toEqual([]);
    expect(p?.windows_done).toBe(0);
    expect(p?.lease).toBeNull();
  });
});

describe('resolveCorpusWindowsPerSweepTotal (GBRAIN_CORPUS_WINDOWS_PER_SWEEP)', () => {
  test('a positive integer overrides; invalid values fall back with one warning', () => {
    __resetCorpusWindowsWarningForTests();
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveCorpusWindowsPerSweepTotal({}, warn)).toBe(CORPUS_WINDOWS_PER_SWEEP_TOTAL);
    expect(resolveCorpusWindowsPerSweepTotal({ GBRAIN_CORPUS_WINDOWS_PER_SWEEP: '2' }, warn)).toBe(2);
    expect(resolveCorpusWindowsPerSweepTotal({ GBRAIN_CORPUS_WINDOWS_PER_SWEEP: '0' }, warn)).toBe(32);
    expect(resolveCorpusWindowsPerSweepTotal({ GBRAIN_CORPUS_WINDOWS_PER_SWEEP: 'lots' }, warn)).toBe(32);
    expect(resolveCorpusWindowsPerSweepTotal({ GBRAIN_CORPUS_WINDOWS_PER_SWEEP: '1.5' }, warn)).toBe(32);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('GBRAIN_CORPUS_WINDOWS_PER_SWEEP');
  });
});

describe('#6091: retired turns are skipped wherever they sit', () => {
  test('planCorpusWindows leaves a retired turn out of every window, not only a leading run', () => {
    const raw = '[user]\nfirst open turn\n\n[assistant]\nreply one\n\n[user]\nretired secret turn\n\n[assistant]\nreply two\n';
    const turns = parseCorpusTurns(raw);
    const text = planCorpusWindows(turns, { turn: 0, offset: 0 }, undefined, new Set([turns[2].sha256])).map((w) => w.text).join('\n');
    expect(text).toContain('first open turn');
    expect(text).toContain('reply two');
    expect(text).not.toContain('retired secret turn');
  });
});
