import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from '../../../shared/workbench';

export type ComposerAttachment = {
  id: string;
  name: string;
  image: boolean;
  previewUrl?: string;
  file?: File;
  saved?: boolean;
  mime?: string;
};

type ClipboardItemLike = { kind: string; getAsFile?: () => File | null };
export type ClipboardLike = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<ClipboardItemLike> | null;
};

export function filesFromClipboard(data: ClipboardLike | null): File[] {
  if (!data) return [];
  const listed = data.files ? Array.from(data.files).filter((file): file is File => file != null) : [];
  if (listed.length) return listed;
  const fromItems: File[] = [];
  for (const item of data.items ? Array.from(data.items) : []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile?.() ?? null;
    if (file) fromItems.push(file);
  }
  return fromItems;
}

export function sessionAttachments<T>(map: Record<string, readonly T[]>, key: string): readonly T[] {
  return map[key] ?? [];
}

export function assignSessionAttachments<T>(map: Record<string, T[]>, key: string, next: T[]): Record<string, T[]> {
  return { ...map, [key]: next };
}

export function composerFromSaved(items: Array<{ id: string; name: string; mime: string; preview?: string }> | undefined): ComposerAttachment[] {
  return (items ?? []).map(item => ({
    id: item.id,
    name: item.name,
    image: item.mime.startsWith("image/") || Boolean(item.preview),
    previewUrl: item.preview,
    mime: item.mime,
    saved: true,
  }));
}

export function createAttachment(
  file: File,
  id: string,
  createUrl: (file: File) => string = target => URL.createObjectURL(target),
): ComposerAttachment {
  const image = file.type.startsWith("image/");
  return { id, name: file.name || "未命名", image, previewUrl: image ? createUrl(file) : undefined, file, mime: file.type || "application/octet-stream" };
}

export function revokeAttachment(item: ComposerAttachment, revoke: (url: string) => void = url => URL.revokeObjectURL(url)): void {
  if (item.previewUrl && item.file) revoke(item.previewUrl);
}

export function attachmentTooBig(file: File): boolean {
  return file.size > ATTACHMENT_MAX_BYTES;
}

export function attachmentTooBigMessage(name = ''): string {
  return name ? `「${name}」超过 15MB，不能添加。` : '单个附件不能超过 15MB。';
}

export function acceptComposerFiles(currentCount: number, files: File[]): { accepted: File[]; error: string } {
  const errors: string[] = [];
  const accepted: File[] = [];
  let room = Math.max(0, ATTACHMENT_MAX_COUNT - currentCount);
  let reportedCount = false;
  for (const file of files) {
    const name = file.name || '未命名';
    if (file.size <= 0) { errors.push(`「${name}」是空的，不能添加。`); continue; }
    if (attachmentTooBig(file)) { errors.push(attachmentTooBigMessage(name)); continue; }
    if (room <= 0) {
      if (!reportedCount) errors.push(`一次最多 ${ATTACHMENT_MAX_COUNT} 个附件。`);
      reportedCount = true;
      continue;
    }
    accepted.push(file);
    room -= 1;
  }
  return { accepted, error: errors.join('') };
}

export async function filePayload(item: { id: string; name: string; file?: File; saved?: boolean; mime?: string }): Promise<{ id: string; name: string; mime: string; data?: string; keep?: true }> {
  if (item.saved || !item.file) {
    return { id: item.id, name: item.name, mime: item.mime || "application/octet-stream", keep: true };
  }
  const name = item.file.name || item.name || '未命名';
  if (item.file.size <= 0) throw new Error(`「${name}」是空的，不能添加。`);
  if (attachmentTooBig(item.file)) throw new Error(attachmentTooBigMessage(name));
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { id: item.id, name: item.name, mime: (item.file.type || "application/octet-stream").split(";")[0], data: btoa(binary) };
}