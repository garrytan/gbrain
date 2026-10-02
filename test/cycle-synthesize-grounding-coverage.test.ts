import { describe, expect, test } from 'bun:test';
import { emptyQuoteVerifyStats, groundSource, normForGrounding, quarantineUnits, verifyBody, verifyDreamPage } from '../src/core/cycle/synthesize-verify.ts';

const ticket = 'I signed up for a ticket and got it; I still have to travel to the conference.';
const source = groundSource('/fixtures/2026-04-03-session.md', `User: ${ticket}\nAssistant: Noted.`);

describe('semantic grounding covers interpretations around mechanically valid evidence', () => {
  test('speaker mention and supported year do not certify completed attendance', () => {
    const claim = 'The user reached a personal milestone in 2026: attending the conference.';
    const verified = verifyBody(claim, [source]);
    expect(verified.quarantined).toEqual([]);
    expect(verified.body).toBe(claim);
    expect(verified.groundingUnits).toEqual([claim]);
  });

  test('an exact ticket quote does not certify the surrounding attendance claim', () => {
    const claim = `**Attendance:** The user attended the conference: "${ticket}"`;
    const verified = verifyBody(claim, [source]);
    expect(verified.exact).toBe(1);
    expect(verified.quarantined).toEqual([]);
    expect(verified.groundingUnits).toEqual([claim]);
  });

  test.each([
    'The user attended the conference after obtaining the ticket.',
    'A completed milestone in 2026 was attending the conference.',
    'A completed milestone on April 3 was attending the conference.',
  ])('speaker/date evidence alone does not exclude %s', claim => {
    const verified = verifyBody(claim, [source]);
    expect(verified.quarantined).toEqual([]);
    expect(verified.groundingUnits).toEqual([claim]);
  });

  test('headings, fragments, non-prose and failed mechanical checks stay excluded', () => {
    const body = [
      '## The user attended the conference in 2026',
      'Ticket status.',
      '`The user attended the conference in 2026.`',
      'The user paid $999 for a conference ticket.',
      'The user said "this entirely fabricated quotation should never become evidence".',
    ].join('\n\n');
    const verified = verifyBody(body, [source]);
    expect(verified.groundingUnits).toEqual([]);
    expect(verified.quarantined.map(q => q.reason)).toEqual(['number_not_in_source', 'quote_not_in_source']);
  });

  test('only new claims are selected on an existing page', () => {
    const prior = 'The user reached a personal milestone in 2026: attending the conference.';
    const added = 'The user obtained a ticket for the conference.';
    const verified = verifyBody(`${prior}\n\n${added}`, [source], { priorNorm: normForGrounding(prior) });
    expect(verified.groundingUnits).toEqual([added]);
    expect(verified.body).toContain(prior);
  });

  test('semantic quarantine uses final quote repairs and leaves the supported neighboring unit', () => {
    const exact = 'A reliable cache mustn’t disappear — even during a deployment.';
    const transcript = groundSource('/fixtures/cache.md', `User: ${exact}`);
    const claim = 'The user completed deployment: "A reliable cache mustn\'t disappear - even during a deployment."';
    const neighbor = 'The user wants a reliable cache during a deployment.';
    const page = verifyDreamPage({ compiled_truth: `${claim}\n\n${neighbor}`, timeline: '', frontmatter: {} },
      [transcript], { prior: null, checkedAt: '2026-04-03' }, emptyQuoteVerifyStats());
    const repaired = `The user completed deployment: "${exact}"`;
    expect(page.compiled_truth).toContain(repaired);
    expect(page.groundingUnits.map(u => u.text)).toEqual([repaired, neighbor]);
    const output = quarantineUnits(page, [{ body: 'compiled_truth', text: repaired, reason: 'unsupported_paraphrase', detail: 'completion not shown' }],
      [transcript.path], '2026-04-03');
    expect(output.compiled_truth).toBe(neighbor);
    expect(output.frontmatter.unverified_claims).toEqual([expect.objectContaining({ text: repaired, reason: 'unsupported_paraphrase' })]);
  });
});
