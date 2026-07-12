export interface ThinkOutput {
  answer: string;
  citations: string[];
  gaps: string[];
}

export function parseThinkOutput(output: string): ThinkOutput | null {
  const trimmed = output.trim();
  const lines = trimmed.split(/\r?\n/).filter(Boolean).reverse();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const candidates = [
    trimmed,
    ...(firstBrace >= 0 && lastBrace > firstBrace ? [trimmed.slice(firstBrace, lastBrace + 1)] : []),
    ...lines,
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown;
        citations?: Array<{ page_slug?: unknown; row_num?: unknown }>;
        gaps?: unknown[];
      };
      if (typeof parsed.answer !== 'string') continue;
      return {
        answer: parsed.answer,
        citations: Array.isArray(parsed.citations)
          ? parsed.citations.map(item => {
            const slug = typeof item.page_slug === 'string' ? item.page_slug : '';
            return item.row_num === null || item.row_num === undefined ? slug : `${slug}#${String(item.row_num)}`;
          }).filter(Boolean)
          : [],
        gaps: Array.isArray(parsed.gaps) ? parsed.gaps.filter((item): item is string => typeof item === 'string') : [],
      };
    } catch {
      // The CLI may prefix pretty JSON with a banner; keep trying narrower candidates.
    }
  }

  return null;
}

export function getThinkRetrievalWarning(stderr: string): string | null {
  if (!/hybrid stream failed:.*(?:statement timeout|statement_timeout)/i.test(stderr)) return null;
  return '知识库检索超时，模型没有拿到可用资料；这不代表知识库中没有相关内容。请稍后重试，或由管理员检查搜索性能。';
}
