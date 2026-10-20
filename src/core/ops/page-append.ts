/**
 * Wave B (spec 6.1): append_page adds text to the end of a page in time proportional to the text added, idempotent by
 * request_id (persistence/page-append.ts). Never import from '../operations.ts' here (cycle).
 */
import type { Operation } from './contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from './context.ts';
import { pageMutationSource } from '../persistence/page-mutations.ts';
import { PAGE_MUTATION_PARAMS, WRITE_WAIT_PARAM } from '../persistence/params.ts';
import { admitPageAppend, APPEND_TEXT_MAX_BYTES, type AppendRegion, type AppendSeparator } from '../persistence/page-append.ts';

const append_page: Operation = {
  name: 'append_page',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Add text to the end of a page, in time proportional to the text: use it for logs and conversations instead of re-putting a large page. '
    + 'request_id is required (a retry never appends twice). Optional expected_revision / expected_tail_sha256 (tail_sha256 from get_page body: \'none\') refuse with revision_changed / tail_changed when the page moved.',
  params: {
    slug: { type: 'string', description: 'Page slug (an existing page).', required: true },
    text: { type: 'string', required: true, description: `Text to add, at most ${APPEND_TEXT_MAX_BYTES} bytes; a larger append uses begin_page_upload mode 'append'.` },
    request_id: { type: 'string', required: true, description: 'A new UUID per append; reuse only to retry.' },
    expected_revision: { type: 'string', description: 'Append only while the page is at this revision.' },
    expected_tail_sha256: { type: 'string', description: "Append only while the region's last 4096 bytes have this sha256 (get_page body: 'none' tail_sha256)." },
    region: { type: 'string', enum: ['auto', 'truth', 'timeline'], description: 'auto (default): the last non-empty region.' },
    separator: { type: 'string', enum: ['auto', 'none'], description: 'auto (default): one newline first when the tail lacks one.' },
    source_id: PAGE_MUTATION_PARAMS.source_id,
    wait_ms: WRITE_WAIT_PARAM,
  },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    pageMutationSource(ctx, p, 'append_page');
    if (ctx.dryRun) {
      if (typeof p.slug === 'string') {
        validatePageSlug(p.slug);
        enforceClientSlugFence(ctx, p.slug, 'append_page');
        enforceSubagentSlugFence(ctx, p.slug, 'append_page');
      }
      return { dry_run: true, action: 'append_page', slug: p.slug };
    }
    const response = await admitPageAppend(ctx, { slug: p.slug as string, text: p.text as string, request_id: p.request_id as string,
      ...(p.source_id !== undefined ? { source_id: p.source_id as string } : {}),
      ...(p.expected_revision !== undefined ? { expected_revision: p.expected_revision as string } : {}),
      ...(p.expected_tail_sha256 !== undefined ? { expected_tail_sha256: p.expected_tail_sha256 as string } : {}),
      ...(p.region !== undefined ? { region: p.region as AppendRegion } : {}),
      ...(p.separator !== undefined ? { separator: p.separator as AppendSeparator } : {}),
      ...(p.wait_ms !== undefined ? { wait_ms: p.wait_ms } : {}) });
    const outcome = (response.outcome ?? {}) as Record<string, unknown>;
    return { slug: outcome.slug ?? p.slug, revision: response.revision, body_bytes: outcome.body_bytes, appended_bytes: outcome.appended_bytes,
      chunks_new: outcome.chunks_new, ...(outcome.size_state !== undefined ? { size_state: outcome.size_state } : {}),
      ...(outcome.rescanned ? { rescanned: true } : {}), ...(outcome.gate ? { gate: outcome.gate } : {}), receipt: response.write_request ?? response };
  },
};

export const pageAppendOperations: Operation[] = [append_page];
