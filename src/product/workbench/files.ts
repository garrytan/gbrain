import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, isAbsolute, resolve, sep } from 'node:path';
import JSZip from 'jszip';
import type { BrainEngine } from '../../core/engine';
import { resolveMainSourceId } from '../../core/source-resolver';
import type { WorkbenchAgent, WorkbenchArtifact } from '../../../shared/workbench-agents';
import type { WorkbenchCitation } from '../../../shared/workbench';
import type { WorkbenchAgentStore } from './agents';

function inside(root: string, path: string) { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); }
function granted(agent: WorkbenchAgent, path: string) {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error('文件不存在或未授权');
  const resolved = realpathSync(path);
  if (!agent.readDirectories.some(root => inside(realpathSync(root), resolved))) throw new Error('文件不在助手授权目录中');
  return resolved;
}
export async function listLocalFiles(agent: WorkbenchAgent, directory?: string, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('读取位置无效');
  const roots = directory ? [granted(agent, directory)] : agent.readDirectories;
  const files = roots.flatMap(root => readdirSync(root, { withFileTypes: true }).map(item => {
    const path = join(root, item.name);
    if (item.isSymbolicLink()) return null;
    const info = statSync(path);
    return { path, name: item.name, directory: info.isDirectory(), bytes: info.size, modifiedAt: info.mtime.toISOString() };
  }).filter((row): row is NonNullable<typeof row> => row !== null));
  return { files: files.slice(offset, offset + 100), nextOffset: offset + 100 < files.length ? offset + 100 : null };
}
export async function readLocalFile(agent: WorkbenchAgent, path: string, offset = 0) {
  const resolved = granted(agent, path); const info = statSync(resolved);
  if (!info.isFile() || info.size > 15 * 1024 * 1024) throw new Error('只支持不超过 15MB 的文件');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('读取位置无效');
  const extension = extname(resolved).toLowerCase(); let text: string; let notes: string[] = [];
  if (['.md', '.txt', '.csv', '.json', '.log', '.html', '.xml', '.tsv'].includes(extension)) text = readFileSync(resolved, 'utf8');
  else if (['.docx', '.pdf', '.pptx', '.xlsx', '.xlsm', '.xls'].includes(extension)) {
    const { parseDocument } = await import('../../core/document/document-import');
    const { renderStructuredDocument } = await import('../../core/document/markdown-renderer');
    const doc = await parseDocument(resolved); text = renderStructuredDocument(doc);
    notes = [...(doc.metadata.ocrWarnings ?? []), ...(doc.metadata.pagesNeedingOcr?.length ? ['存在需要 OCR 的页面，本地文件读取没有执行 OCR，不能将未读出的内容当作已核对。'] : [])];
  } else throw new Error('文件格式不受当前原生解析器支持');
  if (offset > text.length) throw new Error('读取位置超出正文');
  const content = text.slice(offset, offset + 6000);
  return { path: resolved, title: basename(resolved), content, offset, nextOffset: offset + content.length < text.length ? offset + content.length : null, modifiedAt: info.mtime.toISOString(), notes, note: '文件修改时间不是工作完成时间，请按正文中的事件时间判断。' };
}
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
async function docx(title: string, content: string) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const lines = [title, ...content.split('\n')].map((line, index) => { const heading = index === 0 || /^#{1,3}\s/.test(line); return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Microsoft YaHei"/>${heading ? '<w:b/>' : ''}<w:sz w:val="${heading ? 28 : 22}"/></w:rPr><w:t xml:space="preserve">${xml(line.replace(/^#{1,6}\s+/, ''))}</w:t></w:r></w:p>`; }).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`);
  zip.forEach((_path, file) => { file.date = new Date('1980-01-01T00:00:00Z'); });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export async function saveWorkbenchArtifact(store: WorkbenchAgentStore, input: { agent: WorkbenchAgent; conversationId: string; messageId: string; title: string; content: string; citations: WorkbenchCitation[]; format?: WorkbenchArtifact['format']; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const { agent, conversationId, messageId, title, content, citations } = input;
  if (!title.trim() || title.length > 120 || !content.trim() || content.length > 100000) throw new Error('成果标题或内容无效');
  for (const match of content.matchAll(/\[(\d+)\]/g)) if (!citations[Number(match[1]) - 1]) throw new Error('成果含未经核对的引用编号');
  const format = input.format ?? agent.deliveryFormat;
  if (!['markdown', 'docx'].includes(format)) throw new Error('交付格式无效');
  const hash = createHash('sha256').update(JSON.stringify([title, content, citations, format])).digest('hex');
  const id = createHash('sha256').update(JSON.stringify([conversationId, messageId, hash])).digest('hex');
  const existing = store.artifacts().find(row => row.id === id);
  if (existing) { if (!existsSync(existing.path)) throw new Error('已保存成果的文件缺失'); return existing; }
  const sources = citations.map((item, index) => `[${index + 1}] ${item.title} — ${item.sourceId ?? '本地文件'}/${item.slug}`);
  const rendered = `${content}${sources.length ? `\n\n资料依据\n${sources.join('\n')}` : ''}`;
  const directory = join(store.workbench.root, 'artifacts'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.${format === 'docx' ? 'docx' : 'md'}`);
  const bytes = format === 'docx' ? await docx(title, rendered) : Buffer.from(`# ${title}\n\n${rendered}\n`);
  input.signal?.throwIfAborted();
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  else if (!readFileSync(path).equals(bytes)) throw new Error('成果文件已改变，保留人工内容');
  const artifact: WorkbenchArtifact = { id, agentId: agent.id, conversationId, messageId, title, content, citations: structuredClone(citations), path, format, createdAt: new Date().toISOString(), hash };
  store.recordArtifact(artifact); return artifact;
}
export function artifactFilename(title: string, format: WorkbenchArtifact['format']) {
  const stem = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || '成果';
  return `${stem}.${format === 'docx' ? 'docx' : 'md'}`;
}
export async function resolveAgentDeliveryDirectory(engine: BrainEngine, agent: WorkbenchAgent) {
  let mainId: string | null = null;
  try { mainId = await resolveMainSourceId(engine); } catch { mainId = null; }
  const requested = agent.sourceIds.map(id => id === 'default' && mainId ? mainId : id);
  const ordered = mainId && requested.includes(mainId) ? [mainId, ...requested.filter(id => id !== mainId)] : requested;
  for (const id of ordered) {
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources WHERE id=$1 AND archived=false', [id]);
    const directory = typeof rows[0]?.local_path === 'string' ? rows[0].local_path.trim() : '';
    if (!directory) continue;
    const resolved = resolve(directory);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) continue;
    return { sourceId: rows[0]!.id, directory: resolved };
  }
  return null;
}
export type ArtifactPublishResult = { ok: true; path: string; sourceId: string } | { ok: false; reason: string };
export async function publishArtifactToSource(engine: BrainEngine, agent: WorkbenchAgent, artifact: WorkbenchArtifact): Promise<ArtifactPublishResult> {
  if (artifact.publishedPath && existsSync(artifact.publishedPath) && readFileSync(artifact.publishedPath).equals(readFileSync(artifact.path))) {
    return { ok: true, path: artifact.publishedPath, sourceId: agent.sourceIds[0] ?? 'default' };
  }
  const target = await resolveAgentDeliveryDirectory(engine, agent);
  if (!target) return { ok: false, reason: '知识来源没有绑定可用的本地目录' };
  const bytes = readFileSync(artifact.path);
  const filename = artifactFilename(artifact.title, artifact.format);
  let destination = join(target.directory, filename);
  if (existsSync(destination)) {
    if (readFileSync(destination).equals(bytes)) return { ok: true, path: destination, sourceId: target.sourceId };
    const ext = extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let index = 2;
    while (existsSync(destination) && index < 100) {
      destination = join(target.directory, `${stem} (${index})${ext}`);
      if (existsSync(destination) && readFileSync(destination).equals(bytes)) return { ok: true, path: destination, sourceId: target.sourceId };
      index += 1;
    }
  }
  if (existsSync(destination)) return { ok: false, reason: '目标目录已有同名文件，无法写入' };
  writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' });
  return { ok: true, path: destination, sourceId: target.sourceId };
}
