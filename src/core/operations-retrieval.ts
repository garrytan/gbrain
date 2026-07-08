// Retrieval routing, context read, scenario planning, code-claim
// verification, and workspace card operations.
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import {
  parseEnumParam,
  parseOptionalStringParam,
  parsePositiveIntegerParam,
  parseRequestedScopeParam,
  requestedScopeParam,
} from './operations-shared.ts';
import {
  CONTEXT_READ_MODES,
  includeTimelineParam,
  MEMORY_SCENARIO_SOURCE_KINDS,
  MEMORY_SCENARIOS,
  parseActivationArtifacts,
  parseCodeClaimsParam,
  parseIncludeTimelineParam,
  parseKnownSubjectsParam,
  parseReadContextProbeContextParam,
  parseRetrievalSelectors,
  parseRetrieveContextGraphFrontierParam,
  PERSONAL_EPISODE_SOURCE_KINDS,
  PERSONAL_ROUTE_KINDS,
  PROFILE_MEMORY_TYPES,
  RETRIEVAL_ROUTE_INTENTS,
  withSelectorParamErrors,
} from './operations-retrieval-params.ts';
import { getBroadSynthesisRoute } from './services/broad-synthesis-route-service.ts';
import { extractCodeClaimsFromTrace, verifyCodeClaims } from './services/code-claim-verification-service.ts';
import { selectActivationPolicy } from './services/memory-activation-policy-service.ts';
import { classifyMemoryScenario } from './services/memory-scenario-classifier-service.ts';
import { getMixedScopeBridge } from './services/mixed-scope-bridge-service.ts';
import { getMixedScopeDisclosure } from './services/mixed-scope-disclosure-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './services/note-manifest-service.ts';
import { DEFAULT_PERSONAL_EPISODE_SCOPE_ID, getPersonalEpisodeLookupRoute } from './services/personal-episode-lookup-route-service.ts';
import { previewPersonalExport } from './services/personal-export-visibility-service.ts';
import { DEFAULT_PROFILE_MEMORY_SCOPE_ID, getPersonalProfileLookupRoute } from './services/personal-profile-lookup-route-service.ts';
import { selectPersonalWriteTarget } from './services/personal-write-target-service.ts';
import { getPrecisionLookupRoute } from './services/precision-lookup-route-service.ts';
import {
  createProductionBroadSynthesisRouteDependencies,
  createProductionRetrievalRouteDependencies,
  createProductionRetrieveContextDependencies,
} from './services/production-retrieval-dependencies-service.ts';
import { runProofAgentMemory } from './services/proof-agent-service.ts';
import { readContext } from './services/read-context-service.ts';
import { planRetrievalRequest } from './services/retrieval-request-planner-service.ts';
import { selectRetrievalRoute } from './services/retrieval-route-selector-service.ts';
import { retrieveContext } from './services/retrieve-context-service.ts';
import { planScenarioMemoryRequest } from './services/scenario-memory-request-planner-service.ts';
import { evaluateScopeGate } from './services/scope-gate-service.ts';
import { getWorkspaceCorpusCard } from './services/workspace-corpus-card-service.ts';
import { getWorkspaceOrientationBundle } from './services/workspace-orientation-bundle-service.ts';
import { getWorkspaceProjectCard } from './services/workspace-project-card-service.ts';
import { getWorkspaceSystemCard } from './services/workspace-system-card-service.ts';
import type {
  RetrievalRequestPlannerInput,
  RetrievalTrace,
} from './types.ts';

// O4/N-1 retrieval-navigation consolidation: the standalone route resolvers, scenario
// planners, and workspace cards below duplicate routing that select_retrieval_route and
// retrieve_context already provide, so they are demoted to the admin tier with one-line
// descriptions naming the supported replacement. They stay fully callable (CLI, tier=all).
const get_broad_synthesis_route: Operation = {
  name: 'get_broad_synthesis_route',
  description: 'Admin diagnostic; use select_retrieval_route intent=broad_synthesis.',
  tier: 'admin',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
    query: {
      type: 'string',
      required: true,
      description: 'Plain-text route query string',
    },
    limit: {
      type: 'number',
      description: 'Max matched nodes to inspect while composing the route (default 5)',
    },
  },
  handler: async (ctx, p) => {
    return getBroadSynthesisRoute(
      ctx.engine,
      {
        map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        kind: p.kind as string | undefined,
        query: String(p.query),
        limit: typeof p.limit === 'number' ? p.limit : undefined,
      },
      createProductionBroadSynthesisRouteDependencies(ctx.engine, ctx.config),
    );
  },
  cliHints: { name: 'broad-synthesis-route', aliases: { n: 'limit' } },
};

const get_precision_lookup_route: Operation = {
  name: 'get_precision_lookup_route',
  description: 'Admin diagnostic; use select_retrieval_route intent=precision_lookup.',
  tier: 'admin',
  params: {
    scope_id: {
      type: 'string',
      description: 'Canonical note scope id (default: workspace:default)',
    },
    slug: { type: 'string', description: 'Exact canonical page slug' },
    path: {
      type: 'string',
      description: 'Exact canonical note path, optionally with #section/path fragment',
    },
    section_id: { type: 'string', description: 'Exact canonical section id' },
    source_ref: {
      type: 'string',
      description: 'Exact extracted source reference string',
    },
  },
  handler: async (ctx, p) => {
    return getPrecisionLookupRoute(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      slug: typeof p.slug === 'string' ? p.slug : undefined,
      path: typeof p.path === 'string' ? p.path : undefined,
      section_id: typeof p.section_id === 'string' ? p.section_id : undefined,
      source_ref: typeof p.source_ref === 'string' ? p.source_ref : undefined,
    });
  },
  cliHints: { name: 'precision-lookup-route' },
};

