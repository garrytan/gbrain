import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type TracerProvider,
} from '@opentelemetry/api';

const TRACER_NAME = 'gbrain.search';

const OPERATION_NAMES = new Set(['query', 'search']);
const STAGE_NAMES = new Set([
  'cache_embedding',
  'cache_lookup',
  'config_cache',
  'config_embedding',
  'config_keyword_only',
  'config_mode',
  'expansion',
  'keyword',
  'query_embedding',
  'vector',
  'relational',
  'fusion',
  'post_fusion',
  'rerank',
  'alias_hop',
  'return_policy',
  'serialize',
  'hot_memory',
]);

const SAFE_ATTRIBUTE_KEYS = new Set([
  'attempt_count',
  'brain_id',
  'cache_status',
  'candidate_count',
  'decision',
  'error_class',
  'fallback',
  'gbrain_version',
  'mode',
  'model',
  'operation',
  'outcome',
  'provider',
  'query_length',
  'result_count',
  'resolved_mode',
  'runtime_generation',
  'runtime_version',
  'timeout_ms',
  'workspace_id',
]);

let testProvider: (TracerProvider & { shutdown?: () => Promise<void> }) | undefined;

const LANGFUSE_OBSERVATION_INPUT = 'langfuse.observation.input';
const LANGFUSE_OBSERVATION_OUTPUT = 'langfuse.observation.output';

function profileName(kind: 'operation' | 'stage', name: string): string {
  const allowed = kind === 'operation' ? OPERATION_NAMES : STAGE_NAMES;
  if (!allowed.has(name)) throw new Error(`unknown GBrain profile ${kind}: ${name}`);
  return kind === 'operation' ? `gbrain.operation.${name}` : `gbrain.search.${name}`;
}

function safeAttributes(attributes: Record<string, unknown>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
    }
  }
  return out;
}

export function classifyProfileError(error: unknown): string {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (name.includes('timeout') || message.includes('timeout') || message.includes('deadline') || message.includes('aborted')) {
    return 'timeout';
  }
  if (message.includes('unavailable') || message.includes('network') || message.includes('fetch')) {
    return 'unavailable';
  }
  return 'error';
}

async function profile<T>(
  kind: 'operation' | 'stage',
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const input = safeAttributes(attributes);
  return tracer.startActiveSpan(profileName(kind, name), { attributes: input }, async (span) => {
    setObservationAttribute(span, LANGFUSE_OBSERVATION_INPUT, input);
    try {
      const result = await fn();
      span.setAttribute('outcome', 'success');
      setObservationAttribute(span, LANGFUSE_OBSERVATION_OUTPUT, summarizeProfileResult(result));
      return result;
    } catch (error) {
      span.setAttribute('outcome', 'error');
      span.setAttribute('error_class', classifyProfileError(error));
      setObservationAttribute(span, LANGFUSE_OBSERVATION_OUTPUT, {
        error_class: classifyProfileError(error),
        outcome: 'error',
      });
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

function setObservationAttribute(
  span: Span,
  key: string,
  value: Record<string, unknown>,
): void {
  span.setAttribute(key, JSON.stringify(value));
}

function summarizeProfileResult(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { result_count: value.length, result_type: 'array' };
  if (value instanceof Float32Array) return { dimensions: value.length, result_type: 'vector' };
  if (value === null) return { result_type: 'null' };
  return { result_type: typeof value };
}

export function profileOperation<T>(
  name: 'query' | 'search',
  attributes: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  return profile('operation', name, attributes, fn);
}

export function profileStage<T>(
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T> | T,
): Promise<T> {
  return profile('stage', name, attributes, fn);
}

export function setActiveProfileAttributes(attributes: Record<string, unknown>): void {
  trace.getActiveSpan()?.setAttributes(safeAttributes(attributes));
}

export function setProfileProviderForTests(provider: TracerProvider): void {
  trace.disable();
  testProvider = provider;
  trace.setGlobalTracerProvider(provider);
}

export async function resetProfileProviderForTests(): Promise<void> {
  const provider = testProvider;
  testProvider = undefined;
  trace.disable();
  if (provider?.shutdown) await provider.shutdown().catch(() => undefined);
}
