import { describe, expect, test } from 'bun:test';

import { readQueryProfilingConfig } from '../../src/core/search/profiling-runtime.ts';

describe('query profiling runtime configuration', () => {
  test('requires an explicit OTLP endpoint and keeps configuration bounded', () => {
    expect(readQueryProfilingConfig({})).toBeNull();
    expect(readQueryProfilingConfig({
      GBRAIN_OTEL_TRACES_ENDPOINT: 'https://telemetry.example.test/v1/traces',
      GBRAIN_OTEL_SERVICE_NAME: 'gbrain-e2e',
      GBRAIN_RUNTIME_GENERATION: 'generation-7',
      GBRAIN_RUNTIME_VERSION: '0.42.57.0',
    })).toEqual({
      endpoint: 'https://telemetry.example.test/v1/traces',
      resource: {
        'gbrain.runtime_generation': 'generation-7',
        'gbrain.runtime_version': '0.42.57.0',
        'service.name': 'gbrain-e2e',
      },
    });
  });

  test('does not enable exporting from unrelated environment values', () => {
    expect(readQueryProfilingConfig({ DATABASE_URL: 'postgres://secret' })).toBeNull();
  });

  test('accepts bounded allowlisted resource attributes for isolated acceptance', () => {
    expect(readQueryProfilingConfig({
      GBRAIN_OTEL_RESOURCE_ATTRIBUTES: 'langfuse.environment=e2e,secret=must-ignore,service.name=ignored',
      GBRAIN_OTEL_TRACES_ENDPOINT: 'https://telemetry.example.test/v1/traces',
    })).toEqual({
      endpoint: 'https://telemetry.example.test/v1/traces',
      resource: {
        'langfuse.environment': 'e2e',
        'service.name': 'gbrain',
      },
    });
  });
});
