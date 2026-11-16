/**
 * mcp_request_log_retention doctor check (#6770 rewrite).
 *
 * Authoring gate: (1) protects what the operator is told about request-log
 * growth and retention: past the size threshold with retention off, a warn
 * whose fix turns retention on only after asking the user (the deletion
 * cannot be undone), never an automatic remediation step; with retention on,
 * the pruned-before date, the per-run cap state, and a warn when no prune ran
 * for 48 hours (a PGLite brain whose serve stopped, a cycle that never runs);
 * (2) fails when the fix becomes agent-runnable, when remediate picks it up,
 * or when a stalled prune reads as healthy; (3) the check is new; (4) the row
 * and byte thresholds are parameters so a test need not insert a million rows.
 *
 * Repo-less in-memory PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mcpRequestLogRetentionEntry, mcpRequestLogRetentionResult } from '../src/commands/doctor/checks/mcp-request-log.ts';
import { finalizeCheckFixes } from '../src/commands/doctor/check-fix.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { computeRemediationPlan } from '../src/core/remediation/plan.ts';
import { MCP_LOG_LAST_PRUNE_KEY, MCP_LOG_RETENTION_KEY, runMcpLogRetention } from '../src/core/mcp-request-log-retention.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM mcp_request_log');
  await engine.executeRaw('DELETE FROM mcp_request_log_rollup');
  await engine.unsetConfig(MCP_LOG_RETENTION_KEY);
  await engine.unsetConfig(MCP_LOG_LAST_PRUNE_KEY);
});

async function seed(count: number, daysAgo: number): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO mcp_request_log (token_name, operation, status, created_at)
     SELECT 'alice-client', 'query', 'success', now() - ($2::int * interval '1 day') - (g * interval '1 second') FROM generate_series(1, $1::int) g`,
    [count, daysAgo]);
}

const SMALL = { warnRows: 5, warnBytes: 2 ** 40 };

describe('mcp_request_log_retention', () => {
  test('registered, categorized as ops, and its entry runs on a connected engine', async () => {
    expect(categorizeCheck('mcp_request_log_retention')).toBe('ops');
    expect(mcpRequestLogRetentionEntry.emits).toContain('mcp_request_log_retention');
    const checks = await mcpRequestLogRetentionEntry.run({ engine } as unknown as DoctorContext);
    expect(Array.isArray(checks) && checks.map(c => c.name)).toEqual(['mcp_request_log_retention']);
  });

  test('retention off and a small log: information, nothing to do', async () => {
    await seed(2, 1);
    const check = await mcpRequestLogRetentionResult(engine, SMALL);
    expect(check).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice' });
    expect(check.details).toMatchObject({ retention_days: null, rows: 2 });
  });

  test('retention off past the threshold: warn, and the fix asks the user before any deletion', async () => {
    await seed(6, 1);
    const check = await mcpRequestLogRetentionResult(engine, SMALL);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('6');
    const fix = check.fix as { argv: string[]; ask_user?: true; consent: string[]; user_message?: string };
    expect(fix.argv).toEqual(['gbrain', 'config', 'set', MCP_LOG_RETENTION_KEY, '90']);
    expect(fix.ask_user).toBe(true);
    expect(fix.consent).toContain('destructive');
    expect(fix.user_message).toContain('cannot be restored');
    const [rendered] = finalizeCheckFixes([{ name: 'mcp_request_log_retention', ...check }]);
    expect((rendered!.fix as { next: string }).next).toBe('ask_user');
  });

  test('doctor --remediate never runs it: the remediation plan names no retention step', async () => {
    await seed(6, 1);
    expect((await mcpRequestLogRetentionResult(engine, SMALL)).status).toBe('warn');
    const plan = await computeRemediationPlan(engine, { repairs: { noEmbed: true } });
    expect(JSON.stringify(plan)).not.toContain('mcp_request_log_retention');
  });

  test('retention on with a recent prune: ok, with the pruned-before date and the cap state', async () => {
    await seed(3, 60);
    await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
    await runMcpLogRetention(engine);
    const check = await mcpRequestLogRetentionResult(engine, SMALL);
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ retention_days: 30, last_prune: { deleted: 3, capped: false } });
    expect(Date.parse((check.details as { pruned_before: string }).pruned_before)).toBeLessThan(Date.now() - 59 * 86_400_000);
  });

  test('retention on but no prune for 48 hours: warn', async () => {
    await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
    await engine.setConfig(MCP_LOG_LAST_PRUNE_KEY, JSON.stringify({ at: new Date(Date.now() - 49 * 3_600_000).toISOString(), deleted: 0, capped: false }));
    const check = await mcpRequestLogRetentionResult(engine, SMALL);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('48 hours');
    expect(check.fix).toBeDefined();
  });

  test('retention on and never pruned: warn only once rows past the window are waiting', async () => {
    await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
    await seed(2, 1);
    expect((await mcpRequestLogRetentionResult(engine, SMALL)).status).toBe('ok');
    await seed(2, 40);
    expect((await mcpRequestLogRetentionResult(engine, SMALL)).status).toBe('warn');
  });

  test('a run that hit the per-run cap reports that older rows are still waiting', async () => {
    await engine.setConfig(MCP_LOG_RETENTION_KEY, '30');
    await engine.setConfig(MCP_LOG_LAST_PRUNE_KEY, JSON.stringify({ at: new Date().toISOString(), deleted: 400_000, capped: true }));
    const check = await mcpRequestLogRetentionResult(engine, SMALL);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('still waiting');
  });
});
