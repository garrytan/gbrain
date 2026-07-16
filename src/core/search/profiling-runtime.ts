import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { registerBackgroundWorkDrainer } from '../background-work.ts';

export interface QueryProfilingConfig {
  endpoint: string;
  authorization?: string;
  resource: Record<string, string>;
}

type Environment = Record<string, string | undefined>;

export function readQueryProfilingConfig(env: Environment = process.env): QueryProfilingConfig | null {
  const endpoint = env.GBRAIN_OTEL_TRACES_ENDPOINT?.trim();
  if (!endpoint || !/^https?:\/\//i.test(endpoint)) return null;

  const serviceName = env.GBRAIN_OTEL_SERVICE_NAME?.trim() || 'gbrain';
  const resource: Record<string, string> = {
    'service.name': serviceName,
  };
  Object.assign(resource, readResourceAttributes(env.GBRAIN_OTEL_RESOURCE_ATTRIBUTES));
  const runtimeGeneration = env.GBRAIN_RUNTIME_GENERATION?.trim();
  const runtimeVersion = env.GBRAIN_RUNTIME_VERSION?.trim();
  if (runtimeGeneration) resource['gbrain.runtime_generation'] = runtimeGeneration;
  if (runtimeVersion) resource['gbrain.runtime_version'] = runtimeVersion;

  const authorization = env.GBRAIN_OTEL_AUTHORIZATION?.trim();
  return authorization ? { authorization, endpoint, resource } : { endpoint, resource };
}

let provider: NodeTracerProvider | null = null;

export function initializeQueryProfiling(env: Environment = process.env): boolean {
  if (provider) return true;
  const config = readQueryProfilingConfig(env);
  if (!config) return false;

  const exporter = new OTLPTraceExporter({
    url: config.endpoint,
    ...(config.authorization ? { headers: { Authorization: config.authorization } } : {}),
  });
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes(config.resource),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        exportTimeoutMillis: 1_000,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 250,
      }),
    ],
  });
  provider.register({ contextManager: new AsyncLocalStorageContextManager() });
  return true;
}

export async function shutdownQueryProfiling(timeoutMs = 1_500): Promise<void> {
  const active = provider;
  provider = null;
  if (!active) return;

  const shutdown = (async () => {
    await active.forceFlush().catch(() => undefined);
    await active.shutdown().catch(() => undefined);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    shutdown,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

registerBackgroundWorkDrainer({
  name: 'query-profiling',
  order: -1,
  drain: async (timeoutMs) => {
    await shutdownQueryProfiling(timeoutMs);
    return { unfinished: 0 };
  },
});

function readResourceAttributes(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const allowed = new Set(['langfuse.environment', 'gbrain.runtime_generation', 'gbrain.runtime_version']);
  const attributes: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (allowed.has(key) && value.length > 0 && value.length <= 128) attributes[key] = value;
  }
  return attributes;
}
