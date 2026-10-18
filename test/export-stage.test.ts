import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ExportStage, EXPORT_PAYLOAD_LIMIT, EXPORT_STAGE_LIMIT, exportPathKey, exportPayloadLimit } from '../src/core/export-stage.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';

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
test('the payload limit is the page ceiling plus the 32 MiB limit\'s metadata headroom, never below 32 MiB', () => {
  expect(exportPayloadLimit(PAGE_MAX_BYTES)).toBe(EXPORT_PAYLOAD_LIMIT);
  expect(exportPayloadLimit(1024 * 1024)).toBe(EXPORT_PAYLOAD_LIMIT);
  expect(exportPayloadLimit(256 * 1024 * 1024)).toBe(256 * 1024 * 1024 + EXPORT_PAYLOAD_LIMIT - PAGE_MAX_BYTES);
});
test('streamed stage files are written piece by piece to the stage directory and refuse capacity without truncating', async () => {
  const stage = new ExportStage();
  const pieces = async function* (...parts: Array<string | Uint8Array>) { yield* parts; };
  const files = () => stage.db.query<{ path: string; file: string | null }, []>("SELECT path, file FROM paths WHERE kind='file'").all();
  try {
    await stage.addStream('notes/big.md', 10, 64, pieces('head\n', Buffer.from('ü body'), '\n'));
    expect(files()).toEqual([{ path: 'notes/big.md', file: '0' }]);
    expect(readFileSync(stage.filePath('0'), 'utf8')).toBe('head\nü body\n');
    expect(stage.fileBytes).toBe(Buffer.byteLength('head\nü body\n'));
    await expect(stage.addStream('notes/over.md', 65, 64, pieces('x'))).rejects.toThrow('capacity');
    await expect(stage.addStream('notes/disk.md', Number.MAX_SAFE_INTEGER, Infinity, pieces('x'))).rejects.toThrow('capacity');
    expect(files()).toHaveLength(1);
    await expect(stage.addStream('notes/grew.md', 4, 8, pieces('12345', '6789'))).rejects.toThrow('capacity');
    await expect(stage.addStream('Notes/Big.md', 1, 64, pieces('x'))).rejects.toThrow('collision');
  } finally { stage.close(); }
});
