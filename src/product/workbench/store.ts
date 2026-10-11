import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAssistant, normalizeAssistant, type KnowledgeAssistantSettings, type WorkbenchConversation } from '../../../shared/workbench';
import { smallPreview } from './attachments';

const PREVIEW_MAX_CHARS = 12_000;

export class WorkbenchStore {
  constructor(private root: string) {}
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的会话 ID');
    return join(this.root, `${id}.json`);
  }
  private filesDir(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的会话 ID');
    return join(this.root, 'files', id);
  }
  private attachmentPath(conversationId: string, attachmentId: string) {
    if (!/^[a-f0-9-]{36}$/.test(attachmentId)) throw new Error('无效的附件 ID');
    return join(this.filesDir(conversationId), attachmentId);
  }
  get(id: string): WorkbenchConversation {
    const path = this.path(id);
    if (!existsSync(path)) throw new Error('会话不存在');
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  list(): WorkbenchConversation[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => this.get(name.slice(0, -5))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  readAttachment(conversationId: string, attachmentId: string): Buffer | null {
    const path = this.attachmentPath(conversationId, attachmentId);
    if (!existsSync(path)) return null;
    return readFileSync(path);
  }
  deleteAttachment(conversationId: string, attachmentId: string) {
    const path = this.attachmentPath(conversationId, attachmentId);
    if (existsSync(path)) unlinkSync(path);
  }
  save(conversation: WorkbenchConversation) {
    this.externalize(conversation);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = this.path(conversation.id);
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(conversation), { mode: 0o600 });
    renameSync(temp, target);
  }
  remove(id: string) {
    unlinkSync(this.path(id));
    rmSync(this.filesDir(id), { recursive: true, force: true });
  }
  assistant(): KnowledgeAssistantSettings {
    const path = join(this.root, 'assistant.json');
    if (!existsSync(path)) return defaultAssistant();
    try { return normalizeAssistant(JSON.parse(readFileSync(path, 'utf8'))); } catch { return defaultAssistant(); }
  }
  saveAssistant(input: unknown): KnowledgeAssistantSettings {
    const settings = normalizeAssistant(input);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, 'assistant.json');
    const temp = `${target}.tmp`;
    writeFileSync(temp, JSON.stringify(settings), { mode: 0o600 });
    renameSync(temp, target);
    return settings;
  }
  private writeAttachment(conversationId: string, attachmentId: string, bytes: Buffer) {
    const path = this.attachmentPath(conversationId, attachmentId);
    mkdirSync(this.filesDir(conversationId), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  }
  private externalize(conversation: WorkbenchConversation) {
    for (const message of conversation.messages) {
      for (const item of message.attachments ?? []) {
        let bytes: Buffer | null = null;
        if (item.data) bytes = Buffer.from(item.data, 'base64');
        else if (item.preview && item.preview.length > PREVIEW_MAX_CHARS) {
          const match = /^data:[^;]+;base64,([\s\S]+)$/.exec(item.preview);
          if (match) bytes = Buffer.from(match[1], 'base64');
        }
        if (bytes?.length) this.writeAttachment(conversation.id, item.id, bytes);
        delete item.data;
        if (item.preview && item.preview.length > PREVIEW_MAX_CHARS) {
          const thumb = bytes ? smallPreview(bytes, item.mime) : undefined;
          if (thumb) item.preview = thumb;
          else delete item.preview;
        }
      }
    }
  }
}