const get_mixed_scope_bridge: Operation = {
  name: 'get_mixed_scope_bridge',
  description: 'Admin diagnostic; use select_retrieval_route intent=mixed_scope_bridge.',
  tier: 'admin',
  params: {
    requested_scope: requestedScopeParam('Access scope override; must be mixed for this route. Use query for topical retrieval details.'),
    personal_route_kind: {
      type: 'string',
      required: true,
      description: 'Personal-side route kind for the bridge',
      enum: ['profile', 'episode'],
    },
    map_id: {
      type: 'string',
      description: 'Optional context map id for the work-side broad synthesis route',
    },
    scope_id: {
      type: 'string',
      description: 'Work-side scope id for broad synthesis (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter for the work-side route',
    },
    query: {
      type: 'string',
      required: true,
      description: 'Work-side broad synthesis query',
    },
    limit: { type: 'number', description: 'Optional work-side match limit' },
    subject: {
      type: 'string',
      description: 'Exact personal profile subject for the personal-side profile route',
    },
    profile_type: {
      type: 'string',
      description: 'Optional exact personal profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    episode_title: {
      type: 'string',
      description: 'Exact personal episode title for the personal-side episode route',
    },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    const personalRouteKind = String(p.personal_route_kind);
    if (personalRouteKind !== 'profile' && personalRouteKind !== 'episode') {
      throw new OperationError('invalid_params', 'personal_route_kind must be one of profile or episode.');
    }
    if (personalRouteKind === 'profile' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'profile mixed bridge requires subject.');
    }
    if (personalRouteKind === 'episode' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'episode mixed bridge requires episode_title.');
    }

    return getMixedScopeBridge(
      ctx.engine,
      {
        requested_scope: parseRequestedScopeParam(p.requested_scope),
        personal_route_kind: personalRouteKind as any,
        map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        kind: typeof p.kind === 'string' ? p.kind : undefined,
        query: String(p.query),
        limit: typeof p.limit === 'number' ? p.limit : undefined,
        subject: typeof p.subject === 'string' ? p.subject : undefined,
        profile_type: typeof p.profile_type === 'string' ? (p.profile_type as any) : undefined,
        episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
        episode_source_kind: typeof p.episode_source_kind === 'string' ? (p.episode_source_kind as any) : undefined,
      },
      {
        broadSynthesis: createProductionBroadSynthesisRouteDependencies(ctx.engine, ctx.config),
      },
    );
  },
  cliHints: { name: 'mixed-scope-bridge' },
};

const get_mixed_scope_disclosure: Operation = {
  name: 'get_mixed_scope_disclosure',
  description: 'Admin diagnostic; use select_retrieval_route intent=mixed_scope_bridge.',
  tier: 'admin',
  params: {
    requested_scope: requestedScopeParam('Access scope override; must be mixed for this route. Use query for topical retrieval details.'),
    personal_route_kind: {
      type: 'string',
      required: true,
      description: 'Personal-side route kind for the bridge',
      enum: ['profile', 'episode'],
    },
    map_id: {
      type: 'string',
      description: 'Optional context map id for the work-side broad synthesis route',
    },
    scope_id: {
      type: 'string',
      description: 'Work-side scope id for broad synthesis (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter for the work-side route',
    },
    query: {
      type: 'string',
      required: true,
      description: 'Work-side broad synthesis query',
    },
    limit: { type: 'number', description: 'Optional work-side match limit' },
    subject: {
      type: 'string',
      description: 'Exact personal profile subject for the personal-side profile route',
    },
    profile_type: {
      type: 'string',
      description: 'Optional exact personal profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    episode_title: {
      type: 'string',
      description: 'Exact personal episode title for the personal-side episode route',
    },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    const personalRouteKind = String(p.personal_route_kind);
    if (personalRouteKind !== 'profile' && personalRouteKind !== 'episode') {
      throw new OperationError('invalid_params', 'personal_route_kind must be one of profile or episode.');
    }
    if (personalRouteKind === 'profile' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'profile mixed disclosure requires subject.');
    }
    if (personalRouteKind === 'episode' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'episode mixed disclosure requires episode_title.');
    }

    return getMixedScopeDisclosure(
      ctx.engine,
      {
        requested_scope: parseRequestedScopeParam(p.requested_scope),
        personal_route_kind: personalRouteKind as any,
        map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        kind: typeof p.kind === 'string' ? p.kind : undefined,
        query: String(p.query),
        limit: typeof p.limit === 'number' ? p.limit : undefined,
        subject: typeof p.subject === 'string' ? p.subject : undefined,
        profile_type: typeof p.profile_type === 'string' ? (p.profile_type as any) : undefined,
        episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
        episode_source_kind: typeof p.episode_source_kind === 'string' ? (p.episode_source_kind as any) : undefined,
      },
      {
        broadSynthesis: createProductionBroadSynthesisRouteDependencies(ctx.engine, ctx.config),
      },
    );
  },
  cliHints: { name: 'mixed-scope-disclosure' },
};

