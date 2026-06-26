import { test, expect } from 'bun:test';
import { isOfficeFilePath, OFFICE_EXTS } from '../src/core/office/extensions.ts';

test('isOfficeFilePath: M0 + the newly-added formats route to office', () => {
  for (const f of [
    'a.pdf', 'b.docx', 'c.pptx', 'd.xlsx', // M0
    'e.odt', 'f.ods', 'g.odp',             // OpenDocument trio
    'h.html', 'i.htm', 'j.csv',            // web + tabular
    'dir/sub/K.PDF', 'x.CSV',              // case-insensitive
  ]) {
    expect(isOfficeFilePath(f)).toBe(true);
  }
});

test('isOfficeFilePath: non-office stays false (md + images go through their own paths)', () => {
  for (const f of ['a.md', 'b.txt', 'c.png', 'd.jpg', 'e.ts', 'noext', 'g.json']) {
    expect(isOfficeFilePath(f)).toBe(false);
  }
});

test('OFFICE_EXTS is the single source: includes the OpenDocument trio + html/csv', () => {
  for (const e of ['.odt', '.ods', '.odp', '.html', '.htm', '.csv']) {
    expect(OFFICE_EXTS.has(e)).toBe(true);
  }
  expect(OFFICE_EXTS.has('.md')).toBe(false); // handled by the markdown path
  expect(OFFICE_EXTS.has('.png')).toBe(false); // handled by importImageFile
});
