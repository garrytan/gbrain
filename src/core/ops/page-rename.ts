import { pageMutationSource, submitPageMutation } from '../persistence/page-mutations.ts';
import { PAGE_MUTATION_PARAMS } from '../persistence/params.ts';
import { opError } from './contract.ts';
import type { Operation } from './contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, validatePageSlug } from './context.ts';

/**
 * rename_page — coordinated, database-canonical page rename. Lives beside
 * ops/pages.ts (which lists it in pagesOperations, the contractual catalog
 * order) and is prepared by persistence/rename-prepare.ts.
 */
export const rename_page: Operation = {
  name: 'rename_page',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: "Rename one live page to a new slug in the same source, in place: the page row keeps its id, so its content, chunks and embeddings, tags, timeline, versions, takes and inbound/outbound graph links stay attached. The same transaction records the old slug as a slug alias (get_page on the old slug redirects and reports resolved_slug; [[old]] links keep resolving) and moves facts keyed to the old slug, fact withdrawals and frontmatter aliases (page_aliases) to the new slug. Textual [[wikilinks]] in other pages' bodies are NOT rewritten; they resolve through the alias. Rows that only store the slug as text (open loops, file records, take proposals) are not moved. Renames one page, not its children: rename each projects/x/* child with its own call. Database-canonical sources only: a source with a working tree (local_path, or sync.repo_path for default) is refused with source_writeback_required, because its file paths are its slugs; rename there with git mv, commit and sync. Read the page revision first and pass expected_revision; retain request_id for replay. Refuses with page_not_found when the page is missing or soft-deleted, slug_conflict when new_slug is held in that source by a live page, a soft-deleted page, or an alias to another page, and revision_conflict when the page changed. The committed receipt reports status renamed, slug (the new slug), renamed_from and the new revision.",
  params: {
    ...PAGE_MUTATION_PARAMS,
    slug: { type: 'string', required: true, description: "Current slug of the page to rename, e.g. 'projects/old-name'." },
    new_slug: { type: 'string', required: true, description: "Slug the page moves to, e.g. 'projects/new-name'. Must be free in the source (no live page, soft-deleted page or alias to another page)." },
    source_id: { type: 'string', description: "Source holding the page (a multi-source brain can hold the same slug in several sources); the rename stays inside it. Defaults to ctx.sourceId. Remote callers may only target their write source — federated read grants do not confer rename access." },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    pageMutationSource(ctx, p, 'rename_page');
    if (ctx.dryRun) {
      for (const slug of [p.slug, p.new_slug]) {
        if (typeof slug !== 'string') throw opError('invalid_params', 'slug and new_slug must be strings.',
          "Pass slug as the page's current slug and new_slug as the slug it moves to, both strings, for example 'projects/old-name' and 'projects/new-name'.");
        validatePageSlug(slug);
        enforceClientSlugFence(ctx, slug, 'rename_page');
        enforceSubagentSlugFence(ctx, slug, 'rename_page');
      }
      return { dry_run: true, action: 'rename_page', slug: p.slug, new_slug: p.new_slug };
    }
    return submitPageMutation(ctx, { operation: 'rename_page', params: p });
  },
  cliHints: { name: 'rename', positional: ['slug', 'new_slug'] },
};