const get_personal_profile_lookup_route: Operation = {
  name: 'get_personal_profile_lookup_route',
  description: 'Admin diagnostic; use select_retrieval_route intent=personal_profile_lookup.',
  tier: 'admin',
  params: {
    scope_id: {
      type: 'string',
      description: 'Personal profile-memory scope id (default: personal:default)',
    },
    requested_scope: requestedScopeParam('Optional access scope override for gate enforcement. Use query for topical retrieval details.'),
    query: {
      type: 'string',
      description: 'Optional natural-language query for gate inference',
    },
    subject: {
      type: 'string',
      required: true,
      description: 'Exact personal profile subject',
    },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
  },
  handler: async (ctx, p) => {
    return getPersonalProfileLookupRoute(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID),
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      query: typeof p.query === 'string' ? p.query : undefined,
      subject: String(p.subject),
      profile_type: typeof p.profile_type === 'string' ? (p.profile_type as any) : undefined,
    });
  },
  cliHints: { name: 'personal-profile-lookup-route' },
};

const get_personal_episode_lookup_route: Operation = {
  name: 'get_personal_episode_lookup_route',
  description: 'Admin diagnostic; use select_retrieval_route intent=personal_episode_lookup.',
  tier: 'admin',
  params: {
    scope_id: {
      type: 'string',
      description: 'Personal episode scope id (default: personal:default)',
    },
    requested_scope: requestedScopeParam('Optional access scope override for gate enforcement. Use query for topical retrieval details.'),
    query: {
      type: 'string',
      description: 'Optional natural-language query for gate inference',
    },
    title: {
      type: 'string',
      required: true,
      description: 'Exact personal episode title',
    },
    source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    return getPersonalEpisodeLookupRoute(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_PERSONAL_EPISODE_SCOPE_ID),
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      query: typeof p.query === 'string' ? p.query : undefined,
      title: String(p.title),
      source_kind: typeof p.source_kind === 'string' ? (p.source_kind as any) : undefined,
    });
  },
  cliHints: { name: 'personal-episode-lookup-route' },
};

const select_personal_write_target: Operation = {
  name: 'select_personal_write_target',
  description: 'Select the safe personal durable-memory target after scope-gate preflight.',
  params: {
    target_kind: {
      type: 'string',
      required: true,
      description: 'One of profile_memory or personal_episode',
      enum: ['profile_memory', 'personal_episode'],
    },
    requested_scope: requestedScopeParam('Optional access scope override for personal write-target selection. Use query for topical retrieval details.'),
    query: {
      type: 'string',
      description: 'Optional plain-text request used for scope classification',
    },
    subject: {
      type: 'string',
      description: 'Optional profile-memory subject when target_kind is profile_memory',
    },
    title: {
      type: 'string',
      description: 'Optional personal-episode title when target_kind is personal_episode',
    },
  },
  handler: async (ctx, p) => {
    const targetKind = String(p.target_kind);
    if (targetKind !== 'profile_memory' && targetKind !== 'personal_episode') {
      throw new OperationError('invalid_params', 'target_kind must be one of profile_memory or personal_episode.');
    }

    return selectPersonalWriteTarget(ctx.engine, {
      target_kind: targetKind as any,
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      query: typeof p.query === 'string' ? p.query : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      title: typeof p.title === 'string' ? p.title : undefined,
    });
  },
  cliHints: { name: 'personal-write-target' },
};

const preview_personal_export: Operation = {
  name: 'preview_personal_export',
  description: 'Preview the personal records that are currently exportable under published visibility rules.',
  params: {
    requested_scope: requestedScopeParam('Optional access scope override for personal export preview. Use query for topical retrieval details.'),
    query: {
      type: 'string',
      description: 'Optional plain-text request used for scope classification',
    },
    scope_id: {
      type: 'string',
      description: 'Optional personal scope id for the export preview (default: personal:default)',
    },
  },
  handler: async (ctx, p) => {
    return previewPersonalExport(ctx.engine, {
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      query: typeof p.query === 'string' ? p.query : undefined,
      scope_id: typeof p.scope_id === 'string' ? p.scope_id : undefined,
    });
  },
  cliHints: { name: 'personal-export-preview' },
};

const evaluate_scope_gate: Operation = {
  name: 'evaluate_scope_gate',
  description: 'Evaluate the deterministic scope gate for the current published retrieval stack.',
  params: {
    intent: {
      type: 'string',
      required: true,
      enum: [...RETRIEVAL_ROUTE_INTENTS],
      description: 'One of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup',
    },
    requested_scope: requestedScopeParam('Optional access scope override for scope-gate evaluation. Use query for topical retrieval details.'),
    task_id: {
      type: 'string',
      description: 'Task id used to derive task scope when present',
    },
    query: {
      type: 'string',
      description: 'Optional plain-text request used for signal detection',
    },
    repo_path: {
      type: 'string',
      description: 'Optional repo path or file path used for work-signal detection',
    },
    subject: {
      type: 'string',
      description: 'Optional personal profile subject used for signal detection',
    },
    episode_title: {
      type: 'string',
      description: 'Optional personal episode title used for signal detection',
    },
  },
  handler: async (ctx, p) => {
    const intent = String(p.intent);
    if (
      intent !== 'task_resume' &&
      intent !== 'broad_synthesis' &&
      intent !== 'precision_lookup' &&
      intent !== 'mixed_scope_bridge' &&
      intent !== 'personal_profile_lookup' &&
      intent !== 'personal_episode_lookup'
    ) {
      throw new OperationError(
        'invalid_params',
        'intent must be one of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup.',
      );
    }

    return evaluateScopeGate(ctx.engine, {
      intent,
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      repo_path: typeof p.repo_path === 'string' ? p.repo_path : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
    });
  },
  cliHints: { name: 'scope-gate' },
};

