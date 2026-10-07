/**
 * `gbrain doctor --only harness_wiring --json` (agent-first operator wave G5
 * step 2, Lane E): engine-free, read-only smoke of the harness registration.
 *
 * Hermetic HOME + GBRAIN_HOME on a keyless PGLite brain:
 * - no harness and no registration → ok + severity:info with the install fix;
 * - a Claude Code registration (~/.claude.json) whose argv starts a real
 *   `gbrain serve --surface verbs` → the smoke spawns it and runs initialize +
 *   tools/list + recall → ok, reason wired_running / smoke_passed;
 * - a live `gbrain serve` already holding the brain lock → ok without spawning
 *   (doctor runs only after that serve answers the MCP handshake, which it does
 *   after taking the lock; polling earlier let doctor's own smoke serve win the
 *   lock and leave the live serve in status-only mode);
 * - a registration whose binary does not exist → warn with a fix or reason;
 * - doctor seeds nothing: the brain holds no pages afterwards.
 *
 * Serial: spawns `gbrain serve` subprocesses against one PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { peekLock } from '../src/core/pglite-lock.ts';
import { makeDoctorHome, runGbrain, type DoctorHome } from './helpers/doctor-json-golden.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let h: DoctorHome;

function register(command: string, args: string[]): void {
  writeFileSync(join(h.home, '.claude.json'), JSON.stringify({
    mcpServers: { gbrain: { type: 'stdio', command, args, env: { GBRAIN_HOME: h.home, GBRAIN_SKIP_STARTUP_HOOKS: '1' } } },
  }));
}

function harnessCheck(run: { json: unknown; stdout: string }): Record<string, unknown> {
  const report = run.json as { checks?: Array<Record<string, unknown>> } | null;
  const check = report?.checks?.find(c => c.name === 'harness_wiring');
  if (!check) throw new Error(`no harness_wiring check in: ${run.stdout.slice(0, 500)}`);
  return check;
}

beforeAll(async () => {
  h = makeDoctorHome('doctor-harness-smoke');
  const init = await runGbrain(h, ['init', '--pglite', '--no-embedding']);
  if (init.exitCode !== 0) throw new Error(`gbrain init failed (${init.exitCode}): ${init.stderr}`);
}, 120_000);

afterAll(() => h?.cleanup());

describe('doctor --only harness_wiring', () => {
  test('no harness and no registration: information with the install fix', async () => {
    rmSync(join(h.home, '.claude.json'), { force: true });
    const run = await runGbrain(h, ['doctor', '--only', 'harness_wiring', '--json']);
    expect(run.exitCode).toBe(0);
    const report = run.json as { checks: unknown[] };
    expect(report.checks).toHaveLength(1);
    expect(harnessCheck(run)).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'missing', details: { reason: 'no_harness_detected' } });
  }, 60_000);

  test('a registered stdio serve answers initialize + tools/list + recall', async () => {
    register(process.execPath, ['--no-env-file', CLI, 'serve', '--direct', '--surface', 'verbs']);
    const run = await runGbrain(h, ['doctor', '--only', 'harness_wiring', '--json']);
    const check = harnessCheck(run);
    expect(check, run.stderr).toMatchObject({ status: 'ok', details: { reason: 'wired_running', smoke: 'smoke_passed', harness: 'claude-code' } });
    expect(String(check.message)).toContain('recall answered');
  }, 60_000);

  test('a live serve holding the brain lock passes without spawning a second one', async () => {
    register(process.execPath, ['--no-env-file', CLI, 'serve', '--direct', '--surface', 'verbs']);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, { HOME: h.home, GBRAIN_HOME: h.home, GBRAIN_SKIP_STARTUP_HOOKS: '1' });
    // This fixture asserts process ownership and immediate release between checks.
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve', '--direct', '--surface', 'verbs'], env, stderr: 'pipe' });
    let serveStderr = '';
    transport.stderr?.on('data', (chunk) => { serveStderr += String(chunk); });
    const client = new Client({ name: 'doctor-harness-smoke-live-serve', version: '1' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const dataDir = join(h.home, '.gbrain', 'brain.pglite');
      const owner = peekLock(dataDir);
      const run = await runGbrain(h, ['doctor', '--only', 'harness_wiring', '--json']);
      const check = harnessCheck(run);
      const lockFile = join(dataDir, '.gbrain-lock', 'lock');
      const diagnostics = [
        `live serve pid ${transport.pid}; observed owner ${JSON.stringify(owner)}`,
        `lock record: ${existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : '(missing)'}`,
        `doctor stderr: ${run.stderr}`,
        `serve stderr: ${serveStderr}`,
      ].join('\n');
      expect(owner, diagnostics).toMatchObject({ held: true, isServe: true, pid: transport.pid });
      expect(check, diagnostics).toMatchObject({ status: 'ok', details: { reason: 'wired_running' } });
      expect(check.details, diagnostics).not.toHaveProperty('smoke');
      expect(String(check.message), diagnostics).toContain('holds this brain');
    } finally {
      await client.close().catch(() => {});
    }
  }, 90_000);

  test('a registration whose binary is missing warns with a next step', async () => {
    register(join(h.home, 'missing', 'gbrain'), ['serve', '--surface', 'verbs']);
    const run = await runGbrain(h, ['doctor', '--only', 'harness_wiring', '--json']);
    const check = harnessCheck(run);
    expect(check.status).toBe('warn');
    expect(check.fix !== undefined || check.fix_unavailable_reason !== undefined).toBe(true);
    expect((check.details as Record<string, unknown>).reason).toBe('spawn_failed');
  }, 60_000);

  test('doctor seeds nothing into the brain', async () => {
    rmSync(join(h.home, '.claude.json'), { force: true });
    const run = await runGbrain(h, ['doctor', '--only', 'connection', '--json']);
    const conn = (run.json as { checks: Array<{ name: string; message: string }> }).checks.find(c => c.name === 'connection');
    expect(conn?.message).toMatch(/Connected, 0 pages/);
  }, 60_000);
});
