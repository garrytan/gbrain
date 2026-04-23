import type { BrainEngine } from '../engine.ts';
import type {
  BroadSynthesisRoute,
  MixedScopeBridgeRoute,
  PersonalEpisodeLookupRoute,
  PersonalProfileLookupRoute,
  PrecisionLookupRoute,
  ScopeGateDecisionResult,
  ScopeGateScope,
  RetrievalTrace,
  RetrievalRouteSelection,
  RetrievalRouteSelectorInput,
  RetrievalRouteSelectorResult,
} from '../types.ts';
import { getBroadSynthesisRoute } from './broad-synthesis-route-service.ts';
import { getMixedScopeBridge } from './mixed-scope-bridge-service.ts';
import { getPersonalEpisodeLookupRoute } from './personal-episode-lookup-route-service.ts';
import { getPersonalProfileLookupRoute } from './personal-profile-lookup-route-service.ts';
import { getPrecisionLookupRoute } from './precision-lookup-route-service.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';
import { buildTaskResumeCard, type TaskResumeCard } from './task-memory-service.ts';

export async function selectRetrievalRoute(
  engine: BrainEngine,
  input: RetrievalRouteSelectorInput,
): Promise<RetrievalRouteSelectorResult> {
  const shouldEvaluateScopeGate = input.intent !== 'mixed_scope_bridge' && (
    input.requested_scope !== undefined
    || input.intent === 'personal_profile_lookup'
    || input.intent === 'personal_episode_lookup'
    || (input.persist_trace === true && input.task_id === undefined)
  );
  const scopeGate = shouldEvaluateScopeGate
    ? await evaluateScopeGate(engine, {
      intent: input.intent,
      requested_scope: input.requested_scope,
      task_id: input.task_id,
      query: input.query,
      subject: input.subject,
      title: input.episode_title,
    })
    : undefined;

  if (scopeGate && scopeGate.policy !== 'allow') {
    const denied: RetrievalRouteSelectorResult = {
      selected_intent: input.intent,
      selection_reason: scopeGate.decision_reason,
      candidate_count: 0,
      route: null,
      scope_gate: scopeGate,
    };

    if (!input.persist_trace) {
      return denied;
    }

    return {
      ...denied,
      trace: await persistSelectedRouteTrace(engine, denied, input.task_id),
    };
  }

  const selected = await (async (): Promise<RetrievalRouteSelectorResult> => {
    switch (input.intent) {
    case 'task_resume':
      return selectTaskResumeRoute(engine, input.task_id);
    case 'broad_synthesis':
      return selectBroadSynthesisRoute(engine, input);
    case 'precision_lookup':
      return selectPrecisionLookupRoute(engine, input);
    case 'mixed_scope_bridge':
      return selectMixedScopeBridgeRoute(engine, input);
    case 'personal_profile_lookup':
      return selectPersonalProfileLookupRoute(engine, input);
    case 'personal_episode_lookup':
      return selectPersonalEpisodeLookupRoute(engine, input);
    default:
      throw new Error(`Unsupported retrieval intent: ${String(input.intent)}`);
    }
  })();

  if (scopeGate) {
    selected.scope_gate = scopeGate;
  }

  if (!input.persist_trace) {
    return selected;
  }

  return {
    ...selected,
    trace: await persistSelectedRouteTrace(engine, selected, input.task_id),
  };
}