const select_retrieval_route: Operation = {
  name: 'select_retrieval_route',
  description: 'Select one published retrieval route by explicit intent.',
  params: {
    intent: {
      type: 'string',
      required: true,
      enum: [...RETRIEVAL_ROUTE_INTENTS],
      description: 'One of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup',
    },
    task_id: { type: 'string', description: 'Task id for task_resume intent' },
    persist_trace: {
      type: 'boolean',
      description: 'Persist a Retrieval Trace for the selected route; task_id is optional and task-less traces are stored with task_id=null',
    },
    requested_scope: requestedScopeParam('Optional access scope override for route selection. Use query for topical retrieval details.'),
    personal_route_kind: {
      type: 'string',
      description: 'Personal-side route kind for mixed_scope_bridge intent',
      enum: ['profile', 'episode'],
    },
    map_id: {
      type: 'string',
      description: 'Optional context map id for broad_synthesis intent',
    },
    scope_id: {
      type: 'string',
      description: 'Scope id for delegated route selection',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter for broad_synthesis intent',
    },
    query: {
      type: 'string',
      description: 'Query string for broad_synthesis intent',
    },
    limit: {
      type: 'number',
      description: 'Optional broad_synthesis match limit',
    },
    slug: {
      type: 'string',
      description: 'Exact slug for precision_lookup intent',
    },
    path: {
      type: 'string',
      description: 'Exact path for precision_lookup intent, optionally with #section/path fragment',
    },
    section_id: {
      type: 'string',
      description: 'Exact section id for precision_lookup intent',
    },
    source_ref: {
      type: 'string',
      description: 'Exact extracted source reference string for precision_lookup intent',
    },
    subject: {
      type: 'string',
      description: 'Exact profile-memory subject for personal_profile_lookup intent',
    },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter for personal_profile_lookup intent',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    episode_title: {
      type: 'string',
      description: 'Exact personal episode title for personal_episode_lookup intent',
    },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter for personal_episode_lookup intent',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
  },
  handler: async (ctx, p) => {
    const intent = String(p.intent);
    if (
      intent !== 'task_resume' &&
      intent !== 'broad_synthesis' &&
      intent !== 'precision_lookup' &&
      intent !== 'mixed_scope_bridge' &&
      intent !== 'personal_profile_lookup' &&
      intent !== 'personal_episode_lookup'
    ) {
      throw new OperationError(
        'invalid_params',
        'intent must be one of task_resume, broad_synthesis, precision_lookup, mixed_scope_bridge, personal_profile_lookup, personal_episode_lookup.',
      );
    }
    if (intent === 'task_resume' && typeof p.task_id !== 'string') {
      throw new OperationError('invalid_params', 'task_resume intent requires task_id.');
    }
    if (intent === 'broad_synthesis' && typeof p.query !== 'string') {
      throw new OperationError('invalid_params', 'broad_synthesis intent requires query.');
    }
    if (intent === 'mixed_scope_bridge' && typeof p.personal_route_kind !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge intent requires personal_route_kind.');
    }
    if (intent === 'mixed_scope_bridge' && typeof p.query !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge intent requires query.');
    }
    if (intent === 'mixed_scope_bridge' && p.personal_route_kind === 'profile' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge profile intent requires subject.');
    }
    if (intent === 'mixed_scope_bridge' && p.personal_route_kind === 'episode' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'mixed_scope_bridge episode intent requires episode_title.');
    }
    if (intent === 'personal_profile_lookup' && typeof p.subject !== 'string') {
      throw new OperationError('invalid_params', 'personal_profile_lookup intent requires subject.');
    }
    if (intent === 'personal_episode_lookup' && typeof p.episode_title !== 'string') {
      throw new OperationError('invalid_params', 'personal_episode_lookup intent requires episode_title.');
    }
    if (intent === 'precision_lookup' && typeof p.slug !== 'string' && typeof p.section_id !== 'string') {
      if (typeof p.path !== 'string' && typeof p.source_ref !== 'string') {
        throw new OperationError('invalid_params', 'precision_lookup intent requires slug, path, section_id, or source_ref.');
      }
    }
    return selectRetrievalRoute(
      ctx.engine,
      {
        intent,
        task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
        persist_trace: p.persist_trace === true,
        requested_scope: parseRequestedScopeParam(p.requested_scope),
        personal_route_kind: typeof p.personal_route_kind === 'string' ? (p.personal_route_kind as any) : undefined,
        map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
        scope_id: String(
          p.scope_id ??
            (intent === 'personal_profile_lookup'
              ? DEFAULT_PROFILE_MEMORY_SCOPE_ID
              : intent === 'personal_episode_lookup'
                ? DEFAULT_PERSONAL_EPISODE_SCOPE_ID
                : DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        ),
        kind: p.kind as string | undefined,
        query: typeof p.query === 'string' ? p.query : undefined,
        limit: typeof p.limit === 'number' ? p.limit : undefined,
        slug: typeof p.slug === 'string' ? p.slug : undefined,
        path: typeof p.path === 'string' ? p.path : undefined,
        section_id: typeof p.section_id === 'string' ? p.section_id : undefined,
        source_ref: typeof p.source_ref === 'string' ? p.source_ref : undefined,
        subject: typeof p.subject === 'string' ? p.subject : undefined,
        profile_type: typeof p.profile_type === 'string' ? (p.profile_type as any) : undefined,
        episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
        episode_source_kind: typeof p.episode_source_kind === 'string' ? (p.episode_source_kind as any) : undefined,
      },
      createProductionRetrievalRouteDependencies(ctx.engine, ctx.config),
    );
  },
  cliHints: { name: 'retrieval-route' },
};

