import { expect, test } from 'bun:test';
import { CUE_SYSTEM_PROMPT, formatCueEvidence, resolveCueEvidence } from '../src/core/memory-cues/evidence.ts';
import { buildCueWindows, groundCueQuote, MAX_CUE_WINDOW_BYTES, validateCueOutput } from '../src/core/memory-cues/windows.ts';
import { cueSlots } from './helpers/memory-cues-wire.ts';

for (const [name, text] of [
  ['ascii', 'x'.repeat(8192)],
  ['escaped controls', '\u0001'.repeat(8192)],
  ['JSON punctuation', '\\"\n'.repeat(2700)],
  ['Unicode boundaries', 'x'.repeat(511) + '🌱'.repeat(1900)],
  ['combining and multilingual', '漢字 e\u0301 🌱\n'.repeat(400)],
  ['dense boundaries', 'A.\n'.repeat(2700)],
  ['short', 'I prefer morning practice.'],
  ['empty', ''],
] as const) {
  test(`evidence formatter preserves ${name}, bounds excerpts and reserves the exact wire`, () => {
    for (const includeBridge of [false, true]) {
      const formatted = formatCueEvidence(text, includeBridge);
      expect(formatted).toEqual(formatCueEvidence(text, includeBridge));
      expect(formatted.excerpts.map(e => e.text).join('')).toBe(text);
      expect(formatted.excerpts.length).toBeLessThanOrEqual(64);
      for (const [i, excerpt] of formatted.excerpts.entries()) {
        expect(excerpt.id).toBe(i + 1);
        expect(excerpt.text.length).toBeGreaterThan(0);
        expect(excerpt.text.length).toBeLessThanOrEqual(640);
        expect(excerpt.text.isWellFormed()).toBe(true);
      }
      expect(JSON.parse(formatted.content)).toEqual({ includeBridge, evidence: formatted.excerpts });
      expect(formatted.inputTokenCeiling).toBe(Buffer.byteLength(CUE_SYSTEM_PROMPT + formatted.content) + 1024);
      expect(formatted.inputTokenCeiling).toBeLessThanOrEqual(formatted.maximumInputTokenCeiling);
    }
  });
}

test('formatter prefers sentence and newline boundaries near the target without losing whitespace', () => {
  for (const delimiter of ['. ', '\n']) {
    const text = 'a'.repeat(500) + delimiter + 'b'.repeat(900);
    const formatted = formatCueEvidence(text, false);
    expect(formatted.excerpts[0]!.text).toBe('a'.repeat(500) + delimiter[0]);
    expect(formatted.excerpts.map(e => e.text).join('')).toBe(text);
  }
  expect(() => formatCueEvidence('a'.repeat(MAX_CUE_WINDOW_BYTES + 1), false)).toThrow('unsupported_window');
  expect(() => formatCueEvidence('🌱'.repeat(2049), false)).toThrow('unsupported_window');
});

test('selecting a later excerpt preserves exact Markdown and clipped window edges', () => {
  const heading = '**Goal 2: Balance video watching time**\n- Limit viewing to an evening break.\n- Keep mornings for practice.\nclipped final sent';
  const source = 'clipped beginning ' + 'x'.repeat(582) + '\n' + heading;
  const [window] = buildCueWindows([{ id: 1, chunk_text: source }]);
  expect(window).toBeDefined();
  const formatted = formatCueEvidence(window!.text, false);
  const selected = formatted.excerpts.find(e => e.text.includes('**Goal 2:'))!;
  const output = resolveCueEvidence(cueSlots({ kind: 'horizon:stated_goal_tradeoff', evidence_ref: selected.id,
    text: 'Planning evening viewing time' }), formatted.excerpts);
  const [cue] = validateCueOutput(output, window!);
  expect(cue!.quote).toBe(selected.text);
  expect(cue!.quote).toContain('**Goal 2: Balance video watching time**');
  expect(groundCueQuote(window!, cue!.quote)).not.toBeNull();
  expect(() => validateCueOutput([{ ...cue, quote: cue!.quote.replace('time**', 'time') }], window!)).toThrow('unsupported_cue');
  expect(() => validateCueOutput([{ ...cue, quote: 'An invented prefix ' + cue!.quote }], window!)).toThrow('unsupported_cue');
});

