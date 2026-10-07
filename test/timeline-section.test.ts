/** #5969 (D3): reading a put_page body's Timeline section before normalization. */
import { describe, expect, test } from 'bun:test';
import { timelineSectionOf } from '../src/core/persistence/timeline-omission.ts';

const slug = 'projects/example';
const head = '---\ntype: note\ntitle: Example project\n---\n';
const withTimeline = (body: string) => `${head}${body}\n\n## Timeline\n\n- **2026-08-01** | markdown — Launch review\n`;
const withoutTimeline = (body: string) => `${head}${body}\n`;

describe('#5969 timeline section detection', () => {
  test('sentinels and the headings the parser accepts count as a section; code blocks do not', () => {
    expect(timelineSectionOf(withTimeline('Body.'), slug)).toBe('present');
    expect(timelineSectionOf(withoutTimeline('Body.'), slug)).toBe('omitted');
    expect(timelineSectionOf(`${head}Body.\n\n## Timeline\n`, slug)).toBe('emptied');
    expect(timelineSectionOf(`${head}Body.\n\n<!-- timeline -->\n`, slug)).toBe('emptied');
    expect(timelineSectionOf(`${head}Body.\n\n## History\n\n- **2026-01-02** | notes — Founded\n`, slug)).toBe('present');
    expect(timelineSectionOf(`${head}Body.\n\n<!-- timeline -->\n\n- **2026-01-02** | notes — Founded\n`, slug)).toBe('present');
    expect(timelineSectionOf(`${head}Body.\n\n\`\`\`\n## Timeline\n\`\`\`\n`, slug)).toBe('omitted');
  });
});

