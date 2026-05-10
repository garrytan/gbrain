/**
 * `gbrain remote` subcommands (multi-topology v1, Tier B).
 *
 * Two thin-client convenience commands that round-trip through the host's
 * HTTP MCP endpoint:
 *
 *   - `gbrain remote ping`  : submit_job(autopilot-cycle) → poll get_job →
 *                             exit when terminal. The "I just wrote markdown,
 *                             tell the host to re-index" affordance.
 *   - `gbrain remote doctor`: run_doctor MCP op → render the host's
 *                             DoctorReport → exit 0/1 based on status.
 *
 * Both require a thin-client install (~/.gbrain/config.json with remote_mcp).
 * Local installs get a clear error pointing them at the local equivalents.
 *
 * Polling design (ping): backoff curve is 1s × 30s, then 5s × 5min, then 10s.
 * Default cap 15min, override with `--timeout`. Without backoff, a 5-min
 * autopilot cycle would burn 300 round-trips against the host's rate limiter.
 */

import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult, RemoteMcpError } from '../core/mcp-client.ts';
import type { DoctorReport, Check } from './doctor.ts';

interface RemoteFlags {
  json: boolean;
  timeoutMs: number;
}

function parseFlags(args: string[]): RemoteFlags {
  const json = args.includes('--json');
  const tIdx = args.indexOf('--timeout');
  let timeoutMs = 15 * 60 * 1000;
  if (tIdx !== -1 && args[tIdx + 1]) {
    timeoutMs = parseDuration(args[tIdx + 1]) ?? timeoutMs;
  }
  return { json, timeoutMs };
}

function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? 'ms';
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
  }
  return null;
}

export async function runRemote(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    process.exit(0);
  }
  const config = loadConfig();
  if (!isThinClient(config)) {
    console.error(
      '`gbrain remote` requires thin-client mode. This install has no remote_mcp config.\n' +
      'Run `gbrain init --mcp-only` to set up thin-client mode, or use the local CLI directly.',
    );
    process.exit(1);
  }
  const subArgs = args.slice(1);

  if (sub === 'ping') {
    return runRemotePing(config!, subArgs);
  }
  if (sub === 'doctor') {
    return runRemoteDoctorCli(config!, subArgs);
  }
  console.error(`Unknown subcommand: gbrain remote ${sub}\n`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log('Usage: gbrain remote <subcommand>');
  console.log('');
  console.log('Subcommands:');
  console.log('  ping            Trigger an autopilot cycle on the remote host (sync + extract + embed).');
  console.log('  doctor          Run brain health checks on the remote host and render the report.');
  console.log('');
  console.log('Flags:');
  console.log('  --json          Emit structured JSON instead of human output.');
  console.log('  --timeout DUR   ping only: max wait (e.g. 5m, 30m, 90s). Default: 15m.');
}

/**
 * Submits an autopilot-cycle job over MCP, polls until terminal state, exits
 * 0 on completed / 1 otherwise. Backoff curve: 1s for first 30s, then 5s for
 * the next 5min, then 10s. Total wait capped at --timeout (default 15min).
 *
 * NO `repo` arg passed — the autopilot uses the server's configured brain
 * repo. This sidesteps TODO #1144 (sync_brain repo-path validation) entirely
 * because the path is server-controlled.
 *
 * Payload uses `data: {phases: [...]}`, NOT `params:` — the submit_job op
 * shape takes `data`. Codex review #8 catch.
 */
