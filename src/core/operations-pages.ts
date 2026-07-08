// Page read/list/delete operations (get_page, explain_page_provenance,
// delete_page, list_pages) plus the get_page projection/windowing helpers.
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { parseNonNegativeIntegerParam, parseOptionalStringParam, parsePositiveIntegerParam } from './operations-shared.ts';
import { buildPageProvenanceView } from './services/page-provenance-service.ts';
import { scalarLength, sliceScalars } from './text-offsets.ts';
import type {
  PageProjection,
} from './types.ts';

// --- Page CRUD ---

const get_page: Operation = {
  name: 'get_page',
  description:
    'Read a specific knowledge page by slug. Use after search or query returns a relevant slug. Pages contain compiled truth (current understanding) and timeline (evidence history).',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    fuzzy: {
      type: 'boolean',
      description: 'Enable fuzzy slug resolution (default: false)',
    },
    content_char_limit: {
      type: 'number',
      description: 'Optional max characters per content field. Use continuation selectors for the rest.',
    },
    compiled_truth_char_start: {
      type: 'number',
      description: 'Optional compiled_truth character offset for paged reads.',
    },
    timeline_char_start: {
      type: 'number',
      description: 'Optional timeline character offset for paged reads.',
    },
    content_hash: {
      type: 'string',
      description: 'Optional page content hash expected by continuation reads. Stale continuations return a structured stale_continuation result.',
    },
    full_content: {
      type: 'boolean',
      description: 'When true, ignore MCP/default content windowing and return full page content.',
    },
  },
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;
    const contentCharLimit = p.full_content === true ? undefined : parsePositiveIntegerParam(p.content_char_limit, 'content_char_limit');
    const compiledTruthCharStart = parseNonNegativeIntegerParam(p.compiled_truth_char_start, 'compiled_truth_char_start') ?? 0;
    const timelineCharStart = parseNonNegativeIntegerParam(p.timeline_char_start, 'timeline_char_start') ?? 0;
    const expectedContentHash = parseOptionalStringParam(p.content_hash, 'content_hash');
    if (expectedContentHash !== undefined && expectedContentHash.trim().length === 0) {
      throw new OperationError('invalid_params', 'content_hash must be a non-empty string');
    }

    if (contentCharLimit !== undefined) {
      let projection = await ctx.engine.getPageProjection(slug, {
        windows: {
          compiled_truth: {
            char_start: compiledTruthCharStart,
            char_limit: contentCharLimit,
          },
          timeline: {
            char_start: timelineCharStart,
            char_limit: contentCharLimit,
          },
        },
      });
      let resolved_slug: string | undefined;

      if (!projection && fuzzy) {
        const candidates = await ctx.engine.resolveSlugs(slug);
        if (candidates.length === 1) {
          projection = await ctx.engine.getPageProjection(candidates[0], {
            windows: {
              compiled_truth: {
                char_start: compiledTruthCharStart,
                char_limit: contentCharLimit,
              },
              timeline: {
                char_start: timelineCharStart,
                char_limit: contentCharLimit,
              },
            },
          });
          resolved_slug = candidates[0];
        } else if (candidates.length > 1) {
          return { error: 'ambiguous_slug', candidates };
        }
      }

      if (!projection) {
        if (expectedContentHash) {
          return staleContinuationResult({
            code: getPageStaleCode(compiledTruthCharStart, timelineCharStart),
            slug,
            requestedSlug: slug,
            resolvedSlug: resolved_slug,
            expectedContentHash,
            actualContentHash: undefined,
          });
        }
        throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug or use fuzzy: true');
      }

      if (expectedContentHash && projection.content_hash !== expectedContentHash) {
        return staleContinuationResult({
          code: getPageStaleCode(compiledTruthCharStart, timelineCharStart),
          slug: projection.slug,
          requestedSlug: slug,
          resolvedSlug: resolved_slug,
          expectedContentHash,
          actualContentHash: projection.content_hash,
        });
      }

      const tags = await ctx.engine.getTags(projection.slug);
      return applyGetPageProjectionWindow({
        projection,
        tags,
        resolvedSlug: resolved_slug,
        contentCharLimit,
        compiledTruthCharStart,
        timelineCharStart,
      });
    }

    let page = await ctx.engine.getPage(slug);
    let resolved_slug: string | undefined;

    if (!page && fuzzy) {
      const candidates = await ctx.engine.resolveSlugs(slug);
      if (candidates.length === 1) {
        page = await ctx.engine.getPage(candidates[0]);
        resolved_slug = candidates[0];
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      if (expectedContentHash) {
        return staleContinuationResult({
          code: getPageStaleCode(compiledTruthCharStart, timelineCharStart),
          slug,
          requestedSlug: slug,
          resolvedSlug: resolved_slug,
          expectedContentHash,
          actualContentHash: undefined,
        });
      }
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug or use fuzzy: true');
    }

    if (expectedContentHash && page.content_hash !== expectedContentHash) {
      return staleContinuationResult({
        code: getPageStaleCode(compiledTruthCharStart, timelineCharStart),
        slug: page.slug,
        requestedSlug: slug,
        resolvedSlug: resolved_slug,
        expectedContentHash,
        actualContentHash: page.content_hash,
      });
    }

    const tags = await ctx.engine.getTags(page.slug);
    return applyGetPageWindow({
      page: { ...page, tags, ...(resolved_slug ? { resolved_slug } : {}) },
      contentCharLimit,
      compiledTruthCharStart,
      timelineCharStart,
    });
  },
  cliHints: { name: 'get', positional: ['slug'] },
};

