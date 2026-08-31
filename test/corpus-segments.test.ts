/**
 * Cathedral 5 (WI4) — corpus-segments unit contract: content-addressed
 * idempotency, hash-keyed ledger, boundary slicing/splitting, exact-set
 * coverage (duplicate-boundary can't mask a missed one), crash-order
 * fallback, GC of orphaned sidecars + aged ledgers.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendSegmentLedger,
  readOpenclawBoundaryTail,
  bankCompactSegment,
  coverageComplete,
  decideCorpusMode,
  gcCorpusArtifacts,
  ledgerFileName,
  parseSegmentFileName,
  readSegmentLedger,
  renderSegmentText,
  segmentFileName,
  segmentHash,
  sliceBoundaryWindow,
  splitByBoundaries,
  writeSegment,
} from '../src/core/context/corpus-segments.ts';
import type { WindowTurn } from '../src/core/context/entity-salience.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gb-seg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const t = (text: string, role: 'user' | 'assistant' = 'user'): WindowTurn => ({ role, text });

describe('content addressing + ledger', () => {
  test('same text ⇒ same name ⇒ existed=true, no rewrite; ledger append is idempotent', () => {
    const w1 = writeSegment(dir, 's', 'hello world');
    expect(w1.existed).toBe(false);
    expect(w1.file.endsWith(segmentFileName('s', segmentHash('hello world')))).toBe(true);
    const k1 = appendSegmentLedger(dir, 's', w1.hash);
    expect(k1).toBe(1);

    const w2 = writeSegment(dir, 's', 'hello world');
    expect(w2.existed).toBe(true);
    expect(w2.file).toBe(w1.file);
    expect(appendSegmentLedger(dir, 's', w2.hash)).toBe(1); // same ordinal, no dup entry
    expect(readSegmentLedger(dir, 's')).toHaveLength(1);

    const w3 = writeSegment(dir, 's', 'different content');
    expect(appendSegmentLedger(dir, 's', w3.hash)).toBe(2);
    expect(readSegmentLedger(dir, 's')).toHaveLength(2);
  });

  test('unreadable/malformed ledger reads as absent (fail-open [])', () => {
    writeFileSync(join(dir, ledgerFileName('s')), 'not json at all');
    expect(readSegmentLedger(dir, 's')).toEqual([]);
    writeFileSync(join(dir, ledgerFileName('s2')), JSON.stringify({ nope: true }));
    expect(readSegmentLedger(dir, 's2')).toEqual([]);
  });
});

describe('boundary slicing', () => {
  const turns = [t('a'), t('b'), t('c'), t('d'), t('e')];

  test('sliceBoundaryWindow: since last boundary; no boundary ⇒ all; maxTurns caps from the newest end', () => {
    expect(sliceBoundaryWindow(turns, [])).toEqual(turns);
    expect(sliceBoundaryWindow(turns, [2])).toEqual([t('c'), t('d'), t('e')]);
    expect(sliceBoundaryWindow(turns, [1, 3])).toEqual([t('d'), t('e')]);
    expect(sliceBoundaryWindow(turns, [], { maxTurns: 2 })).toEqual([t('d'), t('e')]);
  });

  test('splitByBoundaries: windows partition the pre-boundary turns; remainder is the tail', () => {
    const { windows, remainder } = splitByBoundaries(turns, [2, 4]);
    expect(windows).toEqual([[t('a'), t('b')], [t('c'), t('d')]]);
    expect(remainder).toEqual([t('e')]);
  });
});

describe('exact-set coverage', () => {
  async function bankWindow(win: WindowTurn[]): Promise<string> {
    const rendered = await renderSegmentText(win);
    expect(rendered).not.toBeNull();
    const w = writeSegment(dir, 's', rendered!.text);
    appendSegmentLedger(dir, 's', w.hash);
    return w.hash;
  }

  test('covered when every non-empty window hash is banked; remainder-only decision follows', async () => {
    const turns = [t('w1-a'), t('w1-b'), t('w2-a'), t('rem-a')];
    await bankWindow(turns.slice(0, 2)); // window 1
    await bankWindow(turns.slice(2, 3)); // window 2
    expect(await coverageComplete(dir, 's', turns, [2, 3])).toBe(true);
    const d = await decideCorpusMode(dir, 's', turns, [2, 3]);
    expect(d.mode).toBe('remainder');
    expect(d.turns).toEqual([t('rem-a')]);
  });

  test('a missed window fails coverage even when a duplicated boundary keeps the COUNT equal', async () => {
    const turns = [t('w1-a'), t('w2-a')];
    // Bank window 1 TWICE conceptually (same content = one ledger entry) plus
    // an unrelated hash so ledger COUNT (2) equals the boundary count (2) —
    // but window 2's hash is absent: exact-set must fail.
    await bankWindow(turns.slice(0, 1));
    appendSegmentLedger(dir, 's', 'deadbeef0000');
    expect(readSegmentLedger(dir, 's')).toHaveLength(2);
    expect(await coverageComplete(dir, 's', turns, [1, 2])).toBe(false);
    expect((await decideCorpusMode(dir, 's', turns, [1, 2])).mode).toBe('full_fallback');
  });

  test('empty windows are covered by construction; empty remainder ⇒ skip_covered', async () => {
    const turns = [t('w1-a')];
    await bankWindow(turns);
    // Boundary at 1 then a duplicate boundary at 1: second window is empty.
    expect(await coverageComplete(dir, 's', turns, [1, 1])).toBe(true);
    expect((await decideCorpusMode(dir, 's', turns, [1, 1])).mode).toBe('skip_covered');
  });

  test('no boundaries ⇒ mode full (today behavior); empty ledger with boundaries ⇒ full_fallback', async () => {
    const turns = [t('a')];
    expect((await decideCorpusMode(dir, 's', turns, [])).mode).toBe('full');
    expect((await decideCorpusMode(dir, 's-none', turns, [1])).mode).toBe('full_fallback');
  });
});

describe('bankCompactSegment (compact-time step)', () => {
  test('banks the since-last-boundary window; identical retry is segment_dup with the same ordinal', async () => {
    const turns = [t('old-a'), t('new-a'), t('new-b')];
    const budget = { remainingMs: () => 5000, minScanMs: 600, minWriteMs: 300 };
    const r1 = await bankCompactSegment(dir, 's', turns, [1], budget);
    expect(r1.segment).toBe('segment_banked');
    expect(r1.ordinal).toBe(1);
    expect(existsSync(join(dir, r1.flushCorpusFile!))).toBe(true);
    const body = readFileSync(join(dir, r1.flushCorpusFile!), 'utf8');
    expect(body).toContain('new-a');
    expect(body).not.toContain('old-a');

    const r2 = await bankCompactSegment(dir, 's', turns, [1], budget);
    expect(r2.segment).toBe('segment_dup');
    expect(r2.ordinal).toBe(1);
    expect(readSegmentLedger(dir, 's')).toHaveLength(1);
  });

  test('empty window ⇒ empty_window, nothing written; tight budget ⇒ deadline_scan, nothing written', async () => {
    const turns = [t('a')];
    const empty = await bankCompactSegment(dir, 's', turns, [1], { remainingMs: () => 5000, minScanMs: 600, minWriteMs: 300 });
    expect(empty.segment).toBe('empty_window');
    const tight = await bankCompactSegment(dir, 's', turns, [], { remainingMs: () => 100, minScanMs: 600, minWriteMs: 300 });
    expect(tight.segment).toBe('deadline_scan');
    expect(readdirSync(dir).filter((f) => f.endsWith('.txt'))).toEqual([]);
    expect(readSegmentLedger(dir, 's')).toEqual([]);
  });
});

describe('gcCorpusArtifacts', () => {
  test('removes orphaned sidecars (base .txt gone) and aged ledgers; keeps live pairs', () => {
    // Live pair: base + sidecar both stay.
    writeFileSync(join(dir, 'live.txt'), 'x');
    writeFileSync(join(dir, 'live.txt.ingested'), '');
    // Orphan sidecars: base missing.
    writeFileSync(join(dir, 'gone.txt.ingested'), '');
    writeFileSync(join(dir, 'gone.txt.in-progress'), '');
    // Fresh ledger stays; aged ledger goes.
    writeFileSync(join(dir, 'fresh.ledger.json'), '[]');
    writeFileSync(join(dir, 'old.ledger.json'), '[]');
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 'old.ledger.json'), past, past);

    gcCorpusArtifacts(dir, 30 * 24 * 60 * 60 * 1000, ['.ingested', '.in-progress']);

    const names = readdirSync(dir).sort();
    expect(names).toContain('live.txt');
    expect(names).toContain('live.txt.ingested');
    expect(names).toContain('fresh.ledger.json');
    expect(names).not.toContain('gone.txt.ingested');
    expect(names).not.toContain('gone.txt.in-progress');
    expect(names).not.toContain('old.ledger.json');
  });

  test('reaps orphaned receipts and aged tmp files from crashed writers (adversarial review)', () => {
    // Orphaned receipt (base .txt gone) — previously lived forever.
    writeFileSync(join(dir, 'gone.txt.receipt.json'), '{}');
    // Live receipt (base present, harvest mid-retry) stays.
    writeFileSync(join(dir, 'live.txt'), 'x');
    writeFileSync(join(dir, 'live.txt.receipt.json'), '{}');
    // Aged tmp from a crashed atomic writer goes; fresh tmp stays.
    writeFileSync(join(dir, 's.ledger.json.tmp-12345'), '[]');
    const past = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 's.ledger.json.tmp-12345'), past, past);
    writeFileSync(join(dir, 's.txt.tmp-99999'), 'x');

    gcCorpusArtifacts(dir, 30 * 24 * 60 * 60 * 1000, ['.ingested', '.in-progress', '.receipt.json']);

    const names = readdirSync(dir).sort();
    expect(names).not.toContain('gone.txt.receipt.json');
    expect(names).toContain('live.txt.receipt.json');
    expect(names).not.toContain('s.ledger.json.tmp-12345');
    expect(names).toContain('s.txt.tmp-99999');
  });
});

describe('parseSegmentFileName (sweep-lane link publish)', () => {
  test('round-trips segmentFileName, accepts legacy 12-hex, rejects non-segments', () => {
    const hash = segmentHash('some window text');
    expect(hash).toHaveLength(24); // 96-bit width (adversarial review)
    const name = segmentFileName('sess-a', hash);
    expect(parseSegmentFileName(name)).toEqual({ sessionId: 'sess-a', hash });
    // Pre-widening 12-hex segments still parse during upgrade.
    expect(parseSegmentFileName('s.seg-abc123def456.txt')).toEqual({
      sessionId: 's', hash: 'abc123def456',
    });
    expect(parseSegmentFileName('plain-corpus-file.txt')).toBeNull();
    expect(parseSegmentFileName('s.ledger.json')).toBeNull();
    expect(parseSegmentFileName('s.seg-XYZ.txt')).toBeNull();
  });
});

describe('pre-landing review pins', () => {
  test('filename builders enforce the safe charset structurally (traversal-shaped ids cannot escape the dir)', () => {
    const w = writeSegment(dir, '../../etc/evil', 'contained content');
    // Separators are stripped, so the name can never traverse — the file
    // lands INSIDE dir (a literal '..' SUBSTRING without separators is inert).
    expect(w.file.startsWith(dir + '/')).toBe(true);
    expect(w.file.slice(dir.length + 1)).not.toContain('/');
    expect(existsSync(w.file)).toBe(true);
    expect(ledgerFileName('../../x')).not.toContain('/');
    const hostile = segmentFileName('a/b\\c', 'ff00ff00ff00');
    expect(hostile).not.toContain('/');
    expect(hostile).not.toContain('\\');
  });

  test('bankCompactSegment deadline_write: scan budget passes, write budget does not — nothing written', async () => {
    const turns = [t('window that renders fine')];
    let calls = 0;
    // First check (minScanMs) sees plenty; second check (minWriteMs) sees a
    // drained budget — the render happened, the write must not.
    const remainingMs = () => (calls++ === 0 ? 5000 : 100);
    const r = await bankCompactSegment(dir, 's-dw', turns, [], { remainingMs, minScanMs: 600, minWriteMs: 300 });
    expect(r.segment).toBe('deadline_write');
    expect(readdirSync(dir).filter((f) => f.startsWith('s-dw'))).toEqual([]);
  });

  test('readOpenclawBoundaryTail tail-reads over maxBytes: partial first line dropped, boundary positions window-relative', () => {
    const sessionLine = JSON.stringify({ type: 'session', id: 's', cwd: '/w', timestamp: 't' });
    const msgLine = (text: string) =>
      JSON.stringify({ type: 'message', timestamp: 't', message: { role: 'user', content: [{ type: 'text', text }] } });
    const boundaryLine = JSON.stringify({ type: 'compaction', timestamp: 't' });
    const pad = 'x'.repeat(400);
    const lines = [sessionLine];
    for (let i = 0; i < 20; i++) lines.push(msgLine(`early-${i}-${pad}`));
    lines.push(boundaryLine);
    lines.push(msgLine('tail-a'), msgLine('tail-b'));
    const p = join(dir, 'oc-tail.jsonl');
    writeFileSync(p, lines.join('\n') + '\n');
    const full = statSync(p).size;
    // Cap the read to roughly the last few lines: the cut lands mid-line and
    // that partial first line must be silently dropped, not corrupt a turn.
    const parsed = readOpenclawBoundaryTail(p, { maxBytes: 1200 });
    expect(parsed).not.toBeNull();
    expect(full).toBeGreaterThan(1200);
    const texts = parsed!.turns.map((x) => x.text);
    expect(texts).toContain('tail-a');
    expect(texts).toContain('tail-b');
    for (const x of texts) expect(x.startsWith('early-0')).toBe(false); // scrolled out
    // Boundary position is relative to THIS window's turns array.
    expect(parsed!.boundaryTurnIndexes.length).toBeGreaterThanOrEqual(1);
    const b = parsed!.boundaryTurnIndexes.at(-1)!;
    expect(parsed!.turns.slice(b).map((x) => x.text)).toEqual(['tail-a', 'tail-b']);
  });
});

describe('decideCorpusMode reports where the written span begins', () => {
  /** Anything else derived from the transcript — tool calls, hashes — must
   * use the same origin as the corpus, or the receipt describes two spans. */
  test('full and full_fallback modes start at zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-start-'));
    try {
      const turns = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] as never;
      const d = await decideCorpusMode(dir, 'sess', turns, []);
      expect(d.mode).toBe('full');
      expect(d.startTurnIndex).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an uncovered boundary falls back to full, still from zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-start-'));
    try {
      const turns = [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }] as never;
      const d = await decideCorpusMode(dir, 'sess', turns, [1]);
      expect(d.mode).toBe('full_fallback');
      expect(d.startTurnIndex).toBe(0);
      // the whole window is written, so nothing may be filtered out of it
      expect(d.turns.length).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('readOpenclawBoundaryTail — tool-call extraction (memorable, name-only v1)', () => {
  test('fixture toolCall block extracted with input:null, stamped at its own turn slot', () => {
    const parsed = readOpenclawBoundaryTail('test/fixtures/transcripts/agent-session.jsonl');
    expect(parsed).not.toBeNull();
    // The fixture's one toolCall rides the assistant message at turn index 1
    // (m-1 user = 0, m-2 assistant = 1) — stamped BEFORE its turn is pushed.
    expect(parsed!.toolCalls).toEqual([{ name: 'search_brain', input: null }]);
    expect(parsed!.toolCallTurnIndexes).toEqual([1]);
    expect(parsed!.toolCalls.length).toBe(parsed!.toolCallTurnIndexes.length);
  });

  test('a placeholder-only message (toolCall, no text) keeps its calls; stamps stay non-decreasing', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 's-tc', cwd: '/w', timestamp: 't0', version: 3 }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'run the tests' }] } }),
      // No text at all — today's mapper skips the TURN but the call is real work.
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tc-a', name: 'exec' }] } }),
      JSON.stringify({ type: 'compaction', summary: 'x' }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }, { type: 'toolCall', id: 'tc-b', name: 'read_file' }] } }),
    ];
    const p = join(dir, 'tc.jsonl');
    writeFileSync(p, lines.join('\n') + '\n');
    const parsed = readOpenclawBoundaryTail(p);
    expect(parsed).not.toBeNull();
    expect(parsed!.turns.map((x) => x.text)).toEqual(['run the tests', 'done']);
    expect(parsed!.toolCalls.map((c) => c.name)).toEqual(['exec', 'read_file']);
    // exec sits between turn 0 and turn 1 (stamped 1 — the slot it precedes);
    // read_file rides the turn at index 1. Non-decreasing, parallel arrays.
    expect(parsed!.toolCallTurnIndexes).toEqual([1, 1]);
    const idx = parsed!.toolCallTurnIndexes;
    for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThanOrEqual(idx[i - 1]!);
    // Boundary position unchanged by call extraction.
    expect(parsed!.boundaryTurnIndexes).toEqual([1]);
    // Filtering at the boundary keeps only the post-boundary call — the
    // span rule the receipt writer applies.
    const startTurnIndex = parsed!.boundaryTurnIndexes[0]!;
    const span = parsed!.toolCalls.filter((_c, i) => (parsed!.toolCallTurnIndexes[i] ?? 0) >= startTurnIndex);
    expect(span.map((c) => c.name)).toEqual(['exec', 'read_file']);
  });

  test('no speculative args keys: an args-bearing block still extracts input:null (name-only v1)', () => {
    const lines = [
      JSON.stringify({ type: 'session', id: 's-args', cwd: '/w', timestamp: 't0', version: 3 }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            // Whatever field the real format uses for args, v1 must NOT guess
            // it into an egress payload.
            { type: 'toolCall', id: 'tc-x', name: 'exec', arguments: { command: 'rm -rf /' }, args: { c: 1 }, input: { c: 2 } },
          ],
        },
      }),
    ];
    const p = join(dir, 'tc-args.jsonl');
    writeFileSync(p, lines.join('\n') + '\n');
    const parsed = readOpenclawBoundaryTail(p);
    expect(parsed!.toolCalls).toEqual([{ name: 'exec', input: null }]);
  });
});
