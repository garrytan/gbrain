/**
 * Temporal typed edges — deterministic evidence derivation from page content
 * (src/core/link-temporal-evidence.ts): cue-dated timeline lines, the explicit
 * Started/Ended grammar, frontmatter since/until and assertion tense.
 */
import { describe, test, expect } from 'bun:test';
import { deriveTemporalEvidence, rowKey, normalizeLinkTarget, type OwnedRow } from '../src/core/link-temporal-evidence.ts';
import { setPackRelationSemantics } from '../src/core/link-validity.ts';

const alice = 'people/alice-example';
const row = (to: string, link_type: string, extra: Partial<OwnedRow> = {}): OwnedRow => ({ from_slug: alice, to_slug: to, link_type, link_source: 'markdown', ...extra });
const derive = (compiled: string, timeline: string, rows: OwnedRow[], frontmatter: Record<string, unknown> = {}) =>
  deriveTemporalEvidence({ slug: alice, compiled_truth: compiled, timeline, frontmatter }, rows);
const brief = (t: ReturnType<typeof derive>['transitions']) => t.map(x => `${x.to_slug.split('/').pop()}:${x.link_type}:${x.kind}:${x.occurred_on}:${x.producer}`);

describe('dated timeline cues', () => {
  test('left X to join Y dates both relationships', () => {
    const ev = derive('', '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co) as CTO',
      [row('companies/acme-example', 'works_at'), row('companies/widget-co', 'works_at')]);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:end:2025-03-01:timeline', 'widget-co:works_at:start:2025-03-01:timeline']);
  });

  test('a cue never creates a relationship the page does not assert', () => {
    const ev = derive('', '- **2025-03-01** | note — Joined [Widget](companies/widget-co)', [row('companies/acme-example', 'works_at')]);
    expect(ev.transitions).toEqual([]);
  });

  test('leaving employment does not end an advisory relationship', () => {
    const ev = derive('', '- **2024-06-01** | note — left [Acme](companies/acme-example)', [row('companies/acme-example', 'advises')]);
    expect(ev.transitions).toEqual([]);
  });

  test('advisory cues date advises', () => {
    const ev = derive('', '- **2024-06-01** | note — stepped down as advisor to [Acme](companies/acme-example)', [row('companies/acme-example', 'advises')]);
    expect(brief(ev.transitions)).toEqual(['acme-example:advises:end:2024-06-01:timeline']);
  });

  test('a meeting with a former employer is not a start', () => {
    const ev = derive('', '- **2026-01-10** | cal — Coffee with the [Acme](companies/acme-example) team', [row('companies/acme-example', 'works_at')]);
    expect(ev.transitions).toEqual([]);
  });

  test('bare wikilinks resolve against asserted targets', () => {
    const ev = derive('', '- **2023-02-01** | me — joined [[acme-example]]', [row('companies/acme-example', 'works_at')]);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:start:2023-02-01:timeline']);
  });

  test('event relations get their dated occurrence', () => {
    const ev = derive('', '- **2021-05-01** | deal — invested in [Fund A](companies/fund-a)', [row('companies/fund-a', 'invested_in')]);
    expect(brief(ev.transitions)).toEqual(['fund-a:invested_in:start:2021-05-01:timeline']);
  });

  test('fenced code is ignored', () => {
    const ev = derive('', '```\n- **2025-03-01** | x — left [Acme](companies/acme-example)\n```', [row('companies/acme-example', 'works_at')]);
    expect(ev.transitions).toEqual([]);
  });
});

describe('explicit grammar', () => {
  test('Ended works_at needs no positive assertion on the page', () => {
    const ev = derive('', '- **2025-03-01** | me — Ended works_at [[companies/acme-example]]', []);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:end:2025-03-01:explicit']);
  });

  test('dream-labelled lines carry producer dream', () => {
    const ev = derive('', '- **2025-03-01** | gbrain-dream (inferred) — Ended works_at [[companies/acme-example]] (superseded by works_at companies/widget-co)', []);
    expect(brief(ev.transitions)).toEqual(['acme-example:works_at:end:2025-03-01:dream']);
  });

  test('unusable explicit lines are reported, not silent', () => {
    const ev = derive('', '- **2025-03-01** | me — Ended mentions [[companies/acme-example]]\n- **2025-03-02** | me — Ended founded [[companies/acme-example]]', []);
    expect(ev.transitions).toEqual([]);
    expect(ev.unmatched.map(u => u.reason)).toEqual(['not_temporal', 'event_cannot_end']);
  });
});

