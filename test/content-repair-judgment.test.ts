/**
 * #6377 Lane B3: the slug-conflict judgment prompt and parser (pure).
 *
 * Protects: the prompt is built from the two participants only (both
 * frontmatter blocks, headings, the first 60 body lines and the later lines
 * that mention the other slug; never other page text), with a null named
 * side when no page has the slug; each allowed answer parses with its
 * optional why; a canonical that is neither slug, prose, an empty answer, a
 * refusal, a truncated stop and the bare HOLD word land in their failure
 * classes; the participant builder keeps frontmatter as text and bounds the
 * mention lines.
 * Fails when: the prompt leaks text past the participants, an answer shape
 * parses wrong, or a failure class drifts from the fence tier's vocabulary.
 * Why new: the module is new in #6377.
 */
import { describe, expect, test } from 'bun:test';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import { buildJudgmentPrompt, JUDGMENT_HEAD_LINES, JUDGMENT_MAX_MENTIONS, JUDGMENT_PROMPT_VERSION, judgmentParticipant, parseJudgmentAnswer, parseJudgmentText,
  type JudgmentInput } from '../src/core/content-repair/judgment.ts';

const SENTINEL_BODY = 'Sentinelbodyqx9 lives elsewhere';
const result = (text: string, stopReason: ChatResult['stopReason'] = 'end'): ChatResult => ({ text, blocks: [], stopReason, usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-opus-5-5', providerId: 'anthropic' });

const heldFile = `---\ntitle: Alice Example\ntype: person\nslug: people/alice-example\ntags: [founder, synthetic]\n---\n# Alice Example\n\nA synthetic founder.\n\n## Notes\n\nPossible duplicate of people/alice-example.\n${Array.from({ length: 70 }, (_, i) => `Line ${i} of filler.`).join('\n')}\nSee also people/alice-example for the older record.\n`;
const namedPage = `---\ntitle: Alice Example\ntype: person\n---\nA synthetic founder, first met in 2024.\n\nThe newer file people/alice-example-2 repeats this page.\n`;

function input(): JudgmentInput {
  return {
    held: judgmentParticipant({ path: 'people/alice-example-2.md', slug: 'people/alice-example-2', content: heldFile, otherSlug: 'people/alice-example' }),
    named: judgmentParticipant({ path: 'people/alice-example.md', slug: 'people/alice-example', content: namedPage, otherSlug: 'people/alice-example-2', type: 'person' }),
    reason: 'frontmatter_slug_conflict',
  };
}

describe('judgmentParticipant', () => {
  test('frontmatter as text, headings, the first 60 body lines and the later lines that mention the other slug', () => {
    const held = input().held;
    expect(held.frontmatter).toEqual({ title: 'Alice Example', type: 'person', slug: 'people/alice-example', tags: '[founder, synthetic]' });
    expect(held.headings).toEqual(['Alice Example', 'Notes']);
    expect(held.head_lines).toHaveLength(JUDGMENT_HEAD_LINES);
    expect(held.head_lines[0]).toBe('# Alice Example');
    expect(held.mentions).toEqual(['See also people/alice-example for the older record.']);
    expect(held.type).toBe('person');
  });

  test('mentions are bounded and a leaf-word mention counts', () => {
    const body = `---\ntitle: T\n---\n${Array.from({ length: 60 }, () => 'filler').join('\n')}\n${Array.from({ length: 50 }, (_, i) => `mention ${i} of acme-example`).join('\n')}\n`;
    const p = judgmentParticipant({ path: 'notes/t.md', slug: 'notes/t', content: body, otherSlug: 'companies/acme-example' });
    expect(p.mentions).toHaveLength(JUDGMENT_MAX_MENTIONS);
    expect(judgmentParticipant({ path: 'notes/t.md', slug: 'notes/t', content: body, otherSlug: null }).mentions).toEqual([]);
  });
});

describe('buildJudgmentPrompt', () => {
  test('one system and one user message built from both participants only', () => {
    const messages = buildJudgmentPrompt(input());
    expect(messages.map(m => m.role)).toEqual(['system', 'user']);
    const system = messages[0]!.content as string;
    const user = messages[1]!.content as string;
    expect(system).toContain('exactly one JSON object');
    expect(system).toContain('people/alice-example-2 or people/alice-example');
    expect(system).toMatch(/^8\. .*needs_human/m);
    expect(user).toContain('## Held file');
    expect(user).toContain('## Named page');
    expect(user).toContain('path: people/alice-example-2.md');
    expect(user).toContain('slug: people/alice-example');
    expect(user).toContain('Possible duplicate of people/alice-example.');
    expect(user).toContain('later lines mentioning the other slug:');
    expect(user).toContain('The newer file people/alice-example-2 repeats this page.');
    expect(user).not.toContain('Line 65 of filler.');
    expect(user).not.toContain(SENTINEL_BODY);
    expect(JUDGMENT_PROMPT_VERSION).toBe(1);
  });

  test('no named page: the user message says so and the system message offers only the held slug as canonical', () => {
    const messages = buildJudgmentPrompt({ ...input(), named: null });
    expect(messages[1]!.content as string).toContain('(no page has that slug)');
    expect(messages[0]!.content as string).toContain('where <slug> is exactly people/alice-example-2\n');
  });
});

describe('parseJudgmentAnswer', () => {
  const slugs = { held: 'people/alice-example-2', named: 'people/alice-example' };
  test('each allowed answer, with and without why, in a code fence too', () => {
    expect(parseJudgmentAnswer(result('{"action":"remove_slug"}'), slugs)).toEqual({ ok: true, action: 'remove_slug' });
    expect(parseJudgmentAnswer(result('{"action":"merge_into","canonical":"people/alice-example","why":"Same founder, same company."}'), slugs))
      .toEqual({ ok: true, action: 'merge_into', canonical: 'people/alice-example', why: 'Same founder, same company.' });
    expect(parseJudgmentAnswer(result('```json\n{"action":"needs_human"}\n```'), slugs)).toEqual({ ok: true, action: 'needs_human' });
    expect(parseJudgmentText('{"action":"merge_into","canonical":"anything/goes"}')).toMatchObject({ ok: true, action: 'merge_into', canonical: 'anything/goes' });
  });

  test('failure classes: malformed, a canonical that is neither slug, prose, refusal, empty, truncated, declined', () => {
    expect(parseJudgmentAnswer(result('{"action":"merge_into","canonical":"people/someone-else"}'), slugs)).toMatchObject({ ok: false, reason: 'llm_malformed' });
    expect(parseJudgmentAnswer(result('{"action":"delete_page"}'), slugs)).toMatchObject({ ok: false, reason: 'llm_malformed' });
    expect(parseJudgmentAnswer(result('The two pages look like the same person, so merge them.'), slugs)).toMatchObject({ ok: false, reason: 'llm_malformed' });
    expect(parseJudgmentAnswer(result('I cannot help with that request.'), slugs)).toMatchObject({ ok: false, reason: 'llm_refused' });
    expect(parseJudgmentAnswer(result('{"action":"remove_slug"}', 'refusal'), slugs)).toMatchObject({ ok: false, reason: 'llm_refused' });
    expect(parseJudgmentAnswer(result('', 'end'), slugs)).toMatchObject({ ok: false, reason: 'llm_empty' });
    expect(parseJudgmentAnswer(result('', 'length'), slugs)).toMatchObject({ ok: false, reason: 'llm_empty' });
    expect(parseJudgmentAnswer(result('{"action":"merge_in', 'length'), slugs)).toMatchObject({ ok: false, reason: 'llm_truncated' });
    expect(parseJudgmentAnswer(result('HOLD'), slugs)).toMatchObject({ ok: false, reason: 'llm_declined' });
  });
});
