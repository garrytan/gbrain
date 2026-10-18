import type { BrainEngine } from '../../engine.ts';
import { OperationError } from '../../ops/contract.ts';

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

/**
 * #6779: a subagent's put_page refused `revision_required` names the page's
 * current revision, so the child can merge and resend (or skip) instead of
 * dying with the bare refusal. Subagent tool path only: MCP and CLI callers
 * keep the refusal and its get_page fix unchanged. A failed lookup rethrows
 * the refusal as it was.
 */
export async function rethrowWithCurrentRevision(engine: BrainEngine, sourceId: string, slug: unknown, error: unknown): Promise<never> {
  if (!(error instanceof OperationError) || error.code !== 'revision_required' || typeof slug !== 'string') throw error;
  const revision = await engine.readPageSnapshot(slug.toLowerCase(), { sourceId }).then(s => s?.revision, () => undefined);
  if (revision) {
    error.message = `${error.message} Its current revision is ${revision}: skip the page if it already covers what you would write, or read it with get_page, merge, and resend put_page with expected_revision "${revision}".`;
  }
  throw error;
}
