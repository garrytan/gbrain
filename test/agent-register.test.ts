/**
 * gbrain agent register (cathedral-6) — parser, presets, guards, and the
 * PGLite end-to-end integration (pre-flight → one tx → post-commit audit →
 * exchange → verify round-trip).
 *
 * The 3600s-default regression pin lives here: register ALWAYS writes
 * oauth_clients.token_ttl (default 30d) because the server default for
 * CLI-minted access tokens is one hour.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { writeSurfaceChangeAudit } from '../src/core/surface-audit.ts';
import {
  parseAgentRegisterArgs,
  resolvePreset,
  rotateClientSecret,
  ensureWorkspaceSource,
  snapshotGrantSources,
  RegisterError,
  REGISTER_DEFAULT_TOKEN_TTL_SECONDS,
  WORKSPACE_NAME_MAX,
} from '../src/commands/agent-register.ts';
import {
  registerScopedClient,
  preflightOauthClientColumns,
  type RegisterClientArgs,
} from '../src/commands/auth.ts';

function baseRegisterArgs(over: Partial<RegisterClientArgs> = {}): RegisterClientArgs {
  return {
    grantTypes: ['client_credentials'],
    scopes: 'read write',
    sourceId: 'default',
    federatedRead: undefined,
    redirectUris: [],
    tokenEndpointAuthMethod: undefined,
    boundTools: undefined,
    boundSourceId: undefined,
    boundBrainId: undefined,
    boundSlugPrefixes: undefined,
    boundMaxConcurrent: undefined,
    budgetUsdPerDay: undefined,
    tokenTtlSeconds: undefined,
    ...over,
  };
}

// ── parser (pure) ─────────────────────────────────────────────────────────

describe('parseAgentRegisterArgs', () => {
  test('happy path parses all flags', () => {
    const p = parseAgentRegisterArgs([
      'aurora-coder', '--harness', 'claude-code', '--preset', 'coding-agent',
      '--federated-read', 'proj-widget,shared', '--url', 'https://brain.example.com/mcp',
      '--token-ttl', '86400', '--show-token', '--json',
    ]);
    expect(p.name).toBe('aurora-coder');
    expect(p.harness).toBe('claude-code');
    expect(p.preset).toBe('coding-agent');
    expect(p.federatedRead).toEqual(['proj-widget', 'shared']);
    expect(p.tokenTtlSeconds).toBe(86400);
    expect(p.showToken).toBe(true);
    expect(p.json).toBe(true);
  });

  test('requires --harness and validates its values', () => {
    expect(() => parseAgentRegisterArgs(['a'])).toThrow(/--harness is required/);
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'cursor'])).toThrow(/--harness must be one of/);
  });

  test('requires a name (outside --reissue)', () => {
    expect(() => parseAgentRegisterArgs(['--harness', 'codex'])).toThrow(/requires a <name>/);
  });

  test('scope blocklist rejects operator scopes per token', () => {
    for (const bad of ['admin', 'sources_admin', 'users_admin', 'agent']) {
      expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--scopes', `read ${bad}`]))
        .toThrow(/not grantable to an agent client/);
    }
  });

  test('unknown scopes still rejected by the shared allowlist', () => {
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--scopes', 'read wrote']))
      .toThrow();
  });

  test('rejects the __all__ literal in --federated-read', () => {
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--federated-read', 'default,__all__']))
      .toThrow(/no wildcard read grant exists/);
  });

  test('--federated-read dedupes repeated ids, preserving first-seen order', () => {
    const p = parseAgentRegisterArgs([
      'a', '--harness', 'codex', '--federated-read', 'proj-widget,shared,proj-widget,shared',
    ]);
    expect(p.federatedRead).toEqual(['proj-widget', 'shared']);
  });

  test('url|port mutual exclusion; port bounds', () => {
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--url', 'https://x/mcp', '--port', '3131']))
      .toThrow(/--url OR --port/);
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--port', '0'])).toThrow(/--port/);
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--port', '70000'])).toThrow(/--port/);
  });

  test.each([['0'], ['-1'], ['abc'], ['10000000']])('rejects --token-ttl %s', (raw) => {
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--token-ttl', raw]))
      .toThrow(/between 60 and 7776000/);
  });

  test('name validation: shell-unsafe or uppercase names refused', () => {
    expect(() => parseAgentRegisterArgs(['Bad Name', '--harness', 'codex'])).toThrow(/invalid name/);
    expect(() => parseAgentRegisterArgs(['UPPER', '--harness', 'codex'])).toThrow(/invalid name/);
  });

  test('--reissue grammar: no name, no scope flags', () => {
    const p = parseAgentRegisterArgs(['--reissue', 'gbrain_cl_x', '--harness', 'codex']);
    expect(p.reissueClientId).toBe('gbrain_cl_x');
    expect(() => parseAgentRegisterArgs(['name', '--reissue', 'gbrain_cl_x', '--harness', 'codex']))
      .toThrow(/client-id, not a name/);
    expect(() => parseAgentRegisterArgs(['--reissue', 'gbrain_cl_x', '--harness', 'codex', '--scopes', 'read']))
      .toThrow(/scope flags are not allowed/);
  });

  test('unknown flag throws', () => {
    expect(() => parseAgentRegisterArgs(['a', '--harness', 'codex', '--frobnicate'])).toThrow(/Unknown flag/);
  });

  test('--allow-old-serve parses (default false)', () => {
    expect(parseAgentRegisterArgs(['a', '--harness', 'codex']).allowOldServe).toBe(false);
    expect(parseAgentRegisterArgs(['a', '--harness', 'codex', '--allow-old-serve']).allowOldServe).toBe(true);
    // Boolean flag: it must not eat a following positional.
    const p = parseAgentRegisterArgs(['a', '--allow-old-serve', '--harness', 'codex']);
    expect(p.allowOldServe).toBe(true);
    expect(p.name).toBe('a');
    expect(p.harness).toBe('codex');
  });
});

// ── snapshot grant (daily-driver) — workspace exclusion ───────────────────

describe('snapshotGrantSources', () => {
  test('excludes *-workspace sources from the snapshot grant, keeps the rest', () => {
    const r = snapshotGrantSources(['default', 'proj-widget', 'x-workspace', 'nova-notes', 'aurora-coder-workspace']);
    expect(r.granted).toEqual(['default', 'proj-widget', 'nova-notes']);
    expect(r.excludedWorkspaces).toEqual(['x-workspace', 'aurora-coder-workspace']);
  });

  test('no workspaces → nothing excluded', () => {
    const r = snapshotGrantSources(['default', 'proj-widget']);
    expect(r.granted).toEqual(['default', 'proj-widget']);
    expect(r.excludedWorkspaces).toEqual([]);
  });

  test('an EXPLICIT --federated-read grant of a workspace bypasses the snapshot (no filtering)', () => {
    // The exclusion lives in the snapshot branch only: an explicit grant
    // resolves through preset.federatedRead = flags.federatedRead verbatim.
    const flags = { showToken: false, json: false, allowOldServe: false, name: 'aurora', harness: 'claude-code' } as any;
    const r = resolvePreset({ ...flags, preset: 'daily-driver', federatedRead: ['x-workspace', 'proj-widget'] });
    expect(r.federatedRead).toEqual(['x-workspace', 'proj-widget']);
  });
});

// ── presets (pure) ────────────────────────────────────────────────────────

describe('resolvePreset', () => {
  const flags = (over: Record<string, unknown>) =>
    ({ showToken: false, json: false, name: 'aurora', harness: 'claude-code', ...over }) as any;

  test('daily-driver: snapshot grant, default write source, starter surface', () => {
    const r = resolvePreset(flags({ preset: 'daily-driver' }));
    expect(r).toEqual({
      scopes: 'read write',
      writeSource: 'default',
      federatedRead: 'snapshot',
      surface: 'starter',
      workspaceDerived: false,
    });
  });

  test('coding-agent: derived workspace first in the read list, starter surface', () => {
    const r = resolvePreset(flags({ preset: 'coding-agent', federatedRead: ['proj-widget'] }));
    expect(r.writeSource).toBe('aurora-workspace');
    expect(r.workspaceDerived).toBe(true);
    expect(r.federatedRead).toEqual(['aurora-workspace', 'proj-widget']);
    expect(r.surface).toBe('starter');
  });

  test('coding-agent without --federated-read fails loud', () => {
    expect(() => resolvePreset(flags({ preset: 'coding-agent' }))).toThrow(/requires --federated-read/);
  });

  test('explicit flags beat preset', () => {
    const r = resolvePreset(flags({
      preset: 'coding-agent', federatedRead: ['proj-widget'],
      source: 'shared', scopes: 'read', surface: 'full',
    }));
    expect(r.writeSource).toBe('shared');
    expect(r.workspaceDerived).toBe(false);
    expect(r.scopes).toBe('read');
    expect(r.surface).toBe('full');
  });

  test(`workspace derivation: ${WORKSPACE_NAME_MAX}-char name ok, ${WORKSPACE_NAME_MAX + 1} refused with guidance`, () => {
    const ok = 'a'.repeat(WORKSPACE_NAME_MAX);
    const long = 'a'.repeat(WORKSPACE_NAME_MAX + 1);
    expect(resolvePreset(flags({ name: ok, preset: 'coding-agent', federatedRead: ['x'] })).writeSource)
      .toBe(`${ok}-workspace`);
    expect(() => resolvePreset(flags({ name: long, preset: 'coding-agent', federatedRead: ['x'] })))
      .toThrow(/Pass --source <id> or shorten the name/);
    expect(() => resolvePreset(flags({ name: 'a'.repeat(33), preset: 'coding-agent', federatedRead: ['x'] })))
      .toThrow(/shorten the name/);
  });

  test('underscore names cannot derive a workspace (SOURCE_ID_RE)', () => {
    expect(() => resolvePreset(flags({ name: 'my_agent', preset: 'coding-agent', federatedRead: ['x'] })))
      .toThrow(/Pass --source/);
  });

  test('no preset: passthrough defaults matching auth register-client, no surface', () => {
    const r = resolvePreset(flags({}));
    expect(r).toEqual({
      scopes: 'read write',
      writeSource: 'default',
      federatedRead: ['default'],
      surface: undefined,
      workspaceDerived: false,
    });
  });
});

// ── structural guards (the PGLite self-deadlock class) ───────────────────

describe('structural guards', () => {
  const src = fs.readFileSync(path.join(import.meta.dir, '../src/commands/agent-register.ts'), 'utf8');

  test('agent-register never acquires its own engine (withConfiguredSql / .connect are banned)', () => {
    expect(src).not.toMatch(/withConfiguredSql/);
    expect(src).not.toMatch(/\.connect\(/);
    expect(src).not.toMatch(/createEngine\(/);
  });

  test('registerScopedClient core is print-free and exit-free', () => {
    const auth = fs.readFileSync(path.join(import.meta.dir, '../src/commands/auth.ts'), 'utf8');
    const coreStart = auth.indexOf('export async function registerScopedClient');
    const coreEnd = auth.indexOf('export function formatRegisterClientOutput');
    const core = auth.slice(coreStart, coreEnd);
    expect(coreStart).toBeGreaterThan(0);
    // Call sites only — prose in neighboring docblocks may NAME console.log.
    expect(core).not.toMatch(/console\.\w+\s*\(/);
    expect(core).not.toMatch(/process\.exit\s*\(/);
  });
});

// ── PGLite integration ────────────────────────────────────────────────────

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM oauth_tokens');
  await engine.executeRaw('DELETE FROM oauth_clients');
});

describe('PGLite integration (pre-flight → tx → audit → exchange)', () => {
  test('end-to-end: row, ttl, surface via rescope, audit row, verify round-trip', async () => {
    const sql = sqlQueryForEngine(engine);
    const columns = await preflightOauthClientColumns(sql);
    expect(columns.has('token_ttl')).toBe(true);
    expect(columns.has('surface')).toBe(true);
    expect(columns.has('deleted_at')).toBe(true);

    let registered!: Awaited<ReturnType<typeof registerScopedClient>>;
    await engine.transaction(async (tx) => {
      const txSql = sqlQueryForEngine(tx);
      registered = await registerScopedClient(txSql, 'itest-agent', baseRegisterArgs({
        sourceId: 'default',
        federatedRead: ['default'],
      }), {
        tokenTtlSeconds: REGISTER_DEFAULT_TOKEN_TTL_SECONDS,
        surface: 'starter',
        columns,
      });
    });

    expect(registered.tokenTtl).toBe(REGISTER_DEFAULT_TOKEN_TTL_SECONDS);
    expect(registered.surface).toBe('starter');
    expect(registered.clientSecret).toMatch(/^gbrain_cs_/);

    // Row state: ttl written, surface set through the audited writer path
    // (surface_set_by='operator' — the request_tools lock).
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT token_ttl, surface, surface_set_by FROM oauth_clients WHERE client_id = $1`,
      [registered.clientId],
    );
    expect(rows[0].token_ttl).toBe(REGISTER_DEFAULT_TOKEN_TTL_SECONDS);
    expect(rows[0].surface).toBe('starter');
    expect(rows[0].surface_set_by).toBe('operator');

    // Post-commit fail-open audit (designed position — never inside the tx).
    const audited = await writeSurfaceChangeAudit(engine, {
      actor: 'operator',
      client_id: registered.clientId,
      old: registered.surfaceOld ?? null,
      new: 'starter',
      via: 'register_cli',
    });
    expect(audited).toBe(true);
    const auditRows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT operation FROM mcp_request_log WHERE operation = 'surface_change'`,
    );
    expect(auditRows.length).toBe(1);

    // Exchange on the OUTER engine (tx sql is dead after commit) — the
    // 3600s-default regression pin: expires_in must reflect the 30d column.
    const provider = new GBrainOAuthProvider({ sql });
    const tokens = await provider.exchangeClientCredentials(registered.clientId, registered.clientSecret!);
    expect(tokens.expires_in).toBe(REGISTER_DEFAULT_TOKEN_TTL_SECONDS);

    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect((auth as any).sourceId).toBe('default');
    expect((auth as any).allowedSources).toEqual(['default']);
  });

  test('42703 degrade path: missing columns are skipped OUTSIDE the tx, register still lands', async () => {
    const sql = sqlQueryForEngine(engine);
    // Simulate a pre-migration brain: a column set that lacks token_ttl+surface.
    const columns = new Set(['source_id', 'federated_read', 'deleted_at']);
    let registered!: Awaited<ReturnType<typeof registerScopedClient>>;
    await engine.transaction(async (tx) => {
      const txSql = sqlQueryForEngine(tx);
      registered = await registerScopedClient(txSql, 'itest-degrade', baseRegisterArgs(), {
        tokenTtlSeconds: REGISTER_DEFAULT_TOKEN_TTL_SECONDS,
        surface: 'starter',
        columns,
      });
    });
    expect(registered.skipped).toEqual({ tokenTtl: true, surface: true });
    expect(registered.tokenTtl).toBeUndefined();
    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT client_id, token_ttl FROM oauth_clients WHERE client_id = $1`,
      [registered.clientId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].token_ttl).toBeNull();
  });

  test('reissue: rotation invalidates the old secret, keeps one row, new secret works', async () => {
    const sql = sqlQueryForEngine(engine);
    let registered!: Awaited<ReturnType<typeof registerScopedClient>>;
    await engine.transaction(async (tx) => {
      registered = await registerScopedClient(sqlQueryForEngine(tx), 'itest-rotate', baseRegisterArgs(), {});
    });
    const oldSecret = registered.clientSecret!;
    const provider = new GBrainOAuthProvider({ sql });
    await provider.exchangeClientCredentials(registered.clientId, oldSecret); // sanity: works pre-rotation

    const newSecret = await rotateClientSecret(engine, registered.clientId, 'itest-rotate');
    expect(newSecret).toMatch(/^gbrain_cs_/);
    expect(newSecret).not.toBe(oldSecret);

    await expect(provider.exchangeClientCredentials(registered.clientId, oldSecret)).rejects.toThrow();
    const tokens = await provider.exchangeClientCredentials(registered.clientId, newSecret);
    expect(tokens.access_token).toBeTruthy();

    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT count(*) AS n FROM oauth_clients WHERE client_name = $1`, ['itest-rotate'],
    );
    expect(Number(rows[0].n)).toBe(1);
  });
});

// ── ensureWorkspaceSource (create-or-clean-reuse, refuse dirty/archived) ──

describe('ensureWorkspaceSource', () => {
  const sql = () => sqlQueryForEngine(engine);

  test('creates the source when missing (returns true)', async () => {
    const created = await ensureWorkspaceSource(engine, sql(), 'ews-new-workspace');
    expect(created).toBe(true);
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id = $1`, ['ews-new-workspace'],
    );
    expect(rows.length).toBe(1);
  });

  test('reuses an existing CLEAN source (returns false)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('ews-clean-workspace', 'ews-clean-workspace')`,
    );
    const created = await ensureWorkspaceSource(engine, sql(), 'ews-clean-workspace');
    expect(created).toBe(false);
  });

  test('archived-but-empty workspace is refused with an unarchive hint (never silently reused)', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, archived) VALUES ('ews-archived-workspace', 'ews-archived-workspace', true)`,
    );
    const caught = await ensureWorkspaceSource(engine, sql(), 'ews-archived-workspace')
      .then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(RegisterError);
    expect((caught as RegisterError).reason).toBe('archived_source');
    expect((caught as Error).message).toMatch(/exists but is archived — unarchive it/);
  });

  test('source holding pages is dirty', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('ews-pages-workspace', 'ews-pages-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title) VALUES ('ews-pages-workspace', 'ews/p1', 'note', 'p1')`,
    );
    await expect(ensureWorkspaceSource(engine, sql(), 'ews-pages-workspace'))
      .rejects.toThrow(/holds 1 pages/);
  });

  test('source holding FACTS (zero pages) is dirty too — the primary agent write lane', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('ews-facts-workspace', 'ews-facts-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO facts (source_id, fact, source) VALUES ('ews-facts-workspace', 'agent memory row', 'test')`,
    );
    const caught = await ensureWorkspaceSource(engine, sql(), 'ews-facts-workspace')
      .then(() => null, (e: unknown) => e);
    expect((caught as RegisterError).reason).toBe('dirty_source');
    expect((caught as Error).message).toMatch(/holds 1 facts/);
  });

  test('source backed by a local path is dirty', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path) VALUES ('ews-path-workspace', 'ews-path-workspace', '/tmp/x')`,
    );
    await expect(ensureWorkspaceSource(engine, sql(), 'ews-path-workspace'))
      .rejects.toThrow(/backed by a local path/);
  });

  test('source holding FILES (zero pages, zero facts) is dirty too — files can exist page-less', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('ews-files-workspace', 'ews-files-workspace')`,
    );
    await engine.executeRaw(
      `INSERT INTO files (source_id, filename, storage_path, content_hash)
       VALUES ('ews-files-workspace', 'notes.pdf', 'files/notes.pdf', 'deadbeef')`,
    );
    const caught = await ensureWorkspaceSource(engine, sql(), 'ews-files-workspace')
      .then(() => null, (e: unknown) => e);
    expect((caught as RegisterError).reason).toBe('dirty_source');
    expect((caught as Error).message).toMatch(/holds 1 files/);
  });
});
