/**
 * WP4 (T9) — request_tools meta-op: catalog visibility (never leak hidden
 * names), read-only descriptor fetch (D5), and the {surface} persist branch
 * (D2 ceiling deny, operator lock, rate limit, no-clientId path, audit row,
 * migration-pending fallback).
 *
 * Exercised via dispatchToolCall against a real PGLite engine so the tests
 * cover the same envelope + validation path MCP clients hit.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  operations,
  __resetRequestToolsPersistLimiterForTests,
  type AuthInfo,
} from '../src/core/operations.ts';
import { VERB_NAMES } from '../src/core/verbs.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Pin the publish gates OFF on the DB plane (which wins over the file
  // plane) so the developer's real ~/.gbrain/config.json can't flip the
  // gated-op visibility assertions below.
  await engine.setConfig('mcp.publish_skills', 'false');
  await engine.setConfig('mcp.publish_advisor', 'false');
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  __resetRequestToolsPersistLimiterForTests();
});

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

interface CatalogEntry { area: string; tools: Array<{ name: string; one_line: string }> }

function flatNames(catalog: CatalogEntry[]): string[] {
  return catalog.flatMap(g => g.tools.map(t => t.name));
}

async function seedClient(clientId: string, extra: { surface?: string; setBy?: string } = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients (client_id, client_name, surface, surface_set_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_id) DO UPDATE SET surface = $3, surface_set_by = $4`,
    [clientId, `test ${clientId}`, extra.surface ?? null, extra.setBy ?? null],
  );
}

function authFor(clientId: string, scopes: string[], extra: Partial<AuthInfo> = {}): AuthInfo {
  return { token: 't', clientId, scopes, ...extra };
}

const HTTP = { remote: true, transport: 'http' as const, sourceId: 'default' };

describe('request_tools catalog (no args)', () => {
  test('http transport, no auth: grouped by area; localOnly + gated ops never named', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', {}, { ...HTTP });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(Array.isArray(body.catalog)).toBe(true);
    expect(body.total_tools).toBeGreaterThan(20);
    const names = flatNames(body.catalog);
    // Areas group the names; every group has a non-empty area label + one_lines.
    for (const group of body.catalog as CatalogEntry[]) {
      expect(typeof group.area).toBe('string');
      expect(group.area.length).toBeGreaterThan(0);
      for (const t of group.tools) expect(t.one_line.length).toBeGreaterThan(0);
    }
    expect(names).toContain('get_page');
    expect(names).toContain('put_page');
    expect(names).toContain('request_tools');
    // localOnly ops are hidden on network transports (D7)…
    expect(names).not.toContain('file_list');
    expect(names).not.toContain('sync_brain');
    // …and publish-gated ops are hidden while their gate is off (default).
    expect(names).not.toContain('list_skills');
    expect(names).not.toContain('get_skill');
    expect(names).not.toContain('list_brain_skillpack');
    expect(names).not.toContain('advisor');
    // Raw payload never leaks a gated name anywhere (C8 class).
    const raw = res.content[0].text;
    expect(raw).not.toContain('list_skills');
    expect(raw).not.toContain('advisor');
  });

  test('stdio transport: localOnly listed (D7) but gate-off publish-gated ops hidden', async () => {
    // Two distinct axes: stdio IS the local pipe (locality — localOnly ops
    // dispatch there, so they list), but publish-gate enforcement exempts
    // only remote === false and stdio dispatches remote:true — a gate-off op
    // in this catalog would deny at call time (the listed-but-denied class).
    const res = await dispatchToolCall(engine, 'request_tools', {}, {
      remote: true, transport: 'stdio', sourceId: 'default',
    });
    const names = flatNames(parsed(res).catalog);
    expect(names).toContain('file_list');
    expect(names).not.toContain('list_skills');
    expect(names).not.toContain('advisor');
  });

  test('stdio transport: gated ops appear once their gate is on (DB plane)', async () => {
    await engine.setConfig('mcp.publish_skills', 'true');
    try {
      const res = await dispatchToolCall(engine, 'request_tools', {}, {
        remote: true, transport: 'stdio', sourceId: 'default',
      });
      const names = flatNames(parsed(res).catalog);
      expect(names).toContain('list_skills');
      expect(names).not.toContain('advisor'); // separate gate, still off
    } finally {
      await engine.setConfig('mcp.publish_skills', 'false');
    }
  });

  test('trusted local CLI (remote === false, no transport): localOnly + gated ops visible', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', {}, {
      remote: false, sourceId: 'default',
    });
    const names = flatNames(parsed(res).catalog);
    // The local operator CAN call all of these (assertPublishEnabled exempts
    // remote === false), so hiding them would make the catalog dishonest.
    expect(names).toContain('file_list');   // localOnly
    expect(names).toContain('sync_brain');  // localOnly
    expect(names).toContain('list_skills'); // publish-gated (gates pinned off above)
    expect(names).toContain('advisor');     // publish-gated
  });

  test('read-scope token: write/admin ops hidden, reads visible', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', {}, {
      ...HTTP, auth: authFor('ro-client', ['read']),
    });
    const names = flatNames(parsed(res).catalog);
    expect(names).toContain('get_page');
    expect(names).toContain('request_tools');
    expect(names).not.toContain('put_page');      // write scope
    expect(names).not.toContain('run_doctor');    // admin scope
    expect(names).not.toContain('submit_agent');  // agent scope
  });

  test('FOV-4: agent-only token gets the honest minimal catalog (agent lane + request_tools)', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', {}, {
      ...HTTP, auth: authFor('agent-client', ['agent']),
    });
    const names = flatNames(parsed(res).catalog).sort();
    expect(names).toEqual(['get_agent_job', 'request_tools', 'submit_agent']);
  });

  test('D9: a slug-bound client keeps discovery; unfenceable writes stay hidden', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', {}, {
      ...HTTP, auth: authFor('bound-client', ['read', 'write'], { boundSlugPrefixes: ['chan-a/'] }),
    });
    // Without the BOUND_CLIENT_META_OPS carve-out, the dispatch fence would
    // have denied this call outright (request_tools is mutating).
    expect(parsed(res).catalog).toBeDefined();
    const names = flatNames(parsed(res).catalog);
    expect(names).toContain('put_page');          // fenced-write allow-list
    expect(names).not.toContain('extract_facts'); // unfenceable write
  });

  test('D2: the catalog never names ops above the server ceiling', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', {}, {
      ...HTTP, surfaceCeiling: 'verbs',
    });
    const names = flatNames(parsed(res).catalog).sort();
    expect(names).toEqual([...VERB_NAMES].sort());
  });
});

describe('request_tools {tools: [...]} descriptor fetch (D5)', () => {
  test('returns full schemas for the visible subset; hidden/unknown names silently omitted', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', {
      tools: ['get_page', 'put_page', 'file_list', 'no_such_tool_xyz', 'get_page'],
    }, { ...HTTP, auth: authFor('ro-client', ['read']) });
    const body = parsed(res);
    expect(Array.isArray(body.tools)).toBe(true);
    const names = body.tools.map((t: { name: string }) => t.name);
    // Visible + deduped: put_page (write scope), file_list (localOnly), and
    // the unknown name are all silently omitted.
    expect(names).toEqual(['get_page']);
    expect(body.tools[0].inputSchema.type).toBe('object');
    expect(body.tools[0].inputSchema.properties.slug).toBeDefined();
    const raw = res.content[0].text;
    expect(raw).not.toContain('no_such_tool_xyz');
  });
});

describe('request_tools {surface} persist branch', () => {
  test('happy path: persists surface + surface_set_by=self and writes the audit row', async () => {
    await seedClient('cl-persist');
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'starter' }, {
      ...HTTP, surfaceCeiling: 'full', auth: authFor('cl-persist', ['read']),
    });
    const body = parsed(res);
    expect(body.persisted).toBe(true);
    expect(body.surface).toBe('starter');
    expect(body.note).toContain('tools/list');

    const rows = await engine.executeRaw(
      `SELECT surface, surface_set_by FROM oauth_clients WHERE client_id = $1`, ['cl-persist'],
    );
    expect(rows[0].surface).toBe('starter');
    expect(rows[0].surface_set_by).toBe('self');

    // Amendment 32 / ENG-8: the mutation is answerable from logs alone.
    const audit = await engine.executeRaw(
      `SELECT token_name, params FROM mcp_request_log
       WHERE operation = 'surface_change' AND token_name = $1`, ['cl-persist'],
    );
    expect(audit.length).toBe(1);
    const params = audit[0].params as { actor: string; client_id: string; old: string | null; new: string | null; via: string };
    expect(params.via).toBe('request_tools');
    expect(params.actor).toBe('cl-persist');
    expect(params.old).toBe(null);
    expect(params.new).toBe('starter');
  });

  test('D2 ceiling deny: widening past the ceiling is a machine-readable permission_denied', async () => {
    await seedClient('cl-ceiling');
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'full' }, {
      ...HTTP, surfaceCeiling: 'starter', auth: authFor('cl-ceiling', ['read']),
    });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('permission_denied');
    expect(body.detail).toBe('ceiling=starter');
    // Narrowing below the ceiling is always allowed.
    const ok = await dispatchToolCall(engine, 'request_tools', { surface: 'verbs' }, {
      ...HTTP, surfaceCeiling: 'starter', auth: authFor('cl-ceiling', ['read']),
    });
    expect(parsed(ok).persisted).toBe(true);
  });

  test('operator lock deny (amendment 19): surface_set_by=operator cannot be self-overridden', async () => {
    await seedClient('cl-locked', { surface: 'verbs', setBy: 'operator' });
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'full' }, {
      ...HTTP, surfaceCeiling: 'full', auth: authFor('cl-locked', ['read']),
    });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('permission_denied');
    expect(body.detail).toBe('locked_by=operator');
    const rows = await engine.executeRaw(
      `SELECT surface FROM oauth_clients WHERE client_id = $1`, ['cl-locked'],
    );
    expect(rows[0].surface).toBe('verbs'); // untouched
  });

  test('no clientId (stdio): persist no-ops with a reason, never an error', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'starter' }, {
      remote: true, transport: 'stdio', sourceId: 'default', surfaceCeiling: 'full',
    });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.persisted).toBe(false);
    expect(body.reason).toContain('no per-client surface');
  });

  test('legacy token (clientId not an oauth_clients row): persist no-ops with the same reason', async () => {
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'starter' }, {
      ...HTTP, surfaceCeiling: 'full', auth: authFor('legacy-token-row-id', ['read']),
    });
    const body = parsed(res);
    expect(body.persisted).toBe(false);
    expect(body.reason).toContain('no per-client surface');
  });

  test('rate limit (D14.5): ~5 persists/hour/client, 6th is rate_limited', async () => {
    await seedClient('cl-rl');
    const opts = { ...HTTP, surfaceCeiling: 'full' as const, auth: authFor('cl-rl', ['read']) };
    for (let i = 0; i < 5; i++) {
      const res = await dispatchToolCall(engine, 'request_tools', {
        surface: i % 2 === 0 ? 'starter' : 'full',
      }, opts);
      expect(parsed(res).persisted).toBe(true);
    }
    const sixth = await dispatchToolCall(engine, 'request_tools', { surface: 'verbs' }, opts);
    expect(sixth.isError).toBe(true);
    expect(parsed(sixth).error).toBe('rate_limited');
    // A different client is unaffected (per-client buckets).
    await seedClient('cl-rl-2');
    const other = await dispatchToolCall(engine, 'request_tools', { surface: 'starter' }, {
      ...HTTP, surfaceCeiling: 'full', auth: authFor('cl-rl-2', ['read']),
    });
    expect(parsed(other).persisted).toBe(true);
  });

  test('{surface, tools} together → invalid_params, never a persist (D5 branch exclusivity)', async () => {
    await seedClient('cl-both');
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'starter', tools: ['query'] }, {
      ...HTTP, surfaceCeiling: 'full', auth: authFor('cl-both', ['read']),
    });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('invalid_params');
    expect(body.message).toContain('not both');
    const rows = await engine.executeRaw(
      `SELECT surface FROM oauth_clients WHERE client_id = $1`, ['cl-both'],
    );
    expect(rows[0].surface).toBe(null);
  });

  test('RateLimiter.refund returns a token so a race-lost persist never burns budget (adversarial fix)', async () => {
    // The handler refunds when the atomic UPDATE affects 0 rows (a concurrent
    // operator pin between SELECT and UPDATE); pin the primitive it leans on.
    const { RateLimiter } = await import('../src/mcp/rate-limit.ts');
    const now = 0;
    const lim = new RateLimiter({ limit: 2, windowMs: 60_000, lruCap: 10 }, () => now);
    expect(lim.check('k').allowed).toBe(true);
    expect(lim.check('k').allowed).toBe(true);
    expect(lim.check('k').allowed).toBe(false); // exhausted
    lim.refund('k');
    expect(lim.check('k').allowed).toBe(true); // refund restored exactly one token
    expect(lim.check('k').allowed).toBe(false);
    lim.refund('unknown-key'); // no-op, never throws
    // Refund never overfills past the limit.
    const lim2 = new RateLimiter({ limit: 1, windowMs: 60_000, lruCap: 10 }, () => now);
    expect(lim2.check('k').allowed).toBe(true);
    lim2.refund('k');
    lim2.refund('k');
    expect(lim2.check('k').allowed).toBe(true);
    expect(lim2.check('k').allowed).toBe(false);
  });

  test('invalid surface value → invalid_params naming the valid set (D10: never a persist)', async () => {
    await seedClient('cl-garbage');
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'garbage' }, {
      ...HTTP, surfaceCeiling: 'full', auth: authFor('cl-garbage', ['read']),
    });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('invalid_params');
    expect(body.message).toContain('verbs, starter, full');
    const rows = await engine.executeRaw(
      `SELECT surface FROM oauth_clients WHERE client_id = $1`, ['cl-garbage'],
    );
    expect(rows[0].surface).toBe(null);
  });

  test('dry_run: reports without writing', async () => {
    await seedClient('cl-dry');
    const res = await dispatchToolCall(engine, 'request_tools', { surface: 'starter', dry_run: true }, {
      ...HTTP, surfaceCeiling: 'full', auth: authFor('cl-dry', ['read']),
    });
    const body = parsed(res);
    expect(body.persisted).toBe(false);
    expect(body.dry_run).toBe(true);
    const rows = await engine.executeRaw(
      `SELECT surface FROM oauth_clients WHERE client_id = $1`, ['cl-dry'],
    );
    expect(rows[0].surface).toBe(null);
  });

  test('dry-run previews never consume the persist budget (D14.5)', async () => {
    await seedClient('cl-dry-budget');
    const opts = { ...HTTP, surfaceCeiling: 'full' as const, auth: authFor('cl-dry-budget', ['read']) };
    for (let i = 0; i < 5; i++) {
      const res = await dispatchToolCall(engine, 'request_tools', { surface: 'starter', dry_run: true }, opts);
      expect(parsed(res).dry_run).toBe(true);
    }
    // The limiter meters actual writes only: a real persist still succeeds
    // after 5 previews (pre-fix, the previews exhausted the budget).
    const real = await dispatchToolCall(engine, 'request_tools', { surface: 'starter' }, opts);
    expect(real.isError ?? false).toBe(false);
    expect(parsed(real).persisted).toBe(true);
  });

  // LAST: mutates the schema (drops the v127 columns); the finally block
  // restores them so the shared engine stays whole for any later suite.
  test('pre-migration brain: persist reports {persisted:false, reason:"migration pending"} (D5)', async () => {
    try {
      await engine.executeRaw(`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS surface`, []);
      await engine.executeRaw(`ALTER TABLE oauth_clients DROP COLUMN IF EXISTS surface_set_by`, []);
      const res = await dispatchToolCall(engine, 'request_tools', { surface: 'starter' }, {
        ...HTTP, surfaceCeiling: 'full', auth: authFor('cl-persist', ['read']),
      });
      expect(res.isError ?? false).toBe(false);
      const body = parsed(res);
      expect(body.persisted).toBe(false);
      expect(body.reason).toBe('migration pending');
    } finally {
      await engine.executeRaw(`ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface TEXT`, []);
      await engine.executeRaw(`ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS surface_set_by TEXT`, []);
    }
  });
});
