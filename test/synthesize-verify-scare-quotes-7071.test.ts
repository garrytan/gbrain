/**
 * #7071 — dream synthesis quote_verify: a short term the writer put in scare
 * quotes (`not simply "work-life balance"`) is prose, not a quotation, so the
 * unit around it is no longer quarantined as quote_not_in_source. A short
 * quotation attributed to a speaker, or introduced as speech, is still verified.
 */
import { describe, expect, test } from 'bun:test';
import { groundSource, verifyBody } from '../src/core/cycle/synthesize-verify.ts';

const SOURCE = '**alice-example** (10:02): The deal desk is always open at the right price for us.\n\n**bob-example** (10:03): Fine, send terms. We keep the pace sustainable.\n';
const strict = groundSource('conversations/2026-10-01-acme-example', SOURCE);
const tolerant = groundSource('conversations/2026-10-01-acme-example', SOURCE, { tolerant: true });
const reflection = (line: string) => `# Pacing\n\n## Reflection\n\n${line}\n`;

describe('#7071 scare quotes', () => {
  test('a short term in scare quotes is prose in strict and tolerant grounding', () => {
    for (const line of [
      'The pattern here is not simply "work-life balance" but a deliberate pacing choice the team keeps making.',
      'What looks like “strategic patience” is mostly a refusal to discount the offer for acme-example.',
    ]) {
      for (const source of [strict, tolerant]) {
        const v = verifyBody(reflection(line), [source]);
        expect(v.quarantined).toEqual([]);
        expect(v.body).toBe(reflection(line));
        expect(v.quotes).toBe(0);
      }
    }
  });

  test('a short quotation attributed to a speaker is still verified and quarantined when absent', () => {
    const v = verifyBody(reflection('alice-example described the desk as "strategic patience" in the meeting.'), [strict]);
    expect(v.quarantined.map(q => q.reason)).toEqual(['quote_not_in_source']);
  });

  test('a three-word unattributed span is still verified', () => {
    expect(verifyBody(reflection('You keep a "weekly launch diary" for the desk.'), [strict]).quarantined.map(q => q.reason)).toEqual(['quote_not_in_source']);
  });

  test('a short span introduced as speech is still verified', () => {
    for (const line of ['The team said "shipping tomorrow" and moved on.', 'The takeaway was blunt: "never discounting" for now.']) {
      expect(verifyBody(reflection(line), [strict]).quarantined.map(q => q.reason)).toEqual(['quote_not_in_source']);
    }
  });

  test('a longer quotation and a short span with sentence punctuation are still verified', () => {
    expect(verifyBody(reflection('The desk is "never closed to a good offer from anyone" in practice.'), [strict]).quarantined.map(q => q.reason)).toEqual(['quote_not_in_source']);
    expect(verifyBody(reflection('The desk motto is "closed, then open" in practice.'), [strict]).quarantined.map(q => q.reason)).toEqual(['quote_not_in_source']);
  });

  test('a short span that does ground keeps its provenance', () => {
    const v = verifyBody(reflection('The pace stays "pace sustainable" by design, per bob-example.'), [strict]);
    expect(v.quarantined).toEqual([]);
    expect(v.quotes).toBe(1);
    expect(v.provenance.map(p => p.text)).toEqual(['pace sustainable']);
  });
});
