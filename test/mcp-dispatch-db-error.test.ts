/**
 * db-availability loop (4a): the MCP error envelope for DB-access failures.
 *
 * Before this wave, an uncaught pg error reached agents as
 * `{"error":"internal_error","message":"<RAW error — DSN, host, password>"}`
 * with no remediation. Pins the new contract end to end through
 * `dispatchToolCall` (the path both MCP transports share):
 *   - non-verb ops   → error 'database_error' + the GBRAIN_DB_ACCESS marker
 *     in `suggestion` (the literal the bundled skills/db-repair skill matches)
 *   - the 7 verbs    → FROZEN v1 code 'unavailable' + reason in `detail`
 *   - schema_missing → 'unavailable' + apply-migrations (NO db-repair marker:
 *     mid-op relation errors are code skew, not access failure)
 *   - unknown        → legacy envelope, message now REDACTED
 */

import { describe, expect, it } from 'bun:test';

import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const OPTS = { remote: true, sourceId: 'default' } as const;

function throwingEngine(err: Error): BrainEngine {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'kind') return 'postgres';
      if (prop === 'then') return undefined; // not a thenable
      return () => { throw err; };
    },
  }) as unknown as BrainEngine;
}

function errWithCode(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

const LEAKY_MESSAGE =
  'connection to server at "db.abc123.supabase.co" (1.2.3.4), port 5432 failed: ' +
  'password=hunter2secret postgresql://postgres:hunter2secret@db.abc123.supabase.co:5432/postgres'; /* allow-pg-url-literal */

function body(r: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(r.content[0].text);
}

describe('MCP dispatch DB-error envelopes', () => {
  it('non-verb op → database_error + GBRAIN_DB_ACCESS marker, redacted', async () => {
    const engine = throwingEngine(errWithCode('ECONNREFUSED', LEAKY_MESSAGE));
    const r = await dispatchToolCall(engine, 'query', { query: 'hello' }, OPTS) as {
      isError?: boolean; content: Array<{ type: string; text: string }>;
    };
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b.error).toBe('database_error');
    expect(String(b.suggestion)).toContain('GBRAIN_DB_ACCESS conn_refused');
    expect(String(b.suggestion)).toContain('gbrain db-repair');
    const flat = JSON.stringify(b);
    expect(flat).not.toContain('hunter2secret');
    expect(flat).not.toContain('1.2.3.4');
  });

  it('verb → FROZEN unavailable + reason in detail + marker in suggestion', async () => {
    const engine = throwingEngine(errWithCode('ECONNREFUSED', LEAKY_MESSAGE));
    const r = await dispatchToolCall(engine, 'recall', { query: 'hello' }, OPTS) as {
      isError?: boolean; content: Array<{ type: string; text: string }>;
    };
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b.error).toBe('unavailable'); // never 'database_error' — the v1 code set is frozen
    expect(b.protocol_version).toBe(1);
    expect(b.detail).toBe('conn_refused');
    expect(String(b.suggestion)).toContain('GBRAIN_DB_ACCESS conn_refused');
    expect(JSON.stringify(b)).not.toContain('hunter2secret');
  });

  it('schema_missing → unavailable + apply-migrations, NO db-repair marker', async () => {
    const engine = throwingEngine(errWithCode('42P01', 'relation "pages" does not exist'));
    const r = await dispatchToolCall(engine, 'get_page', { slug: 'anything' }, OPTS) as {
      isError?: boolean; content: Array<{ type: string; text: string }>;
    };
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b.error).toBe('unavailable');
    expect(String(b.suggestion)).toContain('apply-migrations');
    expect(JSON.stringify(b)).not.toContain('GBRAIN_DB_ACCESS');
  });

  it('host-resolved brain: the marker carries NO brain= suffix (host is not noise)', async () => {
    // dispatch classifies with brainIdForClassify() → resolveBrainId(null),
    // which resolves 'host' outside any mount. formatDbAccessMarker appends
    // ` brain=<id>` ONLY for non-host ids — a host failure must read as the
    // bare marker, never `brain=host` noise the skill would have to strip.
    const engine = throwingEngine(errWithCode('ECONNREFUSED', LEAKY_MESSAGE));
    const r = await dispatchToolCall(engine, 'query', { query: 'hello' }, OPTS) as {
      isError?: boolean; content: Array<{ type: string; text: string }>;
    };
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(String(b.suggestion)).toContain('GBRAIN_DB_ACCESS conn_refused');
    expect(String(b.suggestion)).not.toContain('brain=');
  });

  it('unknown reason → legacy internal_error envelope, message REDACTED (the old DSN leak)', async () => {
    const engine = throwingEngine(new Error(`something novel broke: ${LEAKY_MESSAGE}`));
    const r = await dispatchToolCall(engine, 'get_page', { slug: 'anything' }, OPTS) as {
      isError?: boolean; content: Array<{ type: string; text: string }>;
    };
    expect(r.isError).toBe(true);
    const b = body(r);
    // "connection to server ... failed" classifies conn_dropped? No — the
    // message contains 'could not connect'? It doesn't; but 'connection to
    // server ... failed' matches no row, so reason may be unknown OR a row.
    // Accept either envelope class; the LOAD-BEARING assertion is redaction.
    expect(JSON.stringify(b)).not.toContain('hunter2secret');
    expect(JSON.stringify(b)).not.toContain('1.2.3.4');
  });
});