const plan_retrieval_request: Operation = {
  name: 'plan_retrieval_request',
  description: 'Admin diagnostic; use retrieve_context or select_retrieval_route.',
  tier: 'admin',
  params: {
    intent: {
      type: 'string',
      description: 'Optional explicit intent override',
      enum: [...RETRIEVAL_ROUTE_INTENTS],
    },
    allow_decomposition: {
      type: 'boolean',
      description: 'Allow deterministic decomposition into multiple route intents',
    },
    task_id: {
      type: 'string',
      description: 'Task id for task_resume decomposition or inference',
    },
    persist_trace: {
      type: 'boolean',
      description: 'Forwarded trace preference for planned selector inputs',
    },
    requested_scope: requestedScopeParam('Optional access scope override for retrieval planning. Use query for topical retrieval details.'),
    personal_route_kind: {
      type: 'string',
      description: 'Personal-side route kind for mixed_scope_bridge planning',
      enum: [...PERSONAL_ROUTE_KINDS],
    },
    map_id: {
      type: 'string',
      description: 'Optional context map id for broad_synthesis planning',
    },
    scope_id: {
      type: 'string',
      description: 'Scope id for planned route selection',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter for broad_synthesis planning',
    },
    query: {
      type: 'string',
      description: 'Query string for synthesis or signal inference',
    },
    limit: {
      type: 'number',
      description: 'Optional broad_synthesis match limit',
    },
    slug: {
      type: 'string',
      description: 'Exact slug for precision_lookup planning',
    },
    path: {
      type: 'string',
      description: 'Exact path for precision_lookup planning, optionally with #section/path fragment',
    },
    section_id: {
      type: 'string',
      description: 'Exact section id for precision_lookup planning',
    },
    source_ref: {
      type: 'string',
      description: 'Exact extracted source reference string for precision_lookup planning',
    },
    subject: {
      type: 'string',
      description: 'Exact profile-memory subject for personal_profile_lookup or mixed planning',
    },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter for personal_profile_lookup planning',
      enum: [...PROFILE_MEMORY_TYPES],
    },
    episode_title: {
      type: 'string',
      description: 'Exact personal episode title for personal_episode_lookup planning',
    },
    episode_source_kind: {
      type: 'string',
      description: 'Optional exact personal episode source kind filter for personal_episode_lookup planning',
      enum: [...PERSONAL_EPISODE_SOURCE_KINDS],
    },
  },
  mutating: false,
  handler: async (_ctx, p) => {
    const input: RetrievalRequestPlannerInput = {
      intent: parseEnumParam(p.intent, 'intent', RETRIEVAL_ROUTE_INTENTS),
      allow_decomposition: p.allow_decomposition === true,
      task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
      persist_trace: p.persist_trace === true,
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      personal_route_kind: parseEnumParam(p.personal_route_kind, 'personal_route_kind', PERSONAL_ROUTE_KINDS),
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: typeof p.scope_id === 'string' ? p.scope_id : undefined,
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      query: typeof p.query === 'string' ? p.query : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      slug: typeof p.slug === 'string' ? p.slug : undefined,
      path: typeof p.path === 'string' ? p.path : undefined,
      section_id: typeof p.section_id === 'string' ? p.section_id : undefined,
      source_ref: typeof p.source_ref === 'string' ? p.source_ref : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      profile_type: parseEnumParam(p.profile_type, 'profile_type', PROFILE_MEMORY_TYPES),
      episode_title: typeof p.episode_title === 'string' ? p.episode_title : undefined,
      episode_source_kind: parseEnumParam(p.episode_source_kind, 'episode_source_kind', PERSONAL_EPISODE_SOURCE_KINDS),
    };

    return planRetrievalRequest(input);
  },
  cliHints: { name: 'plan-retrieval-request' },
};