const explain_page_provenance: Operation = {
  name: 'explain_page_provenance',
  description: 'Explain why a page exists by collecting its citations, version history, ingest log, candidate trail, canonical handoffs, and backlinks.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug or unique slug fragment' },
    limit: { type: 'number', description: 'Max rows per provenance section (default 20)' },
  },
  handler: async (ctx, p) => {
    const slug = String(p.slug ?? '').trim();
    if (!slug) throw new OperationError('invalid_params', 'slug is required.');
    try {
      return await buildPageProvenanceView(ctx.engine, {
        slug,
        limit: parsePositiveIntegerParam(p.limit, 'limit'),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Page not found:')) {
        throw new OperationError('page_not_found', error.message, 'Check the slug or use a more specific slug fragment');
      }
      throw error;
    }
  },
  cliHints: { name: 'why', positional: ['slug'], aliases: { n: 'limit' } },
};

function getPageStaleCode(compiledTruthCharStart: number, timelineCharStart: number): 'stale_selector' | 'stale_continuation' {
  return compiledTruthCharStart > 0 || timelineCharStart > 0 ? 'stale_continuation' : 'stale_selector';
}

function staleContinuationResult(input: {
  code: 'stale_selector' | 'stale_continuation';
  slug: string;
  requestedSlug: string;
  resolvedSlug?: string;
  expectedContentHash: string;
  actualContentHash?: string;
}) {
  const warning = {
    code: input.code,
    severity: 'warning',
    slug: input.slug,
    expected_content_hash: input.expectedContentHash,
    current_content_hash: input.actualContentHash ?? null,
    message: 'The page changed after this content_hash was issued. Start a fresh get_page/read_context window from the current content_hash.',
  };
  return {
    status: 'stale',
    error: input.code,
    warning,
    slug: input.slug,
    ...(input.resolvedSlug ? { resolved_slug: input.resolvedSlug } : {}),
    ...(input.requestedSlug !== input.slug ? { requested_slug: input.requestedSlug } : {}),
    expected_content_hash: input.expectedContentHash,
    actual_content_hash: input.actualContentHash ?? null,
    hint: 'The page changed after this continuation selector was issued. Start a new get_page/read_context window from the current content_hash.',
  };
}

function applyGetPageProjectionWindow(input: {
  projection: PageProjection;
  tags: string[];
  resolvedSlug?: string;
  contentCharLimit: number;
  compiledTruthCharStart: number;
  timelineCharStart: number;
}) {
  const { projection, tags, resolvedSlug, contentCharLimit, compiledTruthCharStart, timelineCharStart } = input;
  const compiledTruthWindow = contentWindowForProjectionField({
    slug: projection.slug,
    kind: 'compiled_truth',
    contentHash: projection.content_hash,
    window: projection.content_windows.compiled_truth,
  });
  const timelineWindow = contentWindowForProjectionField({
    slug: projection.slug,
    kind: 'timeline_range',
    contentHash: projection.content_hash,
    window: projection.content_windows.timeline,
  });

  return {
    id: projection.id,
    slug: projection.slug,
    type: projection.type,
    title: projection.title,
    compiled_truth: compiledTruthWindow.text,
    timeline: timelineWindow.text,
    frontmatter: projection.frontmatter,
    content_hash: projection.content_hash,
    created_at: projection.created_at,
    updated_at: projection.updated_at,
    tags,
    ...(resolvedSlug ? { resolved_slug: resolvedSlug } : {}),
    content_window: {
      truncated: compiledTruthWindow.has_more || timelineWindow.has_more || compiledTruthCharStart > 0 || timelineCharStart > 0,
      char_limit: contentCharLimit,
      compiled_truth: compiledTruthWindow,
      timeline: timelineWindow,
    },
  };
}