async function runRemotePing(config: NonNullable<ReturnType<typeof loadConfig>>, args: string[]): Promise<void> {
  const { json, timeoutMs } = parseFlags(args);

  let submitted: { id: number; name: string; state: string };
  try {
    const res = await callRemoteTool(config, 'submit_job', {
      name: 'autopilot-cycle',
      data: { phases: ['sync', 'extract', 'embed'] },
    });
    submitted = unpackToolResult<{ id: number; name: string; state: string }>(res);
  } catch (e) {
    return failPing(e, json);
  }

  if (!json) {
    console.error(`Submitted autopilot-cycle (job #${submitted.id}). Polling...`);
  }

  const startMs = Date.now();
  let attempt = 0;
  let lastState = submitted.state;
  while (Date.now() - startMs < timeoutMs) {
    const elapsed = Date.now() - startMs;
    const intervalMs = elapsed < 30_000 ? 1_000 : elapsed < 5 * 60_000 + 30_000 ? 5_000 : 10_000;
    await sleep(intervalMs);
    attempt++;

    let job: { id: number; state: string; failed_reason?: string };
    try {
      const res = await callRemoteTool(config, 'get_job', { id: submitted.id });
      job = unpackToolResult<{ id: number; state: string; failed_reason?: string }>(res);
    } catch (e) {
      // Network blip mid-poll: log and keep going. Surface only if persistent.
      if (!json) console.error(`  poll #${attempt} failed (${e instanceof Error ? e.message : String(e)}); continuing...`);
      continue;
    }

    if (job.state !== lastState) {
      lastState = job.state;
      if (!json) console.error(`  job #${submitted.id} → ${job.state}`);
    }

    const terminal = ['completed', 'failed', 'dead', 'cancelled'];
    if (terminal.includes(job.state)) {
      const ok = job.state === 'completed';
      if (json) {
        console.log(JSON.stringify({
          status: ok ? 'success' : 'error',
          job_id: submitted.id,
          state: job.state,
          ...(job.failed_reason ? { failed_reason: job.failed_reason } : {}),
          elapsed_ms: Date.now() - startMs,
        }));
      } else {
        console.log(ok
          ? `\nautopilot-cycle complete (${Math.round((Date.now() - startMs) / 1000)}s).`
          : `\nautopilot-cycle ended ${job.state}${job.failed_reason ? `: ${job.failed_reason}` : ''}.`);
      }
      process.exit(ok ? 0 : 1);
    }
  }

  // Timeout
  if (json) {
    console.log(JSON.stringify({
      status: 'error',
      reason: 'timeout',
      job_id: submitted.id,
      last_state: lastState,
      message: `ping timed out after ${Math.round(timeoutMs / 1000)}s; check job ${submitted.id} on the host.`,
    }));
  } else {
    console.error(`\nping timed out after ${Math.round(timeoutMs / 1000)}s. Job #${submitted.id} is still ${lastState}.`);
    console.error(`Run \`gbrain jobs get ${submitted.id}\` on the host to inspect.`);
  }
  process.exit(1);
}

function failPing(e: unknown, json: boolean): never {
  const msg = e instanceof Error ? e.message : String(e);
  const reason = e instanceof RemoteMcpError ? e.reason : 'unknown';
  if (json) {
    console.log(JSON.stringify({ status: 'error', reason, message: msg }));
  } else {
    console.error(`Failed to submit autopilot-cycle: ${msg}`);
    if (reason === 'auth' || reason === 'auth_after_refresh') {
      console.error('Hint: ensure the OAuth client was registered with admin scope (`--scopes read,write,admin`).');
    }
  }
  process.exit(1);
}

/**
 * Calls run_doctor on the remote host, renders the structured DoctorReport
 * the same way local doctor renders --json output, and exits 0/1 based on
 * status (healthy → 0, warnings/unhealthy → 0/1 respectively).
 */
async function runRemoteDoctorCli(config: NonNullable<ReturnType<typeof loadConfig>>, args: string[]): Promise<void> {
  const { json } = parseFlags(args);

  let report: DoctorReport;
  try {
    const res = await callRemoteTool(config, 'run_doctor', {});
    report = unpackToolResult<DoctorReport>(res);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const reason = e instanceof RemoteMcpError ? e.reason : 'unknown';
    if (json) {
      console.log(JSON.stringify({ status: 'error', reason, message: msg }));
    } else {
      console.error(`Failed to run remote doctor: ${msg}`);
      if (reason === 'auth' || reason === 'auth_after_refresh') {
        console.error('Hint: run_doctor requires admin scope. Re-register the client with `--scopes read,write,admin`.');
      }
    }
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(report));
  } else {
    renderDoctorReport(report);
  }
  process.exit(report.status === 'unhealthy' ? 1 : 0);
}

function renderDoctorReport(report: DoctorReport): void {
  console.log('\nGBrain Health Check (remote host)');
  console.log('=================================');
  for (const c of report.checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
  }
  console.log(`\nHealth score: ${report.health_score}/100. Status: ${report.status}.`);
  if (report.status === 'unhealthy') {
    const fails = report.checks.filter((c: Check) => c.status === 'fail');
    if (fails.length > 0) {
      console.log('\nFailures:');
      for (const f of fails) console.log(`  - ${f.name}: ${f.message}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