describe('frontmatter since/until', () => {
  test('relationship objects with since and until', () => {
    const r = row('companies/acme-example', 'works_at', { link_source: 'frontmatter', origin_field: 'company' });
    const ev = derive('', '', [r], { company: [{ name: 'Acme', since: '2021-04', until: '2024-02-15' }] });
    expect(ev.transitions.map(t => `${t.kind}:${t.occurred_on}:${t.date_precision}:${t.producer}`)).toEqual(['start:2021-04-01:month:frontmatter', 'end:2024-02-15:day:frontmatter']);
  });

  test('targets sharing a slug prefix: each object dates only its exact target when several match', () => {
    const page = 'contracts/msa-example-amendment-2';
    const msa = { from_slug: page, to_slug: 'contracts/msa-example', link_type: 'amends', link_source: 'frontmatter', origin_field: 'amends' };
    const renewal = { ...msa, to_slug: 'contracts/msa-example-renewal' };
    const fm = { amends: [{ name: 'MSA Example', since: '2026-11-01' }, { name: 'MSA Example Renewal', since: '2027-03-01' }] };
    setPackRelationSemantics(new Map([['amends', 'event']]));
    let ev;
    try { ev = deriveTemporalEvidence({ slug: page, compiled_truth: '', timeline: '', frontmatter: fm }, [msa, renewal]); }
    finally { setPackRelationSemantics(new Map()); }
    expect(ev.transitions.map(t => `${t.to_slug}:${t.kind}:${t.occurred_on}`).sort()).toEqual([
      'contracts/msa-example-renewal:start:2027-03-01',
      'contracts/msa-example:start:2026-11-01',
    ]);
  });

  test('a single prefix match still dates its target; two prefix-only matches date nothing', () => {
    const r = row('companies/acme-example', 'works_at', { link_source: 'frontmatter', origin_field: 'company' });
    expect(brief(derive('', '', [r], { company: [{ name: 'Acme', since: '2021-04' }, { name: 'Widget', since: '2022-01' }] }).transitions))
      .toEqual(['acme-example:works_at:start:2021-04-01:frontmatter']);
    expect(derive('', '', [r], { company: [{ name: 'Acme', since: '2021-04' }, { name: 'Acme Example', since: '2022-01' }] }).transitions
      .map(t => t.occurred_on)).toEqual(['2022-01-01']);
    expect(derive('', '', [row('companies/acme-example-labs', 'works_at', { link_source: 'frontmatter', origin_field: 'company' })], {
      company: [{ name: 'Acme', since: '2021-04' }, { name: 'Acme Example', since: '2022-01' }],
    }).transitions).toEqual([]);
  });
});

describe('assertion tense', () => {
  const acme = row('companies/acme-example', 'works_at');
  test('past-tense mention only → past', () => {
    expect(derive('Alice was previously at [Acme](companies/acme-example).', '', [acme]).tense.get(rowKey(acme))).toBe('past');
    expect(derive('She is a former CTO of [Acme](companies/acme-example).', '', [acme]).tense.get(rowKey(acme))).toBe('past');
  });
  test('present beats past on the same page', () => {
    const text = 'Alice was previously at [Acme](companies/acme-example). Now she runs the EU team at [Acme](companies/acme-example).';
    expect(derive(text, '', [acme]).tense.get(rowKey(acme))).toBe('present');
  });
  test('plain present mention → present', () => {
    expect(derive('Alice is CTO of [Acme](companies/acme-example).', '', [acme]).tense.get(rowKey(acme))).toBe('present');
  });
  test('timeline lines do not set tense', () => {
    expect(derive('Alice is CTO of [Acme](companies/acme-example).\n- **2025-03-01** | x — worked at [Acme](companies/acme-example)', '', [acme]).tense.get(rowKey(acme))).toBe('present');
  });
});

test('normalizeLinkTarget', () => {
  expect(normalizeLinkTarget('../companies/acme-example.md#team')).toBe('companies/acme-example');
  expect(normalizeLinkTarget('./people/a')).toBe('people/a');
});