function applyGetPageWindow(input: { page: Record<string, any>; contentCharLimit?: number; compiledTruthCharStart: number; timelineCharStart: number }) {
  const { page, contentCharLimit, compiledTruthCharStart, timelineCharStart } = input;
  if (contentCharLimit === undefined) return page;

  const compiledTruth = page.compiled_truth ?? '';
  const timeline = page.timeline ?? '';
  const compiledTruthWindow = contentWindowForField({
    slug: page.slug,
    kind: 'compiled_truth',
    text: compiledTruth,
    charStart: compiledTruthCharStart,
    charLimit: contentCharLimit,
    contentHash: page.content_hash,
  });
  const timelineWindow = contentWindowForField({
    slug: page.slug,
    kind: 'timeline_range',
    text: timeline,
    charStart: timelineCharStart,
    charLimit: contentCharLimit,
    contentHash: page.content_hash,
  });

  return {
    ...page,
    compiled_truth: compiledTruthWindow.text,
    timeline: timelineWindow.text,
    content_window: {
      truncated: compiledTruthWindow.has_more || timelineWindow.has_more || compiledTruthCharStart > 0 || timelineCharStart > 0,
      char_limit: contentCharLimit,
      compiled_truth: compiledTruthWindow,
      timeline: timelineWindow,
    },
  };
}

function contentWindowForProjectionField(input: {
  slug: string;
  kind: 'compiled_truth' | 'timeline_range';
  contentHash?: string;
  window?: PageProjection['content_windows']['compiled_truth'];
}) {
  const window = input.window ?? {
    text: '',
    char_start: 0,
    returned_chars: 0,
    total_chars: 0,
    next_char_start: null,
    has_more: false,
  };
  return {
    text: window.text,
    char_start: window.char_start,
    returned_chars: window.returned_chars,
    total_chars: window.total_chars,
    has_more: window.has_more,
    ...(window.has_more
      ? {
          continuation_selector: {
            kind: input.kind,
            slug: input.slug,
            char_start: window.next_char_start ?? window.char_start + window.returned_chars,
            ...(input.contentHash ? { content_hash: input.contentHash } : {}),
          },
        }
      : {}),
  };
}

function contentWindowForField(input: {
  slug: string;
  kind: 'compiled_truth' | 'timeline_range';
  text: string;
  charStart: number;
  charLimit: number;
  contentHash?: string;
}) {
  const totalChars = scalarLength(input.text);
  const start = Math.min(input.charStart, totalChars);
  const end = Math.min(start + input.charLimit, totalChars);
  const text = sliceScalars(input.text, start, end);
  const returnedChars = scalarLength(text);
  const hasMore = end < totalChars;
  return {
    text,
    char_start: start,
    returned_chars: returnedChars,
    total_chars: totalChars,
    has_more: hasMore,
    ...(hasMore
      ? {
          continuation_selector: {
            kind: input.kind,
            slug: input.slug,
            char_start: end,
            ...(input.contentHash ? { content_hash: input.contentHash } : {}),
          },
        }
      : {}),
  };
}

const delete_page: Operation = {
  name: 'delete_page',
  description: 'Delete a page',
  params: {
    slug: { type: 'string', required: true },
  },
  mutating: true,
  tier: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'delete_page', slug: p.slug };
    await ctx.engine.deletePage(p.slug as string);
    return { status: 'deleted' };
  },
  cliHints: { name: 'delete', positional: ['slug'] },
};

const list_pages: Operation = {
  name: 'list_pages',
  description: 'List pages with optional filters',
  params: {
    type: { type: 'string', description: 'Filter by page type' },
    tag: { type: 'string', description: 'Filter by tag' },
    limit: { type: 'number', description: 'Max results (default 50)' },
  },
  handler: async (ctx, p) => {
    const pages = await ctx.engine.listPages({
      type: p.type as any,
      tag: p.tag as string,
      limit: (p.limit as number) ?? 50,
    });
    return pages.map((pg) => ({
      slug: pg.slug,
      type: pg.type,
      title: pg.title,
      updated_at: pg.updated_at,
    }));
  },
  cliHints: { name: 'list', aliases: { n: 'limit' } },
};

export function createPageOperations(): Operation[] {
  return [get_page, explain_page_provenance, delete_page, list_pages];
}
