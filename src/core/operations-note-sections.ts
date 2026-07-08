// Note section registry and structural-graph navigation operations.
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './services/note-manifest-service.ts';
import { rebuildNoteSectionEntries } from './services/note-section-service.ts';
import { findStructuralPath, getStructuralNeighbors, type StructuralNodeId } from './services/note-structural-graph-service.ts';

function structuralNodeId(value: string): StructuralNodeId {
  return value as StructuralNodeId;
}

// --- Note sections ---

const get_note_section_entry: Operation = {
  name: 'get_note_section_entry',
  description: 'Get one derived note-section entry by scope and section id.',
  params: {
    section_id: {
      type: 'string',
      required: true,
      description: 'Durable section id.',
    },
    scope_id: {
      type: 'string',
      description: 'Section scope id (default: workspace:default)',
    },
  },
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    const sectionId = String(p.section_id);
    const entry = await ctx.engine.getNoteSectionEntry(scopeId, sectionId);
    if (!entry) {
      throw new OperationError('page_not_found', `Section not found: ${sectionId}`, 'Run section-rebuild for the page, or verify the section id.');
    }
    return entry;
  },
  cliHints: { name: 'section-get', positional: ['section_id'] },
};

const list_note_section_entries: Operation = {
  name: 'list_note_section_entries',
  description: 'List derived note-section entries for structural inspection.',
  params: {
    page_slug: {
      type: 'string',
      required: true,
      description: 'Canonical page slug',
    },
    scope_id: {
      type: 'string',
      description: 'Section scope id (default: workspace:default)',
    },
    limit: { type: 'number', description: 'Max results (default 50)' },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listNoteSectionEntries({
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      page_slug: String(p.page_slug),
      limit: (p.limit as number) ?? 50,
    });
  },
  cliHints: {
    name: 'section-list',
    positional: ['page_slug'],
    aliases: { n: 'limit' },
  },
};

const rebuild_note_sections: Operation = {
  name: 'rebuild_note_sections',
  description: 'Rebuild derived note-section rows from canonical page state.',
  params: {
    page_slug: {
      type: 'string',
      description: 'Optional slug to rebuild a single page',
    },
    scope_id: {
      type: 'string',
      description: 'Section scope id (default: workspace:default)',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    const pageSlug = typeof p.page_slug === 'string' ? p.page_slug : undefined;

    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'rebuild_note_sections',
        scope_id: scopeId,
        page_slug: pageSlug ?? null,
      };
    }

    try {
      const entries = await rebuildNoteSectionEntries(ctx.engine, {
        scope_id: scopeId,
        page_slug: pageSlug,
      });
      return {
        scope_id: scopeId,
        rebuilt: entries.length,
        section_ids: entries.map((entry) => entry.section_id),
      };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Page not found:')) {
        throw new OperationError('page_not_found', error.message, 'Check the slug or omit it to rebuild all section entries.');
      }
      throw error;
    }
  },
  cliHints: { name: 'section-rebuild' },
};

const get_note_structural_neighbors: Operation = {
  name: 'get_note_structural_neighbors',
  description: 'List deterministic structural neighbors for a page or section node.',
  params: {
    node_id: {
      type: 'string',
      required: true,
      description: 'page:<slug> or section:<section_id>',
    },
    scope_id: {
      type: 'string',
      description: 'Structural scope id (default: workspace:default)',
    },
    limit: { type: 'number', description: 'Max results (default 20)' },
  },
  handler: async (ctx, p) => {
    try {
      return await getStructuralNeighbors(ctx.engine, structuralNodeId(String(p.node_id)), {
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        limit: (p.limit as number) ?? 20,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid structural node id:')) {
        throw new OperationError('invalid_params', error.message);
      }
      if (error instanceof Error && error.message.startsWith('Structural node not found:')) {
        throw new OperationError('page_not_found', error.message);
      }
      throw error;
    }
  },
  cliHints: {
    name: 'section-neighbors',
    positional: ['node_id'],
    aliases: { n: 'limit' },
  },
};

const find_note_structural_path: Operation = {
  name: 'find_note_structural_path',
  description: 'Find a bounded deterministic structural path between two nodes.',
  params: {
    from_node_id: {
      type: 'string',
      required: true,
      description: 'Start node id',
    },
    to_node_id: {
      type: 'string',
      required: true,
      description: 'Target node id',
    },
    scope_id: {
      type: 'string',
      description: 'Structural scope id (default: workspace:default)',
    },
    max_depth: { type: 'number', description: 'Maximum hop count (default 6)' },
  },
  handler: async (ctx, p) => {
    try {
      return await findStructuralPath(ctx.engine, structuralNodeId(String(p.from_node_id)), structuralNodeId(String(p.to_node_id)), {
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        max_depth: (p.max_depth as number) ?? 6,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid structural node id:')) {
        throw new OperationError('invalid_params', error.message);
      }
      if (error instanceof Error && error.message.startsWith('Structural node not found:')) {
        throw new OperationError('page_not_found', error.message);
      }
      throw error;
    }
  },
  cliHints: {
    name: 'section-path',
    positional: ['from_node_id', 'to_node_id'],
  },
};

export function createNoteSectionOperations(): Operation[] {
  return [get_note_section_entry, list_note_section_entries, rebuild_note_sections, get_note_structural_neighbors, find_note_structural_path];
}
