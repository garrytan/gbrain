/**
 * #5616 partial page edit. Never import from '../operations.ts' here (cycle).
 */
import type { Operation } from './contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from './context.ts';
import { pageMutationSource, submitPageMutation } from '../persistence/page-mutations.ts';
import { PAGE_MUTATION_PARAMS, WRITE_REQUEST_PARAM } from '../persistence/params.ts';
import { EDIT_PAGE_MAX_EDITS, parsePageEdits } from '../persistence/page-edit.ts';

const edit_page: Operation = {
  name: 'edit_page',
  idempotent: true,
  outputRedaction: { exempt: "the diff is the caller's own authorized view of the page it just edited (the get_page boundary), secret-redacted when created because the receipt retains it" },
  description: 'Change part of an existing page without resending it: prefer this over put_page for small changes to large pages. Read get_page with include_content:true and pass its revision as expected_revision. Each edit replaces old_text with new_text; edits apply in order, each to the text the previous edit produced, and each old_text must match exactly once in that content. Protected takes and facts sections never match (use the takes_* operations or remember/forget). All edits publish together or none do, through the same receipts, fences and write-through as put_page. Returns the new revision and a unified diff of your view (at most 8 KB). Refusals name the edit: edit_no_match, edit_ambiguous_match (with match_count), edit_protected_span, edit_invalid; a stale revision returns revision_conflict with current_revision. Retain request_id and repeat identical arguments after a pending receipt.',
  params: {
    slug: { type: 'string', required: true, description: 'Slug of the existing page to edit.' },
    expected_revision: { type: 'string', required: true, description: 'The `revision` from get_page include_content:true. The edit is refused if the page changed since.' },
    edits: {
      type: 'array', required: true,
      description: `1 to ${EDIT_PAGE_MAX_EDITS} replacements, applied in order and all or nothing.`,
      items: {
        type: 'object',
        properties: {
          old_text: { type: 'string', required: true, description: 'Exact existing text (including whitespace) to replace; must occur exactly once in the current content.' },
          new_text: { type: 'string', required: true, description: 'Replacement text; empty deletes old_text.' },
        },
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
