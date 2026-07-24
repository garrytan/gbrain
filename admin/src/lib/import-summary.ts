export interface ImportSummaryRun {
  status: string;
  stdout?: string | null;
  stderr?: string | null;
  error?: string | null;
}

export interface ImportSummaryPreview {
  slots: Record<string, unknown>;
}

export interface ImportFileReport {
  status: 'imported' | 'partial' | 'unchanged' | 'failed';
  path: string;
  chunks?: number;
  bytes?: number;
  reason?: string;
}

export interface ImportRunSummary {
  markdown: string;
  badge: '已完成' | '部分完成' | '未完成';
  tone: 'success' | 'partial' | 'failed';
}

const FILE_EXTENSIONS = new Set([
  '.md', '.mdx', '.docx', '.doc', '.wps', '.pptx', '.ppt', '.pdf',
  '.xlsx', '.xlsm', '.xls', '.csv', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.heic', '.heif', '.avif',
]);

function runText(run: ImportSummaryRun): string {
  return [run.error, run.stderr, run.stdout].filter(Boolean).join('\n');
}

function fileExtension(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const name = normalized.split(/[\\/]/).pop() ?? '';
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(index).toLowerCase() : '';
}

function isSingleFileImport(preview: ImportSummaryPreview): boolean {
  if (Array.isArray(preview.slots.files) && preview.slots.files.length > 0) return true;
  const path = typeof preview.slots.path === 'string' ? preview.slots.path.trim() : '';
  return Boolean(path && FILE_EXTENSIONS.has(fileExtension(path)));
}

function parseReportLine(value: string): ImportFileReport | null {
  try {
    const parsed = JSON.parse(value) as Partial<ImportFileReport>;
    if (
      typeof parsed.path !== 'string'
      || !['imported', 'partial', 'unchanged', 'failed'].includes(parsed.status ?? '')
    ) return null;
    return parsed as ImportFileReport;
  } catch {
    return null;
  }
}

export function getImportFileReports(run: ImportSummaryRun): ImportFileReport[] {
  const reports: ImportFileReport[] = [];
  for (const match of runText(run).matchAll(/^\[pmbrain import-file\]\s+(.+)$/gm)) {
    const report = parseReportLine(match[1]);
    if (report) reports.push(report);
  }
  return reports;
}

function formatExamples(label: string, reports: ImportFileReport[], formatter: (report: ImportFileReport) => string): string | null {
  if (reports.length === 0) return null;
  const shown = reports.slice(0, 8).map(formatter);
  const remainder = reports.length - shown.length;
  return `- ${label}：${shown.join('；')}${remainder > 0 ? `；另有 ${remainder} 个，完整名单见执行详情` : ''}`;
}

function getEmbeddingSkip(text: string): { bytes: number | null } | null {
  if (!/content-sanity soft-block:/i.test(text) || !/embedding skipped/i.test(text)) return null;
  const bytesMatch = text.match(/content-sanity soft-block:[^\n]*\((\d+) bytes\)/i);
  return { bytes: bytesMatch ? Number(bytesMatch[1]) : null };
}

function summarizeSingleFile(preview: ImportSummaryPreview, run: ImportSummaryRun): ImportRunSummary | null {
  if (!isSingleFileImport(preview)) return null;
  const text = runText(run);
  const reports = getImportFileReports(run);
  const partial = reports.find(report => report.status === 'partial');
  const skip = partial
    ? { bytes: typeof partial.bytes === 'number' ? partial.bytes : null }
    : getEmbeddingSkip(text);
  if (!skip) return null;
  const sourcePath = typeof preview.slots.path === 'string'
    ? preview.slots.path
    : Array.isArray(preview.slots.files) && typeof preview.slots.files[0] === 'string'
      ? preview.slots.files[0]
      : '该文件';
  const sizeReason = skip.bytes && Number.isFinite(skip.bytes)
    ? `转换后的正文约 ${skip.bytes.toLocaleString('zh-CN')} 字节，超过当前内容安全阈值`
    : '转换后的正文超过当前内容安全阈值';
  return {
    markdown: [
      `文件 \`${sourcePath}\` 仅部分导入。`,
      '- 正文已保存到知识库',
      '- 未生成切片，也未进行向量化',
      `- 原因：${sizeReason}`,
      '- 处理方法：拆分成多个较小文件，或在“设置 → 导入切片与向量化”中谨慎提高正文上限后重新导入。',
    ].join('\n'),
    badge: '部分完成',
    tone: 'partial',
  };
}

function legacyFailures(text: string): ImportFileReport[] {
  const rows = [
    ...text.matchAll(/Skipped\s+([^:]+):\s+([^\n]+)/gi),
    ...text.matchAll(/Warning:\s+skipped\s+([^:]+):\s+([^\n]+)/gi),
  ];
  return rows.map(match => ({
    status: 'failed' as const,
    path: match[1].trim(),
    reason: match[2].trim().replace(/\s+/g, ' '),
  }));
}

function getCompletionTotals(text: string): {
  imported: number;
  skipped: number;
  unchanged: number;
  errors: number;
} | null {
  const match = text.match(
    /Import complete \([^)]+\):\s*\r?\n\s*(\d+)\s+pages imported\s*\r?\n\s*(\d+)\s+pages skipped\s*\((\d+)\s+unchanged,\s*(\d+)\s+errors\)/i,
  );
  if (!match) return null;
  return {
    imported: Number(match[1]),
    skipped: Number(match[2]),
    unchanged: Number(match[3]),
    errors: Number(match[4]),
  };
}

