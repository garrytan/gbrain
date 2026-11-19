/**
 * Engine graduation through the agent-operator CLI contract, on Postgres 16,
 * transaction-mode PgBouncer and a hosted-style non-superuser role.
 *
 * Protects: §3 measured outcomes and §7/§13 contract.
 * - Agent workflow: the bare command prints the plan and exits 3
 *   (`confirmation_required`, ask_user, egress + destructive effects,
 *   plan_hash, preview and fix commands); `--yes` alone re-plans and refuses;
 *   `--yes --expect <hash>` graduates with the doctor inline; the target
 *   doctor is green; existing tokens and OAuth clients authorize; over MCP a
 *   recall, a write, a replay of that write's request id (same outcome, no new
 *   row) and a grant-denied call behave as before.
 * - `--force` binds the target's destructive snapshot: a page added between
 *   preview and confirmation refuses with `preview_changed`.
 * The rest of the contract is split across files so CI can run them side by
 * side (test/helpers/graduation-cli-cases.ts): connection topologies
 * (graduation-cli-topologies), the 1k-page history round trip
 * (graduation-cli-history) and zero-mutation `--plan`/`--status` polling
 * (graduation-cli-zero-mutation-N).
 * Not covered elsewhere: unit tests cover the plan document and the state
 * machine without a real target.
 */
import { describe, expect } from 'bun:test';
import { join } from 'node:path';
import {
  codeOf, DATABASE_URL, digestChanges, fixOf, freePort, gbrain, graduationTest, mcpHttpCall, passwordLeaks, passwordOf,
  planHashOf, startGbrain, stateDigest, TARGET_ENV, type GbrainResult,
} from '../helpers/graduation-e2e.ts';
import { useGraduationCases } from '../helpers/graduation-cli-cases.ts';
import { expectGraduated, failingChecks, planAndRun, targetRowState, withTarget } from '../helpers/graduation-scenarios.ts';
import { loadLegacyExpected } from '../fixtures/graduation/legacy-brain.ts';

const { fresh } = useGraduationCases();

describe.skipIf(!DATABASE_URL)('graduation: agent workflow', () => {
  graduationTest('plan -> ask_user -> --yes --expect -> green doctor, then MCP recall, write, replay and a denied grant', async () => {
    const c = await fresh('agent-flow');
    const env = { [TARGET_ENV]: c.target.url };
    const results: GbrainResult[] = [];
    const started = Date.now();
    const ask = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--json'], { home: c.fx.home, env });
    results.push(ask);
    expect(ask.code).toBe(3);
    expect(codeOf(ask.json)).toBe('confirmation_required');
    expect(fixOf(ask.json)?.next).toBe('ask_user');
    expect(ask.json?.effects).toEqual(expect.arrayContaining(['egress', 'destructive']));
    const hash = planHashOf(ask.json)!;
    expect(hash).toMatch(/^[a-f0-9]{8,}$/);
    expect(JSON.stringify(fixOf(ask.json))).toContain(`--expect ${hash}`);
    expect(JSON.stringify(ask.json?.preview ?? ask.json)).toContain('--plan');
    expect(String(ask.json?.user_message ?? '')).toContain(new URL(c.target.url).hostname);
    expect(await targetRowState(c.target.url)).toBeNull();

    const yesOnly = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--json'], { home: c.fx.home, env });
    results.push(yesOnly);
    expect(yesOnly.code).toBe(3);
    expect(planHashOf(yesOnly.json)).toBe(hash);

    const run = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', hash, '--json'], { home: c.fx.home, env, timeoutMs: 900_000 });
    results.push(run);
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    expect(failingChecks(run.json?.doctor ?? run.json?.receipt?.doctor ?? null)).toEqual([]);
    expect(JSON.stringify(run.json)).toContain('foresights mcp expose');
    const minutes = (Date.now() - started) / 60_000;
    expect(minutes).toBeLessThan(5);
    await expectGraduated(c, 'agent flow');
    expect(passwordLeaks(passwordOf(c.target.url), results, c.fx.dir)).toEqual([]);

    const port = freePort();
    const serve = startGbrain(['serve', '--http', '--port', String(port)], { home: c.fx.home, timeoutMs: 300_000 });
    try {
      const base = `http://127.0.0.1:${port}`;
      const live = loadLegacyExpected().secrets.liveToken;
      for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).status < 500) break; } catch {} await Bun.sleep(100); }
      const t0 = performance.now();
      const recall = await mcpHttpCall(base, live, 'search', { query: 'acme' });
      const remoteMs = Math.round(performance.now() - t0);
      expect(recall.status).toBe(200);
      expect(JSON.stringify(recall.rpc)).toContain('acme');
      const requestId = '00000000-0000-4000-8000-0000000000e1';
      const write = await mcpHttpCall(base, live, 'put_page', { slug: 'notes/after-graduation', content: 'Written over MCP after graduation.\n', request_id: requestId });
      expect(write.rpc?.error).toBeUndefined();
      const replay = await mcpHttpCall(base, live, 'put_page', { slug: 'notes/after-graduation', content: 'Written over MCP after graduation.\n', request_id: requestId });
      expect(JSON.stringify(replay.rpc?.result)).toBe(JSON.stringify(write.rpc?.result));
      await withTarget(c.target.url, async t => {
        const [row] = await t.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
        expect(Number(row.n)).toBe(1);
      });
      const denied = await mcpHttpCall(base, loadLegacyExpected().secrets.revokedToken, 'search', { query: 'acme' });
      expect(denied.status === 401 || denied.status === 403 || !!denied.rpc?.error).toBe(true);
      console.log(JSON.stringify({ graduation_agent_flow: { minutes_plan_to_green_doctor: Number(minutes.toFixed(2)), remote_search_ms: remoteMs } }));
    } finally {
      serve.kill('SIGTERM');
      await serve.exited;
    }
  }, 1_200_000);
});

