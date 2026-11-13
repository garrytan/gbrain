/**
 * #8020: fence locators that counted or spliced markers as raw text while the fence readers skip a marker inside
 * markdown code (an inline span or a fenced block, `locateOutsideCode`). A page that quotes a marker in code, which
 * the content-repair lane's quoted-marker fix produces by wrapping the marker in backticks, was held by the concept
 * preservation check (CONCEPT_FACTS_FENCE_DUPLICATE: concept republication, the Google connector's fence carry and
 * the connector-fences repair all refuse) and its timeline fence could not be relocated. The readers' rule is
 * unchanged; these locators now find the same fence the readers parse. Pure functions; no database.
 */
import { describe, expect, test } from 'bun:test';
import { conceptPreservationHold, preserveCanonicalFences } from '../src/core/cycle/concept-publication.ts';
import { relocateTimelineFences } from '../src/core/repair/connector-fences.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, parseTakesFence } from '../src/core/takes-fence.ts';

const FACTS = [FACTS_FENCE_BEGIN,
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  '| 1 | Acme example ships in Q3 | fact | 1.0 | world | medium | 2026-01-01 |  | notes |  |',
  FACTS_FENCE_END].join('\n');
const QUOTED = `Writers quote the markers as \`${FACTS_FENCE_BEGIN}\` and \`${FACTS_FENCE_END}\` when they explain the format.`;
const BLOCK = ['\`\`\`', TAKES_FENCE_BEGIN, '\`\`\`'].join('\n');

describe('#8020: a marker quoted in code is not a fence to the locators either', () => {
  test('the concept preservation check does not hold a page whose only extra markers sit in code', () => {
    const page = { compiled_truth: `# Acme example\n\n${QUOTED}\n\n${BLOCK}\n\n## Facts\n\n${FACTS}\n`, timeline: '', body_storage: 'inline' as const };
    expect(parseFactsFence(page.compiled_truth).facts.map(f => f.claim)).toEqual(['Acme example ships in Q3']);
    expect(parseTakesFence(page.compiled_truth).takes).toEqual([]);
    expect(conceptPreservationHold(page)).toBeNull();
    const republished = preserveCanonicalFences(page, '# Acme example\n\nA new narrative.');
    expect(parseFactsFence(republished).facts.map(f => f.claim)).toEqual(['Acme example ships in Q3']);
    expect(republished).toContain(FACTS);
    expect(republished).not.toContain(TAKES_FENCE_BEGIN);
  });

  test('a real duplicate fence outside code is still held', () => {
    const page = { compiled_truth: `# Acme example\n\n${QUOTED}\n\n${FACTS}\n\n${FACTS}\n`, timeline: '' };
    expect(conceptPreservationHold(page)).toMatch(/^CONCEPT_FACTS_FENCE_DUPLICATE/);
  });

  test('a timeline that only quotes a marker in code is not a fence below the sentinel', () => {
    const page = { compiled_truth: `# Acme example\n\n## Facts\n\n${FACTS}\n`, timeline: `- **2026-10-01** | ${QUOTED}` };
    expect(conceptPreservationHold(page)).toBeNull();
  });

  test('connector-fences relocates the timeline fence when the body quotes its marker in code', () => {
    const page = { compiled_truth: `# Acme example\n\n${QUOTED}\n`, timeline: `- **2026-10-01** | Kickoff\n\n${FACTS}\n` };
    const moved = relocateTimelineFences(page);
    expect(moved).not.toBeNull();
    expect(moved!.timeline).toBe('- **2026-10-01** | Kickoff');
    expect(moved!.compiled_truth).toContain(QUOTED);
    expect(parseFactsFence(moved!.compiled_truth).facts.map(f => f.claim)).toEqual(['Acme example ships in Q3']);
  });
});