async function selectTaskResumeRoute(
  engine: BrainEngine,
  taskId: string | undefined,
): Promise<RetrievalRouteSelectorResult> {
  if (!taskId) {
    return {
      selected_intent: 'task_resume',
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  const thread = await engine.getTaskThread(taskId);
  if (!thread) {
    return {
      selected_intent: 'task_resume',
      selection_reason: 'task_not_found',
      candidate_count: 0,
      route: null,
    };
  }

  const card = await buildTaskResumeCard(engine, taskId);
  return {
    selected_intent: 'task_resume',
    selection_reason: 'direct_task_match',
    candidate_count: 1,
    route: buildTaskResumeSelection(card),
  };
}

async function selectBroadSynthesisRoute(
  engine: BrainEngine,
  input: RetrievalRouteSelectorInput,
): Promise<RetrievalRouteSelectorResult> {
  const result = await getBroadSynthesisRoute(engine, {
    map_id: input.map_id,
    scope_id: input.scope_id,
    kind: input.kind,
    query: input.query ?? '',
    limit: input.limit,
  });
  return {
    selected_intent: 'broad_synthesis',
    selection_reason: result.selection_reason,
    candidate_count: result.candidate_count,
    route: result.route ? buildDelegatedSelection('broad_synthesis', result.route) : null,
  };
}

async function selectPrecisionLookupRoute(
  engine: BrainEngine,
  input: RetrievalRouteSelectorInput,
): Promise<RetrievalRouteSelectorResult> {
  const result = await getPrecisionLookupRoute(engine, {
    scope_id: input.scope_id,
    slug: input.slug,
    path: input.path,
    section_id: input.section_id,
    source_ref: input.source_ref,
  });
  return {
    selected_intent: 'precision_lookup',
    selection_reason: result.selection_reason,
    candidate_count: result.candidate_count,
    route: result.route ? buildDelegatedSelection('precision_lookup', result.route) : null,
  };
}

async function selectMixedScopeBridgeRoute(
  engine: BrainEngine,
  input: RetrievalRouteSelectorInput,
): Promise<RetrievalRouteSelectorResult> {
  const missingPersonalSelector = input.personal_route_kind === 'episode'
    ? !input.episode_title
    : !input.subject;

  if (!input.query || missingPersonalSelector) {
    return {
      selected_intent: 'mixed_scope_bridge',
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  const result = await getMixedScopeBridge(engine, {
    requested_scope: input.requested_scope,
    personal_route_kind: input.personal_route_kind ?? 'profile',
    map_id: input.map_id,
    scope_id: input.scope_id,
    kind: input.kind,
    query: input.query,
    limit: input.limit,
    subject: input.subject,
    profile_type: input.profile_type,
    episode_title: input.episode_title,
    episode_source_kind: input.episode_source_kind,
  });

  return {
    selected_intent: 'mixed_scope_bridge',
    selection_reason: result.selection_reason,
    candidate_count: result.candidate_count,
    route: result.route ? buildDelegatedSelection('mixed_scope_bridge', result.route) : null,
    scope_gate: result.scope_gate,
  };
}

async function selectPersonalProfileLookupRoute(
  engine: BrainEngine,
  input: RetrievalRouteSelectorInput,
): Promise<RetrievalRouteSelectorResult> {
  if (!input.subject) {
    return {
      selected_intent: 'personal_profile_lookup',
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  const result = await getPersonalProfileLookupRoute(engine, {
    scope_id: input.scope_id,
    subject: input.subject,
    profile_type: input.profile_type,
    requested_scope: input.requested_scope ?? 'personal',
    query: input.query,
  });
  return {
    selected_intent: 'personal_profile_lookup',
    selection_reason: result.selection_reason,
    candidate_count: result.candidate_count,
    route: result.route ? buildDelegatedSelection('personal_profile_lookup', result.route) : null,
  };
}

async function selectPersonalEpisodeLookupRoute(
  engine: BrainEngine,
  input: RetrievalRouteSelectorInput,
): Promise<RetrievalRouteSelectorResult> {
  if (!input.episode_title) {
    return {
      selected_intent: 'personal_episode_lookup',
      selection_reason: 'no_match',
      candidate_count: 0,
      route: null,
    };
  }

  const result = await getPersonalEpisodeLookupRoute(engine, {
    scope_id: input.scope_id,
    title: input.episode_title,
    source_kind: input.episode_source_kind,
    requested_scope: input.requested_scope ?? 'personal',
    query: input.query,
  });
  return {
    selected_intent: 'personal_episode_lookup',
    selection_reason: result.selection_reason,
    candidate_count: result.candidate_count,
    route: result.route ? buildDelegatedSelection('personal_episode_lookup', result.route) : null,
  };
}

function buildTaskResumeSelection(card: TaskResumeCard): RetrievalRouteSelection {
  return {
    route_kind: 'task_resume',
    retrieval_route: [
      'task_thread',
      'working_set',
      'attempt_decision_history',
      'focused_source_reads',
    ],
    summary_lines: [
      `Task resume is anchored to task ${card.task_id}.`,
      `Latest failed attempts available: ${card.failed_attempts.length}.`,
      `Latest decisions available: ${card.active_decisions.length}.`,
    ],
    payload: card,
  };
}

function buildDelegatedSelection(
  routeKind: 'broad_synthesis' | 'precision_lookup' | 'mixed_scope_bridge' | 'personal_profile_lookup' | 'personal_episode_lookup',
  payload: BroadSynthesisRoute | PrecisionLookupRoute | MixedScopeBridgeRoute | PersonalProfileLookupRoute | PersonalEpisodeLookupRoute,
): RetrievalRouteSelection {
  return {
    route_kind: routeKind,
    retrieval_route: payload.retrieval_route,
    summary_lines: payload.summary_lines,
    payload,
  };
}

async function persistSelectedRouteTrace(
  engine: BrainEngine,
  selected: RetrievalRouteSelectorResult,
  taskId?: string,
): Promise<RetrievalTrace> {
  const thread = taskId ? await engine.getTaskThread(taskId) : null;
  const threadMissing = Boolean(taskId) && thread == null;

  const scope: ScopeGateScope = thread?.scope
    ?? selected.scope_gate?.resolved_scope
    ?? 'unknown';

  return engine.putRetrievalTrace({
    id: crypto.randomUUID(),
    task_id: thread ? taskId! : null,
    scope,
    route: selected.route?.retrieval_route ?? [],
    source_refs: collectSourceRefs(selected.route),
    verification: [
      `intent:${selected.selected_intent}`,
      `selection_reason:${selected.selection_reason}`,
      ...buildScopeGateVerification(selected.scope_gate),
      ...(threadMissing ? [`task_id_not_found:${taskId}`] : []),
    ],
    outcome: selected.route
      ? `${selected.selected_intent} route selected`
      : `${selected.selected_intent} route unavailable`,
  });
}

function buildScopeGateVerification(scopeGate: ScopeGateDecisionResult | undefined): string[] {
  if (!scopeGate) {
    return [];
  }

  return [
    `scope_gate:${scopeGate.policy}`,
    `scope_gate_reason:${scopeGate.decision_reason}`,
  ];
}

function collectSourceRefs(route: RetrievalRouteSelection | null): string[] {
  if (!route) return [];
  const payload = route.payload as {
    recommended_reads?: Array<{
      node_kind?: 'page' | 'section';
      page_slug?: string;
      section_id?: string;
    }>;
    task_id?: string;
    profile_memory_id?: string;
    personal_episode_id?: string;
    work_route?: BroadSynthesisRoute;
    personal_route?: PersonalProfileLookupRoute | PersonalEpisodeLookupRoute;
  };

  if (route.route_kind === 'task_resume' && payload.task_id) {
    return [`task-thread:${payload.task_id}`];
  }

  if (route.route_kind === 'mixed_scope_bridge' && payload.work_route && payload.personal_route) {
    const workRefs = payload.work_route.recommended_reads.map((read) => {
      if (read.node_kind === 'section' && read.section_id) {
        return `section:${read.section_id}`;
      }
      return `page:${read.page_slug}`;
    });

    return [...new Set([
      ...workRefs,
      payload.personal_route.route_kind === 'personal_profile_lookup'
        ? `profile-memory:${payload.personal_route.profile_memory_id}`
        : `personal-episode:${payload.personal_route.personal_episode_id}`,
    ])];
  }

  if (route.route_kind === 'personal_profile_lookup' && payload.profile_memory_id) {
    return [`profile-memory:${payload.profile_memory_id}`];
  }

  if (route.route_kind === 'personal_episode_lookup' && payload.personal_episode_id) {
    return [`personal-episode:${payload.personal_episode_id}`];
  }

  const refs = payload.recommended_reads ?? [];
  const collected = refs.map((read) => {
    if (read.node_kind === 'section' && read.section_id) {
      return `section:${read.section_id}`;
    }
    if (read.page_slug) {
      return `page:${read.page_slug}`;
    }
    return null;
  }).filter((value): value is string => value !== null);

  return [...new Set(collected)];
}
