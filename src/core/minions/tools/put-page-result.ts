export function putPageRejection(output: unknown): string | null {
  if (typeof output === 'string') {
    try { output = JSON.parse(output); } catch { return null; }
  }
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const result = output as Record<string, unknown>;
  if (result.status === 'error'
    || (result.status === 'skipped' && typeof result.error === 'string' && result.error.length > 0)) {
    return 'brain_put_page: page content was rejected before persistence. Check the page size and YAML frontmatter, then retry.';
  }
  return null;
}
