/**
 * Sync operation cluster — pure move from operations.ts (v0.46.x tranche 2).
 * Op consts stay module-private; `syncStatusOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { opError } from './contract.ts';
import { opTransport, readFix } from './op-fix.ts';

/** `gbrain sync --source <id>` on the CLI, `source_id: "<id>"` over MCP. */
function sourceRef(ctx: OperationContext, id: string): string {
  return opTransport(ctx) === 'cli' ? `--source ${id}` : `source_id: "${id}"`;
}

const LIST_SOURCES = readFix('Lists the registered, active source ids sync can target.', {
  argv: ['gbrain', 'sources', 'list'], mcp: { tool: 'sources_list', arguments: {} },
});

// --- Sync ---

const sync_brain: Operation = {
  name: 'sync_brain',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Pull and import changes from a source\'s git repository (incremental; dry_run previews). Use when files changed on disk or upstream. Needs admin scope and the local stdio server. On a missing local_path: the error names the sources add command.',
  params: {
    repo: { type: 'string', description: 'Path to git repo (optional if configured)' },
    source_id: { type: 'string', description: 'Explicit source to sync (wins over repo-derived and ambient routing)' },
    dry_run: { type: 'boolean', description: 'Preview changes without applying' },
    full: { type: 'boolean', description: 'Full re-sync (ignore checkpoint)' },
    no_pull: { type: 'boolean', description: 'Skip git pull' },
    no_embed: { type: 'boolean', description: 'Skip embedding generation' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    const { performSync } = await import('../../commands/sync.ts');
    // #3765 routing precedence: explicit source_id param > repo-derived source
    // (dotfile / registered local_path anchored at the REPO dir, #3765) >
    // ctx.sourceId (#2830 ambient thread). Pre-fix, a `repo` pointing at
    // source B's checkout synced under the CALLER's source: wrong anchor,
    // wrong page source_id, wrong `syncLockId(sourceId)` lock key.
    let sourceId = ctx.sourceId;
    const explicit = p.source_id as string | undefined;
    const repo = p.repo as string | undefined;
    if (explicit) {
      const { resolveSourceId, SourceTargetError, ALL_SOURCES } = await import('../source-resolver.ts');
      if (explicit === ALL_SOURCES) {
        throw opError(
          'invalid_params',
          `sync_brain targets exactly one source; '${ALL_SOURCES}' is not valid here.`,
          `Pass one registered source id (for example ${sourceRef(ctx, 'default')}); run it once per source to sync several.`,
          { fix: LIST_SOURCES },
        );
      }
      try {
        // Explicit tier of the canonical resolver: regex-validates AND asserts
        // the source exists + is not archived (no dead-FK writes).
        sourceId = await resolveSourceId(ctx.engine, explicit);
      } catch (e) {
        if (e instanceof SourceTargetError) {
          throw opError('invalid_params', e.message, 'Pick a registered, active source id (fix lists them) and pass it explicitly.', { fix: LIST_SOURCES });
        }
        throw e;
      }
    } else if (repo) {
      const { resolveSourceForRepoPath, SourceTargetError } = await import('../source-resolver.ts');
      let derived: Awaited<ReturnType<typeof resolveSourceForRepoPath>> = null;
      try {
        derived = await resolveSourceForRepoPath(ctx.engine, repo);
      } catch (e) {
        if (e instanceof SourceTargetError) {
          throw opError('invalid_params', e.message, 'Pick a registered, active source id (fix lists them) and pass it explicitly.', { fix: LIST_SOURCES });
        }
        throw e;
      }
      if (derived) {
        // Conflict guard: the caller is PINNED to a non-default source (MCP
        // scope / dotfile context) but `repo` belongs to a different one.
        // Refuse with a structured error instead of silently picking a side.
        if (ctx.sourceId && ctx.sourceId !== 'default' && ctx.sourceId !== derived.source_id) {
          throw opError(
            'invalid_params',
            `repo path resolves to source '${derived.source_id}' (via ${derived.tier}) but the ` +
            `caller is scoped to source '${ctx.sourceId}'. Pass source_id explicitly to pick one.`,
            `Re-run with ${sourceRef(ctx, derived.source_id)} to sync that repo's source, or ` +
            `${sourceRef(ctx, ctx.sourceId)} to force the caller's scope.`,
          );
        }
        sourceId = derived.source_id;
      }
    }
    const sourceOpts = sourceId ? { sourceId } : {};
    return performSync(ctx.engine, {
      repoPath: repo,
      dryRun: ctx.dryRun || (p.dry_run as boolean) || false,
      noEmbed: (p.no_embed as boolean) || false,
      noPull: (p.no_pull as boolean) || false,
      full: (p.full as boolean) || false,
      ...sourceOpts,
    });
  },
  cliHints: { name: 'sync', hidden: true },
};


// Ops in EXACTLY the canonical `operations` array order.
export const syncStatusOperations: Operation[] = [sync_brain];
