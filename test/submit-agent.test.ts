import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { operationsByName } from '../src/core/operations.ts';

/**
 * v0.38 Slice 3 — `submit_agent` MCP op tests.
 *
 * Covers the load-bearing trust-boundary surface:
 *   - Per-dispatch binding enforcement against oauth_clients.bound_*
 *   - allowed_tools ⊆ bound_tools subset check
 *   - allowed_slug_prefixes prefix-match against bound_slug_prefixes
 *   - bound_max_concurrent concurrency cap
 *   - Local CLI bypass (ctx.remote === false → invalid_request)
 *   - Refusal when client has scope but missing bindings
 *   - Refusal for unknown client_id
 *   - dry_run path
 *   - Happy-path submission writes audit row + queue row
 *
 * Audit-trail writes go to a tmpdir via GBRAIN_AUDIT_DIR (withEnv-wrapped).
 */

const submit_agent = operationsByName['submit_agent'];
if (!submit_agent) {
  throw new Error('submit_agent op missing from operations registry — test fixture invalid');
}

let engine: PGLiteEngine;
let tmpAuditDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState truncates `config` table; restore the version row so
  // MinionQueue.ensureSchema() sees the migrated state. The schema itself
  // is preserved (initSchema applied in beforeAll); only the config-table
  // marker row needs re-seeding.
  await engine.setConfig('version', '85');
  tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-agent-audit-'));
});

interface SeedOpts {
  bound_tools?: string[] | null;
  bound_source_id?: string | null;
  bound_brain_id?: string | null;
  bound_slug_prefixes?: string[] | null;
  bound_max_concurrent?: number;
  budget_usd_per_day?: number | null;
  scope?: string;
}