describe('conservative cues (only a cue that governs the relationship moves it)', () => {
  const acme = row('companies/acme-example', 'works_at');
  const widget = row('companies/widget-co', 'works_at');
  const line = (text: string) => `- **2025-03-01** | note — ${text}`;

  test('investing, meeting and event lines never start or end employment', () => {
    for (const text of [
      "Joined [Acme](companies/acme-example)'s Series B as an angel investor",
      'Back at [Acme](companies/acme-example) for an alumni reunion',
      'Joined the [Acme](companies/acme-example) alumni dinner',
      'Left [Acme](companies/acme-example) early after the panel',
      'Returned to [Acme](companies/acme-example) to give a talk',
    ]) expect(derive('', line(text), [acme]).transitions).toEqual([]);
  });

  test('a qualified reference is about something of the organization, not the organization', () => {
    expect(derive('', line("Left [Acme](companies/acme-example)'s London office"), [acme]).transitions).toEqual([]);
    expect(derive('', line('Joined [Acme](companies/acme-example) alumni on a trip'), [acme]).transitions).toEqual([]);
  });

  test("an advisory board possessive starts and ends advises", () => {
    const adv = row('companies/acme-example', 'advises');
    expect(brief(derive('', line("Joined [Acme](companies/acme-example)'s advisory board"), [adv]).transitions)).toEqual(['acme-example:advises:start:2025-03-01:timeline']);
    expect(brief(derive('', line("Stepped down from [Acme](companies/acme-example)'s advisory board"), [adv]).transitions)).toEqual(['acme-example:advises:end:2025-03-01:timeline']);
  });

  test('moved from / left A to / for B ends A and starts B, for the relation that ended only', () => {
    for (const text of [
      'Moved from [Acme](companies/acme-example) to [Widget](companies/widget-co) as CTO',
      'Left [Acme](companies/acme-example) for [Widget](companies/widget-co) (CTO)',
      'Switched from [Acme](companies/acme-example) to [Widget](companies/widget-co)',
    ]) expect(brief(derive('', line(text), [acme, widget]).transitions)).toEqual(['acme-example:works_at:end:2025-03-01:timeline', 'widget-co:works_at:start:2025-03-01:timeline']);
    const advWidget = row('companies/widget-co', 'advises');
    expect(brief(derive('', line('Moved from [Acme](companies/acme-example) to [Widget](companies/widget-co)'), [acme, advWidget]).transitions)).toEqual(['acme-example:works_at:end:2025-03-01:timeline']);
  });

  test('wider join and leave verbs', () => {
    for (const text of ['Moved on from [Acme](companies/acme-example)', 'Stepped away from [Acme](companies/acme-example)', 'Wrapped up her time at [Acme](companies/acme-example)', 'Last day at [Acme](companies/acme-example)'])
      expect(brief(derive('', line(text), [acme]).transitions)).toEqual(['acme-example:works_at:end:2025-03-01:timeline']);
    for (const text of ['Was hired by [Acme](companies/acme-example) as CTO', 'Started at [Acme](companies/acme-example) as CTO', 'Accepted an offer from [Acme](companies/acme-example)', 'Rejoined [Acme](companies/acme-example)'])
      expect(brief(derive('', line(text), [acme]).transitions)).toEqual(['acme-example:works_at:start:2025-03-01:timeline']);
  });

  test('"Started at [X]" is prose, not the explicit grammar; a snake_case token still is', () => {
    expect(derive('', line('Started at [Acme](companies/acme-example) as CTO'), [acme]).unmatched).toEqual([]);
    expect(derive('', line('Ended reports_to [[people/bob-example]]'), []).unmatched.map(u => u.reason)).toEqual(['not_temporal']);
  });

  test('present perfect and promotions read as present; plain past tense reads as past', () => {
    const tense = (compiled: string) => derive(compiled, '', [acme]).tense.get(rowKey(acme));
    expect(tense('Alice has worked at [Acme](companies/acme-example) for years.')).toBe('present');
    expect(tense('Alice was promoted to CTO at [Acme](companies/acme-example) last year.')).toBe('present');
    expect(tense("Alice has spent six years at [Acme](companies/acme-example).")).toBe('present');
    expect(tense('Alice worked at [Acme](companies/acme-example).')).toBe('past');
    expect(tense('Alice was CTO at [Acme](companies/acme-example).')).toBe('past');
  });

  test('frontmatter dates stored as UTC-midnight timestamps', () => {
    const r = row('companies/acme-example', 'works_at', { link_source: 'frontmatter', origin_field: 'company' });
    const ev = derive('', '', [r], { company: [{ name: 'companies/acme-example', since: '2019-07-14T00:00:00.000Z' }, { name: 'companies/acme-example', since: '2023-09-16T00:00:00.000Z' }] });
    expect(ev.transitions.map(t => `${t.kind}:${t.occurred_on}`)).toEqual(['start:2019-07-14', 'start:2023-09-16']);
  });
});
