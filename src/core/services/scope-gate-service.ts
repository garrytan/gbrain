import type { BrainEngine } from '../engine.ts';
import type {
  ScopeGateDecisionInput,
  ScopeGateDecisionResult,
  ScopeGatePolicy,
  ScopeGateScope,
} from '../types.ts';

const WORK_SIGNAL_PATTERNS = [
  /\b(repo|repository|code|coding|docs?|architecture|issue|pr|pull request|test|branch)\b/i,
  /\/[\w./-]+\.(ts|tsx|js|jsx|md|json|sql)\b/i,
] as const;

const PERSONAL_SIGNAL_PATTERNS = [
  /\b(personal|routine|habit|daily|life|travel|health|preference|schedule)\b/i,
] as const;

export async function evaluateScopeGate(
  engine: BrainEngine,
  input: ScopeGateDecisionInput,
): Promise<ScopeGateDecisionResult> {
  const scope = await resolveScope(engine, input);
  const policy = resolvePolicy(input.intent, scope.resolved_scope);

  return {
    resolved_scope: scope.resolved_scope,
    policy,
    decision_reason: policy === 'deny' && input.intent !== 'task_resume'
      ? 'unsupported_scope_intent'
      : scope.decision_reason,
    summary_lines: buildSummaryLines(input.intent, scope.resolved_scope, policy),
  };
}

async function resolveScope(
  engine: BrainEngine,
  input: ScopeGateDecisionInput,
): Promise<{ resolved_scope: ScopeGateScope; decision_reason: string }> {
  if (input.intent === 'task_resume' && input.task_id) {
    const task = await engine.getTaskThread(input.task_id);
    if (task) {
      return {
        resolved_scope: task.scope,
        decision_reason: 'task_scope',
      };
    }
  }

  if (input.requested_scope) {
    return {
      resolved_scope: input.requested_scope,
      decision_reason: 'explicit_scope',
    };
  }

  if (input.task_id) {
    const task = await engine.getTaskThread(input.task_id);
    if (task) {
      return {
        resolved_scope: task.scope,
        decision_reason: 'task_scope',
      };
    }
  }

  const haystack = `${input.repo_path ?? ''}\n${input.query ?? ''}\n${input.subject ?? ''}\n${input.title ?? ''}`;
  const hasWorkSignals = WORK_SIGNAL_PATTERNS.some((pattern) => pattern.test(haystack));
  const hasPersonalSignals = PERSONAL_SIGNAL_PATTERNS.some((pattern) => pattern.test(haystack));

  if (hasWorkSignals && hasPersonalSignals) {
    return {
      resolved_scope: 'unknown',
      decision_reason: 'cross_scope_signal_without_explicit_scope',
    };
  }
  if (hasWorkSignals) {
    return {
      resolved_scope: 'work',
      decision_reason: 'work_signal',
    };
  }
  if (hasPersonalSignals) {
    return {
      resolved_scope: 'personal',
      decision_reason: 'personal_signal',
    };
  }

  return {
    resolved_scope: 'unknown',
    decision_reason: 'insufficient_signal',
  };
}

function resolvePolicy(intent: ScopeGateDecisionInput['intent'], scope: ScopeGateScope): ScopeGatePolicy {
  if (scope === 'unknown') {
    return 'defer';
  }
  if (intent === 'task_resume') {
    return 'allow';
  }
  if (intent === 'mixed_scope_bridge') {
    return scope === 'mixed' ? 'allow' : 'deny';
  }
  if (intent === 'personal_profile_lookup' || intent === 'personal_episode_lookup') {
    return scope === 'personal' ? 'allow' : 'deny';
  }
  if (scope === 'work') {
    return 'allow';
  }
  return 'deny';
}

function buildSummaryLines(
  intent: ScopeGateDecisionInput['intent'],
  scope: ScopeGateScope,
  policy: ScopeGatePolicy,
): string[] {
  const lines = [`Scope gate resolved ${intent} to ${scope} scope.`];

  if (policy === 'allow') {
    lines.push('Current published route stack may proceed under this scope.');
  } else if (policy === 'deny') {
    lines.push('Current published route stack must not proceed under this scope.');
  } else {
    lines.push('Scope is not safe enough to proceed without clarification.');
  }

  return lines;
}
