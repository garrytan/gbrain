/**
 * #6162 — the enrich skill's page templates must carry the same sections, in
 * the same order, as the recommended schema. Agents write people and company
 * pages from skills/enrich/SKILL.md; when its template drops a section the
 * schema calls high-value (Communication Style), no page ever gets it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SCHEMA = readFileSync(join(ROOT, 'docs', 'GBRAIN_RECOMMENDED_SCHEMA.md'), 'utf8');
const ENRICH = readFileSync(join(ROOT, 'skills', 'enrich', 'SKILL.md'), 'utf8');

/** Ordered `## ` headings of the first fenced markdown template after `heading`. */
function templateSections(doc: string, heading: RegExp): string[] {
  const at = doc.search(heading);
  expect(at, `template heading ${heading} not found`).toBeGreaterThanOrEqual(0);
  const fence = /```markdown\n([\s\S]*?)\n```/.exec(doc.slice(at));
  expect(fence, `no markdown template after ${heading}`).not.toBeNull();
  return [...fence![1].matchAll(/^## (.+)$/gm)].map(m => m[1].trim());
}

describe('enrich templates match docs/GBRAIN_RECOMMENDED_SCHEMA.md', () => {
  it('Person template sections', () => {
    const schema = templateSections(SCHEMA, /^### Person$/m);
    expect(schema).toContain('Communication Style');
    expect(templateSections(ENRICH, /^#### Person page template$/m)).toEqual(schema);
  });

  it('Company template sections', () => {
    expect(templateSections(ENRICH, /^#### Company page template$/m)).toEqual(templateSections(SCHEMA, /^### Company$/m));
  });
});
