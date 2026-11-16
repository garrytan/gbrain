/**
 * #8893: a citation-derived timeline summary keeps the text of its inline code.
 *
 * Protects: the summary of `Shipped \`build-42.tar\` [Source: …]` names the
 * file (backticks dropped, code text never emphasis-unwrapped), fenced code
 * still never reaches a summary, a citation inside code still files nothing,
 * and a stored row written by the code-masking reading is retired on
 * reconcile instead of lingering next to the new row.
 * Fails when: the summary is built from the code-masked text (inline code
 * stored as blanks), or the masked reading is not listed as superseded.
 * Seams: none; pure parser plus real PGLite for the retraction.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseInlineCitationTimelineEntries, supersededInlineCitationEntries } from '../src/core/timeline-citations.ts';
import { retractRemovedTimelineEntries } from '../src/core/timeline-extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cpuMs } from './helpers/cpu-time.ts';

const tick = '`';

describe('#8893 inline code in citation summaries', () => {
  test('inline code text stays in the summary without its backticks', () => {
    expect(parseInlineCitationTimelineEntries(`Shipped ${tick}build-42.tar${tick} to acme-example. [Source: deploy log, 2026-01-02]`))
      .toEqual([{ date: '2026-01-02', source: 'deploy log', summary: 'Shipped build-42.tar to acme-example.' }]);
  });

  test('code text is not emphasis-unwrapped and double-backtick spans keep their inner backtick', () => {
    expect(parseInlineCitationTimelineEntries(`Renamed ${tick}__init__.py${tick} and ${tick}${tick} a${tick}b ${tick}${tick}. [Source: review, 2026-01-03]`).map(e => e.summary))
      .toEqual([`Renamed __init__.py and a${tick}b.`]);
  });

  test('a fenced block next to a cited paragraph never enters the summary', () => {
    const body = `Deployed the fix. [Source: deploy log, 2026-01-04]\n${tick.repeat(3)}\nsecret-looking build output\n${tick.repeat(3)}`;
    expect(parseInlineCitationTimelineEntries(body).map(e => e.summary)).toEqual(['Deployed the fix.']);
  });

  test('a citation written inside inline code still files nothing and never enters a summary', () => {
    expect(parseInlineCitationTimelineEntries(`Use ${tick}[Source: x, 2026-01-02]${tick} literally.`)).toEqual([]);
    expect(parseInlineCitationTimelineEntries(`Quoted ${tick}[Source: x, 2026-01-02]${tick} and ${tick}<!-- note -->${tick}. [Source: style guide, 2026-01-05]`).map(e => e.summary))
      .toEqual(['Quoted and .']);
  });

  test('a long code span with a leading space parses in linear time (remote put_page bodies)', () => {
    const body = `Intro [Source: A, 2026-01-01]\n\nx ${tick} ${'a'.repeat(200_000)}${tick} y [Source: B, 2026-01-02]`;
    expect(cpuMs(() => { parseInlineCitationTimelineEntries(body); supersededInlineCitationEntries(body); })).toBeLessThan(1_000);
  }, 60_000);

  test('restored code never completes citation or comment markup that continues outside the span', () => {
    expect(parseInlineCitationTimelineEntries(`See ${tick}[Sour${tick}ce: X, 2026-03-03] now [Source: B, 2026-02-02]`).map(e => e.summary)).toEqual(['See ce: X, 2026-03-03] now']);
    expect(parseInlineCitationTimelineEntries(`Note ${tick}<!${tick}-- hidden tail [Source: B, 2026-02-02]`).map(e => e.summary)).toEqual(['Note -- hidden tail']);
  });

  test('placeholder characters already in the text are never replaced by code', () => {
    expect(parseInlineCitationTimelineEntries(`Literal \uE0000\uE001 then ${tick}code${tick} [Source: B, 2026-02-02]`).map(e => e.summary))
      .toEqual(['Literal 0 then code']);
  });

  test('the code-masking reading is reported as superseded only where the summary changed', () => {
    expect(supersededInlineCitationEntries(`Shipped ${tick}build-42.tar${tick} to acme-example. [Source: deploy log, 2026-01-02]`))
      .toEqual([{ date: '2026-01-02', source: 'deploy log', summary: 'Shipped to acme-example.' }]);
    expect(supersededInlineCitationEntries('Shipped the beta. [Source: deploy log, 2026-01-02]')).toEqual([]);
  });
});

describe('#8893 a row the code-masking reading stored is retired on reconcile', () => {
  const text = `Shipped ${tick}build-42.tar${tick} to acme-example. [Source: deploy log, 2026-01-02]`;
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test('the masked-summary row is retracted and the current row stays', async () => {
    await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: text, timeline: '' });
    await engine.addTimelineEntry('companies/acme-example', { date: '2026-01-02', source: 'deploy log', summary: 'Shipped to acme-example.', detail: 'Source: deploy log' });
    await engine.addTimelineEntry('companies/acme-example', { date: '2026-01-02', source: 'deploy log', summary: 'Shipped build-42.tar to acme-example.', detail: 'Source: deploy log' });
    const retired = await retractRemovedTimelineEntries(engine, 'companies/acme-example', 'default', text);
    expect(retired.map(r => r.summary)).toEqual(['Shipped to acme-example.']);
    const left = await engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries');
    expect(left.map(r => r.summary)).toEqual(['Shipped build-42.tar to acme-example.']);
  });
});
