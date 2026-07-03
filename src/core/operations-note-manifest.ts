import type { Operation, ErrorCode } from './operations.ts';
import {
  DEFAULT_NOTE_MANIFEST_SCOPE_ID,
  rebuildNoteManifestEntries,
} from './services/note-manifest-service.ts';

type OperationErrorCtor = new (
  code: ErrorCode,
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

export function createNoteManifestOperations({
  OperationError,
}: {
  OperationError: OperationErrorCtor;
}): Operation[] {
  const get_note_manifest_entry: Operation = {
    name: 'get_note_manifest_entry',
    description: 'Read one derived note-manifest entry by slug for structural inspection.',
    params: {
      slug: {
        type: 'string',
        required: true,
        description: 'Canonical page slug',
      },
      scope_id: {
        type: 'string',
        description: 'Manifest scope id (default: workspace:default)',
      },
    },
    handler: async (ctx, p) => {
      const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
      const entry = await ctx.engine.getNoteManifestEntry(scopeId, String(p.slug));
      if (!entry) {
        throw new OperationError(
          'page_not_found',
          `Note manifest entry not found: ${String(p.slug)}`,
          'Run manifest-rebuild for the slug, or verify the page exists.',
        );
      }
      return entry;
    },
    cliHints: { name: 'manifest-get', positional: ['slug'] },
  };

  const list_note_manifest_entries: Operation = {
    name: 'list_note_manifest_entries',
    description: 'List derived note-manifest entries for structural inspection.',
    params: {
      scope_id: {
        type: 'string',
        description: 'Manifest scope id (default: workspace:default)',
      },
      slug: { type: 'string', description: 'Filter to a single slug' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    handler: async (ctx, p) => {
      return ctx.engine.listNoteManifestEntries({
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        slug: p.slug as string | undefined,
        limit: (p.limit as number) ?? 20,
      });
    },
    cliHints: { name: 'manifest-list', aliases: { n: 'limit' } },
  };

  const rebuild_note_manifest: Operation = {
    name: 'rebuild_note_manifest',
    description: 'Rebuild derived note-manifest entries from canonical page state.',
    params: {
      slug: {
        type: 'string',
        description: 'Optional slug to rebuild a single entry',
      },
      scope_id: {
        type: 'string',
        description: 'Manifest scope id (default: workspace:default)',
      },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const scopeId = String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
      const slug = p.slug as string | undefined;

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'rebuild_note_manifest',
          scope_id: scopeId,
          slug: slug ?? null,
        };
      }

      try {
        const entries = await rebuildNoteManifestEntries(ctx.engine, {
          scope_id: scopeId,
          slug,
        });
        return {
          scope_id: scopeId,
          rebuilt: entries.length,
          slugs: entries.map((entry) => entry.slug),
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Page not found:')) {
          throw new OperationError('page_not_found', error.message, 'Check the slug or omit it to rebuild all entries.');
        }
        throw error;
      }
    },
    cliHints: { name: 'manifest-rebuild' },
  };

  return [
    get_note_manifest_entry,
    list_note_manifest_entries,
    rebuild_note_manifest,
  ];
}
