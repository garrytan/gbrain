/**
 * GBRA-60: a staged put_page, the write of a trusted local patterns child (SubagentHandlerData.stage_writes). It passes
 * every check put_page runs before it is journaled (preparePageAdmission: reserved fields, page size, slug grammar, the
 * client and subagent slug fences, the source grant, publication permission, timeline preservation) and the page write
 * gate at the tier the door would give it, but nothing is journaled: the page lives only in the job's tool-execution
 * ledger (`subagent_tool_executions.input`) until the phase that submitted the job publishes it (cycle/patterns.ts), so no
 * row in `pages` and no commit in git exists before that publication. A failed check fails the tool call as put_page
 * would, so the child sees the refusal and a refused page is never staged.
 */
import type { OperationContext } from '../../operations.ts';
import { OperationError } from '../../ops/contract.ts';
import { parseMarkdown } from '../../markdown.ts';
import { loadImportSanityConfig } from '../../import-screen.ts';
import { assessPageForGate, DEFAULT_WRITE_GATE_CONFIG, writeGateApplies, writeGateRejectedError } from '../../write-gate.ts';
import { gateInput } from '../../trust/gate-outcomes.ts';
import { pageGateTrust, pageWriteTrust, storedPageTier } from '../../trust/page-write.ts';
import type { WriteRequest } from '../../persistence/model.ts';

export async function stagePutPage(ctx: OperationContext, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { preparePageAdmission } = await import('../../persistence/page-mutations.ts');
  const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params });
  if (prepared.prior) {
    throw new OperationError('invalid_params', 'A staged page write never replays an admitted request.',
      'Send put_page without request_id; the job stages the page for its phase to publish.');
  }
  const { admission } = prepared;
  const content = typeof admission.intent.content === 'string' ? admission.intent.content : '';
  const parsed = parseMarkdown(content, `${admission.slug}.md`);
  const row = { id: null, operation: 'put_page', authority: admission.authority, intent: admission.intent } as unknown as Pick<WriteRequest, 'id' | 'operation' | 'authority' | 'intent'>;
  const trust = pageGateTrust(row, pageWriteTrust(row, parsed.frontmatter), await storedPageTier(ctx.engine, admission.sourceId, admission.slug));
  const cfg = (await loadImportSanityConfig(ctx.engine)).writeGate ?? DEFAULT_WRITE_GATE_CONFIG;
  if (trust && writeGateApplies(trust.tier, cfg)) {
    const gate = assessPageForGate(parsed, gateInput(trust, null), cfg);
    if (gate.verdict === 'reject') throw writeGateRejectedError(gate);
  }
  // The phase publishes the input's content; a type the active pack does not declare comes back normalized (page-input.ts).
  return { status: 'staged', slug: admission.slug, source_id: admission.sourceId, ...(content !== params.content ? { content } : {}) };
}
