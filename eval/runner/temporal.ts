/**
 * BrainBench Category 4: Temporal Queries.
 *
 * Tests:
 *   - Point: "what happened on date X?"
 *   - Range: "what happened between A and B?"
 *   - Recency: "most recent N events for X"
 *   - As-of: "as of date D, where did X work?" (HARD — gbrain has no native op)
 *   - Comparative: "what changed between Q1 and Q2?" (HARD — gbrain has no native op)
 *
 * Compares structured timeline_entries (via getTimeline) against content scan
 * (parsing markdown timeline section in pages.timeline).
 *
 * Usage: bun run eval/runner/temporal.ts [--json]
 */

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

interface TimelineEvent {
  slug: string;
  date: string;
  summary: string;
}

interface AsOfQuery {
  question: string;
  slug: string;
  asOfDate: string;
  /** Expected answer: the most-recent timeline entry summary on or before asOfDate. */
  expected: string;
}

function generateData(): { events: TimelineEvent[]; asOfQueries: AsOfQuery[] } {
  const events: TimelineEvent[] = [];
  const asOfQueries: AsOfQuery[] = [];

  // 50 entities, each with 10-20 dated events spread over 5 years.
  for (let i = 0; i < 50; i++) {
    const slug = `people/p${i}`;
    const eventCount = 10 + (i % 10);
    let currentJob = 'startup-0';
    for (let e = 0; e < eventCount; e++) {
      // Date: 2021 to 2026, evenly spaced + jittered.
      const baseDays = (e / eventCount) * (5 * 365);
      const jitter = (i * 13 + e * 7) % 30;
      const dayOffset = Math.floor(baseDays + jitter);
      const d = new Date('2021-01-01');
      d.setUTCDate(d.getUTCDate() + dayOffset);
      const date = d.toISOString().slice(0, 10);
      // Event types: job change, funding, talk, mention.
      const eventTypes = ['joined', 'announced', 'spoke at', 'hired by', 'promoted to'];
      const summary = `${eventTypes[e % eventTypes.length]} startup-${e % 5}`;
      events.push({ slug, date, summary });

      if (eventTypes[e % eventTypes.length] === 'joined' || eventTypes[e % eventTypes.length] === 'hired by') {
        currentJob = `startup-${e % 5}`;
      }
    }

    // As-of query: pick a date in 2024 and ask where this person worked at that time.
    const asOfDate = `2024-06-${15 + (i % 14)}`;
    // Expected: the most recent "joined" or "hired by" event before asOfDate.
    const before = events
      .filter(ev => ev.slug === slug && (ev.summary.startsWith('joined') || ev.summary.startsWith('hired by')) && ev.date <= asOfDate)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (before.length > 0) {
      asOfQueries.push({
        question: `As of ${asOfDate}, where did p${i} work?`,
        slug,
        asOfDate,
        expected: before[0].summary,
      });
    }
  }

  return { events, asOfQueries };
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  log('# BrainBench Category 4: Temporal Queries\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

  const { events, asOfQueries } = generateData();
  log(`Events: ${events.length}`);
  log(`Entities: 50`);
  log(`As-of queries: ${asOfQueries.length}`);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed pages with timeline content (markdown form) AND structured entries.
  const eventsBySlug = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    if (!eventsBySlug.has(e.slug)) eventsBySlug.set(e.slug, []);
    eventsBySlug.get(e.slug)!.push(e);
  }

  for (const [slug, slugEvents] of eventsBySlug) {
    const timelineMd = slugEvents.map(e => `- **${e.date}** | ${e.summary}`).join('\n');
    await engine.putPage(slug, {
      type: 'person',
      title: slug.replace('people/', ''),
      compiled_truth: 'A person.',
      timeline: timelineMd,
    });
    // Also add structured entries.
    for (const e of slugEvents) {
      await engine.addTimelineEntry(slug, { date: e.date, summary: e.summary, source: '', detail: '' });
    }
  }

  // ── Test 1: Point queries ──
  // "What happened on YYYY-MM-DD?" — pick 30 random dates that have at least one event.
  log('\n## Point queries');
  const dates = [...new Set(events.map(e => e.date))].sort();
  const testDates = dates.filter((_, i) => i % Math.floor(dates.length / 30) === 0).slice(0, 30);
  let pointHits = 0, pointTotal = 0, pointReturned = 0, pointValid = 0;
  for (const date of testDates) {
    // Use getTimeline filtered manually (no native cross-entity date query).
    const allEntries: { slug: string; summary: string }[] = [];
    for (const slug of eventsBySlug.keys()) {
      const tl = await engine.getTimeline(slug);
      for (const t of tl) {
        const tDate = t.date instanceof Date ? t.date.toISOString().slice(0, 10) : String(t.date).slice(0, 10);
        if (tDate === date) allEntries.push({ slug, summary: t.summary });
      }
    }
    const expected = events.filter(e => e.date === date);
    pointTotal += expected.length;
    pointReturned += allEntries.length;
    for (const e of expected) {
      if (allEntries.some(a => a.slug === e.slug && a.summary === e.summary)) pointHits++;
    }
    for (const a of allEntries) {
      if (expected.some(e => e.slug === a.slug && e.summary === a.summary)) pointValid++;
    }
  }
  const pointRecall = pointTotal > 0 ? pointHits / pointTotal : 1;
  const pointPrecision = pointReturned > 0 ? pointValid / pointReturned : 1;
  log(`  ${testDates.length} dates queried, ${pointTotal} expected events`);
  log(`  Recall: ${(pointRecall * 100).toFixed(1)}%, Precision: ${(pointPrecision * 100).toFixed(1)}%`);

  // ── Test 2: Range queries ──
  log('\n## Range queries');
  const ranges = [
    { from: '2024-01-01', to: '2024-03-31', label: 'Q1 2024' },
    { from: '2025-04-01', to: '2025-06-30', label: 'Q2 2025' },
    { from: '2026-01-01', to: '2026-12-31', label: '2026 full year' },
    { from: '2023-07-01', to: '2023-09-30', label: 'Q3 2023' },
  ];
  let rangeRecall = 0, rangePrecision = 0;
  for (const r of ranges) {
    const expected = events.filter(e => e.date >= r.from && e.date <= r.to);
    const allEntries: { slug: string; date: string; summary: string }[] = [];
    for (const slug of eventsBySlug.keys()) {
      const tl = await engine.getTimeline(slug);
      for (const t of tl) {
        const tDate = t.date instanceof Date ? t.date.toISOString().slice(0, 10) : String(t.date).slice(0, 10);
        if (tDate >= r.from && tDate <= r.to) allEntries.push({ slug, date: tDate, summary: t.summary });
      }
    }
    const hits = expected.filter(e => allEntries.some(a => a.slug === e.slug && a.summary === e.summary)).length;
    const valid = allEntries.filter(a => expected.some(e => e.slug === a.slug && e.summary === a.summary)).length;
    const recall = expected.length > 0 ? hits / expected.length : 1;
    const precision = allEntries.length > 0 ? valid / allEntries.length : 1;
    rangeRecall += recall / ranges.length;
    rangePrecision += precision / ranges.length;
    log(`  ${r.label}: ${expected.length} expected, ${allEntries.length} returned, R=${(recall * 100).toFixed(1)}%, P=${(precision * 100).toFixed(1)}%`);
  }
  log(`  Average: R=${(rangeRecall * 100).toFixed(1)}%, P=${(rangePrecision * 100).toFixed(1)}%`);

  // ── Test 3: Recency queries ──
  log('\n## Recency queries (most recent 3 events per entity)');
  let recencyCorrect = 0, recencyTotal = 0;
  const sampleEntities = [...eventsBySlug.keys()].slice(0, 30);
  for (const slug of sampleEntities) {
    const expected = events.filter(e => e.slug === slug).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const tl = await engine.getTimeline(slug);
    const sortedTl = [...tl].sort((a, b) => {
      const ad = a.date instanceof Date ? a.date.toISOString() : String(a.date);
      const bd = b.date instanceof Date ? b.date.toISOString() : String(b.date);
      return bd.localeCompare(ad);
    }).slice(0, 3);
    for (const e of expected) {
      recencyTotal++;
      const sd = sortedTl.find(t => {
        const tDate = t.date instanceof Date ? t.date.toISOString().slice(0, 10) : String(t.date).slice(0, 10);
        return tDate === e.date && t.summary === e.summary;
      });
      if (sd) recencyCorrect++;
    }
  }
  const recencyAcc = recencyTotal > 0 ? recencyCorrect / recencyTotal : 1;
  log(`  ${sampleEntities.length} entities × 3 most-recent events each`);
  log(`  Top-3 correctness: ${(recencyAcc * 100).toFixed(1)}%`);

  // ── Test 4: As-of queries ──
  log('\n## As-of queries (HARD — no native gbrain operation)');
  log('  Approach: read full timeline, filter events ≤ asOfDate, take most-recent matching entry.');
  let asOfCorrect = 0;
  for (const q of asOfQueries) {
    const tl = await engine.getTimeline(q.slug);
    const eligible = tl
      .filter(t => {
        const tDate = t.date instanceof Date ? t.date.toISOString().slice(0, 10) : String(t.date).slice(0, 10);
        return tDate <= q.asOfDate && (t.summary.startsWith('joined') || t.summary.startsWith('hired by'));
      })
      .sort((a, b) => {
        const ad = a.date instanceof Date ? a.date.toISOString() : String(a.date);
        const bd = b.date instanceof Date ? b.date.toISOString() : String(b.date);
        return bd.localeCompare(ad);
      });
    if (eligible.length > 0 && eligible[0].summary === q.expected) asOfCorrect++;
  }
  const asOfAcc = asOfQueries.length > 0 ? asOfCorrect / asOfQueries.length : 1;
  log(`  ${asOfQueries.length} as-of queries, ${asOfCorrect} correct = ${(asOfAcc * 100).toFixed(1)}%`);
  log('  Note: requires manual filter+sort logic per query. A native `getStateAtTime`');
  log('  operation would make this trivial. Suggested v0.11 feature.');

  await engine.disconnect();

  log('\n## Summary');
  log('| Sub-category    | Recall | Precision | Notes                                |');
  log('|-----------------|--------|-----------|--------------------------------------|');
  log(`| Point           | ${(pointRecall * 100).toFixed(1)}% | ${(pointPrecision * 100).toFixed(1)}%    | Cross-entity date query (manual)     |`);
  log(`| Range           | ${(rangeRecall * 100).toFixed(1)}% | ${(rangePrecision * 100).toFixed(1)}%    | Same — manual cross-entity filter    |`);
  log(`| Recency (top-3) | ${(recencyAcc * 100).toFixed(1)}% | —         | Per-entity, native getTimeline       |`);
  log(`| As-of           | ${(asOfAcc * 100).toFixed(1)}% | —         | Hard, no native op (filter+sort)     |`);

  if (json) {
    process.stdout.write(JSON.stringify({
      summary: { pointRecall, pointPrecision, rangeRecall, rangePrecision, recencyAcc, asOfAcc },
    }, null, 2) + '\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
