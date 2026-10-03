import { pageMutationSource, submitPageMutation } from '../persistence/page-mutations.ts';
import { PAGE_MUTATION_PARAMS } from '../persistence/params.ts';
import { OperationError } from './contract.ts';
import type { Operation } from './contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from './context.ts';
import { pagesOperations } from './pages.ts';

/**
 * #5616: a partial page edit. put_page replaces the whole page, so an MCP
 * client that changes one line of a large page has to emit the whole page
 * verbatim as a tool argument (tens of thousands of output tokens for a 60 KB
 * page, and every re-transcription is a chance to alter text the edit never
 * meant to touch). edit_page takes exact-string replacements against the
 * canonical `content` that get_page returns (include_content: true), applies
 * them server-side in order under expected_revision, and submits the result
 * through the put_page path with the same ctx, so it inherits every guard
 * (slug fences, revision check, protected fences, receipts, the coordinator,
 * write-through) rather than adding a writer. Each old_string must occur
 * exactly once in the current content: zero or several matches refuse the
 * whole call naming the edit, the contract LLM editors already use.
 */
const EDIT_PAGE_MAX_EDITS = 50;

export function applyPageEdits(content: string, edits: Array<{ old_string: string; new_string: string }>): string {
  let out = content;
  edits.forEach((edit, i) => {
    const n = out.split(edit.old_string).length - 1;
    const shown = JSON.stringify(edit.old_string.length > 80 ? edit.old_string.slice(0, 77) + '…' : edit.old_string);
    if (n === 0) {
      throw new OperationError('edit_not_found', `edits[${i}]: old_string not found in the current content: ${shown}`,
        'Read the page again with get_page include_content: true and copy the text exactly; earlier edits in the same call may have changed it.');
    }
    if (n > 1) {
      throw new OperationError('edit_ambiguous', `edits[${i}]: old_string occurs ${n} times in the current content: ${shown}`,
        'Include enough surrounding text to make the match unique.');
    }
    out = out.replace(edit.old_string, () => edit.new_string);
  });
  return out;
}

function parseEdits(raw: unknown): Array<{ old_string: string; new_string: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OperationError('invalid_params', 'edits must be a non-empty array of { old_string, new_string }.');
  }
  if (raw.length > EDIT_PAGE_MAX_EDITS) {
    throw new OperationError('invalid_params', `edits holds ${raw.length} entries; the limit is ${EDIT_PAGE_MAX_EDITS}. Use put_page for a rewrite.`);
  }
  return raw.map((e, i) => {
    const edit = e as Record<string, unknown>;
    if (!edit || typeof edit !== 'object' || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string') {
      throw new OperationError('invalid_params', `edits[${i}] must be an object with string old_string and new_string.`);
    }
    if (edit.old_string.length === 0) throw new OperationError('invalid_params', `edits[${i}].old_string must not be empty.`);
    return { old_string: edit.old_string, new_string: edit.new_string };
  });
}

const edit_page: Operation = {
  name: 'edit_page',
  outputRedaction: 'no_stored_text',
  description: 'Change parts of a page without re-sending it: exact-string replacements applied server-side to the canonical `content` get_page returns (include_content: true), in order, each old_string matching exactly once, then written through the put_page path under expected_revision (required; the revision from the read). Zero or several matches refuse the whole call naming the edit; a revision that moved refuses with revision_conflict; nothing is written in either case. Returns what put_page returns, plus edits_applied. Everything put_page guards and preserves applies here too (slug fences, protected facts/takes fences, receipts, write-through). For a rewrite, or to create a page, use put_page.',
  params: {
    ...PAGE_MUTATION_PARAMS,
    slug: { type: 'string', required: true, description: 'Page slug' },
    edits: {
      type: 'array', required: true,
      description: `Ordered list of { old_string, new_string } (1–${EDIT_PAGE_MAX_EDITS}). old_string is copied verbatim from the current content and must occur exactly once; new_string replaces it (empty deletes it). Later edits see the result of earlier ones.`,
      items: { type: 'object', description: '{ old_string, new_string }' },
    },
  },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    pageMutationSource(ctx, p, 'edit_page');
    const slug = p.slug as string;
    const edits = parseEdits(p.edits);
    if (p.force === true) {
      throw new OperationError('invalid_params', 'edit_page has no force: it edits the revision you read. Pass expected_revision, or use put_page to overwrite.');
    }
    if (typeof p.expected_revision !== 'string' || p.expected_revision.length === 0) {
      throw new OperationError('invalid_params', 'expected_revision is required: the revision returned by the get_page read the edits were made against.');
    }
    if (ctx.dryRun) {
      validatePageSlug(slug);
      enforceClientSlugFence(ctx, slug, 'edit_page');
      enforceSubagentSlugFence(ctx, slug, 'edit_page');
      return { dry_run: true, action: 'edit_page', slug, edits: edits.length };
    }
    // The same read a client makes before editing (source scope, private-page
    // gate, the remote reader's fence strip), so the edits apply to the text
    // the client saw; put_page then puts the protected fences back.
    const get_page = pagesOperations.find((o) => o.name === 'get_page')!;
    const current = await get_page.handler(ctx, { slug, include_content: true, content_only: true, ...(p.source_id !== undefined ? { source_id: p.source_id } : {}) }) as Record<string, unknown>;
    if (typeof current.content !== 'string' || typeof current.revision !== 'string') {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'edit_page changes an existing page; use put_page to create one.');
    }
    if (current.revision !== p.expected_revision) {
      throw new OperationError('revision_conflict', `The page has moved on: expected_revision ${String(p.expected_revision).slice(0, 8)} is not the current revision ${current.revision.slice(0, 8)}.`,
        'Read the page again with get_page include_content: true and make the edits against that revision.');
    }
    const content = applyPageEdits(current.content, edits);
    if (content === current.content) {
      throw new OperationError('no_change', 'The edits leave the content as it is; nothing was written.');
    }
    const { edits: _edits, ...rest } = p;
    const result = await submitPageMutation(ctx, { operation: 'put_page', params: { ...rest, slug: current.slug ?? slug, content } });
    return typeof result === 'object' && result !== null ? { ...(result as Record<string, unknown>), edits_applied: edits.length } : result;
  },
  cliHints: { name: 'edit-page', positional: ['slug'], hidden: true },
};

export const editPageOperations: Operation[] = [edit_page];
