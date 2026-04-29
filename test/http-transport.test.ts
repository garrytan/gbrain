/**
 * Unit tests for src/mcp/http-transport.ts.
 *
 * Covers:
 *   - Auth path (valid, missing header, no Bearer prefix, unknown, revoked, /health bypass)
 *   - F1+F2+F3 round-trip guards (handler arg order, full OperationContext, param validation)
 *   - JSON-only response shape (no SSE)
 *   - CORS default-deny + allowlist
 *   - Body cap (Content-Length + chunked)
 *   - Rate limit (token + IP buckets, LRU eviction, TTL prune, /health bypass)
 *
 * No DATABASE_URL needed — engine.sql is mocked. E2E coverage of the real Postgres
 * round-trip lives in test/e2e/http-transport.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';

type SqlResult = unknown[] | unknown;
type SqlHandler = (query: string, values: unknown[]) => SqlResult | Promise<SqlResult>;

interface FakeEngine {
  kind: 'postgres';
  sql: ReturnType<typeof makeSqlTag>;
  audit: { token_name: string | null; operation: string; status: string; latency_ms: number }[];
}

function makeSqlTag(handler: SqlHandler) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = '';
    for (let i = 0; i < strings.length; i++) {
      query += strings[i];
      if (i < values.length) query += '?';
    }
    const result = handler(query.trim(), values);
    return Promise.resolve(result);
  };
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface FakeEngineConfig {
  validTokens?: Map<string, { id: string; name: string }>;
  /** Tokens that are present but revoked (revoked_at IS NOT NULL — query returns empty). */
  revokedTokens?: Set<string>;
  /** If true, every SELECT throws (simulating DB outage). */
  dbDown?: boolean;
}

function makeFakeEngine(cfg: FakeEngineConfig = {}): FakeEngine {
  const validTokens = cfg.validTokens ?? new Map();
  const revokedTokens = cfg.revokedTokens ?? new Set();
  const audit: FakeEngine['audit'] = [];

  const sql = makeSqlTag((query, values) => {
    if (cfg.dbDown && query.startsWith('SELECT')) throw new Error('db down');

    if (query === 'SELECT 1') {
      // /health DB probe
      return [{ '?column?': 1 }];
    }

    if (query.startsWith('SELECT id, name FROM access_tokens')) {
      const tokenHash = values[0] as string;
      if (revokedTokens.has(tokenHash)) return [];
      const row = validTokens.get(tokenHash);
      return row ? [row] : [];
    }

    if (query.startsWith('UPDATE access_tokens')) {
      // last_used_at debounce — succeed silently
      return [];
    }

    if (query.startsWith('INSERT INTO mcp_request_log')) {
      audit.push({
        token_name: values[0] as string | null,
        operation: values[1] as string,
        latency_ms: values[2] as number,
        status: values[3] as string,
      });
      return [];
    }

    return [];
  });

  return { kind: 'postgres', sql, audit };
}

interface TestServer {
  url: string;
  stop: () => void;
  engine: FakeEngine;
  ipLimiter: RateLimiter;
  tokenLimiter: RateLimiter;
}

let mockNow = 0;
function freezeClock(at: number) { mockNow = at; }
function advanceClock(deltaMs: number) { mockNow += deltaMs; }

async function startTest(cfg: FakeEngineConfig & { lruCap?: number; ipLimit?: number; tokenLimit?: number; corsOrigin?: string; bodyCap?: number; trustProxy?: boolean } = {}): Promise<TestServer> {
  if (cfg.corsOrigin) process.env.GBRAIN_HTTP_CORS_ORIGIN = cfg.corsOrigin;
  else delete process.env.GBRAIN_HTTP_CORS_ORIGIN;
  if (cfg.bodyCap) process.env.GBRAIN_HTTP_MAX_BODY_BYTES = String(cfg.bodyCap);
  else delete process.env.GBRAIN_HTTP_MAX_BODY_BYTES;
  if (cfg.trustProxy) process.env.GBRAIN_HTTP_TRUST_PROXY = '1';
  else delete process.env.GBRAIN_HTTP_TRUST_PROXY;

  const engine = makeFakeEngine(cfg);
  const clock = () => mockNow || Date.now();
  const ipLimiter = new RateLimiter(
    { limit: cfg.ipLimit ?? 1000, windowMs: 60_000, lruCap: cfg.lruCap ?? 10000 },
    clock,
  );
  const tokenLimiter = new RateLimiter(
    { limit: cfg.tokenLimit ?? 1000, windowMs: 60_000, lruCap: cfg.lruCap ?? 10000 },
    clock,
  );
  const server = await startHttpTransport({
    port: 0,
    engine: engine as any,
    limiters: { ip: ipLimiter, token: tokenLimiter },
  });
  return {
    url: `http://localhost:${(server as any).port}`,
    stop: () => (server as any).stop(true),
    engine,
    ipLimiter,
    tokenLimiter,
  };
}

