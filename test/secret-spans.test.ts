/**
 * GST-327: the pure span planner behind `gbrain repair secret-spans`. Spans come from the scanner's claims plus echoes
 * of claimed values across a page's fields; the splice must equal `applyRedaction` byte for byte; a marker-only claim is
 * dropped, so redacted text is a fixed point; unknown rule names refuse before anything is scanned.
 */
import { describe, expect, test } from 'bun:test';
import { NAMED_SECRET_RULES } from '../src/core/secret-scan.ts';
import { BROAD_SECRET_RULES, redactFields, residualMatches, resolveSecretRules } from '../src/core/secret-spans.ts';

const OPENAI = ['sk', 'proj', 'EXAMPLExNOTxREALxEXAMPLExNOTxREAL'].join('-');
const AWS = 'AKIA' + 'EXAMPLENOTREAL00';
const BEARER = 'EXAMPLEtokenNOTreal' + '1234567890abcdef';

describe('secret-spans planner', () => {
  test('default rules are every named rule; broad heuristics only when named; unknown names refuse', () => {
    expect(resolveSecretRules().rules).toEqual([...NAMED_SECRET_RULES]);
    expect(resolveSecretRules().rules.some(rule => BROAD_SECRET_RULES.includes(rule))).toBe(false);
    expect(resolveSecretRules(['labeled_credential', 'openai']).scan).toEqual({ highEntropy: false, labeledCredentials: true });
    expect(() => resolveSecretRules(['openai', 'nope'])).toThrow(/Unknown secret rule: "nope"; nothing was scanned/);
  });

  test('claims, echoes across fields and a key glued to a marker are replaced; everything else is byte-identical; the result is a fixed point', () => {
    const rules = resolveSecretRules();
    const fields = [
      { key: 'title', text: 'Notes' },
      { key: 'compiled_truth', text: `Key ${OPENAI} and ${AWS}.\n<REDACTED:openai>${OPENAI} glued.\nAuthorization: Bearer ${BEARER}` },
      { key: 'facts/1/fact', text: `The bare token ${BEARER} again.` },
    ];
    const results = redactFields(fields, rules);
    expect(results.every(result => result.proven)).toBe(true);
    expect(results.map(result => result.next)).toEqual(['Notes',
      'Key <REDACTED:openai> and <REDACTED:aws_access_key>.\n<REDACTED:openai><REDACTED:openai> glued.\nAuthorization: Bearer <REDACTED:bearer>',
      'The bare token <REDACTED:bearer> again.']);
    expect(results[0]!.spans).toEqual([]);
    expect(results[2]!.spans).toEqual([expect.objectContaining({ rule: 'bearer', echo: true })]);
    expect(results[0]!.new_sha256).toBe(results[0]!.old_sha256);
    expect(JSON.stringify(results.map(({ next: _next, ...rest }) => rest))).not.toContain(OPENAI);
    const again = redactFields(results.map(result => ({ key: result.key, text: result.next })), rules);
    expect(again.every(result => result.spans.length === 0 && result.proven)).toBe(true);
    for (const result of results) expect(residualMatches(result.next, rules)).toEqual({});
  });

  test('a rule left out of the selection is neither claimed nor echoed', () => {
    const [result] = redactFields([{ key: 'compiled_truth', text: `${OPENAI} ${AWS} ${OPENAI}` }], resolveSecretRules(['aws_access_key']));
    expect(result!.next).toBe(`${OPENAI} <REDACTED:aws_access_key> ${OPENAI}`);
  });
});