const retrieve_context: Operation = {
  name: 'retrieve_context',
  description:
    'Agentic MBrain retrieval probe. Returns a bounded read_plan, required canonical reads, and non-canonical candidate_signals from Memory Inbox; chunks and candidate signals are not answer evidence. Call read_context on read_plan.selected_selector_snapshots before answering factual questions; use read_plan.selected_selectors only as a legacy selector-id fallback.',
  discovery: {
    compactDescription: true,
    description:
      'Core knowledge lookup: retrieve_context finds candidate context and required canonical reads. For factual answers, call read_context on read_plan.selected_selector_snapshots; read_plan.selected_selectors is a legacy fallback. If read_context is hidden, use tool_search for mbrain read_context.',
  },
  params: {
    query: { type: 'string', description: 'Raw user request or memory query' },
    selectors: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Optional exact retrieval selector objects, or a JSON array string for CLI usage',
    },
    task_id: { type: 'string', description: 'Optional active task id' },
    repo_path: {
      type: 'string',
      description: 'Optional active repository path',
    },
    requested_scope: requestedScopeParam('Optional access scope override for memory retrieval. Use query for topical retrieval details.'),
    source_kind: {
      type: 'string',
      description: 'Optional source kind for classification',
      enum: [...MEMORY_SCENARIO_SOURCE_KINDS],
    },
    known_subjects: {
      type: ['array', 'string'],
      items: { type: ['string', 'object'] },
      description: 'Optional detected subject refs as strings or objects with ref and kind, or a JSON array string',
    },
    limit: { type: 'number', description: 'Candidate and required-read limit' },
    token_budget: {
      type: 'number',
      description: 'Approximate probe output token budget. Shrinks candidates by budget/600, required reads by budget/1200, and drops derived orientation below 2000 tokens.',
    },
    include_orientation: {
      type: 'boolean',
      description: 'Include derived orientation when useful',
    },
    include_push_context: {
      type: 'boolean',
      description: 'Include a bounded selector-first push_context envelope; it contains no raw memory text and requires read_context before factual use.',
    },
    auto_route: {
      type: 'boolean',
      description: 'Auto-apply the classified retrieval route. Defaults to true; pass false to keep route null.',
    },
    graph_frontier: {
      type: ['object', 'string', 'boolean'],
      description: 'Explicit graph frontier selector planning flag. Default is off; graph paths are explanation-only.',
    },
    persist_trace: {
      type: 'boolean',
      description: 'Persist a retrieval trace for this probe. Defaults to true; pass false to opt out.',
    },
  },
  mutating: false,
  handler: async (ctx, p) =>
    withSelectorParamErrors(() =>
      retrieveContext(
        ctx.engine,
        {
          query: parseOptionalStringParam(p.query, 'query'),
          selectors: parseRetrievalSelectors(p.selectors, 'selectors'),
          task_id: parseOptionalStringParam(p.task_id, 'task_id'),
          repo_path: parseOptionalStringParam(p.repo_path, 'repo_path'),
          requested_scope: parseRequestedScopeParam(p.requested_scope),
          source_kind: parseEnumParam(p.source_kind, 'source_kind', MEMORY_SCENARIO_SOURCE_KINDS),
          known_subjects: parseKnownSubjectsParam(p.known_subjects, 'known_subjects'),
          limit: parsePositiveIntegerParam(p.limit, 'limit'),
          token_budget: parsePositiveIntegerParam(p.token_budget, 'token_budget'),
          include_orientation: typeof p.include_orientation === 'boolean' ? p.include_orientation : undefined,
          include_push_context: p.include_push_context === true,
          auto_route: typeof p.auto_route === 'boolean' ? p.auto_route : undefined,
          graph_frontier: parseRetrieveContextGraphFrontierParam(p.graph_frontier, 'graph_frontier'),
          persist_trace: typeof p.persist_trace === 'boolean' ? p.persist_trace : undefined,
        },
        createProductionRetrieveContextDependencies(ctx.engine, ctx.config),
      ),
    ),
  cliHints: {
    name: 'retrieve-context',
    positional: ['query'],
    aliases: { n: 'limit', scope: 'requested_scope' },
  },
};

const read_context: Operation = {
  name: 'read_context',
  description: 'Read bounded canonical evidence for retrieval selectors. This is the evidence boundary before answering factual questions.',
  discovery: {
    compactDescription: true,
    description: 'Core knowledge lookup: read_context reads canonical evidence for retrieval selectors and is the evidence boundary before factual answers.',
  },
  params: {
    query: {
      type: 'string',
      description: 'Optional natural-language request for automatic reads. A query without selectors defaults to reads=auto instead of returning empty evidence.',
    },
    selectors: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Retrieval selector objects, or a JSON array string for CLI usage',
    },
    reads: {
      type: 'string',
      description: 'Read selection mode (default: auto when only a query is provided)',
      enum: [...CONTEXT_READ_MODES],
    },
    token_budget: {
      type: 'number',
      description: 'Approximate canonical read token budget',
    },
    max_selectors: {
      type: 'number',
      description: 'Maximum selectors to read before returning unread selectors',
    },
    include_timeline: includeTimelineParam(),
    include_source_refs: {
      type: 'boolean',
      description: 'Include extracted source refs when available',
    },
    persist_trace: {
      type: 'boolean',
      description: 'Persist a retrieval trace for this canonical read. Defaults to true; pass false to opt out.',
    },
    task_id: { type: 'string', description: 'Optional active task id' },
    requested_scope: requestedScopeParam('Optional access scope override for scope-gate enforcement. Use query for topical retrieval details.'),
    probe_context: {
      type: ['object', 'string'],
      description: 'Optional bounded handoff from the preceding retrieve_context result: trace ids and counts only, never raw candidate text.',
    },
  },
  mutating: false,
  handler: async (ctx, p) =>
    withSelectorParamErrors(() =>
      readContext(
        ctx.engine,
        {
          query: parseOptionalStringParam(p.query, 'query'),
          selectors: parseRetrievalSelectors(p.selectors, 'selectors'),
          reads: parseEnumParam(p.reads, 'reads', CONTEXT_READ_MODES),
          token_budget: parsePositiveIntegerParam(p.token_budget, 'token_budget'),
          max_selectors: parsePositiveIntegerParam(p.max_selectors, 'max_selectors'),
          include_timeline: parseIncludeTimelineParam(p.include_timeline),
          include_source_refs: typeof p.include_source_refs === 'boolean' ? p.include_source_refs : undefined,
          persist_trace: typeof p.persist_trace === 'boolean' ? p.persist_trace : undefined,
          task_id: parseOptionalStringParam(p.task_id, 'task_id') ?? null,
          requested_scope: parseRequestedScopeParam(p.requested_scope),
          probe_context: parseReadContextProbeContextParam(p.probe_context, 'probe_context'),
        },
        createProductionRetrieveContextDependencies(ctx.engine, ctx.config),
      ),
    ),
  cliHints: { name: 'read-context', aliases: { n: 'max_selectors' } },
};

