const CJK_OR_HANGUL_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/gu;

export function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const cjkMatches = trimmed.match(CJK_OR_HANGUL_RE);
  const cjkCount = cjkMatches?.length ?? 0;
  const nonCjkText = trimmed.replace(CJK_OR_HANGUL_RE, '');
  const nonCjkChars = nonCjkText.replace(/\s+/g, ' ').length;

  return Math.max(1, cjkCount + Math.ceil(nonCjkChars / 4));
}