export function summarizeImportRun(preview: ImportSummaryPreview, run: ImportSummaryRun): ImportRunSummary | null {
  if (run.status === 'queued' || run.status === 'running') return null;
  const single = summarizeSingleFile(preview, run);
  if (single) return single;
  if (isSingleFileImport(preview)) return null;

  const text = runText(run);
  if (!text.trim()) return null;

  const reports = getImportFileReports(run);
  const imported = reports.filter(report => report.status === 'imported');
  const partial = reports.filter(report => report.status === 'partial');
  const unchanged = reports.filter(report => report.status === 'unchanged');
  const failed = reports.filter(report => report.status === 'failed');
  const totalMatch = text.match(/\bfiles=(\d+)\b/) ?? text.match(/Found\s+(\d+)\s+\w+\s+files/i);
  const total = totalMatch ? Number(totalMatch[1]) : null;
  const latestProgress = Array.from(text.matchAll(/imported=(\d+)\s+skipped=(\d+)\s+errors=(\d+)/g)).pop();
  const checkpointMatch = text.match(/Resuming from checkpoint:\s+skipping\s+(\d+)\s+already-processed files/i);
  const checkpointSkipped = checkpointMatch ? Number(checkpointMatch[1]) : 0;
  const timeoutMatch = text.match(/Command timed out after\s+(\d+)\s+minutes/i);
  const timedOut = Boolean(timeoutMatch);
  const completionTotals = getCompletionTotals(text);
  const legacyFailed = reports.length === 0 ? legacyFailures(text) : [];
  const processed = completionTotals
    ? completionTotals.imported + completionTotals.skipped
    : reports.length > 0
      ? reports.length
      : latestProgress
        ? Number(latestProgress[1]) + Number(latestProgress[2])
        : 0;
  const legacyImported = latestProgress ? Number(latestProgress[1]) : 0;
  const legacySkipped = latestProgress ? Number(latestProgress[2]) : 0;
  const legacyErrors = latestProgress ? Number(latestProgress[3]) : legacyFailed.length;
  const remaining = total === null ? null : Math.max(0, total - checkpointSkipped - processed);
  const reportsTruncated = completionTotals !== null && reports.length < processed;
  const hasProblems = partial.length > 0
    || failed.length > 0
    || legacyErrors > 0
    || (completionTotals?.errors ?? 0) > 0;
  const tone: ImportRunSummary['tone'] = timedOut || run.status === 'cancelled' || (run.status === 'failed' && !completionTotals)
    ? 'failed'
    : hasProblems
      ? 'partial'
      : 'success';
  const badge: ImportRunSummary['badge'] = tone === 'failed' ? '未完成' : tone === 'partial' ? '部分完成' : '已完成';
  const title = timedOut
    ? `文件夹导入未完成：执行 ${timeoutMatch?.[1] ?? ''} 分钟后达到任务时限，进程已停止。`
    : run.status === 'cancelled'
      ? '文件夹导入已取消。'
      : run.status === 'failed' && !completionTotals
        ? '文件夹导入未完成。'
      : hasProblems
        ? '文件夹导入部分完成。'
        : '文件夹导入完成。';

  const lines = [title];
  if (total !== null) {
    lines.push(remaining === 0 && checkpointSkipped === 0
      ? `- 共发现 ${total.toLocaleString('zh-CN')} 个可导入文件；本次已处理全部 ${processed.toLocaleString('zh-CN')} 个。`
      : `- 共发现 ${total.toLocaleString('zh-CN')} 个可导入文件；本次实际检查 ${processed.toLocaleString('zh-CN')} 个。`);
  }
  if (completionTotals && reportsTruncated) {
    lines.push(
      `- 任务完成汇总：成功写入 ${completionTotals.imported} 个；未变化跳过 ${completionTotals.unchanged} 个；失败 ${completionTotals.errors} 个。`,
      '- 逐文件日志超过显示上限，下面只展示当前保留的日志样例；总数以任务完成汇总为准。',
    );
  } else if (reports.length > 0) {
    lines.push(
      `- 完整导入 ${imported.length} 个；正文已保存但未切片/向量化 ${partial.length} 个；未变化跳过 ${unchanged.length} 个；失败 ${failed.length} 个。`,
    );
  } else if (latestProgress) {
    lines.push(`- 截止任务停止时：导入 ${legacyImported} 个；跳过 ${legacySkipped} 个；错误 ${legacyErrors} 个。`);
  }
  if (checkpointSkipped > 0) {
    lines.push(`- 旧断点直接略过 ${checkpointSkipped} 个文件，未重新检查这些文件后来是否修改；下次从管理台导入会重新检查全部文件。`);
  }
  if (remaining !== null && remaining > 0) {
    lines.push(`- 仍有至少 ${remaining.toLocaleString('zh-CN')} 个文件尚未检查，不能认定整个文件夹已经导入完成。`);
  }
  lines.push('- 再次导入同一路径时，内容未变化的文件会跳过；内容已修改的文件会重新导入。');

  const examples = [
    formatExamples('完整导入', imported, report => report.path),
    formatExamples('未变化跳过', unchanged, report => report.path),
    formatExamples('未切片文件', partial, report => {
      const size = typeof report.bytes === 'number' ? `，正文 ${report.bytes.toLocaleString('zh-CN')} 字节` : '';
      return `${report.path}${size}`;
    }),
    formatExamples('失败文件', reports.length > 0 ? failed : legacyFailed, report => (
      `${report.path}${report.reason ? `（${report.reason.slice(0, 120)}）` : ''}`
    )),
  ].filter((line): line is string => Boolean(line));
  lines.push(...examples);
  if (reports.length === 0 && (latestProgress || checkpointSkipped > 0)) {
    lines.push('- 这是旧版任务记录，没有保存逐文件成功名单；从下次导入开始会在执行详情中记录完整分类。');
  }

  return { markdown: lines.join('\n'), badge, tone };
}