const classify_memory_scenario: Operation = {
  name: 'classify_memory_scenario',
  description: 'Admin diagnostic; retrieve_context classifies and routes automatically.',
  tier: 'admin',
  params: {
    query: { type: 'string', description: 'Raw user request or system task' },
    task_id: { type: 'string', description: 'Optional active task id' },
    repo_path: {
      type: 'string',
      description: 'Optional active repository path',
    },
    requested_scope: requestedScopeParam('Optional access scope override for scenario classification. Use query for topical retrieval details.'),
    source_kind: {
      type: 'string',
      description: 'Optional source kind for classification',
      enum: [...MEMORY_SCENARIO_SOURCE_KINDS],
    },
    known_subjects: {
      type: ['array', 'string'],
      items: { type: ['string', 'object'] },
      description: 'Optional detected subject refs as strings or objects with ref and kind, or a JSON array string',
    },
  },
  mutating: false,
  handler: async (_ctx, p) =>
    classifyMemoryScenario({
      query: parseOptionalStringParam(p.query, 'query'),
      task_id: parseOptionalStringParam(p.task_id, 'task_id'),
      repo_path: parseOptionalStringParam(p.repo_path, 'repo_path'),
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      source_kind: parseEnumParam(p.source_kind, 'source_kind', MEMORY_SCENARIO_SOURCE_KINDS),
      known_subjects: parseKnownSubjectsParam(p.known_subjects, 'known_subjects'),
    }),
  cliHints: {
    name: 'classify-memory-scenario',
    aliases: { scope: 'requested_scope' },
  },
};

const select_activation_policy: Operation = {
  name: 'select_activation_policy',
  description: 'Admin diagnostic; retrieve_context applies activation policy automatically.',
  tier: 'admin',
  params: {
    scenario: {
      type: 'string',
      required: true,
      description: 'Memory scenario',
      enum: [...MEMORY_SCENARIOS],
    },
    artifacts: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Activation artifacts as objects or a JSON array string',
    },
  },
  mutating: false,
  handler: async (_ctx, p) => {
    const scenario = parseEnumParam(p.scenario, 'scenario', MEMORY_SCENARIOS);
    if (!scenario) {
      throw new OperationError('invalid_params', `scenario must be one of: ${MEMORY_SCENARIOS.join(', ')}.`);
    }

    return selectActivationPolicy({
      scenario,
      artifacts: parseActivationArtifacts(p.artifacts, 'artifacts'),
    });
  },
  cliHints: { name: 'select-activation-policy' },
};

const proof_agent_memory: Operation = {
  name: 'proof_agent_memory',
  description: 'Run deterministic authority-first memory proof scenarios for agent use without mutating memory.',
  params: {
    verbose: {
      type: 'boolean',
      description: 'Include verbose memory-why fields in formatted output',
    },
  },
  mutating: false,
  handler: async (_ctx, p) =>
    runProofAgentMemory({
      verbose: p.verbose === true,
    }),
  cliHints: { name: 'proof-agent' },
};

const plan_scenario_memory_request: Operation = {
  name: 'plan_scenario_memory_request',
  description: 'Admin diagnostic; use retrieve_context for scenario-aware planning.',
  tier: 'admin',
  params: {
    query: { type: 'string', description: 'Raw user request or system task' },
    task_id: { type: 'string', description: 'Optional active task id' },
    repo_path: {
      type: 'string',
      description: 'Optional active repository path',
    },
    requested_scope: requestedScopeParam('Optional access scope override for scenario memory planning. Use query for topical retrieval details.'),
    source_kind: {
      type: 'string',
      description: 'Optional source kind for classification',
      enum: [...MEMORY_SCENARIO_SOURCE_KINDS],
    },
    known_subjects: {
      type: ['array', 'string'],
      items: { type: ['string', 'object'] },
      description: 'Optional detected subject refs as strings or objects with ref and kind, or a JSON array string',
    },
    artifacts: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Optional activation artifacts as objects or a JSON array string',
    },
  },
  mutating: false,
  handler: async (_ctx, p) =>
    planScenarioMemoryRequest({
      query: parseOptionalStringParam(p.query, 'query'),
      task_id: parseOptionalStringParam(p.task_id, 'task_id'),
      repo_path: parseOptionalStringParam(p.repo_path, 'repo_path'),
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      source_kind: parseEnumParam(p.source_kind, 'source_kind', MEMORY_SCENARIO_SOURCE_KINDS),
      known_subjects: parseKnownSubjectsParam(p.known_subjects, 'known_subjects'),
      artifacts: parseActivationArtifacts(p.artifacts, 'artifacts'),
    }),
  cliHints: {
    name: 'plan-scenario-memory-request',
    aliases: { scope: 'requested_scope' },
  },
};

