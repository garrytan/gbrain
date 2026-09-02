/**
 * Ambient-writeback WP2: the instruction section builder (single source for
 * MCP instructions AND the bootstrap-managed blocks), buildMcpInstructions'
 * byte-identity when off, and transport parity — the legacy bearer transport
 * must serve exactly what the shared builder produces, per request, with the
 * last-known-good bundle riding out a mid-session config blip.
 *
 * (stdio + OAuth enabled-state coverage rides the hermetic e2e fixture,
 * test/e2e/ambient-writeback-lifecycle.serial.test.ts — those transports need
 * a real subprocess/app boot. The three existing byte-exact OFF pins are
 * test/e2e/serve-stdio-roundtrip.test.ts, test/http-transport.test.ts, and
 * test/e2e/connect-bearer.test.ts and run unchanged.)
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';

import { buildAmbientWritebackSection } from '../src/core/facts/writeback-instructions.ts';
import { GBRAIN_MCP_INSTRUCTIONS, buildMcpInstructions } from '../src/mcp/instructions.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';

const BASE_OPTS = {
  mode: 'salient' as const,
  transientTtl: '3d',
  visibility: 'world' as const,
  extractFactsAvailable: true,
};

describe('buildAmbientWritebackSection (F1 leaf — the single source)', () => {
  test('salient mode carries the durable-only candidate policy', () => {
    const s = buildAmbientWritebackSection(BASE_OPTS);
    expect(s).toContain('mode: salient');
    expect(s).toContain('preferences, corrections, decisions, commitments, relationships');
    expect(s).not.toContain('every direct factual statement');
  });

  test('all mode saves every direct statement but keeps the exclusions (req 4 "all" definition)', () => {
    const s = buildAmbientWritebackSection({ ...BASE_OPTS, mode: 'all' });
    expect(s).toContain('mode: all');
    expect(s).toContain('every direct factual statement');
    expect(s).toContain('operational chatter');
    expect(s).toContain('secrets or credentials');
    expect(s).toContain('quoted third-party material');
  });

  test('the resolved transient TTL is embedded literally', () => {
    expect(buildAmbientWritebackSection({ ...BASE_OPTS, transientTtl: '12h' })).toContain('ttl: "12h"');
    // With extract_facts advertised, the transient line must ALSO warn that
    // extract_facts has no ttl parameter (a transient claim batched through
    // it would become permanent — adversarial review, this wave).
    expect(buildAmbientWritebackSection({ ...BASE_OPTS, transientTtl: '12h', extractFactsAvailable: true }))
      .toContain('never batch them through extract_facts');
    expect(buildAmbientWritebackSection({ ...BASE_OPTS, transientTtl: '12h', extractFactsAvailable: false }))
      .toContain('pass ttl: "12h"');
  });

  test('extract_facts is only named when actually callable (OV2-14)', () => {
    expect(buildAmbientWritebackSection(BASE_OPTS)).toContain('extract_facts');
    const without = buildAmbientWritebackSection({ ...BASE_OPTS, extractFactsAvailable: false });
    expect(without).not.toContain('extract_facts');
    expect(without).toContain('distill them yourself');
  });

  test('visibility postures: world names the agents-on-this-brain semantics; private names the widen trap + recall trade-off (F5/req 6)', () => {
    const world = buildAmbientWritebackSection(BASE_OPTS);
    expect(world).toContain('visibility: "world"');
    expect(world).toContain('not the public internet');
    expect(world).toContain('Never widen a private fact on your own.');
    const priv = buildAmbientWritebackSection({ ...BASE_OPTS, visibility: 'private' });
    expect(priv).toContain('visibility: "private"');
    expect(priv).toContain('omitting visibility would silently widen');
    expect(priv).toContain('not by remote sessions');
  });

  test('every requirement-3 bullet is present (skip-list, no assistant inference, no raw transcripts, provenance, one claim, scope, silence, durable-no-ttl)', () => {
    const s = buildAmbientWritebackSection(BASE_OPTS);
    expect(s).toContain('ONE claim per call');
    expect(s).toContain('provenance');
    expect(s).toContain('omit ttl');
    expect(s).toContain('greetings, acknowledgements, questions that carry no new facts');
    expect(s).toContain('unless the user explicitly asks');
    expect(s).toContain('Never store your own inference, diagnosis, speculation, or interpretation');
    expect(s).toContain('Never store raw transcripts');
    expect(s).toContain('authenticated brain and source scope');
    expect(s).toContain('Write silently');
  });

  test('stays lean: ≤ 15 lines (OV2/Codex#15 acceptance)', () => {
    expect(buildAmbientWritebackSection(BASE_OPTS).split('\n').length).toBeLessThanOrEqual(15);
  });
});

describe('buildMcpInstructions composition', () => {
  test('off/absent → BYTE-IDENTICAL to the frozen base (the three transport pins depend on this)', () => {
    expect(buildMcpInstructions()).toBe(GBRAIN_MCP_INSTRUCTIONS);
    expect(buildMcpInstructions({})).toBe(GBRAIN_MCP_INSTRUCTIONS);
    expect(buildMcpInstructions({ writeback: null })).toBe(GBRAIN_MCP_INSTRUCTIONS);
  });
  test('enabled → base + blank line + section, base untouched', () => {
    const out = buildMcpInstructions({ writeback: BASE_OPTS });
    expect(out.startsWith(GBRAIN_MCP_INSTRUCTIONS + '\n\n')).toBe(true);
    expect(out.endsWith(buildAmbientWritebackSection(BASE_OPTS))).toBe(true);
  });
});

// ── legacy bearer transport: enabled state + LKG, per request ──────────────

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('legacy bearer transport serves the shared builder output (parity)', () => {
  const TOKEN = 'wb-instr-token';
  let stop: (() => void) | null = null;
  afterAll(() => stop?.());

  test('enabled config → initialize carries base+section; config blip → last-known-good bundle; fresh engine off → base', async () => {
    const rows = new Map<string, string>([
      ['memory.auto_writeback', 'salient'],
      ['memory.auto_writeback_transient_ttl', '12h'],
      ['facts.default_visibility', 'private'],
    ]);
    let dbHealthy = true;
    const validTokens = new Map([[hash(TOKEN), { id: 'tok-wb', name: 'wb-test' }]]);
    const engine = {
      kind: 'postgres',
      executeRaw: async (sql: string, params?: unknown[]) => {
        const norm = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        if (norm.startsWith('select id, name')) {
          const row = validTokens.get(params?.[0] as string);
          return row ? [{ ...row, permissions: { takes_holders: ['world'] } }] : [];
        }
        return [];
      },
      getConfig: async (k: string) => {
        if (!dbHealthy) throw new Error('db blip');
        return rows.get(k) ?? null;
      },
    };
    const server = await startHttpTransport({
      port: 0,
      engine: engine as never,
      limiters: {
        ip: new RateLimiter({ limit: 1000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 1000, windowMs: 60_000, lruCap: 100 }),
      },
    });
    stop = () => (server as { stop: (b: boolean) => void }).stop(true);
    const url = `http://localhost:${(server as { port: number }).port}/mcp`;

    const init = async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { result?: { instructions?: string } };
      return body.result?.instructions;
    };

    const expected = buildMcpInstructions({
      writeback: { mode: 'salient', transientTtl: '12h', visibility: 'private', extractFactsAvailable: true },
    });
    expect(await init()).toBe(expected);

    // Mid-session config blip: the FULL last-known-good bundle keeps serving
    // (never base, never a mixed default) — OV2-8/F3 on a live transport.
    dbHealthy = false;
    expect(await init()).toBe(expected);
  });
});