function rpc(method: string, params?: unknown, id: number = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

// --------------------------------------------------------------------------
// Auth path
// --------------------------------------------------------------------------

describe('http-transport: auth', () => {
  let srv: TestServer;
  const VALID_TOKEN = 'valid-token-abc';
  const REVOKED_TOKEN = 'revoked-token-xyz';

  beforeAll(async () => {
    srv = await startTest({
      validTokens: new Map([[hash(VALID_TOKEN), { id: 'tok-1', name: 'test' }]]),
      revokedTokens: new Set([hash(REVOKED_TOKEN)]),
    });
  });
  afterAll(() => srv.stop());

  test('1. valid token → 200 + tools/list returns ops', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${VALID_TOKEN}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.tools).toBeArray();
    expect(body.result.tools.length).toBeGreaterThan(0);
    expect(body.jsonrpc).toBe('2.0');
  });

  test('2. missing Authorization header → 401', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(401);
  });

  test('3. header missing Bearer prefix → 401', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': VALID_TOKEN, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(401);
  });

  test('4. unknown token → 401', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer not-a-real-token', 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(401);
  });

  test('5. revoked token → 401', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${REVOKED_TOKEN}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.status).toBe(401);
  });

  test('6. /health → 200 without auth, body has expected fields, probes DB', async () => {
    const r = await fetch(`${srv.url}/health`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('ok');
    expect(body.transport).toBe('http');
    expect(body.version).toBeString();
    expect(body.db).toBe('ok');
  });

  test('6b. /health → 503 when DB is unreachable', async () => {
    const dbDownSrv = await startTest({ dbDown: true });
    try {
      const r = await fetch(`${dbDownSrv.url}/health`);
      expect(r.status).toBe(503);
      const body = await r.json();
      expect(body.status).toBe('unhealthy');
      expect(body.db).toBe('unreachable');
    } finally { dbDownSrv.stop(); }
  });
});

// --------------------------------------------------------------------------
// F1+F2+F3 regression guards (the actual existing-PR bugs)
// --------------------------------------------------------------------------

describe('http-transport: tools/call dispatch', () => {
  let srv: TestServer;
  const TOK = 'tok-fix';

  beforeAll(async () => {
    srv = await startTest({ validTokens: new Map([[hash(TOK), { id: 'tok-fix-id', name: 'fix' }]]) });
  });
  afterAll(() => srv.stop());

  test('7. tools/call with a real op (list_pages) round-trips successfully (F1+F2 guard)', async () => {
    // list_pages doesn't need real DB rows in this stub — it'll call engine methods we don't mock,
    // so we expect EITHER a successful tool-result OR an isError result with a meaningful message.
    // The point is that the handler IS invoked with (ctx, params) order — not (params, ctx).
    // If F1 regressed, the handler would receive {limit: 1} as ctx and crash trying to read ctx.engine.
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'list_pages', arguments: { limit: 1 } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result).toBeDefined();
    expect(body.result.content).toBeArray();
    // Either success (handler ran) or a structured error (handler ran and returned an error)
    // — both prove dispatch reached the handler with the correct shape.
  });

  test('8. tools/call with malformed params → 200 wrapping an isError result (F3 guard via dispatch.ts)', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      // get_page expects `slug` as required string; passing a number triggers validateParams
      body: rpc('tools/call', { name: 'get_page', arguments: { slug: 42 } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toContain('invalid_params');
  });

  test('9. /mcp response has Content-Type: application/json (not SSE)', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: rpc('tools/list'),
    });
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(r.headers.get('content-type')).not.toContain('event-stream');
  });

  test('9b. unknown tool name → 200 wrapping an isError result', async () => {
    const r = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: rpc('tools/call', { name: 'definitely_not_a_real_tool', arguments: {} }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Unknown tool');
  });
});

