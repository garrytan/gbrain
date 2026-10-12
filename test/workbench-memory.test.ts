import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WorkbenchService } from '../src/product/workbench/service';
import { WorkbenchStore } from '../src/product/workbench/store';

function fixture() {
  const store = new WorkbenchStore(mkdtempSync(join(tmpdir(), 'pmbrain-native-memory-')));
  const captures: string[] = [];
  const finished: string[] = [];
  const hooks = {
    capture: async (conversation: any, message: any) => {
      captures.push(message.text);
      return { mode: 'all', status: 'pending', sourceId: conversation.sourceId, hash: createHash('sha256').update(message.text).digest('hex'), capturedAt: message.createdAt, visibility: 'world', ttl: '3d' };
    },
    settled: async (id: string) => { finished.push(id); },
  };
  const service = new (WorkbenchService as any)(store, () => [{ id: 'ollama:test', name: '测试' }], async () => ({ text: '已回答', model: 'ollama:test', citations: [] }), undefined, undefined, hooks) as WorkbenchService;
  const conversation = service.create({ knowledge: false, sourceId: 'work' } as any);
  return { store, service, conversation, captures, finished };
}

test('普通对话也登记自动记忆，保存后后台处理不影响已完成回答', async () => {
  const f = fixture();
  f.service.send(f.conversation.id, { text: '以后方案先写结论，再写依据' });
  await f.service.settled(f.conversation.id);
  const saved: any = f.store.get(f.conversation.id);
  expect(saved.sourceId).toBe('work');
  expect(f.captures).toEqual(['以后方案先写结论，再写依据']);
  expect(saved.messages[0].memory?.status).toBe('pending');
  expect(saved.messages[1].status).toBe('complete');
  expect(f.finished).toEqual([f.conversation.id]);
});

test('老会话继续聊天绑定 default，旧消息不补登记记忆',async()=>{
  const f=fixture();f.service.send(f.conversation.id,{text:'旧会话的历史内容'});await f.service.settled(f.conversation.id);
  const old=f.store.get(f.conversation.id);delete old.sourceId;delete old.messages[0].memory;f.store.save(old);f.captures.length=0;
  f.service.send(old.id,{text:'以后报告采用中文'});await f.service.settled(old.id);const saved=f.store.get(old.id);
  expect(saved.sourceId).toBe('default');expect(saved.messages[0].memory).toBeUndefined();expect(saved.messages[2].memory?.sourceId).toBe('default');expect(f.captures).toEqual(['以后报告采用中文']);
});

test('重试只重答，保留旧回答版本且不重复登记用户回合', async () => {
  const f = fixture();
  f.service.send(f.conversation.id, { text: '我不喝咖啡' });
  await f.service.settled(f.conversation.id);
  f.service.send(f.conversation.id, { retry: true });
  await f.service.settled(f.conversation.id);
  const saved: any = f.store.get(f.conversation.id);
  expect(f.captures).toHaveLength(1);
  expect(saved.revisions?.[0].reason).toBe('retry');
  expect(saved.revisions?.[0].messages[0].text).toBe('已回答');
  expect(saved.messages).toHaveLength(2);
});

test('修改问题保留原始分支和出处，只有有效新版本登记提炼', async () => {
  const f = fixture();
  f.service.send(f.conversation.id, { text: '决定周五上线' });
  await f.service.settled(f.conversation.id);
  const first = f.store.get(f.conversation.id).messages[0];
  f.service.send(f.conversation.id, { text: '改成下周一上线', editMessageId: first.id });
  await f.service.settled(f.conversation.id);
  const saved: any = f.store.get(f.conversation.id);
  expect(saved.revisions?.[0].reason).toBe('edit');
  expect(saved.revisions?.[0].messages[0].text).toBe('决定周五上线');
  expect(saved.messages[0].text).toBe('改成下周一上线');
  expect(f.captures).toEqual(['决定周五上线', '改成下周一上线']);
});

test('读取记忆配置失败独立保留错误，普通回答仍然完成', async () => {
  const f = fixture();
  const service = new (WorkbenchService as any)(f.store, () => [{ id: 'ollama:test', name: '测试' }], async () => ({ text: '正常回答', model: 'ollama:test', citations: [] }), undefined, undefined, {
    capture: async () => { throw new Error('记忆配置不可读'); }, settled: async () => {},
  }) as WorkbenchService;
  service.send(f.conversation.id, { text: '我对方案的要求是尽量简短' });
  await service.settled(f.conversation.id);
  const saved: any = f.store.get(f.conversation.id);
  expect(saved.messages[0].memory?.status).toBe('held');
  expect(saved.messages[0].memory?.error).toBe('记忆配置不可读');
  expect(saved.messages[1].text).toBe('正常回答');
  expect(saved.messages[1].status).toBe('complete');
});