test('selection trims only edge whitespace while the complete synthetic chunk separator stays in the input', () => {
  const window = buildCueWindows([{ id: 1, chunk_text: 'a'.repeat(500) }, { id: 2, chunk_text: 'b'.repeat(500) }])[0]!;
  const formatted = formatCueEvidence(window.text, false);
  expect(formatted.excerpts.map(e => e.text).join('')).toBe(window.text);
  expect(formatted.excerpts[0]!.text).toBe('a'.repeat(500) + '\n');
  expect(groundCueQuote(window, formatted.excerpts[0]!.text)).toBeNull();
  for (const ref of [1, 2]) {
    const [cue] = validateCueOutput(resolveCueEvidence(cueSlots({ kind: 'horizon:explicit_constraint_applies',
      text: 'Applying the recorded constraint', evidence_ref: ref }), formatted.excerpts), window);
    expect(cue!.quote).toBe((ref === 1 ? 'a' : 'b').repeat(500));
    expect(cue!.quoteStart).toBe(ref === 1 ? 0 : 501);
    expect(groundCueQuote(window, cue!.quote, cue!.quoteStart)).toEqual([{ chunk_id: ref, start: 0, end: 500, separator: '' }]);
  }
});

test('trusted reference offsets preserve later identical text and Unicode chunk attribution', () => {
  const repeated = 'a'.repeat(500);
  const first = '🌱'.repeat(7) + repeated;
  const window = buildCueWindows([{ id: 1, chunk_text: first }, { id: 2, chunk_text: repeated }])[0]!;
  const formatted = formatCueEvidence(window.text, false);
  const [cue] = validateCueOutput(resolveCueEvidence(cueSlots({ kind: 'horizon:explicit_constraint_applies',
    text: 'Applying the second recorded constraint', evidence_ref: 2 }), formatted.excerpts), window);
  expect(cue!.quote).toBe(repeated);
  expect(window.text.indexOf(cue!.quote)).toBe(14);
  expect(cue!.quoteStart).toBe(515);
  expect(groundCueQuote(window, cue!.quote, cue!.quoteStart)).toEqual([{ chunk_id: 2, start: 0, end: 500, separator: '' }]);

  const singleChunk = buildCueWindows([{ id: 3, chunk_text: window.text }])[0]!;
  expect(groundCueQuote(singleChunk, cue!.quote, cue!.quoteStart)).toEqual([{ chunk_id: 3, start: 508, end: 1008, separator: '' }]);
  for (const quoteStart of [-1, 1.5, NaN, Infinity, 9999, 514, '515', null]) {
    expect(() => validateCueOutput([{ ...cue, quoteStart }], window)).toThrow('unsupported_cue');
  }
  expect(groundCueQuote(window, first.slice(1, 4), 1)).toBeNull();
  expect(groundCueQuote(window, first.slice(0, 3), 0)).toBeNull();
});

test('only selected quote edges lose whitespace, never Markdown punctuation or internal spacing', () => {
  const text = ' \n**Goal 2: Practice**\n- Leave  two spaces.\n\t';
  const window = buildCueWindows([{ id: 1, chunk_text: text }])[0]!;
  const formatted = formatCueEvidence(text, false);
  const [cue] = validateCueOutput(resolveCueEvidence(cueSlots({ kind: 'horizon:stated_goal_tradeoff',
    text: 'Planning practice time', evidence_ref: 1 }), formatted.excerpts), window);
  expect(formatted.excerpts[0]!.text).toBe(text);
  expect(cue!.quote).toBe('**Goal 2: Practice**\n- Leave  two spaces.');
  expect(cue!.quoteStart).toBe(2);
  expect(groundCueQuote(window, cue!.quote, cue!.quoteStart)).not.toBeNull();
});
