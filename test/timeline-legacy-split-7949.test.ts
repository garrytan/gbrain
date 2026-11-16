/**
 * #7949: rows the file walk filed before #3280, when it cut a dated bullet at
 * its first dash of any kind (`foo-bar.de` -> `foo` / `bar.de`), are retired.
 *
 * Protects: `retractRemovedTimelineEntries` (the core of `extract timeline
 * --prune-orphans` and the sync reconcile) retracts a stored row equal to that
 * older reading of the page text when its detail is extractor-written, keeps
 * the current row, and keeps a legacy-shaped row someone gave their own detail.
 * Fails when: the older split is not one of the superseded readings, so no
 * version of the page "produced" the row and it stays forever.
 * Seams: none; real PGLite.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { retractRemovedTimelineEntries, supersededTimelineReadings } from '../src/core/timeline-extract.ts';
import { cpuMs } from './helpers/cpu-time.ts';

const slug = 'people/alice-example';
const text = [
  '- **2020-05-03** | Email activity with acme-example.com (1 messages); link day [[days/2020/2020-05-03|2020-05-03]].',
  '- **2021-04-04** | Call with alice-example about the plan',
].join('\n');
const legacy = [
  { date: '2020-05-03', source: 'Email activity with acme', summary: 'example.com (1 messages); link day [[days/2020/2020-05-03|2020-05-03]].' },
  { date: '2021-04-04', source: 'Call with alice', summary: 'example about the plan' },
];

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });

test('the pre-#3280 split of a dated bullet is a superseded reading', () => {
  expect(supersededTimelineReadings(text)).toEqual(legacy);
  expect(supersededTimelineReadings('- **2020-05-03** | No dash at all here')).toEqual([]);
  expect(supersededTimelineReadings(text.replace(/\n/g, '\r\n') + '\r\n')).toEqual(legacy);
});

test('the older split stays linear on a long line with no dash', () => {
  const line = `- **2020-05-03** | ${' '.repeat(200_000)}x${' '.repeat(200_000)}`;
  expect(cpuMs(() => supersededTimelineReadings(line))).toBeLessThan(1_000);
});

test('legacy split rows are retracted and the current rows stay', async () => {
  await engine.putPage(slug, { type: 'person', title: 'Alice Example', compiled_truth: text, timeline: '' });
  for (const row of legacy) await engine.addTimelineEntry(slug, row);
  await engine.addTimelineEntry(slug, { date: '2020-05-03', source: 'markdown', summary: 'Email activity with acme-example.com (1 messages); link day [[days/2020/2020-05-03|2020-05-03]].' });
  await engine.addTimelineEntry(slug, { date: '2021-04-04', source: 'markdown', summary: 'Call with alice-example about the plan' });
  const retired = await retractRemovedTimelineEntries(engine, slug, 'default', text);
  expect(retired.map(r => r.source).sort()).toEqual(['Call with alice', 'Email activity with acme']);
  const left = await engine.executeRaw<{ source: string }>('SELECT source FROM timeline_entries ORDER BY source');
  expect(left.map(r => r.source)).toEqual(['markdown', 'markdown']);
});

test('a legacy-shaped row someone gave their own detail stays', async () => {
  await engine.putPage(slug, { type: 'person', title: 'Alice Example', compiled_truth: text, timeline: '' });
  await engine.addTimelineEntry(slug, { ...legacy[1]!, detail: 'confirmed by phone' });
  expect(await retractRemovedTimelineEntries(engine, slug, 'default', text)).toEqual([]);
});