async function seedClient(clientId: string, opts: SeedOpts = {}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO oauth_clients
       (client_id, client_name, client_secret_hash, scope, grant_types,
        redirect_uris, token_endpoint_auth_method,
        bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes,
        bound_max_concurrent, budget_usd_per_day, created_at, deleted_at)
     VALUES ($1, $1, '', $2, ARRAY['client_credentials'],
             ARRAY[]::text[], 'client_secret_post',
             $3, $4, $5, $6, $7, $8, now(), NULL)
     ON CONFLICT (client_id) DO UPDATE SET
       bound_tools = EXCLUDED.bound_tools,
       bound_source_id = EXCLUDED.bound_source_id,
       bound_slug_prefixes = EXCLUDED.bound_slug_prefixes,
       bound_max_concurrent = EXCLUDED.bound_max_concurrent,
       budget_usd_per_day = EXCLUDED.budget_usd_per_day,
       scope = EXCLUDED.scope`,
    [
      clientId,
      opts.scope ?? 'read agent',
      opts.bound_tools ?? null,
      opts.bound_source_id ?? null,
      opts.bound_brain_id ?? null,
      opts.bound_slug_prefixes ?? null,
      opts.bound_max_concurrent ?? 1,
      opts.budget_usd_per_day ?? null,
    ],
  );
}

function makeCtx(opts: { clientId?: string; remote?: boolean; dryRun?: boolean } = {}): any {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: opts.dryRun ?? false,
    remote: opts.remote ?? true,
    auth: opts.clientId ? { clientId: opts.clientId } : undefined,
  };
}

async function callSubmitAgent(ctx: any, params: Record<string, unknown>): Promise<any> {
  return await withEnv({ GBRAIN_AUDIT_DIR: tmpAuditDir }, async () => {
    return await submit_agent.handler(ctx, params);
  });
}

describe('submit_agent op (v0.38 Slice 3 — remote-callable agent dispatch with binding enforcement)', () => {
  describe('op surface', () => {
    it('declares scope=agent + mutating=true', () => {
      expect(submit_agent.scope).toBe('agent' as any);
      expect(submit_agent.mutating).toBe(true);
    });
    it('declares required prompt param', () => {
      expect(submit_agent.params.prompt).toBeDefined();
      expect((submit_agent.params.prompt as any).required).toBe(true);
    });
  });

  describe('local CLI bypass (ctx.remote === false)', () => {
    it('throws invalid_request — local CLI must use gbrain agent run', async () => {
      const ctx = makeCtx({ remote: false });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /local CLI.*gbrain agent run/i,
      );
    });
  });

  describe('OAuth client requirement', () => {
    it('refuses when no clientId in ctx.auth', async () => {
      const ctx = makeCtx(); // no clientId
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /requires an OAuth client with the `agent` scope/i,
      );
    });

    it('refuses when client_id is unknown', async () => {
      const ctx = makeCtx({ clientId: 'nobody-here' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /client_id nobody-here not found/,
      );
    });
  });

  describe('binding requirement (D13 — opt-in only)', () => {
    it('refuses when client has agent scope but bound_tools is NULL', async () => {
      // Legacy admin client gets agent scope appended via re-registration but
      // forgot to set --bound-tools. Refuse with the paste-ready hint.
      await seedClient('legacy-admin', { bound_tools: null });
      const ctx = makeCtx({ clientId: 'legacy-admin' });
      await expect(callSubmitAgent(ctx, { prompt: 'hi' })).rejects.toThrow(
        /has the agent scope but no bindings.*re-register/i,
      );
    });
  });

  describe('allowed_tools subset enforcement', () => {
    it('passes when allowed_tools ⊆ bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page', 'put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_tools: ['search', 'get_page'],
      });
      expect(result.dry_run).toBe(true);
      expect(result.action).toBe('submit_agent');
    });

    it('refuses when allowed_tools requests a tool outside bound_tools', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, { prompt: 'go', allowed_tools: ['put_page'] }),
      ).rejects.toThrow(/tool "put_page" is not in client cursor's bound_tools/);
    });

    it('defaults to bound_tools when allowed_tools omitted', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'go' });
      expect(result.dry_run).toBe(true);
    });
  });

  describe('allowed_slug_prefixes enforcement', () => {
    it('passes when each requested prefix is under a bound prefix', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/', 'people/'],
      });
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      // 'wiki/' starts with 'wiki/' (exact prefix match)
      const r1 = await callSubmitAgent(ctx, {
        prompt: 'go',
        allowed_slug_prefixes: ['wiki/'],
      });
      expect(r1.dry_run).toBe(true);
    });

    it('refuses when a requested prefix has no bound parent', async () => {
      await seedClient('cursor', {
        bound_tools: ['put_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(
        callSubmitAgent(ctx, {
          prompt: 'go',
          allowed_slug_prefixes: ['private/'],
        }),
      ).rejects.toThrow(/slug_prefix "private\/" is not under any.*bound_slug_prefixes/);
    });
  });

  describe('concurrency cap enforcement', () => {
    it('refuses when inflight count >= bound_max_concurrent', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 2,
      });
      // Seed 2 already-running subagent jobs for this client.
      for (let i = 0; i < 2; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
           VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
          [JSON.stringify({ prompt: `existing-${i}`, __owner_client_id: 'cursor' })],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor' });
      await expect(callSubmitAgent(ctx, { prompt: 'one too many' })).rejects.toThrow(
        /at concurrency cap \(2\/2\)/,
      );
    });

    it('allows submit when inflight count < cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
      });
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'one', __owner_client_id: 'cursor' })],
      );
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'two' });
      expect(result.dry_run).toBe(true);
      expect(result.bound_max_concurrent).toBe(3);
    });

    it('does NOT count terminal-state jobs toward the cap', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // 5 completed jobs — none counted (status filter is waiting/active/waiting-children).
      for (let i = 0; i < 5; i++) {
        await engine.executeRaw(
          `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
           VALUES ('subagent', 'completed', $1::jsonb, 'default', 0, now())`,
          [JSON.stringify({ prompt: `done-${i}`, __owner_client_id: 'cursor' })],
        );
      }
      const ctx = makeCtx({ clientId: 'cursor', dryRun: true });
      const result = await callSubmitAgent(ctx, { prompt: 'fresh' });
      expect(result.dry_run).toBe(true);
    });

    it('isolates inflight count by client_id (no cross-client leakage)', async () => {
      await seedClient('alice', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      await seedClient('bob', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 1,
      });
      // Alice has 1 active — at her cap.
      await engine.executeRaw(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())`,
        [JSON.stringify({ prompt: 'alice-busy', __owner_client_id: 'alice' })],
      );
      // Bob's submit should succeed — his cap (1) is independent.
      const ctxBob = makeCtx({ clientId: 'bob', dryRun: true });
      const result = await callSubmitAgent(ctxBob, { prompt: 'bob-fresh' });
      expect(result.dry_run).toBe(true);
    });
  });

  describe('happy-path submission', () => {
    it('inserts a subagent job + writes audit row', async () => {
      await seedClient('cursor', {
        bound_tools: ['search', 'get_page'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
        bound_max_concurrent: 3,
        budget_usd_per_day: 5.00,
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      const result = await callSubmitAgent(ctx, {
        prompt: 'research the YC W26 batch',
        allowed_tools: ['search'],
      });
      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe('subagent');
      expect(result.client_id).toBe('cursor');

      // Job persisted with correct shape.
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT name, status, data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('subagent');
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.prompt).toBe('research the YC W26 batch');
      expect(data.allowed_tools).toEqual(['search']);
      expect(data.__owner_client_id).toBe('cursor');
      expect(data.source_id).toBe('default'); // auto-set from bound_source_id

      // Audit file written.
      const auditFiles = fs.readdirSync(tmpAuditDir).filter(f => f.startsWith('agent-jobs-'));
      expect(auditFiles.length).toBe(1);
      const auditContent = fs.readFileSync(path.join(tmpAuditDir, auditFiles[0]), 'utf8');
      const auditLine = JSON.parse(auditContent.trim().split('\n')[0]);
      expect(auditLine.client_id).toBe('cursor');
      expect(auditLine.job_id).toBe(result.id);
      expect(auditLine.bound_tools).toEqual(['search']);
      expect(auditLine.bound_source).toBe('default');
      expect(auditLine.budget_remaining_cents).toBe(500); // 5.00 USD → 500 cents
      expect(auditLine.outcome).toBe('submitted');
      // CRITICAL: prompt text MUST NOT be in audit (only byte count).
      expect(auditContent).not.toContain('YC W26 batch');
    });

    it('caps max_turns at 100', async () => {
      await seedClient('cursor', {
        bound_tools: ['search'],
        bound_source_id: 'default',
        bound_slug_prefixes: ['wiki/'],
      });
      const ctx = makeCtx({ clientId: 'cursor' });
      const result = await callSubmitAgent(ctx, {
        prompt: 'long',
        max_turns: 9999, // way over cap
      });
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.max_turns).toBe(100);
    });
  });
});
