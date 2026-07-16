import { describe, expect, test } from 'bun:test';
import { context, trace } from '@opentelemetry/api';

import {
  extractPrivateTraceContext,
  privateTraceCarrier,
} from '../../src/mcp/dispatch.ts';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('private MCP trace propagation', () => {
  test('extracts standard trace context and ignores generic baggage', () => {
    const carrier = privateTraceCarrier({
      traceparent: TRACEPARENT,
      tracestate: 'vendor=value',
      baggage: 'secret=must-not-cross',
      query: 'must-not-cross',
    });
    const extracted = extractPrivateTraceContext(carrier);
    const spanContext = trace.getSpanContext(extracted);

    expect(spanContext?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(spanContext?.spanId).toBe('00f067aa0ba902b7');
    expect(privateTraceCarrier({ baggage: 'secret=must-not-cross' })).toEqual({});
    expect(carrier).toEqual({ traceparent: TRACEPARENT, tracestate: 'vendor=value' });
  });

  test('returns the active context for malformed or absent carriers', () => {
    const active = context.active();
    expect(extractPrivateTraceContext(undefined)).toBe(active);
    expect(extractPrivateTraceContext({ traceparent: 'not-a-trace' })).toBe(active);
  });
});