describe.skipIf(!DATABASE_URL)('graduation: target emptiness and --force', () => {
  graduationTest('a target the user already initialised counts as empty', async () => {
    const c = await fresh('pre-initialised');
    const init = await gbrain(['doctor', '--json'], { home: join(c.fx.dir, 'init-home'), env: { GBRAIN_DATABASE_URL: c.target.url } });
    expect(init.code).not.toBe(2);
    const { argv, env } = await planAndRun(c);
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'pre-initialised target');
  }, 900_000);

  graduationTest('a foreign non-empty target refuses; --force binds the wipe to the previewed snapshot', async () => {
    const c = await fresh('force');
    const other = join(c.fx.dir, 'foreign-home');
    const put = await gbrain(['put', 'notes/foreign', '--source', 'default'], { home: other, env: { GBRAIN_DATABASE_URL: c.target.url }, stdin: 'a foreign brain page\n' });
    expect(put.code).toBe(0);
    const env = { [TARGET_ENV]: c.target.url };
    const plain = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--plan', '--json'], { home: c.fx.home, env });
    expect(JSON.stringify(plain.json)).toContain('target_not_empty');
    const refused = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', String(planHashOf(plain.json)), '--json'], { home: c.fx.home, env });
    expect(codeOf(refused.json)).toBe('graduation_target_not_empty');
    expect(fixOf(refused.json)?.next).toBe('ask_user');

    const preview = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--plan', '--json'], { home: c.fx.home, env });
    expect(preview.code).toBe(0);
    const hash = planHashOf(preview.json)!;
    expect(JSON.stringify(preview.json)).toMatch(/pages/);
    const more = await gbrain(['put', 'notes/foreign-2', '--source', 'default'], { home: other, env: { GBRAIN_DATABASE_URL: c.target.url }, stdin: 'added after the preview\n' });
    expect(more.code).toBe(0);
    const before = await stateDigest(join(c.fx.dir, '.none'), c.target.url);
    const changed = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--yes', '--expect', hash, '--json'], { home: c.fx.home, env });
    expect(codeOf(changed.json)).toBe('preview_changed');
    expect(digestChanges(before, await stateDigest(join(c.fx.dir, '.none'), c.target.url))).toEqual([]);

    const again = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--plan', '--json'], { home: c.fx.home, env });
    const run = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--force', '--yes', '--expect', String(planHashOf(again.json)), '--json'],
      { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'after --force');
    await withTarget(c.target.url, async t => {
      const [row] = await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'notes/foreign%'`);
      expect(Number(row.n)).toBe(0);
    });
  }, 900_000);
});
