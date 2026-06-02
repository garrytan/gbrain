export interface SearchSourceHintSummary {
  id: string;
  page_count: number | string | null;
}

export function formatEmptyDefaultSourceSearchHint(
  commandName: 'search' | 'query',
  sources: SearchSourceHintSummary[],
): string | null {
  const defaultSource = sources.find((s) => s.id === 'default');
  const defaultPageCount = Number(defaultSource?.page_count ?? 0);
  if (defaultPageCount > 0) return null;

  const populated = sources
    .filter((s) => s.id !== 'default' && Number(s.page_count ?? 0) > 0)
    .sort((a, b) => Number(b.page_count ?? 0) - Number(a.page_count ?? 0));
  if (populated.length === 0) return null;

  const shown = populated.slice(0, 3)
    .map((s) => `${s.id} (${Number(s.page_count ?? 0)} pages)`)
    .join(', ');
  const extra = populated.length > 3 ? `, +${populated.length - 3} more` : '';
  return (
    `[gbrain] Current source resolved to empty 'default'; populated sources exist: ` +
    `${shown}${extra}. Try \`gbrain ${commandName} "<query>" --source <id>\`, ` +
    `set \`gbrain sources default <id>\`, or run \`gbrain sources current\` to verify routing.\n`
  );
}