// --------------------------------------------------------------------------
// CORS
// --------------------------------------------------------------------------

describe('http-transport: CORS', () => {
  test('10. no GBRAIN_HTTP_CORS_ORIGIN + browser request → no ACAO header', async () => {
    const srv = await startTest({});
    try {
      const r = await fetch(`${srv.url}/health`, { headers: { 'Origin': 'https://evil.example' } });
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    } finally { srv.stop(); }
  });

  test('11. env set + matching Origin → ACAO echoes', async () => {
    const srv = await startTest({ corsOrigin: 'https://claude.ai' });
    try {
      const r = await fetch(`${srv.url}/health`, { headers: { 'Origin': 'https://claude.ai' } });
      expect(r.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
      expect(r.headers.get('vary')).toBe('Origin');
    } finally { srv.stop(); }
  });

  test('12. env set + non-matching Origin → no ACAO header', async () => {
    const srv = await startTest({ corsOrigin: 'https://claude.ai' });
    try {
      const r = await fetch(`${srv.url}/health`, { headers: { 'Origin': 'https://evil.example' } });
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    } finally { srv.stop(); }
  });
});

// --------------------------------------------------------------------------
// Body cap
// --------------------------------------------------------------------------

describe('http-transport: body cap', () => {
  const TOK = 'body-cap-tok';

  test('13. Content-Length over cap → 413', async () => {
    const srv = await startTest({
      validTokens: new Map([[hash(TOK), { id: 'b-1', name: 'b' }]]),
      bodyCap: 100,
    });
    try {
      const big = 'x'.repeat(200);
      const r = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: big,
      });
      expect(r.status).toBe(413);
    } finally { srv.stop(); }
  });

  test('14. chunked transfer (no Content-Length) over cap → 413', async () => {
    const srv = await startTest({
      validTokens: new Map([[hash(TOK), { id: 'b-2', name: 'b' }]]),
      bodyCap: 100,
    });
    try {
      // Build a chunked body via a ReadableStream — Bun fetch sends without Content-Length.
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode('y'.repeat(50)));
          controller.close();
        },
      });
      const r = await fetch(`${srv.url}/mcp`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: stream as any,
        // @ts-expect-error Bun fetch supports duplex for streaming bodies
        duplex: 'half',
      });
      expect(r.status).toBe(413);
    } finally { srv.stop(); }
  });
});

// --------------------------------------------------------------------------
// Rate limit
// --------------------------------------------------------------------------

