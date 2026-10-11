import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { filePayload } from '../admin/src/workbench/composer-attachments';
import { mergePolledConversation } from '../admin/src/workbench/useWorkbench';
import type { WorkbenchConversation } from '../shared/workbench';

function sendHarness(failMessage = false, serviceReady = true, databaseReady = true, knowledge = false) {
  const source = readFileSync(new URL('../admin/src/workbench/useWorkbench.ts', import.meta.url), 'utf8');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf('  const send ='), source.indexOf('  const action =')));
  const requests: string[] = [];
  const bodies: any[] = [];
  let current: any;
  const env = {
    pending: false, running: false, conversation: undefined, model: 'local', knowledge, serviceReady, databaseReady,
    active: { current: undefined as string | undefined }, setPending: () => {}, setError: () => {},
    setConversation: (value: any) => { current = value; },
    refresh: async () => { throw new Error('列表刷新失败'); },
    filePayload,
    workbenchRequest: async (path: string, body?: unknown, method?: string) => {
      requests.push(`${method || 'POST'} ${path}`);
      if (body !== undefined) bodies.push(body);
      if (path === '/conversations') return { id: 'thread', messages: [] };
      if (path.endsWith('/messages')) {
        if (failMessage) throw new Error('响应丢失');
        return { id: 'thread', messages: [{ text: '已接收' }] };
      }
      if (method === 'DELETE') throw new Error('会话不为空');
      return { id: 'thread', messages: [{ text: '已接收' }] };
    },
  };
  const send = new Function(...Object.keys(env), `${code}; return send;`)(...Object.values(env));
  return { send, requests, bodies, env, current: () => current };
}

test('发送已成功而列表刷新失败时，不删除会话并返回这个会话', async () => {
  const run = sendHarness();
  expect(await run.send('问题')).toBe('thread');
  expect(run.requests.some(path => path.startsWith('DELETE'))).toBe(false);
  expect(run.current().messages).toHaveLength(1);
  expect(run.env.active.current).toBe('thread');
});

test('只有 HTTP 不可用才停止发送，数据库准备时明确发送普通对话', async () => {
  const offline = sendHarness(false, false, false, true);
  expect(await offline.send('问题')).toBe(false);
  expect(offline.requests).toHaveLength(0);
  const preparing = sendHarness(false, true, false, true);
  expect(await preparing.send('问题')).toBe('thread');
  expect(preparing.bodies.every(body => body.knowledge === false)).toBe(true);
});

test('发送响应丢失时只请求清理空会话，已有消息的会话继续保留', async () => {
  const run = sendHarness(true);
  expect(await run.send('问题')).toBe(false);
  expect(run.requests).toContain('DELETE /conversations/thread?emptyOnly=true');
  expect(run.current().messages).toHaveLength(1);
  expect(run.env.active.current).toBe('thread');
});

test('按 Enter 发送时，文字和附件一起进入请求体', async () => {
  const run = sendHarness();
  const note = new File(['hi'], '00-note.txt', { type: 'text/plain' });
  const image = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  const ok = await run.send('这个能导入知识库吗', false, undefined, [
    { id: '11111111-1111-1111-1111-111111111111', name: note.name, file: note },
    { id: '22222222-2222-2222-2222-222222222222', name: image.name, file: image },
  ]);
  expect(ok).toBe('thread');
  const sent = run.bodies.find(body => Array.isArray(body?.attachments));
  expect(sent.text).toBe('这个能导入知识库吗');
  expect(sent.attachments.map((item: { name: string }) => item.name)).toEqual(['00-note.txt', 'shot.png']);
  expect(sent.attachments[0].data).toBe('aGk=');
  expect(sent.attachments[1].mime).toBe('image/png');
  expect(sent.attachments[1].data).toBe('AQID');
});

test('轮询回来的精简消息仍保留卡片上的预览和已经读出的文字', () => {
  const current: WorkbenchConversation = {
    id: 'thread', title: '对话', model: 'local', knowledge: false, createdAt: '', updatedAt: '',
    messages: [{
      id: 'u1', role: 'user', text: '看图', createdAt: '', status: 'complete',
      attachments: [{ id: 'a', name: 'shot.png', mime: 'image/png', route: 'ocr', included: 4, preview: 'data:image/png;base64,YQ==', text: '发票号码', note: '图片识别没有返回文字。' }],
    }],
  };
  const lite: WorkbenchConversation = {
    ...current,
    messages: [{
      id: 'u1', role: 'user', text: '看图', createdAt: '', status: 'complete',
      attachments: [{ id: 'a', name: 'shot.png', mime: 'image/png', route: 'ocr', included: 4, note: '图片识别没有返回文字。' }],
    }],
  };
  const merged = mergePolledConversation(current, lite);
  expect(merged.messages[0]?.attachments?.[0]).toMatchObject({ preview: 'data:image/png;base64,YQ==', text: '发票号码', note: '图片识别没有返回文字。' });
  expect(mergePolledConversation(undefined, lite)).toBe(lite);
});
