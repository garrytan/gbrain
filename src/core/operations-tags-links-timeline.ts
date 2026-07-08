// Tag, link, backlink, graph-traversal, and timeline operations.
import { canonicalDerivedTags, DERIVED_SCHEMA_VERSION } from './derived-jobs.ts';
import type { BrainEngine } from './engine.ts';
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID, NOTE_MANIFEST_EXTRACTOR_VERSION } from './services/note-manifest-service.ts';
import { validateSlug } from './utils.ts';

// --- Tags ---

async function mutateTagAndEnqueueManifestRefresh(
  engine: BrainEngine,
  slug: string,
  tag: string,
  mutate: (tx: BrainEngine, slug: string, tag: string) => Promise<void>,
): Promise<void> {
  const normalizedSlug = validateSlug(slug);
  await engine.transaction(async (tx) => {
    const page = await tx.getPageForUpdate(normalizedSlug);
    if (!page) return;

    await mutate(tx, normalizedSlug, tag);
    if (!page.content_hash) return;
    const tags = await tx.getTags(normalizedSlug);
    const existingManifest = await tx.getNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, normalizedSlug);
    const manifestPath = existingManifest?.path ?? `${normalizedSlug}.md`;
    await tx.deleteNoteManifestEntry(DEFAULT_NOTE_MANIFEST_SCOPE_ID, normalizedSlug);
    await tx.enqueueDerivedJob({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      slug: normalizedSlug,
      artifact_kind: 'note_manifest',
      target_content_hash: page.content_hash,
      manifest_path: manifestPath,
      derived_parameters: {
        manifest_path: manifestPath,
        tags: canonicalDerivedTags(tags),
        extractor_version: NOTE_MANIFEST_EXTRACTOR_VERSION,
        derived_schema_version: DERIVED_SCHEMA_VERSION,
      },
    });
  });
}

const add_tag: Operation = {
  name: 'add_tag',
  description: 'Add tag to page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_tag', slug: p.slug, tag: p.tag };
    await mutateTagAndEnqueueManifestRefresh(ctx.engine, p.slug as string, p.tag as string, (tx, slug, tag) => tx.addTag(slug, tag));
    return { status: 'ok', derived_storage: 'scheduled' };
  },
  cliHints: { name: 'tag', positional: ['slug', 'tag'] },
};

const remove_tag: Operation = {
  name: 'remove_tag',
  description: 'Remove tag from page',
  params: {
    slug: { type: 'string', required: true },
    tag: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_tag', slug: p.slug, tag: p.tag };
    await mutateTagAndEnqueueManifestRefresh(ctx.engine, p.slug as string, p.tag as string, (tx, slug, tag) => tx.removeTag(slug, tag));
    return { status: 'ok', derived_storage: 'scheduled' };
  },
  cliHints: { name: 'untag', positional: ['slug', 'tag'] },
};

const get_tags: Operation = {
  name: 'get_tags',
  description: 'List tags for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getTags(p.slug as string);
  },
  cliHints: { name: 'tags', positional: ['slug'] },
};

// --- Links ---

const add_link: Operation = {
  name: 'add_link',
  description:
    'Create a typed link between two pages in the knowledge graph. Use to connect entities and technical concepts: people/companies (invested_in, works_at, founded), or systems/concepts (implements, depends_on, extends, contradicts, layer_of, prerequisite_for). Links are bidirectional in traversal and power cross-system navigation.',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    link_type: {
      type: 'string',
      description:
        'Link type. People/deal: invested_in, works_at, founded, mentioned_in. Technical: implements, depends_on, extends, contradicts, layer_of, prerequisite_for. Free-text; no allowlist enforced.',
    },
    context: { type: 'string', description: 'Context for the link' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_link', from: p.from, to: p.to };
    await ctx.engine.addLink(p.from as string, p.to as string, (p.context as string) || '', (p.link_type as string) || '');
    return { status: 'ok' };
  },
  cliHints: { name: 'link', positional: ['from', 'to'] },
};

const remove_link: Operation = {
  name: 'remove_link',
  description: 'Remove link between pages',
  params: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'remove_link', from: p.from, to: p.to };
    await ctx.engine.removeLink(p.from as string, p.to as string);
    return { status: 'ok' };
  },
  cliHints: { name: 'unlink', positional: ['from', 'to'] },
};

const get_links: Operation = {
  name: 'get_links',
  description: 'List outgoing links from a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getLinks(p.slug as string);
  },
};

const get_backlinks: Operation = {
  name: 'get_backlinks',
  description: 'List incoming links to a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getBacklinks(p.slug as string);
  },
  cliHints: { name: 'backlinks', positional: ['slug'] },
};

const traverse_graph: Operation = {
  name: 'traverse_graph',
  description: 'Traverse link graph from a page',
  params: {
    slug: { type: 'string', required: true },
    depth: { type: 'number', description: 'Max traversal depth (default 5)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.traverseGraph(p.slug as string, (p.depth as number) ?? 5);
  },
  cliHints: { name: 'graph', positional: ['slug'] },
};

// --- Timeline ---

const add_timeline_entry: Operation = {
  name: 'add_timeline_entry',
  description: 'Add timeline entry to a page',
  params: {
    slug: { type: 'string', required: true },
    date: { type: 'string', required: true },
    summary: { type: 'string', required: true },
    detail: { type: 'string' },
    source: { type: 'string' },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'add_timeline_entry', slug: p.slug };
    const slug = p.slug as string;
    const existing = await ctx.engine.getPage(slug);
    if (!existing) {
      throw new OperationError('page_not_found', `Page not found for timeline entry: ${slug}`, 'Create the page before appending timeline evidence.');
    }
    await ctx.engine.addTimelineEntry(slug, {
      date: p.date as string,
      source: (p.source as string) || '',
      summary: p.summary as string,
      detail: (p.detail as string) || '',
    });
    return { status: 'ok' };
  },
  cliHints: { name: 'timeline-add', positional: ['slug', 'date', 'summary'] },
};

const get_timeline: Operation = {
  name: 'get_timeline',
  description: 'Get timeline entries for a page',
  params: {
    slug: { type: 'string', required: true },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getTimeline(p.slug as string);
  },
  cliHints: { name: 'timeline', positional: ['slug'] },
};

export function createTagsLinksTimelineOperations(): Operation[] {
  return [add_tag, remove_tag, get_tags, add_link, remove_link, get_links, get_backlinks, traverse_graph, add_timeline_entry, get_timeline];
}
