import { expect, test } from 'bun:test';
import { pendingMaterialRows } from '../admin/src/product/material-list-progress';

const run = { id: 'task-1', kind: 'import_path', status: 'running', product: { stage: '生成向量', material: { name: '示例.md', sourceId: 'other', directory: false, slugs: [], page: { slug: 'actual-slug', title: '实际标题', type: 'note' } } } } as any;

test('任务已接受后立即显示目标源和资料，已存在的精确 Source 页面只显示一行', () => {
  const rows = [{ source_id: 'other', slug: 'actual-slug', title: '旧标题' }, { source_id: 'default', slug: 'actual-slug', title: '同名其他源' }] as any;
  const result = pendingMaterialRows([run], [], rows, { source: 'all', type: 'all', view: 'all', embedded: 'all', q: '' });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ sourceId: 'other', name: '实际标题', type: 'note', existing: rows[0] });
});

test('上传尚未返回任务也显示资料；确认任务后不重复，未知类型保留空值', () => {
  const uploading = { id: 'local', name: '待解析.xlsx', sourceId: 'other' };
  expect(pendingMaterialRows([], [uploading], [], { source: 'all', type: 'all', view: 'all', embedded: 'all', q: '' })[0]).toMatchObject({ name: uploading.name, type: null });
  expect(pendingMaterialRows([run], [{ ...uploading, runId: run.id }], [], { source: 'all', type: 'all', view: 'all', embedded: 'all', q: '' })).toHaveLength(1);
});

test('临时显示遵守源、类型、知识范围和搜索筛选，不把处理状态当成已向量化', () => {
  const base = { source: 'all', type: 'all', view: 'all', embedded: 'all', q: '' };
  for (const change of [{ source: 'default' }, { type: 'concept' }, { view: 'facts' }, { view: 'trash' }, { embedded: 'yes' }, { q: '无关标题' }]) {
    expect(pendingMaterialRows([run], [], [], { ...base, ...change })).toHaveLength(0);
  }
  expect(pendingMaterialRows([run], [], [], { ...base, view: 'materials' })).toHaveLength(1);
});
