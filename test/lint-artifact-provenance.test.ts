import { describe, expect, test } from 'bun:test';
import { lintContent } from '../src/commands/lint.ts';
const page = (fields: string, body = '# Record\n\nEvidence retained.\n') => `---\ntitle: Record\ntype: note\n${fields}\n---\n${body}`;
const rules = (s: string, path = 'notes/record.md') => lintContent(s, path).map(x => x.rule);
describe('lint source artifact contracts without fabricated dates', () => {
  test('mirror observation time is valid provenance without claiming a creation time', () => {
    expect(rules(page('mirrored_at: "2026-09-30T10:32:48Z"'))).not.toContain('missing-created');
    expect(rules(page('mirrored_at: invalid'))).toContain('missing-created');
  });
  test('calendar start is event provenance, while end-only and arbitrary notes remain undated', () => {
    const meeting = page('start: "2027-01-14T13:00:00-08:00"').replace('type: note', 'type: meeting');
    expect(rules(meeting)).not.toContain('missing-created');
    expect(rules(meeting.replace('start:', 'end:'))).toContain('missing-created');
    expect(rules(page('start: "2027-01-14T13:00:00-08:00"'))).toContain('missing-created');
    expect(rules(meeting.replace('2027-01-14T13:00:00-08:00', 'unknown'))).toContain('missing-created');
  });
  test('a valid published skill follows its own name/description contract', () => {
    const skill = '---\nname: brain-search\ndescription: Find sourced records.\n---\n# Search\n\nRead the evidence.\n';
    expect(rules(skill, '/brain/skills/brain-search/SKILL.md')).toEqual([]);
    for (const path of ['/brain/notes/SKILL.md', '/brain/skills/other/SKILL.md', '/brain/skills/brain-search/note.md']) {
      expect(rules(skill, path)).toContain('missing-title');
    }
    expect(rules(skill.replace('description: Find sourced records.', 'description: ""'), '/brain/skills/brain-search/SKILL.md')).toContain('missing-title');
    expect(rules(skill.replace('name: brain-search', 'name: [broken'), '/brain/skills/brain-search/SKILL.md')).toContain('frontmatter-yaml-parse');
  });
  test('indented command examples are code, while adjacent and list-continuation placeholders remain findings', () => {
    const body = '# Record\n\n    gbrain capture YYYY-MM-DD\n\nDue YYYY-MM-DD\n';
    const issues = lintContent(page('created: 2026-10-22', body), 'notes/record.md').filter(x => x.rule === 'placeholder-date');
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(page('created: 2026-10-22', body).split('\n').findIndex(x => x.startsWith('Due ')) + 1);
    expect(rules(page('created: 2026-10-22', '    gbrain capture YYYY-MM-DD\nDue YYYY-MM-DD\n')).filter(x => x === 'placeholder-date')).toHaveLength(1);
    expect(rules(page('created: 2026-10-22', '- Due date\n    YYYY-MM-DD\n'))).toContain('placeholder-date');
    expect(rules(page('created: YYYY-MM-DD'))).toContain('placeholder-date');
  });
  test('real huge pages and empty sections are not suppressed for any artifact', () => {
    expect(rules(page('created: 2026-10-22', 'x'.repeat(51000)))).toContain('huge-page');
    expect(rules(page('created: 2026-10-22', '## Empty\n'))).toContain('empty-section');
    const skill = '---\nname: brain-search\ndescription: Find sourced records.\n---\n' + 'x'.repeat(51000);
    expect(rules(skill, '/brain/skills/brain-search/SKILL.md')).toContain('huge-page');
  });
});
