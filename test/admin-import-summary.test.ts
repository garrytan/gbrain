import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  getImportFileReports,
  summarizeImportRun,
} from '../admin/src/lib/import-summary.ts';

const consoleSource = readFileSync(join(import.meta.dir, '..', 'admin', 'src', 'pages', 'Console.tsx'), 'utf8');
const naturalApiSource = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'natural-lang', 'api.ts'), 'utf8');
const serveHttpSource = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'serve-http.ts'), 'utf8');
const importSource = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'import.ts'), 'utf8');

describe('Admin folder import summary', () => {
  test('does not misreport an old timed-out folder run as one successful oversized file', () => {
    const summary = summarizeImportRun(
      { slots: { path: 'D:\\duwu' } },
      {
        status: 'failed',
        error: 'Command timed out after 10 minutes',
        stdout: 'Found 2057 markdown files\nResuming from checkpoint: skipping 400 already-processed files',
        stderr: [
          '[import.files] 310/1657 imported=120 skipped=190 errors=3',
          '[pmbrain] content-sanity soft-block: sheet (644514 bytes) — page lands, embedding skipped',
          'Warning: skipped broken.pdf: cannot extract text',
        ].join('\n'),
      },
    );

    expect(summary?.badge).toBe('未完成');
    expect(summary?.markdown).toContain('文件夹导入未完成');
    expect(summary?.markdown).toContain('共发现 2,057 个可导入文件');
    expect(summary?.markdown).toContain('旧断点直接略过 400 个文件');
    expect(summary?.markdown).toContain('仍有至少 1,347 个文件尚未检查');
    expect(summary?.markdown).toContain('内容已修改的文件会重新导入');
    expect(summary?.markdown).not.toContain('正文已保存到知识库\n- 未生成切片');
  });

  test('groups new per-file reports into imported, partial, unchanged and failed lists', () => {
    const stderr = [
      '[pmbrain phase] import.collect_files done 20ms files=4',
      '[pmbrain import-file] {"status":"imported","path":"a.md","chunks":2}',
      '[pmbrain import-file] {"status":"partial","path":"large.xlsx","chunks":0,"bytes":644514}',
      '[pmbrain import-file] {"status":"unchanged","path":"same.pdf","reason":"内容未变化"}',
      '[pmbrain import-file] {"status":"failed","path":"broken.pptx","reason":"无法提取正文"}',
      '[import.files] 4/4 imported=2 skipped=2 errors=1',
    ].join('\n');
    const run = { status: 'completed', stderr };
    const summary = summarizeImportRun({ slots: { path: 'D:\\project' } }, run);

    expect(getImportFileReports(run)).toHaveLength(4);
    expect(summary?.badge).toBe('部分完成');
    expect(summary?.markdown).toContain('完整导入 1 个');
    expect(summary?.markdown).toContain('正文已保存但未切片/向量化 1 个');
    expect(summary?.markdown).toContain('未变化跳过 1 个');
    expect(summary?.markdown).toContain('失败 1 个');
    expect(summary?.markdown).toContain('large.xlsx，正文 644,514 字节');
    expect(summary?.markdown).toContain('broken.pptx（无法提取正文）');
  });

  test('omits zero-count problem categories from a successful import summary', () => {
    const summary = summarizeImportRun(
      { slots: { path: 'D:\\lebo' } },
      {
        status: 'completed',
        stderr: [
          '[pmbrain phase] import.collect_files done 3ms files=1',
          '[pmbrain import-file] {"status":"imported","path":"梨园之殇.md","chunks":2}',
          '[import.files] 1/1 imported=1 skipped=0 errors=0',
        ].join('\n'),
      },
    );

    expect(summary?.badge).toBe('已完成');
    expect(summary?.markdown).toContain('完整导入 1 个');
    expect(summary?.markdown).not.toContain('正文已保存但未切片/向量化 0 个');
    expect(summary?.markdown).not.toContain('未变化跳过 0 个');
    expect(summary?.markdown).not.toContain('失败 0 个');
  });

  test('uses the final command totals when per-file logs were truncated', () => {
    const summary = summarizeImportRun(
      { slots: { path: 'D:\\duwu' } },
      {
        status: 'failed',
        stdout: [
          'Found 2057 markdown files',
          'Import complete (398.7s):',
          '  20 pages imported',
          '  2037 pages skipped (2034 unchanged, 3 errors)',
          '  100 chunks created',
        ].join('\n'),
        stderr: [
          '[pmbrain import-file] {"status":"imported","path":"tail-a.md","chunks":2}',
          '[pmbrain import-file] {"status":"unchanged","path":"tail-b.md","reason":"内容未变化"}',
          '[pmbrain import-file] {"status":"failed","path":"tail-c.md","reason":"无法解析"}',
        ].join('\n'),
      },
    );

    expect(summary?.badge).toBe('部分完成');
    expect(summary?.markdown).toContain('文件夹导入部分完成');
    expect(summary?.markdown).toContain('本次已处理全部 2,057 个');
    expect(summary?.markdown).toContain('成功写入 20 个；未变化跳过 2034 个；失败 3 个');
    expect(summary?.markdown).toContain('逐文件日志超过显示上限');
    expect(summary?.markdown).not.toContain('仍有至少');
    expect(summary?.markdown).not.toContain('本次实际检查 3 个');
  });

  test('keeps a precise single-file oversized explanation', () => {
    const summary = summarizeImportRun(
      { slots: { path: 'D:\\project\\large.xlsx' } },
      {
        status: 'completed',
        stderr: '[pmbrain import-file] {"status":"partial","path":"large.xlsx","chunks":0,"bytes":700000}',
      },
    );

    expect(summary?.badge).toBe('部分完成');
    expect(summary?.markdown).toContain('文件 `D:\\project\\large.xlsx` 仅部分导入');
    expect(summary?.markdown).toContain('未生成切片，也未进行向量化');
  });
});

describe('Admin import behavior contracts', () => {
  test('accepts PPT/PPTX once and keeps a single warning per unsupported file', () => {
    expect(consoleSource).toContain("'.pptx', '.ppt'");
    expect(consoleSource).toContain('wps|pptx|ppt|pdf');
    expect(consoleSource).toContain('const warnings = new Set<string>()');
    expect(consoleSource).toContain("setAttachmentError(Array.from(warnings).join('；'))");
  });

  test('save buttons are concise and disabled until their values change', () => {
    expect(consoleSource).toContain("const [savedOutputDir, setSavedOutputDir] = useState('output')");
    expect(consoleSource).toContain('!outputDirDirty');
    expect(consoleSource).toContain("saving ? '正在保存…' : '保存'");
    expect(consoleSource).toContain('value.thresholdKb === savedThresholdKb');
    expect(consoleSource).not.toContain("saving ? '正在保存…' : '保存设置'");
  });

  test('Admin re-walks files, reports each result and allows long folder imports', () => {
    expect(naturalApiSource).toContain('ADMIN_IMPORT_TIMEOUT_MS = 6 * 60 * 60 * 1000');
    expect(naturalApiSource).toContain("command.push('--fresh', '--report-files')");
    expect(serveHttpSource).toContain('fresh: true');
    expect(serveHttpSource).toContain('reportFiles: true');
    expect(importSource).toContain("const reportFiles = args.includes('--report-files')");
    expect(importSource).toContain('[pmbrain import-file]');
  });
});
