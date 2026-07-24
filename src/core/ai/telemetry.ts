/**
 * Opt-in OpenTelemetry bootstrap for Vercel AI SDK calls.
 *
 * Disabled by default. Standard OTLP environment variables configure the
 * exporter, keeping the gateway vendor-neutral and provider-direct.
 */

import type { TelemetrySettings } from 'ai';
import { VERSION } from '../../version.ts';
import { registerBackgroundWorkDrainer } from '../background-work.ts';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

function envEnabled(name: string): boolean {
  return ENABLED_VALUES.has((process.env[name] ?? '').trim().toLowerCase());
}

let initPromise: Promise<void> | null = null;
let initialized = false;
let initWarningEmitted = false;
let tracerProvider: {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
} | null = null;

export function isAiTelemetryEnabled(): boolean {
  return envEnabled('GBRAIN_OTEL_ENABLED');
}

/**
 * Register one process-global OTLP tracer provider. Initialization is lazy so
 * disabled installations do not load the OpenTelemetry SDK or change startup
 * behavior. Fail-open by design: observability must never break inference.
 */
export async function initializeAiTelemetry(): Promise<void> {
  if (!isAiTelemetryEnabled() || initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const [
        { OTLPTraceExporter },
        { resourceFromAttributes },
        { BatchSpanProcessor },
        { NodeTracerProvider },
        { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
      ] = await Promise.all([
        import('@opentelemetry/exporter-trace-otlp-http'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/sdk-trace-base'),
        import('@opentelemetry/sdk-trace-node'),
        import('@opentelemetry/semantic-conventions'),
      ]);

      const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'gbrain',
          [ATTR_SERVICE_VERSION]: VERSION,
        }),
        spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
      });
      provider.register();
      tracerProvider = provider;
      initialized = true;
    } catch (err) {
      if (!initWarningEmitted) {
        initWarningEmitted = true;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[ai.telemetry] OTLP initialization failed; inference will continue untraced: ${message}`);
      }
    }
  })();

  return initPromise;
}

export interface GbrainTelemetryContext {
  functionId: string;
  provider: string;
  model: string;
  metadata?: Record<string, string | number | boolean>;
}

function providerEnabled(provider: string): boolean {
  const raw = process.env.GBRAIN_OTEL_PROVIDERS;
  if (!raw?.trim()) return true;
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .includes(provider.toLowerCase());
}

/**
 * Cache-read/cache-write token attributes come from the provider response and
 * are emitted by AI SDK independently of content recording.
 */
export function aiTelemetrySettings(context: GbrainTelemetryContext): TelemetrySettings | undefined {
  if (!isAiTelemetryEnabled() || !providerEnabled(context.provider)) return undefined;
  return {
    isEnabled: true,
    functionId: context.functionId,
    recordInputs: envEnabled('GBRAIN_OTEL_RECORD_INPUTS'),
    recordOutputs: envEnabled('GBRAIN_OTEL_RECORD_OUTPUTS'),
    metadata: {
      'gbrain.provider': context.provider,
      'gbrain.model': context.model,
      ...context.metadata,
    },
  };
}

/** Test-only reset; production never calls this. */
export function __resetAiTelemetryForTests(): void {
  initPromise = null;
  initialized = false;
  initWarningEmitted = false;
}

registerBackgroundWorkDrainer({
  name: 'ai-telemetry',
  order: 4,
  async drain(timeoutMs) {
    if (!tracerProvider) return { unfinished: 0 };
    let finished = false;
    await Promise.race([
      tracerProvider.forceFlush().then(() => { finished = true; }),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return { unfinished: finished ? 0 : 1 };
  },
  async abort() {
    if (!tracerProvider) return;
    await Promise.race([
      tracerProvider.shutdown(),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]);
  },
});