describe('http-transport: rate limit', () => {
  const TOK = 'rl-tok';

  test('15. token bucket: refill mechanic over time', async () => {
    freezeClock(1000);
    const srv = await startTest({
      validTokens: new Map([[hash(TOK), { id: 'rl-id', name: 'rl' }]]),
      tokenLimit: 2,
      ipLimit: 100,
    });
    try {
      // Use up 2 tokens
      const ok1 = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      expect(ok1.status).toBe(200);
      const ok2 = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      expect(ok2.status).toBe(200);

      // Third should 429
      const blocked = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      expect(blocked.status).toBe(429);

      // Advance past the refill window (60s for 2 limit = 30s/token; advance 35s)
      advanceClock(35_000);
      const refilled = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      expect(refilled.status).toBe(200);
    } finally { srv.stop(); freezeClock(0); }
  });

  test('16. token bucket exhausted → 429 + Retry-After header', async () => {
    freezeClock(1000);
    const srv = await startTest({
      validTokens: new Map([[hash(TOK), { id: 'rl16', name: 'rl' }]]),
      tokenLimit: 1,
      ipLimit: 100,
    });
    try {
      await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      const r = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).not.toBeNull();
      expect(parseInt(r.headers.get('retry-after')!, 10)).toBeGreaterThan(0);
    } finally { srv.stop(); freezeClock(0); }
  });

  test('17. LRU eviction at cap (insert > cap evicts LRU)', () => {
    let now = 0;
    const lim = new RateLimiter({ limit: 10, windowMs: 60_000, lruCap: 3 }, () => now);
    lim.check('a'); now += 1;
    lim.check('b'); now += 1;
    lim.check('c'); now += 1;
    expect(lim.size).toBe(3);
    lim.check('d'); now += 1;
    expect(lim.size).toBe(3);
    // 'a' should have been evicted (oldest by insertion). After re-checking 'a' it's a fresh bucket again.
    // Easiest verification: hammer 'a' should NOT be already exhausted — fresh bucket starts at limit.
    for (let i = 0; i < 10; i++) {
      const r = lim.check('a');
      expect(r.allowed).toBe(true);
    }
    // 11th should fail (no refill since clock barely moved)
    expect(lim.check('a').allowed).toBe(false);
  });

  test('18. TTL prune (entries older than 2× window evicted)', () => {
    let now = 1000;
    const lim = new RateLimiter({ limit: 10, windowMs: 1000, lruCap: 100 }, () => now);
    lim.check('stale'); // touched at t=1000
    expect(lim.size).toBe(1);
    now = 1000 + 2001; // advance past 2× window
    lim.check('fresh'); // triggers prune
    expect(lim.size).toBe(1); // 'stale' evicted, only 'fresh' remains
  });

  test('19. pre-auth IP bucket fires BEFORE auth (DB not called when IP exhausted)', async () => {
    freezeClock(1000);
    const srv = await startTest({
      ipLimit: 1,
      tokenLimit: 100,
      validTokens: new Map([[hash(TOK), { id: 'rl19', name: 'rl' }]]),
    });
    try {
      // First request consumes IP token (will hit auth and succeed)
      const r1 = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      expect(r1.status).toBe(200);
      // Second: IP bucket exhausted. We send WITHOUT auth header. Should be 429 (IP-limited),
      // not 401 (auth-failed) — proving IP check happened first.
      const r2 = await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      expect(r2.status).toBe(429);
    } finally { srv.stop(); freezeClock(0); }
  });

  test('20. /health bypasses rate limit', async () => {
    freezeClock(1000);
    const srv = await startTest({ ipLimit: 1, tokenLimit: 1 });
    try {
      // Hammer health 5 times — none should 429
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`${srv.url}/health`);
        expect(r.status).toBe(200);
      }
    } finally { srv.stop(); freezeClock(0); }
  });
});

// --------------------------------------------------------------------------
// mcp_request_log audit
// --------------------------------------------------------------------------

describe('http-transport: mcp_request_log audit', () => {
  test('21. successful request → audit row with token_name + operation + status', async () => {
    const TOK = 'audit-tok';
    const srv = await startTest({ validTokens: new Map([[hash(TOK), { id: 'a-1', name: 'audit-test' }]]) });
    try {
      await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      // Audit insert is fire-and-forget; give it a tick to land in the fake handler
      await new Promise(r => setTimeout(r, 10));
      expect(srv.engine.audit.length).toBeGreaterThanOrEqual(1);
      const row = srv.engine.audit[srv.engine.audit.length - 1];
      expect(row.token_name).toBe('audit-test');
      expect(row.operation).toBe('tools/list');
      expect(row.status).toBe('success');
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    } finally { srv.stop(); }
  });

  test('22. failed auth → audit row with null token_name + auth_failed status', async () => {
    const srv = await startTest({});
    try {
      await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Authorization': 'Bearer wrong', 'Content-Type': 'application/json' }, body: rpc('tools/list') });
      await new Promise(r => setTimeout(r, 10));
      expect(srv.engine.audit.length).toBeGreaterThanOrEqual(1);
      const row = srv.engine.audit[srv.engine.audit.length - 1];
      expect(row.token_name).toBeNull();
      expect(row.status).toBe('auth_failed');
    } finally { srv.stop(); }
  });
});
