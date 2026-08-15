/**
 * Unit tests for src/core/ai/probes.ts (probeOpenAICompat).
 *
 * Runs against a local Bun.serve fixture on an ephemeral port (port: 0) so
 * no real daemon is needed. Pins:
 *   - models extraction from a valid {object:'list', data:[...]} body, with
 *     non-string / missing ids filtered out
 *   - non-list JSON body → models_endpoint_valid false, models undefined
 *   - connection refused → reachable false
 */

import { describe, test, expect } from 'bun:test';
import { probeOpenAICompat } from '../src/core/ai/probes.ts';

describe('probeOpenAICompat — models extraction', () => {
  test('valid list body extracts string ids only', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ object: 'list', data: [{ id: 'm1' }, { id: 42 }, {}] });
      },
    });
    try {
      const r = await probeOpenAICompat(`http://127.0.0.1:${server.port}`);
      expect(r.reachable).toBe(true);
      expect(r.models_endpoint_valid).toBe(true);
      expect(r.models).toEqual(['m1']);
    } finally {
      server.stop(true);
    }
  });

  test('non-list JSON body → valid false, models undefined', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ hello: 'world' });
      },
    });
    try {
      const r = await probeOpenAICompat(`http://127.0.0.1:${server.port}`);
      expect(r.reachable).toBe(true);
      expect(r.models_endpoint_valid).toBe(false);
      expect(r.models).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test('connection refused → reachable false', async () => {
    // Grab an ephemeral port by binding, then release it before probing so
    // the connection is refused (nothing else claims the port that fast).
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('unused');
      },
    });
    const port = server.port;
    try {
      await server.stop(true);
      const r = await probeOpenAICompat(`http://127.0.0.1:${port}`);
      expect(r.reachable).toBe(false);
      expect(r.error).toBeDefined();
    } finally {
      server.stop(true);
    }
  });
});
