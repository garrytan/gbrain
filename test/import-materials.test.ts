import { expect, test } from 'bun:test';
import { availableImportSources, importMaterials } from '../admin/src/product/import-materials';

test('file and directory imports reuse existing APIs and only remove completed entries', async () => {
  const calls: any[] = []; const completed: string[] = [];
  const file = new File(['正文'], '文档.md');
  await importMaterials([{ id: 'path', name: '目录', path: 'D:\\资料' }, { id: 'file', name: file.name, file }], {
    sourceId: 'selected-source',
    accepted: (item, id) => calls.push({ accepted: item.id, id }),
    api: { startImportRun: async input => { calls.push(input); return { runId: 'path' }; }, startImportUploadRun: async (input, options) => { calls.push([input, options]); return { runId: 'file' }; } },
    wait: async id => ({ id, status: 'completed' }) as any, update: () => {}, starting: () => {}, completed: item => completed.push(item.id),
  });
  expect(calls[0]).toMatchObject({ path: 'D:\\资料', sourceId: 'selected-source', includeOffice: true, includeImages: true, documentOcr: true });
  expect(calls[1]).toEqual({ accepted: 'path', id: 'path' });
  expect(calls[2][0]).toBe(file);
  expect(calls[2][1].sourceId).toBe('selected-source');
  expect(completed).toEqual(['path', 'file']);
});
test('failed import keeps that entry and does not start subsequent files', async () => {
  const started: string[] = []; const completed: string[] = [];
  await expect(importMaterials([{ id: 'one', name: '一', path: 'one' }, { id: 'two', name: '二', path: 'two' }], {
    api: { startImportRun: async input => { started.push(input.path); return { runId: 'one' }; }, startImportUploadRun: async () => { throw new Error('unexpected'); } },
    wait: async () => ({ status: 'failed', error: '原生错误' }) as any, update: () => {}, starting: () => {}, completed: item => completed.push(item.id),
  })).rejects.toThrow('原生错误');
  expect(started).toEqual(['one']); expect(completed).toEqual([]);
});
test('参与跨源搜索的数据源仍可导入，已归档的数据源不可导入', () => {
  const sources = [
    { id: 'main', federated: true },
    { id: 'local', federated: false },
    { id: 'archived', federated: true, archived: true },
  ];
  expect(availableImportSources(sources).map(source => source.id)).toEqual(['main', 'local']);
});
