import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_UPLOAD_MAX_BYTES,
  classifyAdminUploadFilename,
  normalizeAdminUploadFilename,
} from '../src/commands/serve-http.ts';

const root = process.cwd();
const consoleSource = readFileSync(join(root, 'admin/src/pages/Console.tsx'), 'utf8');
const apiSource = readFileSync(join(root, 'admin/src/api.ts'), 'utf8');
const stylesSource = readFileSync(join(root, 'admin/src/index.css'), 'utf8');
const serveHttpSource = readFileSync(join(root, 'src/commands/serve-http.ts'), 'utf8');

function sourceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('Admin knowledge assistant attachment contract', () => {
  test('offers a multi-file picker and accepts files pasted from the clipboard', () => {
    expect(consoleSource).toContain('className="assistant-file-input"');
    expect(consoleSource).toMatch(/type="file"[\s\S]{0,180}\bmultiple\b|\bmultiple\b[\s\S]{0,180}type="file"/);
    expect(consoleSource).toContain('aria-label="添加本地文件"');
    expect(consoleSource).toContain('onPaste={handleAttachmentPaste}');
    expect(consoleSource).toContain('event.clipboardData.files');
  });

  test('renders a removable chip for each attachment', () => {
    expect(consoleSource).toMatch(/attachments\.map\s*\(/);
    expect(consoleSource).toContain('assistant-attachments');
    expect(consoleSource).toContain('assistant-attachment-chip');
    expect(consoleSource).toContain('removeAttachment(attachment.id)');
    expect(consoleSource).toContain('aria-label={`移除文件 ${attachment.file.name}`}');
    expect(stylesSource).toContain('.assistant-attachment-chip');
  });

  test('uploads multiple attachments serially and waits for every run to finish', () => {
    const uploadAttachments = sourceBetween(consoleSource, 'const uploadAttachmentRuns', 'const upsertHistory');
    expect(uploadAttachments).toContain('for (let index = 0; index < files.length; index++)');
    expect(uploadAttachments).toContain('await api.startImportUploadRun(attachment.file');
    expect(uploadAttachments).toContain('await waitForConsoleRun(response.runId');
    expect(uploadAttachments).toContain("lastRun.status !== 'completed'");
  });

  test('Import accepts attachments without text, while Search never uploads attachments', () => {
    const startDirect = sourceBetween(consoleSource, 'const startDirect', 'const execute');
    expect(startDirect).toContain("const attachedFiles = kind === 'import' ? [...attachments] : [];");
    expect(startDirect).toContain("kind === 'search' ? !value : !value && attachedFiles.length === 0");
    expect(startDirect).toContain("if (kind === 'import' && attachedFiles.length > 0)");
    expect(startDirect).toContain('first = await uploadAttachmentRuns(attachedFiles)');
    expect(startDirect).toMatch(/kind === 'search'[\s\S]{0,120}api\.startThinkRun\(value\)/);
  });

  test('Import stores ordinary text through capture while keeping explicit paths on path import', () => {
    const startDirect = sourceBetween(consoleSource, 'const startDirect', 'const execute');
    expect(consoleSource).toContain('function looksLikeLocalImportPath');
    expect(startDirect).toContain("const captureText = kind === 'import'");
    expect(startDirect).toContain('!looksLikeLocalImportPath(value)');
    expect(startDirect).toContain('api.startCaptureRun(value, importOptions?.sourceId)');
    expect(startDirect).toContain('api.startImportRun({');
    expect(apiSource).toContain("apiFetch('/admin/api/capture-runs'");
    expect(serveHttpSource).toMatch(/app\.post\(['"]\/admin\/api\/capture-runs['"], requireAdmin/);
  });

  test('Send imports attachments before passing their names and the request to previewIntent', () => {
    const submitAuto = sourceBetween(consoleSource, 'const submitAuto', 'const startDirect');
    const uploadAt = submitAuto.indexOf('await uploadAttachmentRuns(attachedFiles)');
    const previewAt = submitAuto.indexOf('await api.previewIntent(prompt)');
    expect(uploadAt).toBeGreaterThanOrEqual(0);
    expect(previewAt).toBeGreaterThan(uploadAt);
    expect(submitAuto).toContain('以下附件已经由系统完成导入：${attachedNames.join');
    expect(submitAuto).toContain('不要再次请求文件路径或重复执行导入');
    expect(submitAuto).toContain("text.trim() || '请阅读并整理这些文件。'");
    expect(submitAuto).toContain("nextPreview.intent === 'import_path'");
    expect(submitAuto).toContain("setText('')");
  });

  test('Send clears the composer only after the resulting run completes', () => {
    const submitAuto = sourceBetween(consoleSource, 'const submitAuto', 'const startDirect');
    const execute = sourceBetween(consoleSource, 'const execute', 'useEffect(() =>');
    expect(submitAuto).toContain('await waitForConsoleRun(first.id, setRun)');
    expect(submitAuto).toContain("completed.status === 'completed'");
    expect(execute).toContain('await waitForConsoleRun(first.id, setRun)');
    expect(execute).toContain("completed.status === 'completed'");
    expect(execute).toContain("setText('')");
  });

  test('API sends a raw file with the encoded filename and import options', () => {
    expect(apiSource).toContain("'Content-Type': 'application/octet-stream'");
    expect(apiSource).toContain("'X-PMBrain-Filename': encodeURIComponent(file.name)");
    expect(apiSource).toContain('body: file');
    expect(apiSource).toContain('/admin/api/import-upload-runs?');
    expect(apiSource).toContain('sourceId');
    expect(apiSource).toContain('autoEmbed');
    expect(apiSource).toContain('workers');
  });
});

  test('shows a partial-completion warning when oversized converted content is not chunked or embedded', () => {
    expect(consoleSource).toContain('content-sanity soft-block:');
    expect(consoleSource).toContain('导入仅部分完成。');
    expect(consoleSource).toContain('未生成切片，也未进行向量化');
    expect(consoleSource).toContain('按工作表、地区或主题拆分成多个较小文件');
    expect(consoleSource).toContain("importEmbeddingSkip ? '部分完成'");
    expect(stylesSource).toContain('.nl-summary.is-partial');
  });
describe('Admin local attachment staging safety contract', () => {
  test('caps an individual upload at 50 MiB', () => {
    expect(ADMIN_UPLOAD_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(serveHttpSource).toContain("express.raw({ type: 'application/octet-stream', limit: ADMIN_UPLOAD_MAX_BYTES })");
  });

  test('accepts a plain encoded basename and rejects path or Windows filename hazards', () => {
    expect(normalizeAdminUploadFilename(encodeURIComponent('会议纪要 2026.docx'))).toBe('会议纪要 2026.docx');
    const invalidNames = [
      '../secret.md',
      'folder/secret.md',
      'folder\\secret.md',
      'C:\\secret.md',
      '.hidden.md',
      'bad\u0000.md',
      'bad?.md',
      'trailing.md.',
      'CON.md',
      'aux.pdf',
      'LPT9.xlsx',
    ];
    for (const name of invalidNames) {
      expect(() => normalizeAdminUploadFilename(encodeURIComponent(name))).toThrow();
    }
  });

  test('classifies only the existing Markdown, Office and image import formats', () => {
    expect(classifyAdminUploadFilename('note.md')).toBe('markdown');
    expect(classifyAdminUploadFilename('note.mdx')).toBe('markdown');
    expect(classifyAdminUploadFilename('proposal.docx')).toBe('office');
    expect(classifyAdminUploadFilename('reference.pdf')).toBe('office');
    expect(classifyAdminUploadFilename('budget.xlsx')).toBe('office');
    expect(classifyAdminUploadFilename('scan.png')).toBe('image');
    expect(classifyAdminUploadFilename('photo.jpeg')).toBe('image');
    expect(() => classifyAdminUploadFilename('plain.txt')).toThrow('Unsupported file type');
    expect(() => classifyAdminUploadFilename('script.exe')).toThrow('Unsupported file type');
  });

  test('administrator-only endpoint stages under a server-owned temporary directory', () => {
    expect(serveHttpSource).toMatch(/app\.post\(\s*['"]\/admin\/api\/import-upload-runs['"]\s*,\s*requireAdmin/);
    expect(serveHttpSource).toContain("normalizeAdminUploadFilename(req.get('x-pmbrain-filename'))");
    expect(serveHttpSource).toContain("mkdtemp(joinPath(tmpdir(), 'pmbrain-admin-upload-'))");
    expect(serveHttpSource).toContain('joinPath(tempDir, fileName)');
    expect(serveHttpSource).toContain("writeFile(filePath, req.body, { flag: 'wx', mode: 0o600 })");
  });

  test('reuses startImportRun and removes the temporary directory after completion', () => {
    const uploadRoute = sourceBetween(
      serveHttpSource,
      "'/admin/api/import-upload-runs'",
      "app.post('/admin/api/export-runs'",
    );
    expect(uploadRoute).toContain('await startImportRun(engine, {');
    expect(uploadRoute).toContain("includeOffice: fileKind === 'office'");
    expect(uploadRoute).toContain("includeImages: fileKind === 'image'");
    expect(uploadRoute).toContain('afterComplete: async () =>');
    expect(uploadRoute).toContain('await cleanup()');
  });
});
