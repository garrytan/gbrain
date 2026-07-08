import type { ErrorCode, Operation } from './operations.ts';
import {
  type DetectProceduralPatternsOptions,
  detectProceduralPatterns,
  proposeProceduralCandidates,
} from './services/procedural-memory-service.ts';

type OperationErrorCtor = new (
  code: ErrorCode,
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const DETECTION_PARAM_DEFS = {
  window_days: {
    type: 'number',
    description: 'Detection window in days (default 30, max 365)',
  },
  min_occurrences: {
    type: 'number',
    description: 'Minimum recurrence threshold before a pattern becomes a proposal (default 3, min 2)',
  },
  limit: {
    type: 'number',
    description: 'Maximum number of rule proposals to emit (default 10, max 50)',
  },
  now: {
    type: 'string',
    description: 'ISO datetime override for a deterministic detection window (default: current time)',
  },
} as const;

export function createProceduralMemoryOperations({
  OperationError,
}: {
  OperationError: OperationErrorCtor;
}): Operation[] {
  function optionalInteger(value: unknown, key: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw new OperationError('invalid_params', `${key} must be an integer.`);
    }
    return value;
  }

  function optionalIsoDatetime(value: unknown, key: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new OperationError('invalid_params', `${key} must be a valid ISO datetime string.`);
    }
    return value;
  }

  function parseDetectionOptions(params: Record<string, unknown>): DetectProceduralPatternsOptions {
    return {
      window_days: optionalInteger(params.window_days, 'window_days'),
      min_occurrences: optionalInteger(params.min_occurrences, 'min_occurrences'),
      limit: optionalInteger(params.limit, 'limit'),
      now: optionalIsoDatetime(params.now, 'now'),
    };
  }

  async function detect(engine: Parameters<typeof detectProceduralPatterns>[0], params: Record<string, unknown>) {
    try {
      return await detectProceduralPatterns(engine, parseDetectionOptions(params));
    } catch (error) {
      if (error instanceof RangeError) {
        throw new OperationError('invalid_params', error.message);
      }
      throw error;
    }
  }

  const detect_procedural_patterns: Operation = {
    name: 'detect_procedural_patterns',
    description: 'Deterministically detect recurring task decisions, failure-to-fix attempt pairs, and repeated episodes, and draft short procedural rule proposals (read-only; no LLM).',
    tier: 'admin',
    params: { ...DETECTION_PARAM_DEFS },
    mutating: false,
    handler: async (ctx, params) => detect(ctx.engine, params),
    cliHints: { name: 'detect-procedural-patterns' },
  };

  const propose_procedural_candidates: Operation = {
    name: 'propose_procedural_candidates',
    description: 'Route detected procedural rule proposals through route_memory_writeback into the Memory Inbox procedure lane. Default apply=false plans only; candidates are never auto-promoted.',
    tier: 'admin',
    params: {
      ...DETECTION_PARAM_DEFS,
      scope_id: {
        type: 'string',
        description: 'Memory candidate scope id for work-derived proposals (default: workspace:default; personal episode proposals always route to personal:default)',
      },
      apply: {
        type: 'boolean',
        description: 'Create procedure candidates through the writeback router (default false: plan only)',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview detection and routing without mutating memory',
      },
    },
    mutating: true,
    handler: async (ctx, params) => {
      if (params.scope_id !== undefined && params.scope_id !== null && typeof params.scope_id !== 'string') {
        throw new OperationError('invalid_params', 'scope_id must be a string.');
      }
      if (params.apply !== undefined && params.apply !== null && typeof params.apply !== 'boolean') {
        throw new OperationError('invalid_params', 'apply must be a boolean.');
      }
      const detection = await detect(ctx.engine, params);
      const apply = params.apply === true && !ctx.dryRun;
      const proposal = await proposeProceduralCandidates(ctx.engine, detection.proposals, {
        apply,
        scope_id: typeof params.scope_id === 'string' ? params.scope_id : undefined,
      });
      return {
        detection,
        proposal,
        applied: apply && proposal.created > 0,
        ...(ctx.dryRun ? { dry_run: true } : {}),
      };
    },
    cliHints: { name: 'propose-procedural-candidates' },
  };

  return [detect_procedural_patterns, propose_procedural_candidates];
}
