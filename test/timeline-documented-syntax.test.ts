/**
 * GBRA-789: docs/guides/page-anatomy.md "Timeline rows" lists the timeline
 * forms gbrain reads. This pins that every documented example makes a row
 * through both extractors (the database parser and the file extractor), and
 * that the plain bullets the guide says make no row really make none, so the
 * guide and the parsers cannot drift apart.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTimelineEntries } from '../src/core/link-extraction.ts';
import { extractTimelineFromContent } from '../src/core/timeline-extract.ts';

const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'page-anatomy.md'), 'utf8');
const section = guide.slice(guide.indexOf('## Timeline rows'), guide.indexOf('## Facts and takes fences'));
const supported = /make a row from these forms[^\n]*\n+```markdown\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
const unsupported = [...section.matchAll(/A plain list such as `([^`]+)` or `([^`]+)`/g)].flatMap(m => [m[1]!, m[2]!]);

describe('documented timeline syntax', () => {
  test('every documented example makes one dated row through both extractors', () => {
    expect(supported).not.toBe('');
    const dates = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
    expect(parseTimelineEntries(supported).map(e => e.date).sort()).toEqual(dates);
    expect(extractTimelineFromContent(supported, 'companies/acme-example').map(e => e.date).sort()).toEqual(dates);
  });

  test('the plain bullets the guide names make no row', () => {
    expect(unsupported).toHaveLength(2);
    const list = `## Timeline\n\n${unsupported.join('\n')}\n`;
    expect(parseTimelineEntries(list)).toEqual([]);
    expect(extractTimelineFromContent(list, 'companies/acme-example')).toEqual([]);
  });
});
