import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPageLinks } from '../src/core/link-extraction.ts';
import { extractLinksFromFile } from '../src/commands/extract.ts';
import { loadResolvedPackByName } from '../src/core/schema-pack/load-active.ts';

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

function pageFromSkillTemplate(): string {
  const skill = readFileSync(join(import.meta.dir, '../skills/meeting-ingestion/SKILL.md'), 'utf8');
  const phase5 = skill.slice(skill.indexOf('### Phase 5'));
  const template = /```markdown\n([\s\S]*?)\n```/.exec(phase5)?.[1];
  if (!template) throw new Error('Phase 5 meeting page template not found');
  const links = '[Alice Example](../people/alice-example.md), [Bob Example](../people/bob-example.md)';
  return template.split('\n')
    .map(line => /Attendees/.test(line) ? line.replace(/\{[^}]*\}/, links) : line.replace(/\{[^}]*\}/g, 'Synthetic placeholder'))
    .join('\n');
}

test('a meeting page written from the skill template yields canonical attendance on the DB and filesystem paths', async () => {
  const body = pageFromSkillTemplate();
  // Auto-link always runs with a pack; gbrain-base-v2 is the one `gbrain init` sets.
  const pack = (await loadResolvedPackByName('gbrain-base-v2')).manifest;

  const db = await extractPageLinks(meeting, body, {}, 'meeting', resolver, { targetType: slug => pageTypes.get(slug), pack });
  expect(db.attendanceComplete).toBe(true);
  expect(db.candidates.filter(row => row.canonicalAttendance).map(row => row.targetSlug)).toEqual(people);

  const fs = await extractLinksFromFile(`---\ntype: meeting\n---\n${body}`, `${meeting}.md`, new Set(pageTypes.keys()), { pageTypes, pack });
  const attended = fs.filter(row => row.link_type === 'attended');
  expect(attended.map(row => row.from_slug)).toEqual(people);
  expect(attended.every(row => row.to_slug === meeting)).toBe(true);
});
