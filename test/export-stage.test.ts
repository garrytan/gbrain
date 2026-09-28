import { expect, test } from 'bun:test';
import { ExportStage, EXPORT_PAYLOAD_LIMIT, EXPORT_STAGE_LIMIT, exportPathKey } from '../src/core/export-stage.ts';

test('manifest rejects unsafe paths and conservatively folds Unicode aliases', () => {
  for (const path of ['../escape.md', '/absolute.md', 'a//b.md', 'a/../b.md', 'a\\b.md', 'nul.md', 'a\0b.md', 'a/./b.md', '\ud800.md', 'a'.repeat(241) + '.md']) {
    expect(() => exportPathKey(path)).toThrow();
  }
  expect(exportPathKey('Notes/Café.md')).toBe(exportPathKey('notes/Cafe\u0301.md'));
  expect(exportPathKey('notes/straße.md')).toBe(exportPathKey('notes/STRASSE.md'));
  expect(exportPathKey('notes/🚀.md')).toBe('notes/🚀.md');
});
test('native path depth and superscript device names refuse during staging', () => {
  const stage = new ExportStage();
  try {
    for (const path of ['COM¹.md', 'lpt².json', 'COM³.txt', [...Array(256).fill('a'), 'leaf.md'].join('/')]) {
      expect(() => stage.add(path, 'file', 'payload')).toThrow('Unsafe');
    }
    expect(stage.db.query("SELECT count(*) AS n FROM paths WHERE kind='file'").get()).toEqual({ n: 0 });
  } finally { stage.close(); }
});
test('staging bounds fail without truncating a payload or silently dropping a file', () => {
  const stage = new ExportStage();
  try {
    expect(() => stage.add('large.md', 'file', 'x'.repeat(EXPORT_PAYLOAD_LIMIT + 1))).toThrow('capacity');
    expect(stage.db.query("SELECT count(*) AS n FROM paths WHERE kind='file'").get()).toEqual({ n: 0 });
    stage.bytes = EXPORT_STAGE_LIMIT;
    expect(() => stage.add('small.md', 'file', 'x')).toThrow('capacity');
  } finally { stage.close(); }
});
test('deep paths use a bounded iterative manifest walk and reserved markers cannot become directories', () => {
  const stage = new ExportStage();
  try {
    stage.add([...Array(100).fill('a'), 'leaf.md'].join('/'), 'file', 'payload');
    expect(stage.db.query("SELECT count(*) AS n FROM paths WHERE kind='file'").get()).toEqual({ n: 1 });
    expect(() => stage.add('.gbrain-export-status/leaf.md', 'file', 'payload')).toThrow('collision');
    stage.add('notes/.raw/item.json', 'file', '{}');
    expect(() => stage.add('notes/.raw/item.json/leaf.md', 'file', 'payload')).toThrow('collision');
  } finally { stage.close(); }
});
