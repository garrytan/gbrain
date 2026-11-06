/**
 * A fake Wakeshift (https://wakeshift.ai/docs/http-api) for the report-back tests: Bun.serve on a loopback port
 * with the endpoints gbrain calls. Every request's assertion is verified against the key's public key (EdDSA,
 * typ app+jwt, kid, aud, 120 s life, a jti never seen before), and every call is recorded. `respond` overrides an
 * endpoint's answer (status, body, headers) for failure tests.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { parseWakeshiftKey } from '../../src/core/wakeshift/client.ts';

const MANIFEST_EVENT_FIELDS = new Set(['name', 'description', 'arguments', 'payload', 'topic', 'filter', 'personal', 'delete_on_delivery']);

export interface FakeCall { path: string; body: any; assertionOk: boolean; problem?: string }
type Answer = { status: number; body: unknown; headers?: Record<string, string> };

export interface FakeWakeshift {
  url: string;
  calls: FakeCall[];
  respond: Map<string, (body: any) => Answer | Promise<Answer>>;
  stop(): void;
}

export function startFakeWakeshift(rawKey: string): FakeWakeshift {
  const key = parseWakeshiftKey(rawKey);
  const pub: KeyObject = createPublicKey(key.privateKey);
  const spki = pub.export({ format: 'der', type: 'spki' });
  const kid = createHash('sha256').update(spki.subarray(spki.length - 32)).digest().subarray(0, 16).toString('base64url');
  const seenJti = new Set<string>();
  const calls: FakeCall[] = [];
  const respond = new Map<string, (body: any) => Answer | Promise<Answer>>();
  let subSeq = 0;
  const subs = new Map<string, string>();
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/api\/apps\/v1/, '');
      const text = await req.text();
      const body = text ? JSON.parse(text) : null;
      let problem: string | undefined;
      const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const [h, c, s] = token.split('.');
      try {
        const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
        const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
        if (header.alg !== 'EdDSA' || header.typ !== 'app+jwt' || header.kid !== kid) problem = 'header';
        else if (claims.iss !== kid || claims.sub !== kid || claims.aud !== `${url}/api/apps`) problem = 'claims';
        else if (claims.exp - claims.iat !== 120 || Math.abs(claims.iat - Date.now() / 1000) > 60) problem = 'lifetime';
        else if (!claims.jti || seenJti.has(claims.jti)) problem = 'jti';
        else if (!verify(null, Buffer.from(`${h}.${c}`), pub, Buffer.from(s!, 'base64url'))) problem = 'signature';
        seenJti.add(claims.jti);
      } catch { problem = 'malformed'; }
      calls.push({ path, body, assertionOk: !problem, ...(problem ? { problem } : {}) });
      if (problem) return Response.json({ error: { code: 'unauthenticated', message: problem } }, { status: 401 });
      const override = respond.get(path);
      if (override) {
        const a = await override(body);
        return Response.json(a.body, { status: a.status, headers: a.headers ?? {} });
      }
      switch (path) {
        case '/app': return Response.json({ id: 'app_test', name: 'gbrain-test', key: { key_id: 'key_1', name: 'test key' } });
        case '/manifest/merge': {
          const extra = (body?.events ?? []).flatMap((e: Record<string, unknown>) => Object.keys(e).filter(k => !MANIFEST_EVENT_FIELDS.has(k)));
          if (extra.length) return Response.json({ error: { code: 'bad_request', message: `invalid JSON: json: unknown field "${extra[0]}"` } }, { status: 400 });
          return Response.json({ events: body?.events ?? [] });
        }
        case '/event-subscriptions': {
          const k = `${body.call.user}|${body.name}|${JSON.stringify(body.arguments)}`;
          const created = !subs.has(k);
          if (created) subs.set(k, `sub_${++subSeq}`);
          return Response.json({
            event_subscription: { id: subs.get(k), user: body.call.user, event: body.name, arguments: body.arguments, created, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() },
            addition: { text: 'Wakeshift: this conversation is subscribed (secret-addition-text).', meta: { 'wakeshift/session': 'secret-addition-meta' } }, session: 'claude-code#1',
            agent: { harness: body.call.client === 'claude-code' ? 'claude-code' : null, via: body.call.client === 'claude-code' ? 'client' : null, claimed: body.call.harness ?? null },
          });
        }
        case '/event-subscriptions/unsubscribe': return Response.json({ ended: true });
        case '/event-subscriptions/end': return Response.json({ ended: true });
        case '/events/emit': return Response.json({ matched: 1, duplicate: false, unmatched: [], ended: [] });
        default: return Response.json({ error: { code: 'bad_request', message: `unknown path ${path}` } }, { status: 400 });
      }
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { url, calls, respond, stop: () => server.stop(true) };
}
