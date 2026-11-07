import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { retractRemovedTimelineEntries } from '../src/core/timeline-extract.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

test('retracts a legacy split row duplicated by the current dated bullet', async () => {
  const slug = 'people/alice-example';
  const text = '- **2020-05-03** | Email activity; link day [[days/2020/2020-05-03|2020-05-03]].';
  const summary = 'Email activity; link day [[days/2020/2020-05-03|2020-05-03]].';
  await engine.putPage(slug, { type: 'person', title: 'Example', compiled_truth: text, timeline: '' });
  await engine.addTimelineEntry(slug, {
    date: '2020-05-03', source: 'Email activity; link day [[days/2020/2020',
    summary: '05-03|2020-05-03]].',
  });
  await engine.addTimelineEntry(slug, { date: '2020-05-03', source: 'markdown', summary });

  const removed = await retractRemovedTimelineEntries(engine, slug, 'default', text);
  const remaining = await engine.executeRaw<{ source: string }>(
    'SELECT source FROM timeline_entries ORDER BY source');
  expect(removed.map(row => row.source)).toEqual(['Email activity; link day [[days/2020/2020']);
  expect(remaining.map(row => row.source)).toEqual(['markdown']);
});
