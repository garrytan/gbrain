# AI gateway tracing with OpenTelemetry

GBrain can emit provider-neutral traces for AI gateway chat, expansion, and OCR
calls. Tracing is disabled by default and does not proxy or rewrite provider
requests.

## Enable OTLP export

Configure a standard OTLP/HTTP traces endpoint and headers, then opt GBrain in:

```sh
export GBRAIN_OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="https://your-collector.example/v1/traces"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=..."
export OTEL_SERVICE_NAME=gbrain
```

For a Langfuse project, use its OTLP traces endpoint and Basic authorization
header. Keep the public and secret keys in environment variables or your
service manager's secret store, not in `~/.gbrain/config.json`.

To export only native Anthropic generations:

```sh
export GBRAIN_OTEL_PROVIDERS=anthropic
```

The provider call remains `native-anthropic`. Existing system/tool cache
breakpoints and provider options are unchanged. Vercel AI SDK spans include
provider response usage, including cache-read and cache-write input tokens.
Langfuse can use those fields for cache-aware usage and cost reporting.

## Content privacy

Prompt and completion content are excluded by default. Usage, model, timing,
status, provider, tool count, and whether GBrain enabled prompt caching remain
available.

Enable content capture only after reviewing the sensitivity of the brain:

```sh
export GBRAIN_OTEL_RECORD_INPUTS=true
export GBRAIN_OTEL_RECORD_OUTPUTS=true
```

These are separate opt-ins so an operator can capture one direction without
capturing the other.

## Failure behavior

The exporter initializes lazily on the first traced AI call and batches spans
in the background. Initialization/export problems do not fail inference.
GBrain's normal CLI teardown drains the trace processor with the other
registered background sinks; persistent HTTP, supervisor, and autopilot
processes export batches continuously.
