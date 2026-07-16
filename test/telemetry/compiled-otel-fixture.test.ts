import { describe, expect, test } from 'bun:test';

import { runCompiledOtelFixture } from './compiled-otel-fixture';

describe('compiled OpenTelemetry fixture', () => {
  test('preserves awaited parent context and exports completed spans', async () => {
    let requests = 0;
    const receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/v1/traces') {
          requests += 1;
          await request.arrayBuffer();
          return new Response(null, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });

    try {
      const result = await runCompiledOtelFixture(`http://127.0.0.1:${receiver.port}/v1/traces`);

      expect(result.completed).toBe(true);
      expect(result.childTraceId).toBe(result.rootTraceId);
      expect(result.childParentSpanId).toBe(result.rootSpanId);
      expect(requests).toBeGreaterThan(0);
    } finally {
      receiver.stop(true);
    }
  });
});
