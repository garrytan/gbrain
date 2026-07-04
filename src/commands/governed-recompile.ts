import { loadConfig, type MBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { OperationError, type Logger } from '../core/operations.ts';
import { createMemoryInboxOperations, DEFAULT_MEMORY_INBOX_SCOPE_ID } from '../core/operations-memory-inbox.ts';

const ACTOR = 'mbrain:dream_cycle';

export function createGovernedRecompileDreamDependency(engine: BrainEngine) {
  const operation = createMemoryInboxOperations({
    defaultScopeId: DEFAULT_MEMORY_INBOX_SCOPE_ID,
    OperationError,
  }).find((entry) => entry.name === 'propose_compile_debt_patches');
  if (!operation) {
    throw new Error('propose_compile_debt_patches operation is unavailable');
  }

  return {
    run: async (input: {
      scope_id: string;
      now: string;
      dry_run: boolean;
      write_candidates: boolean;
      limit?: number;
      signal?: AbortSignal;
    }) => {
      if (input.signal?.aborted) {
        throw new Error('governed recompile aborted before start');
      }
      const apply = input.write_candidates && !input.dry_run;
      const reviewSession = apply
        ? await ensureGovernedRecompileSession(engine, input.scope_id)
        : null;
      const result = await operation.handler({
        engine,
        config: {
          ...(loadConfig() ?? {}),
          maintenance_governed_recompile_enabled: true,
        } as MBrainConfig,
        logger: consoleLogger,
        dryRun: false,
      }, {
        apply,
        scope_id: input.scope_id,
        actor: ACTOR,
        ...(reviewSession ? {
          session_id: reviewSession.sessionId,
          realm_id: reviewSession.realmId,
        } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }) as {
        applied?: boolean;
        proposals?: Array<{ candidate_id?: string; slug?: string }>;
        created?: Array<{ id?: string; patch_target_id?: string }>;
        skipped_existing?: string[];
      };
      const proposals = result.proposals ?? [];
      const created = result.created ?? [];
      const candidateIds = apply
        ? created.map((entry) => entry.id).filter((id): id is string => Boolean(id))
        : proposals.map((entry) => entry.candidate_id).filter((id): id is string => Boolean(id));
      const sourceIds = proposals
        .map((entry) => entry.slug)
        .filter((slug): slug is string => Boolean(slug));

      return {
        counts: {
          pages_with_compile_debt: proposals.length,
          proposed_patch_candidates: apply ? created.length : proposals.length,
          skipped_existing: result.skipped_existing?.length ?? 0,
        },
        source_ids: sourceIds,
        candidate_ids: candidateIds,
        summary_lines: [
          apply
            ? `Staged ${created.length} governed compile-debt patch candidate(s).`
            : `Previewed ${proposals.length} governed compile-debt patch candidate(s).`,
        ],
      };
    },
  };
}

async function ensureGovernedRecompileSession(engine: BrainEngine, scopeId: string) {
  const normalizedScope = scopeId.replace(/[^a-zA-Z0-9:_-]+/g, '-');
  const realmId = `realm:dream-cycle:governed-recompile:${normalizedScope}`;
  const sessionId = `session:dream-cycle:governed-recompile:${normalizedScope}`;
  await engine.upsertMemoryRealm({
    id: realmId,
    name: 'Dream Cycle Governed Recompile',
    scope: 'work',
    default_access: 'read_write',
    description: 'Stages reviewable compile-debt patch candidates from the dream-cycle recompile phase.',
  });
  const existingSession = await engine.getMemorySession(sessionId);
  if (!existingSession) {
    await engine.createMemorySession({
      id: sessionId,
      actor_ref: ACTOR,
    });
  }
  await engine.attachMemoryRealmToSession({
    session_id: sessionId,
    realm_id: realmId,
    access: 'read_write',
    instructions: 'Governed recompile may stage patch candidates but must not write canonical page content directly.',
  });
  return { realmId, sessionId };
}

const consoleLogger: Logger = {
  info: (message) => console.info(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};
