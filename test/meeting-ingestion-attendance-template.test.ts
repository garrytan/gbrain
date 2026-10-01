import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPageLinks, LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { extractLinksFromFile, extractStaleFromDB } from '../src/commands/extract.ts';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

// #5765: the meeting-ingestion skill's Phase 5 template is what agents copy
// when they file a meeting. A page written from it must carry attendance
// evidence the extractor accepts, or the meeting gets `mentions` instead of
// `attended` edges. Fails when the template drifts from the extractor's
// evidence rule (as `**Attendees:**` did); the attendance suites feed the
// extractor hand-written bodies, never the shipped template.

const meeting = 'meetings/2026-01-15-planning';
const people = ['people/alice-example', 'people/bob-example'];
const pageTypes = new Map([...people.map(slug => [slug, 'person'] as const), [meeting, 'meeting']]);
const resolver = { async resolve(value: string) { return people.includes(value) ? value : null; } };

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
});
afterAll(async () => {
  await engine.disconnect();
});

function pageFromSkillTemplate(): string {
  const skill = readFileSync(join(import.meta.dir, '../skills/meeting-ingestion/SKILL.md'), 'utf8');
  const phase5 = skill.slice(skill.indexOf('### Phase 5'));
  const template = /```markdown\n([\s\S]*?)\n```/.exec(phase5)?.[1];
  if (!template) throw new Error('Phase 5 meeting page template not found');
  const links = '[Alice Example](../people/alice-example.md), [Bob Example](../people/bob-example.md)';
  return template.split('\n')
    .map(line => /^attendees:/.test(line) ? line.replace(/\{[^}]*\}/, people.join(', '))
      : /Attendees/.test(line) ? line.replace(/\{[^}]*\}/, links) : line.replace(/\{[^}]*\}/g, 'Synthetic placeholder'))
    .join('\n');
}

test('a meeting page written from the skill template yields canonical attendance on the DB and filesystem paths', async () => {
  const page = pageFromSkillTemplate();
  const parsed = parseMarkdown(page, `${meeting}.md`);
  expect(parsed.frontmatter.attendees).toEqual(people);
  const body = `${parsed.compiled_truth}\n${parsed.timeline}`;
  // Auto-link always runs with a pack; gbrain-base-v2 is the one `gbrain init` sets.
  const pack = (await loadResolvedPackByName('gbrain-base-v2')).manifest;

  const db = await extractPageLinks(meeting, body, parsed.frontmatter, 'meeting', resolver, { targetType: slug => pageTypes.get(slug), pack });
  expect(db.attendanceComplete).toBe(true);
  expect([...new Set(db.candidates.filter(row => row.canonicalAttendance).map(row => row.targetSlug))].sort()).toEqual(people);

  const fs = await extractLinksFromFile(page, `${meeting}.md`, new Set(pageTypes.keys()), { pageTypes, pack, includeFrontmatter: true });
  const attended = fs.filter(row => row.link_type === 'attended');
  expect([...new Set(attended.map(row => row.from_slug))].sort()).toEqual(people);
  expect(attended.every(row => row.to_slug === meeting)).toBe(true);
});

async function attendedPeople(slug: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ person: string }>(
    `SELECT DISTINCT CASE WHEN f.slug = $1 THEN t.slug ELSE f.slug END AS person
       FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_type = 'attended' AND (f.slug = $1 OR t.slug = $1) ORDER BY 1`, [slug]);
  return rows.map(row => row.person);
}

test('a stored template page gets attended edges from stale extraction', async () => {
  for (const [slug, name] of [[people[0], 'Alice Example'], [people[1], 'Bob Example']]) {
    await importFromContent(engine, slug, `---\ntype: person\ntitle: ${name}\n---\n\n${name}.\n`, { noEmbed: true });
  }
  await importFromContent(engine, meeting, pageFromSkillTemplate(), { noEmbed: true });
  await extractStaleFromDB(engine, { includeFrontmatter: true, dryRun: false, jsonMode: false, quiet: true, catchUp: true });
  expect(await attendedPeople(meeting)).toEqual(people);
});

test('a page filed with the old bold label re-extracts after the extractor bump and gains attended edges', async () => {
  const old = 'meetings/2026-01-16-review';
  await importFromContent(engine, old, `---\ntype: meeting\n---\n\n# Review\n\n**Attendees:** [Alice Example](../people/alice-example.md), [Bob Example](../people/bob-example.md)\n`, { noEmbed: true });
  await engine.executeRaw(`UPDATE pages SET updated_at = '2026-09-20T00:00:00Z', links_extracted_at = '2026-09-21T00:00:00Z' WHERE slug = $1`, [old]);
  expect(await engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS })).toBeGreaterThan(0);
  await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
  expect(await attendedPeople(old)).toEqual(people);
});
