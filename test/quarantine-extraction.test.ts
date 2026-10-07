/**
 * #5556 (quarantine core): a quarantined page is hidden from search, so no
 * derived-data scan may process it and no extraction-health denominator may
 * count it.
 *
 * Protects: each entry point that turns page text into links, timeline rows
 * or a health ratio — the stale listing (count + batch, both engines via
 * engine-sql), the doctor links_extraction_lag denominator, NER, the meeting
 * timeline projection, the file-walk slug lists (sync/cycle incremental), the
 * DB walks (`extract --source db`, mentions) and the managed link derivation.
 * Fails when: an entry point ignores the marker, so junk becomes typed edges or
 * timeline rows, or the doctor ratio lies about a source's lag.
 * Why new: these entry points never consulted the marker; existing tests seed
 * only unquarantined pages. Negative controls: an unquarantined sibling is
 * still processed, and clearing the marker restores eligibility.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildQuarantineMarker, QUARANTINE_KEY } from '../src/core/quarantine.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { checkLinksExtractionLag } from '../src/commands/doctor/checks/extraction-sync.ts';
import { extractNerLinks } from '../src/core/extract-ner.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { extractLinksForSlugs, extractTimelineForSlugs, runExtractCore } from '../src/commands/extract.ts';
import { extractTimelineFromDB } from '../src/commands/extract-timeline-db.ts';
import { runExtract } from '../src/commands/extract.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import type { Gazetteer } from '../src/core/by-mention.ts';

let engine: PGLiteEngine;
let repo: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-quarantine-extract-'));
}, 240_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const marker = () => ({ [QUARANTINE_KEY]: buildQuarantineMarker('junk_pattern', 'cloudflare_ray_id') });

async function page(slug: string, type: string, title: string, body: string, opts: { quarantined?: boolean; timeline?: string; frontmatter?: Record<string, unknown> } = {}): Promise<void> {
  await engine.putPage(slug, {
    type: type as never, title, compiled_truth: body, timeline: opts.timeline ?? '',
    frontmatter: { ...(opts.frontmatter ?? {}), ...(opts.quarantined ? marker() : {}) },
    effective_date: new Date('2026-04-20T00:00:00.000Z'),
  });
}

function file(slug: string, content: string): void {
  const path = join(repo, `${slug}.md`);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
}

async function linksFrom(slug: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ to_slug: string }>(
    `SELECT t.slug AS to_slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE f.slug = $1 ORDER BY t.slug`, [slug]);
  return rows.map((r) => r.to_slug);
}

async function timelineCount(slug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM timeline_entries te JOIN pages p ON p.id = te.page_id WHERE p.slug = $1`, [slug]);
  return Number(rows[0]?.n ?? 0);
}

describe('stale listing (engine-sql, both engines)', () => {
  test('a quarantined page is neither counted nor listed as stale; clearing the marker restores it', async () => {
    await page('notes/clean', 'note', 'Clean', 'A clean note.');
    await page('notes/junk', 'note', 'Junk', 'Just a moment... checking your browser.', { quarantined: true });
    const opts = { sourceId: 'default', versionTs: LINK_EXTRACTOR_VERSION_TS };
    expect(await engine.countStalePagesForExtraction(opts)).toBe(1);
    expect((await engine.listStalePagesForExtraction({ ...opts, batchSize: 10 })).map((r) => r.slug)).toEqual(['notes/clean']);
    await page('notes/junk', 'note', 'Junk', 'Now a real note.');
    expect(await engine.countStalePagesForExtraction(opts)).toBe(2);
  });
});

describe('doctor links_extraction_lag denominator', () => {
  test('quarantined pages are not in the denominator', async () => {
    await page('notes/clean', 'note', 'Clean', 'A clean note.');
    for (let i = 0; i < 3; i++) await page(`notes/junk-${i}`, 'note', `Junk ${i}`, 'Attention required.', { quarantined: true });
    const check = await checkLinksExtractionLag(engine, { sourceId: 'default' });
    expect(check.details).toMatchObject({ total: 1, stale: 1, pct: 100 });
  });
});

describe('NER', () => {
  test('a quarantined page yields no typed NER edge; an unquarantined sibling does', async () => {
    await page('companies/acme-example', 'company', 'Acme Example', 'Acme Example builds widgets.');
    await page('people/dana-example', 'person', 'Dana Example', 'Dana Example works at Acme Example.');
    await page('people/junk-example', 'person', 'Junk Example', 'Junk Example works at Acme Example.', { quarantined: true });
    const result = await extractNerLinks(engine);
    expect(result.pack_unavailable).toBe(false);
    expect(await linksFrom('people/dana-example')).toEqual(['companies/acme-example']);
    expect(await linksFrom('people/junk-example')).toEqual([]);
  });
});

describe('meeting timeline projection', () => {
  test('a quarantined meeting is not scanned and projects no timeline rows', async () => {
    await page('people/alice-example', 'person', 'Alice Example', 'Alice Example profile');
    await page('meetings/real-sync', 'meeting', 'Real Sync', 'Meeting discussion notes.');
    await page('meetings/junk-sync', 'meeting', 'Junk Sync', 'Meeting discussion notes.', { quarantined: true });
    for (const meeting of ['meetings/real-sync', 'meetings/junk-sync']) {
      await engine.addLinksBatch([{ from_slug: meeting, to_slug: 'people/alice-example', link_type: 'attended', link_source: 'manual' }]);
    }
    const result = await extractTimelineFromMeetings(engine, { gazetteer: new Map() as Gazetteer });
    expect(result.meetings_scanned).toBe(1);
    const timeline = await engine.getTimeline('people/alice-example', { sourceId: 'default' });
    expect(timeline.map((t) => t.source)).toEqual(['extract-timeline-from-meetings:meetings/real-sync']);
  });
});

describe('file-walk slug lists (sync / cycle incremental)', () => {
  test('links and timeline skip a quarantined slug and leave it unprocessed', async () => {
    await page('people/alice-example', 'person', 'Alice Example', 'Alice Example profile');
    await page('notes/clean', 'note', 'Clean', 'See [[people/alice-example]].');
    await page('notes/junk', 'note', 'Junk', 'See [[people/alice-example]].', { quarantined: true });
    const body = '---\ntype: note\n---\nSee [[people/alice-example]].\n\n## Timeline\n\n- **2026-04-03** | Met Alice Example\n';
    file('people/alice-example', '---\ntype: person\n---\nAlice Example profile\n');
    file('notes/clean', body);
    file('notes/junk', body);
    const links = await extractLinksForSlugs(engine, repo, ['notes/clean', 'notes/junk'], { sourceId: 'default' });
    expect(links.processed).toEqual(['notes/clean']);
    expect(await linksFrom('notes/clean')).toEqual(['people/alice-example']);
    expect(await linksFrom('notes/junk')).toEqual([]);
    const timeline = await extractTimelineForSlugs(engine, repo, ['notes/clean', 'notes/junk'], { sourceId: 'default' });
    expect(timeline.processed).toEqual(['notes/clean']);
    expect(await timelineCount('notes/clean')).toBe(1);
    expect(await timelineCount('notes/junk')).toBe(0);
  });

  test('the full file walk skips a quarantined page', async () => {
    await page('people/alice-example', 'person', 'Alice Example', 'Alice Example profile');
    await page('notes/clean', 'note', 'Clean', 'See [[people/alice-example]].');
    await page('notes/junk', 'note', 'Junk', 'See [[people/alice-example]].', { quarantined: true });
    file('people/alice-example', '---\ntype: person\n---\nAlice Example profile\n');
    file('notes/clean', '---\ntype: note\n---\nSee [[people/alice-example]].\n');
    file('notes/junk', '---\ntype: note\n---\nSee [[people/alice-example]].\n');
    await runExtractCore(engine, { mode: 'links', dir: repo, quiet: true, sourceId: 'default' });
    expect(await linksFrom('notes/clean')).toEqual(['people/alice-example']);
    expect(await linksFrom('notes/junk')).toEqual([]);
  });
});

describe('DB walks', () => {
  test('extract links --source db skips a quarantined page', async () => {
    await page('people/alice-example', 'person', 'Alice Example', 'Alice Example profile');
    await page('notes/clean', 'note', 'Clean', 'See [[people/alice-example]].');
    await page('notes/junk', 'note', 'Junk', 'See [[people/alice-example]].', { quarantined: true });
    await quietly(() => runExtract(engine, ['links', '--source', 'db']));
    expect(await linksFrom('notes/clean')).toEqual(['people/alice-example']);
    expect(await linksFrom('notes/junk')).toEqual([]);
  });

  test('extract links --by-mention skips a quarantined page', async () => {
    await page('companies/acme-example', 'company', 'Acme Example', 'Acme Example builds widgets.');
    await page('notes/clean', 'note', 'Clean', 'We talked with Acme Example today.');
    await page('notes/junk', 'note', 'Junk', 'We talked with Acme Example today.', { quarantined: true });
    await quietly(() => runExtract(engine, ['links', '--by-mention', '--source', 'db']));
    expect(await linksFrom('notes/clean')).toEqual(['companies/acme-example']);
    expect(await linksFrom('notes/junk')).toEqual([]);
  });

  test('the shared link derivation skips a quarantined slug a sync names explicitly', async () => {
    await page('people/alice-example', 'person', 'Alice Example', 'Alice Example profile');
    await page('notes/clean', 'note', 'Clean', 'See [[people/alice-example]].');
    await page('notes/junk', 'note', 'Junk', 'See [[people/alice-example]].', { quarantined: true });
    const r = await extractManagedStaleLinks(engine, { sourceId: 'default', slugs: ['notes/junk', 'notes/clean'], mentions: false });
    expect(r.remaining).toBe(0);
    expect(await linksFrom('notes/clean')).toEqual(['people/alice-example']);
    expect(await linksFrom('notes/junk')).toEqual([]);
  });

  test('extract timeline --source db skips a quarantined page', async () => {
    const timeline = '- **2026-04-03** | Met Alice Example';
    await page('notes/clean', 'note', 'Clean', 'A clean note.', { timeline });
    await page('notes/junk', 'note', 'Junk', 'A junk note.', { timeline, quarantined: true });
    await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true });
    expect(await timelineCount('notes/clean')).toBe(1);
    expect(await timelineCount('notes/junk')).toBe(0);
  });
});
