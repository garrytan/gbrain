import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { acceptComposerFiles, createAttachment, filePayload, filesFromClipboard } from '../admin/src/workbench/composer-attachments';
import { ATTACHMENT_MAX_BYTES } from '../shared/workbench';

function urls() {
  const created: string[] = [];
  return { created, createUrl: (file: File) => { const url = `blob:${file.name}`; created.push(url); return url; } };
}

test('粘贴图片或文件会进入可见附件，纯文本不会', () => {
  const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  const doc = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  const pasted = filesFromClipboard({ files: [image, doc] });
  expect(pasted.map(file => file.name)).toEqual(['shot.png', 'notes.txt']);
  const maker = urls();
  const list = pasted.map((file, index) => createAttachment(file, `id-${index}`, maker.createUrl));
  expect(list[0]).toMatchObject({ id: 'id-0', name: 'shot.png', image: true, previewUrl: 'blob:shot.png' });
  expect(list[1]).toMatchObject({ id: 'id-1', name: 'notes.txt', image: false });
  expect(list[1].previewUrl).toBeUndefined();
  expect(maker.created).toEqual(['blob:shot.png']);
  const plain = filesFromClipboard({ files: [], items: [{ kind: 'string', getAsFile: () => image }] });
  expect(plain).toEqual([]);
});

test('剪贴板只有 file item 时也会收下，同一文件可以再加一条', () => {
  const image = new File([new Uint8Array([9])], 'paste.png', { type: 'image/png' });
  const doc = new File(['a'], 'a.pdf', { type: 'application/pdf' });
  expect(filesFromClipboard({ files: [], items: [{ kind: 'file', getAsFile: () => image }] }).map(file => file.name)).toEqual(['paste.png']);
  expect(filesFromClipboard({ files: [doc], items: [{ kind: 'file', getAsFile: () => image }] })).toEqual([doc]);
  const maker = urls();
  const first = createAttachment(doc, '1', maker.createUrl);
  const second = createAttachment(doc, '2', maker.createUrl);
  expect(first.id).not.toBe(second.id);
  expect(first.previewUrl).toBeUndefined();
  expect(second.previewUrl).toBeUndefined();
});

test('加号、拖入和粘贴都能加入附件，发送成功后清空未发送列表', async () => {
  const source = readFileSync(new URL('../admin/src/workbench/Workbench.tsx', import.meta.url), 'utf8');
  const hook = readFileSync(new URL('../admin/src/workbench/useWorkbench.ts', import.meta.url), 'utf8');
  const message = readFileSync(new URL('../admin/src/workbench/Message.tsx', import.meta.url), 'utf8');
  expect(source).toContain('aria-label="添加附件"');
  expect(source).toContain('fileInput.current?.click()');
  expect(source).toContain('type="file"');
  expect(source).toContain('multiple');
  expect(source).not.toMatch(/accept=/);
  expect(source).toContain('onPaste={onPaste}');
  expect(source).toContain('filesFromClipboard(event.clipboardData)');
  expect(source).toContain('onDrop=');
  expect(source).toContain('dataTransfer.files');
  expect(source).toContain('className="wb-attachments"');
  expect(source).toContain('item.previewUrl');
  expect(source).toContain('wb-file-card');
  expect(source).toContain('wb.send(draft, false, editMessageId, queued, Boolean(editMessageId))');
  expect(source).toContain('sentIds');
  expect(source).toContain('assignSessionAttachments');
  expect(source).not.toContain('setAttachments([])');
  expect(source).toContain('disabled={wb.pending || wb.running}');
  expect(source).toContain('composerFromSaved');
  expect(hook).toContain('attachmentsHydrated');
  expect(hook).toContain('?lite=1');
  expect(hook).toContain('attachments');
  expect(message).toContain('message.attachments');
  expect(message).toContain('item.note');
  const file = new File([new Uint8Array([104, 105])], 'notes.txt', { type: 'text/plain' });
  const item = createAttachment(file, '11111111-1111-1111-1111-111111111111');
  expect(await filePayload(item)).toEqual({ id: item.id, name: 'notes.txt', mime: 'text/plain', data: 'aGk=' });
});

test('空文件和超过 15MB 的文件在读取前就被拦住，其余还能加入', async () => {
  const empty = new File([], 'empty.txt', { type: 'text/plain' });
  const big = new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], 'big.pdf', { type: 'application/pdf' });
  const ok = new File(['hi'], 'ok.txt', { type: 'text/plain' });
  const mixed = acceptComposerFiles(0, [empty, big, ok]);
  expect(mixed.accepted.map(file => file.name)).toEqual(['ok.txt']);
  expect(mixed.error).toContain('「empty.txt」是空的，不能添加。');
  expect(mixed.error).toContain('「big.pdf」超过 15MB，不能添加。');
  const many = Array.from({ length: 9 }, (_, index) => new File(['a'], `f${index}.txt`, { type: 'text/plain' }));
  const capped = acceptComposerFiles(0, many);
  expect(capped.accepted).toHaveLength(8);
  expect(capped.error).toContain('一次最多 8 个附件。');
  await expect(filePayload({ id: '1', name: 'empty.txt', file: empty })).rejects.toThrow('「empty.txt」是空的，不能添加。');
  await expect(filePayload({ id: '2', name: 'big.pdf', file: big })).rejects.toThrow('「big.pdf」超过 15MB，不能添加。');
});
