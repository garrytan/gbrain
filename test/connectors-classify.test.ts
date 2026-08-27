/**
 * connectors-classify.test.ts — the pure §2A/§2B response classifier.
 */
import { describe, expect, test } from 'bun:test';
import { classifyResponse } from '../src/core/connectors/classify.ts';

function res(status: number, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return { status, headers: { get: (n: string) => h.get(n) } };
}

describe('classifyResponse', () => {
  test('200 JSON → ok', () => {
    expect(classifyResponse(res(200, { 'content-type': 'application/json' }), '{"items":[]}').kind).toBe('ok');
  });
  test('401 → auth_required', () => {
    expect(classifyResponse(res(401), '{"error":"expired"}').kind).toBe('auth_required');
  });
  test('403 + HTML/Cloudflare → forbidden_fingerprint', () => {
    const body = '<!DOCTYPE html><html><title>Just a moment...</title>cf-browser-verification</html>';
    expect(classifyResponse(res(403, { 'content-type': 'text/html' }), body).kind).toBe('forbidden_fingerprint');
  });
  test('403 + JSON body → auth_required (§2A)', () => {
    expect(classifyResponse(res(403, { 'content-type': 'application/json' }), '{"error":"token_expired"}').kind).toBe('auth_required');
  });
  test('403 + www-authenticate → auth_required', () => {
    expect(classifyResponse(res(403, { 'www-authenticate': 'Bearer' }), 'nope').kind).toBe('auth_required');
  });
  test('403 opaque non-JSON, no markers → forbidden_fingerprint (safer of the two for bot walls)', () => {
    expect(classifyResponse(res(403), 'blocked').kind).toBe('forbidden_fingerprint');
  });
  test('429 + Retry-After → rate_limited with delay (nowMs injected)', () => {
    const c = classifyResponse(res(429, { 'retry-after': '2' }), '', 1000);
    expect(c.kind).toBe('rate_limited');
    expect(c.retryAfterMs).toBe(2000);
  });
  test('500 → server_error', () => {
    expect(classifyResponse(res(500), 'boom').kind).toBe('server_error');
  });
  test('200 but a Cloudflare HTML challenge body → forbidden_fingerprint', () => {
    const body = '<!DOCTYPE html><html>Just a moment... challenge-platform</html>';
    expect(classifyResponse(res(200, { 'content-type': 'text/html' }), body).kind).toBe('forbidden_fingerprint');
  });
});
