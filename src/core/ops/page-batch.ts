/** #6007: `put_pages` — the batch write path for remote agents (src/core/persistence/page-batch.ts). */
import type { Operation } from './contract.ts';
import { WRITE_REQUEST_PARAM, WRITE_WAIT_PARAM, PAGE_MUTATION_PARAMS } from '../persistence/params.ts';
import { PAGE_BATCH_MAX_BYTES, PAGE_BATCH_MAX_PAGES, submitPageBatch } from '../persistence/page-batch.ts';
import { pageMutationSource } from '../persistence/page-mutations.ts';

const put_pages: Operation = {
  name: 'put_pages',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: `Write up to ${PAGE_BATCH_MAX_PAGES} complete Markdown pages (${PAGE_BATCH_MAX_BYTES / 1024 / 1024} MB total) in one call; use instead of put_page for more than 3 pages. Each page replaces its whole page, like put_page. Keep one request_id UUID per batch: replaying the identical call never writes twice, and put_pages with ONLY request_id reports progress without resending content. Waits up to wait_ms (default 25000) for commits; follow the returned \`next\`. Needs put_page permission.`,
  params: {
    pages: {
      type: 'array', description: `1-${PAGE_BATCH_MAX_PAGES} pages; omit to read the batch status.`,
      items: {
        type: 'object',
        properties: {
          slug: { type: 'string', required: true, description: 'Page slug.' },
          content: { type: 'string', required: true, description: 'Complete markdown with frontmatter.' },
          expected_revision: { type: 'string', description: 'Revision read; omit to create.' },
          allow_empty: { type: 'boolean', description: 'Allow emptying a non-empty page.' },
          drop_timeline: { type: 'boolean', description: 'Content without a Timeline section deletes its dated entries.' },
        },
      },
    },
    request_id: { ...WRITE_REQUEST_PARAM, required: true, description: 'Batch UUID; reuse it to replay or poll.' },
    source_id: PAGE_MUTATION_PARAMS.source_id,
    wait_ms: { ...WRITE_WAIT_PARAM, description: 'Hold the reply up to this many ms (0-30000, from arrival) for commits. Default 25000. Not part of the write.' },
  },
  mutating: true,
  scope: 'write',
  area: 'pages',
  handler: async (ctx, p) => {
    pageMutationSource(ctx, p, 'put_pages');
    if (ctx.dryRun) return { dry_run: true, action: 'put_pages', pages: Array.isArray(p.pages) ? p.pages.length : 0 };
    return submitPageBatch(ctx, p);
  },
  cliHints: { name: 'put-pages' },
};

export const pageBatchOperations: Operation[] = [put_pages];
