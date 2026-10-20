/**
 * #5616 partial page edit. Never import from '../operations.ts' here (cycle).
 */
import type { Operation } from './contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from './context.ts';
import { pageMutationSource, submitPageMutation } from '../persistence/page-mutations.ts';
import { PAGE_MUTATION_PARAMS, WRITE_REQUEST_PARAM } from '../persistence/params.ts';
import { EDIT_PAGE_MAX_EDITS, parseEditWithin, parsePageEdits } from '../persistence/page-edit.ts';

const edit_page: Operation = {
  name: 'edit_page',
  idempotent: true,
  outputRedaction: { exempt: "the diff is the caller's own authorized view of the page it just edited (the get_page boundary), secret-redacted when created because the receipt retains it" },
  description: 'Change part of a page: prefer this over put_page for small changes. expected_revision: from get_page include_content:true. Each old_text must match exactly once (in `within` if set); applied in order, all or none. Stale revision: revision_conflict.',
  params: {
    slug: { type: 'string', description: 'Page slug.', required: true },
    expected_revision: { type: 'string', required: true, description: 'From get_page include_content:true.' },
    edits: {
      type: 'array', required: true,
      description: `1 to ${EDIT_PAGE_MAX_EDITS} {old_text, new_text} replacements.`,
      items: {
        type: 'object',
        properties: {
          old_text: { type: 'string', required: true, description: 'Exact text to replace.' },
          new_text: { type: 'string', required: true, description: 'Replacement; empty deletes.' },
        },
      },
    },
    within: {
      type: 'object',
      description: "Match only in this stored-body range: edit_target's byte_start/byte_end from a get_page window read.",
      fullSurfaceOnly: true,
      properties: {
        byte_start: { type: 'number', required: true, description: 'First stored byte.' },
        byte_end: { type: 'number', required: true, description: 'End stored byte (exclusive).' },
      },
    },
    source_id: PAGE_MUTATION_PARAMS.source_id,
    request_id: WRITE_REQUEST_PARAM,
  },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    pageMutationSource(ctx, p, 'edit_page');
    parsePageEdits(p.edits);
    parseEditWithin(p.within);
    if (ctx.dryRun) {
      if (typeof p.slug === 'string') {
        validatePageSlug(p.slug);
        enforceClientSlugFence(ctx, p.slug, 'edit_page');
        enforceSubagentSlugFence(ctx, p.slug, 'edit_page');
      }
      return { dry_run: true, action: 'edit_page', slug: p.slug };
    }
    return submitPageMutation(ctx, { operation: 'edit_page', params: p });
  },
};

export const pageEditOperations: Operation[] = [edit_page];
