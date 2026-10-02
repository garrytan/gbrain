/**
 * #5812 — Claude Code paste blocks. The fixture is a real Claude Code 2.1.287
 * session (paths generalized): a mixed turn (the user's words around a
 * pasted email) and a paste-only turn, exactly as the harness wrote them.
 *
 * Pins: the shared helper strips closed blocks and only a harness-shaped
 * unclosed tail; corpus stripping is per `[user]` block, so an unclosed paste
 * never erases a later turn; the parser classifies a paste-only turn as not
 * genuine while every rendered text (turns, corpus, segments) keeps the paste
 * byte for byte.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPasteOnly,
  stripPastedContent,
  stripPastedContentFromCorpus,
} from '../src/core/transcripts/pasted-content.ts';
import { parseTranscript, toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { corpusTextForExtraction, renderSegmentText } from '../src/core/context/corpus-segments.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'claude-code-paste', 'session.jsonl');
const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const userTexts: string[] = lines
  .filter((l) => l.type === 'user')
  .map((l) => l.message.content as string);
const [MIXED, PASTE_ONLY] = userTexts;
const PASTE_MARK = 'pasted third-party email';
const OWN_WORDS = 'I prefer dark roast coffee';

describe('stripPastedContent — the one paste detector', () => {
  test('a real mixed turn keeps only the user\'s own words', () => {
    expect(MIXED).toContain('<pasted_content id="');
    const r = stripPastedContent(MIXED);
    expect(r.stripped).toBe(1);
    expect(r.text).not.toContain(PASTE_MARK);
    expect(r.text).not.toContain('pasted_content');
    expect(r.text).toContain('Please remember this note I got:');
    expect(r.text).toContain(OWN_WORDS);
    expect(isPasteOnly(MIXED)).toBe(false);
  });

  test('a real paste-only turn is paste-only', () => {
    expect(isPasteOnly(PASTE_ONLY)).toBe(true);
    expect(stripPastedContent(PASTE_ONLY).text.trim()).toBe('');
  });

  test('an unclosed harness-shaped tail is stripped; an unclosed non-harness tag is text', () => {
    expect(stripPastedContent('I moved the sync to Tuesdays. <pasted_content id="7">\nthird party text').text.trim())
      .toBe('I moved the sync to Tuesdays.');
    const odd = 'I like tea. <pasted_content source="mail">not the harness shape';
    expect(stripPastedContent(odd)).toEqual({ text: odd, stripped: 0 });
  });

  test('several blocks, words around them never merge, look-alike tags are text', () => {
    const r = stripPastedContent('alpha<pasted_content id="1">x</pasted_content id="1">beta <pasted_content id="2">y</pasted_content id="2"> gamma');
    expect(r.stripped).toBe(2);
    expect(r.text.replace(/\s+/g, ' ')).toBe('alpha beta gamma');
    const lookAlike = 'see <pasted_contents> and <pasted_content_x id="1">kept</pasted_content_x>';
    expect(stripPastedContent(lookAlike)).toEqual({ text: lookAlike, stripped: 0 });
  });

  test('text without a paste is returned unchanged', () => {
    expect(stripPastedContent('plain words')).toEqual({ text: 'plain words', stripped: 0 });
  });
});

describe('stripPastedContentFromCorpus — per [user] block', () => {
  test('an unclosed paste in one user turn does not erase the next turns', () => {
    const corpus = toCorpusText([
      { role: 'user', text: 'Note for later: <pasted_content id="3">\nforwarded text that never closes' },
      { role: 'assistant', text: 'Noted.' },
      { role: 'user', text: 'I decided to move the standup to 9am every weekday.' },
    ]);
    const out = stripPastedContentFromCorpus(corpus);
    expect(out).not.toContain('forwarded text');
    expect(out).toContain('[assistant]\nNoted.');
    expect(out).toContain('[user]\nI decided to move the standup to 9am every weekday.');
    expect(out).toContain('[user]\nNote for later:');
  });

  test('assistant blocks are unchanged, and a corpus built from the real transcript loses every paste', () => {
    const parsed = parseTranscript(FIXTURE);
    const corpus = toCorpusText(parsed.turns);
    expect(corpus).toContain(PASTE_MARK);
    const out = stripPastedContentFromCorpus(corpus);
    expect(out).not.toContain(PASTE_MARK);
    expect(out).toContain(OWN_WORDS);
    for (const t of parsed.turns.filter((turn) => turn.role === 'assistant')) expect(out).toContain(t.text);
    expect(stripPastedContentFromCorpus('[assistant]\nquoting <pasted_content id="1">x\n')).toBe('[assistant]\nquoting <pasted_content id="1">x\n');
  });

  test('a writeback turn file is one user turn; other corpus files are stripped per block', () => {
    const wbText = 'I prefer dark roast coffee. <pasted_content id="2830"> forwarded email </pasted_content id="2830">\n';
    expect(corpusTextForExtraction('s1.wb-0123456789abcdef01234567.txt', wbText)).not.toContain('forwarded email');
    expect(corpusTextForExtraction('s1.wb-0123456789abcdef01234567.txt', wbText)).toContain('I prefer dark roast coffee.');
    expect(corpusTextForExtraction('s1.txt', wbText)).toBe(wbText);
  });
});

describe('parser — a paste-only turn is not genuine; rendered text is unchanged', () => {
  test('genuineUserTurnIndexes skips the paste-only turn', () => {
    const parsed = parseTranscript(FIXTURE);
    const userIdx = parsed.turns.flatMap((t, i) => (t.role === 'user' ? [i] : []));
    expect(userIdx.length).toBe(2);
    expect(parsed.genuineUserTurnIndexes).toEqual([userIdx[0]]);
  });

  test('turn text, corpus text and segment text keep the paste byte for byte', async () => {
    const parsed = parseTranscript(FIXTURE);
    const users = parsed.turns.filter((t) => t.role === 'user').map((t) => t.text);
    expect(users).toEqual(userTexts.map((t) => t.trim()));
    const corpus = toCorpusText(parsed.turns);
    expect(corpus).toBe(parsed.turns.map((t) => `[${t.role}]\n${t.text}`).join('\n\n') + '\n');
    expect(corpus).toContain(MIXED.trim());
    expect(corpus).toContain(PASTE_ONLY.trim());
    expect((await renderSegmentText(parsed.turns))?.text).toBe(corpus);
  });
});
