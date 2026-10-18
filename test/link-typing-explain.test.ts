/**
 * explainLinkType / traceLinkType: every typing decision names its rule (stable ids), how the verb attached, what it
 * suppressed, the prior, a stated type or pack rule, and the cue behind each dated transition.
 */
import { describe, expect, test } from 'bun:test';
import { explainLinkType, inferLinkType, traceLinkType } from '../src/core/link-extraction.ts';

const ACME = 'companies/acme-example';
const WIDGET = 'companies/widget-example';
const link = (slug: string, name = slug.split('/')[1]!) => `[${name}](../${slug}.md)`;

describe('traceLinkType', () => {
  test('an attached verb names its rule and the outranked alternatives', () => {
    const ctx = `Alice invested in ${link(ACME)} and works at it.`;
    const t = traceLinkType('person', ctx, undefined, ACME, undefined, ctx.indexOf(ACME), undefined, true);
    expect(t).toMatchObject({ type: 'invested_in', rule: 'verb.invested_in', attachment: 'attached', prior: null, unit: null });
    expect(t.suppressed).toContain('verb.works_at:outranked');
    expect(inferLinkType('person', ctx, undefined, ACME, undefined, ctx.indexOf(ACME))).toBe(t.type);
  });

  test("a verb that belongs to another link is suppressed and the prior decides", () => {
    const page = 'Alice is a senior engineer at a startup.';
    const ctx = `Alice met ${link(ACME)} and also advises ${link(WIDGET)}.`;
    const t = traceLinkType('person', ctx, page, ACME, undefined, ctx.indexOf(ACME), page, true);
    expect(t).toMatchObject({ type: 'works_at', rule: 'prior.employee', prior: 'prior.employee', attachment: 'other-links' });
    expect(t.suppressed).toContain('verb.advises:other-link');
  });

  test('page rules have ids too', () => {
    expect(traceLinkType('media', 'x', undefined, ACME).rule).toBe('page.media');
    expect(traceLinkType('person', 'no verbs here', undefined, ACME)).toMatchObject({ type: 'mentions', rule: null, attachment: 'none' });
  });
});

describe('explainLinkType', () => {
  test('stated type wins and is reported', async () => {
    const e = await explainLinkType({ slug: 'people/alice-example', pageType: 'person', target: ACME,
      content: `Alice example.\n\n## Roles\n\n- works_at [[${ACME}]]\n` });
    expect(e.types).toEqual(['works_at']);
    expect(e.occurrences[0]).toMatchObject({ linkType: 'works_at', stated: 'works_at', packRule: null });
  });

  test('transitions carry the cue that produced them', async () => {
    const content = [
      `Alice works at ${link(ACME)} as CTO.`, '', '## Timeline', '',
      `- **2020-01-02** | Joined ${link(ACME)} as CTO`,
      `- **2023-04-05** | Left ${link(ACME)}`,
    ].join('\n');
    const e = await explainLinkType({ slug: 'people/alice-example', pageType: 'person', target: ACME, content });
    expect(e.types).toEqual(['mentions', 'works_at']);
    expect(e.transitions.map(t => [t.kind, t.occurred_on, t.rule])).toEqual([
      ['start', '2020-01-02', 'cue.employment.start'],
      ['end', '2023-04-05', 'cue.employment.end'],
    ]);
    expect(e.occurrences.map(o => [o.linkType, o.rule, o.attachment])).toEqual([
      ['works_at', 'verb.works_at', 'attached'], ['mentions', null, 'other-links'], ['mentions', null, 'none'],
    ]);
  });

  test('explicit grammar and the "left [A] for [B]" start are named', async () => {
    const content = [
      `Alice works at ${link(WIDGET)}. Earlier, she worked at ${link(ACME)}.`, '', '## Timeline', '',
      `- **2019-01-02** | note — Started works_at [[${ACME}]]`,
      `- **2021-03-04** | Left ${link(ACME)} for ${link(WIDGET)}`,
    ].join('\n');
    const acme = await explainLinkType({ slug: 'people/alice-example', pageType: 'person', target: ACME, content });
    const widget = await explainLinkType({ slug: 'people/alice-example', pageType: 'person', target: WIDGET, content });
    expect(acme.transitions.map(t => t.rule)).toEqual(['cue.explicit', 'cue.employment.end']);
    expect(widget.transitions.map(t => [t.kind, t.rule])).toEqual([['start', 'cue.after_end.to_for']]);
  });
});