const reverify_code_claims: Operation = {
  name: 'reverify_code_claims',
  description: 'Re-check code path, symbol, and branch claims against the current workspace.',
  params: {
    repo_path: {
      type: 'string',
      required: true,
      description: 'Repository root used to verify file and symbol claims',
    },
    branch_name: {
      type: 'string',
      description: 'Current branch name for branch-sensitive claims',
    },
    claims: {
      type: ['array', 'string'],
      items: { type: ['object', 'string'] },
      description:
        'Code claims to verify directly, optionally including expected_content_hash, verification_hint, verification_mode, source_ref, and symbol_id',
    },
    trace_id: {
      type: 'string',
      description: 'Retrieval trace id containing code_claim verification entries',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    if (typeof p.repo_path !== 'string' || p.repo_path.trim().length === 0) {
      throw new OperationError('invalid_params', 'reverify_code_claims requires repo_path as a non-empty string.');
    }
    const repoPath = p.repo_path;
    const branchName = typeof p.branch_name === 'string' ? p.branch_name : undefined;
    const traceId = typeof p.trace_id === 'string' ? p.trace_id : undefined;
    const directClaims = parseCodeClaimsParam(p.claims, 'claims');
    if (traceId && directClaims !== undefined) {
      throw new OperationError('invalid_params', 'reverify_code_claims accepts either claims or trace_id, not both.');
    }

    let trace: RetrievalTrace | null = null;
    if (traceId) {
      trace = await ctx.engine.getRetrievalTrace(traceId);
      if (!trace) {
        throw new OperationError('trace_not_found', `Retrieval trace not found: ${traceId}`);
      }
    }

    const claims = directClaims ?? (trace ? extractCodeClaimsFromTrace(trace) : undefined);
    if (!claims || claims.length === 0) {
      throw new OperationError('invalid_params', 'reverify_code_claims requires claims or a trace_id with code_claim verification entries.');
    }

    const results = verifyCodeClaims({
      repo_path: repoPath,
      branch_name: branchName,
      claims,
    });
    const staleCount = results.filter((result) => result.status === 'stale').length;
    const currentCount = results.filter((result) => result.status === 'current').length;
    const unverifiableCount = results.filter((result) => result.status === 'unverifiable').length;
    const nonCurrentCount = results.length - currentCount;
    let writtenTrace: RetrievalTrace | null = null;

    if (!ctx.dryRun && trace && nonCurrentCount > 0) {
      writtenTrace = await ctx.engine.putRetrievalTrace({
        id: crypto.randomUUID(),
        task_id: trace.task_id,
        scope: trace.scope,
        route: ['code_claim_reverification'],
        source_refs: [`retrieval_trace:${trace.id}`],
        verification: results.map((result) => `code_claim_result:${result.claim.path ?? result.claim.symbol ?? 'unknown'}:${result.status}:${result.reason}`),
        write_outcome: 'operational_write',
        outcome: `code claim reverify stale=${staleCount} current=${currentCount} unverifiable=${unverifiableCount}`,
      });
    }

    return {
      trace_id: trace?.id ?? null,
      results,
      written_trace: writtenTrace,
      dry_run: ctx.dryRun || undefined,
    };
  },
  cliHints: { name: 'reverify-code-claims' },
};

const get_workspace_system_card: Operation = {
  name: 'get_workspace_system_card',
  description: 'Admin diagnostic; use retrieve_context with include_orientation.',
  tier: 'admin',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getWorkspaceSystemCard(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-system-card' },
};

const get_workspace_project_card: Operation = {
  name: 'get_workspace_project_card',
  description: 'Admin diagnostic; use retrieve_context with include_orientation.',
  tier: 'admin',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getWorkspaceProjectCard(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-project-card' },
};

const get_workspace_orientation_bundle: Operation = {
  name: 'get_workspace_orientation_bundle',
  description: 'Admin diagnostic; use retrieve_context with include_orientation.',
  tier: 'admin',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getWorkspaceOrientationBundle(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-orientation' },
};

const get_workspace_corpus_card: Operation = {
  name: 'get_workspace_corpus_card',
  description: 'Admin diagnostic; use retrieve_context with include_orientation.',
  tier: 'admin',
  params: {
    map_id: {
      type: 'string',
      description: 'Optional context map id for a direct read',
    },
    scope_id: {
      type: 'string',
      description: 'Map scope id (default: workspace:default)',
    },
    kind: {
      type: 'string',
      description: 'Optional map kind filter when map_id is omitted',
    },
  },
  handler: async (ctx, p) => {
    return getWorkspaceCorpusCard(ctx.engine, {
      map_id: typeof p.map_id === 'string' ? p.map_id : undefined,
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      kind: p.kind as string | undefined,
    });
  },
  cliHints: { name: 'workspace-corpus-card' },
};

export function createRetrievalOperations(): Operation[] {
  return [
    get_broad_synthesis_route,
    get_precision_lookup_route,
    get_mixed_scope_bridge,
    get_mixed_scope_disclosure,
    get_personal_profile_lookup_route,
    get_personal_episode_lookup_route,
    select_personal_write_target,
    preview_personal_export,
    evaluate_scope_gate,
    select_retrieval_route,
    plan_retrieval_request,
    retrieve_context,
    read_context,
    classify_memory_scenario,
    select_activation_policy,
    proof_agent_memory,
    plan_scenario_memory_request,
    reverify_code_claims,
    get_workspace_system_card,
    get_workspace_project_card,
    get_workspace_orientation_bundle,
    get_workspace_corpus_card,
  ];
}
