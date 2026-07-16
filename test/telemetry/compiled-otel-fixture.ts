import { context, trace, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

export async function runCompiledOtelFixture(endpoint: string) {
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'gbrain-compiled-otel-fixture' }),
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }), {
        scheduledDelayMillis: 20,
        exportTimeoutMillis: 1_000,
        maxExportBatchSize: 10,
      }),
    ],
  });
  provider.register({ contextManager: new AsyncLocalStorageContextManager() });

  const tracer = trace.getTracer('gbrain-compiled-otel-fixture');
  const root = tracer.startSpan('fixture.root');
  let childTraceId = '';
  let childParentSpanId = '';

  await context.with(trace.setSpan(context.active(), root), async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    childParentSpanId = trace.getSpan(context.active())?.spanContext().spanId ?? '';
    const child = tracer.startSpan('fixture.child');
    child.setAttribute('fixture.stage', 'awaited');
    childTraceId = child.spanContext().traceId;
    child.end();
  });
  root.end();

  await provider.forceFlush();
  await provider.shutdown();

  return {
    childParentSpanId,
    childTraceId,
    completed: true,
    rootSpanId: root.spanContext().spanId,
    rootTraceId: root.spanContext().traceId,
  };
}

if (import.meta.main) {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) throw new Error('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is required');
  console.log(JSON.stringify(await runCompiledOtelFixture(endpoint)));
}
