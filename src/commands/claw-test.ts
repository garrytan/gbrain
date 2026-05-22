/**
 * gbrain claw-test — end-to-end "fresh user" test harness.
 *
 * Two tiers:
 *   gbrain claw-test                              — scripted (no LLM, CI gate)
 *   gbrain claw-test --live --agent openclaw      — real agent, friction discovery
 *
 * Phases (scripted mode):
 *   setup → install_brain → import → query → extract → verify → render
 *
 * The harness sets GBRAIN_HOME=<tempdir> so the run is hermetic. Each child
 * gbrain invocation runs with --progress-json and the harness captures stderr
 * to assert expected_phases from scenario.json fired.
 *
 * See ~/.claude/plans/system-instruction-you-are-working-noble-biscuit.md
 * for the full design rationale (D1–D23 decisions).
 */

import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { logFriction, frictionDir } from '../core/friction.ts';
import { loadScenario, listScenarios, readBrief, type ScenarioConfig } from '../core/claw-test/scenarios.ts';
import { parseProgressEvents, verifyExpectedPhases } from '../core/claw-test/progress-tail.ts';
import { resolveAgentRunner, listRegisteredAgents, registerAgentRunner } from '../core/claw-test/agent-runner.ts';
import { OpenClawRunner } from '../core/claw-test/runners/openclaw.ts';
import { createTranscriptSink } from '../core/claw-test/transcript-capture.ts';

// Ensure built-in runners are registered.
registerAgentRunner('openclaw', () => new OpenClawRunner());

interface HarnessOpts {
  scenario: string;
  live: boolean;
  agent: string;
  keepTempdir: boolean;
  listAgents: boolean;
  help: boolean;
  /** Path to the gbrain binary used to invoke child commands. Defaults to argv[0]. */
  gbrainBin?: string;
}

interface PhaseOutcome {
  phase: string;
  exitCode: number;
  durationMs: number;
  stderrEvents: number;
  stdoutTail: string;
  stderrTail: string;
}

const TAIL_BYTES = 4_096;
const SUBPROCESS_TIMEOUT_MS = 5 * 60_000; // 5 minutes per phase

export async function runClawTest(args: string[]): Promise<number> {
  const opts = parseArgs(args);

  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.listAgents) {
    return cmdListAgents();
  }

  let scenario: ScenarioConfig;
  try {
    scenario = loadScenario(opts.scenario);
  } catch (e) {
    console.error(`scenario load failed: ${e instanceof Error ? e.message : String(e)}`);
    const available = listScenarios();
    if (available.length) console.error(`available scenarios: ${available.join(', ')}`);
    return 2;
  }

  const runId = newRunId(opts.agent);
  const runRoot = mkdtempSync(join(tmpdir(), `claw-test-${runId}-`));
  const gbrainHome = runRoot; // configDir() appends '.gbrain' itself
  const transcriptPath = join(runRoot, 'transcript.jsonl');
  console.log(`run-id: ${runId}`);
  console.log(`tempdir: ${runRoot}`);

  // SIGINT/SIGTERM finalization (D11)
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    try {
      logFriction({
        runId,
        phase: 'harness',
        message: 'run interrupted by signal',
        kind: 'interrupted',
        source: 'harness',
        agent: opts.agent,
      });
    } catch { /* best effort */ }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let exitCode = 0;
  try {
    if (opts.live) {
      exitCode = await runLive(opts, scenario, { runId, runRoot, gbrainHome, transcriptPath });
    } else {
      exitCode = await runScripted(opts, scenario, { runId, runRoot, gbrainHome });
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (!opts.keepTempdir && !interrupted) {
      try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.log(`tempdir kept at: ${runRoot}`);
    }
  }

  // Always render at the end so the operator can immediately see the report.
  console.log('---');
  console.log(`friction log:    ${join(frictionDir(), runId + '.jsonl')}`);
  console.log(`render report:   gbrain friction render --run-id ${runId}`);

  if (interrupted) return 130;
  return exitCode;
}

// ---------------------------------------------------------------------------
// Scripted mode
// ---------------------------------------------------------------------------

async function runScripted(
  opts: HarnessOpts,
  scenario: ScenarioConfig,
  ctx: { runId: string; runRoot: string; gbrainHome: string },
): Promise<number> {
  const childEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    GBRAIN_HOME: ctx.gbrainHome,
    GBRAIN_FRICTION_RUN_ID: ctx.runId,
  };

  const phases: { name: string; argv: string[] }[] = [];
  // Phase 2: install_brain
  phases.push({ name: 'install_brain', argv: ['init', '--pglite'] });

  // Phase 3: import (only when scenario has a brain dir)
  if (scenario.brainRelative) {
    const brainDir = join(scenario.dir, scenario.brainRelative);
    phases.push({ name: 'import', argv: ['import', brainDir, '--no-embed', '--progress-json'] });
  }

  // Phase 4: query (best-effort sanity)
  phases.push({ name: 'query', argv: ['query', 'the'] });

  // Phase 5: extract (positional argument is required: 'all' covers links + timeline)
  phases.push({ name: 'extract', argv: ['extract', 'all', '--source', 'fs', '--progress-json'] });

  // Phase 6: verify
  phases.push({ name: 'verify', argv: ['doctor', '--json', '--progress-json'] });

  // Pre-phase: upgrade scenario seeds the database
  if (scenario.kind === 'upgrade' && scenario.seedRelative) {
    const seedSql = join(scenario.dir, scenario.seedRelative, 'dump.sql');
    if (existsSync(seedSql)) {
      const dbPath = join(ctx.gbrainHome, '.gbrain', 'brain.pglite');
      mkdirSync(join(ctx.gbrainHome, '.gbrain'), { recursive: true });
      const { seedPgliteFromFile } = await import('../core/claw-test/seed-pglite.ts');
      try {
        await seedPgliteFromFile({ dbPath, sqlPath: seedSql });
        console.log(`[seed] replayed ${seedSql} → ${dbPath}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logFriction({
          runId: ctx.runId,
          phase: 'seed',
          message: `seed replay failed: ${msg}`,
          severity: 'blocker',
          source: 'harness',
          agent: opts.agent,
        });
        return 1;
      }
    }
  }

  const allStderr: string[] = [];
  const outcomes: PhaseOutcome[] = [];
  for (const phase of phases) {
    const outcome = await invokeGbrain(opts.gbrainBin ?? 'gbrain', phase.argv, ctx.runRoot, childEnv);
    outcome.phase = phase.name;
    outcomes.push(outcome);
    allStderr.push(outcome.stderrTail);
    if (outcome.exitCode !== 0) {
      logFriction({
        runId: ctx.runId,
        phase: phase.name,
        message: `command failed (exit ${outcome.exitCode}): gbrain ${phase.argv.join(' ')}`,
        severity: 'error',
        hint: outcome.stderrTail.trim().slice(0, 500),
        source: 'harness',
        agent: opts.agent,
      });
      return 1;
    } else {
      logFriction({
        runId: ctx.runId,
        phase: phase.name,
        message: `phase complete in ${outcome.durationMs}ms`,
        kind: 'phase-marker',
        marker: 'end',
        source: 'harness',
        agent: opts.agent,
      });
    }
  }

  // Phase verification: collect all events from every captured stderr and assert coverage.
  const events = allStderr.flatMap(parseProgressEvents);
  const missing = verifyExpectedPhases(events, scenario.expectedPhases);
  if (missing.length) {
    for (const phaseName of missing) {
      logFriction({
        runId: ctx.runId,
        phase: phaseName,
        message: `expected progress event for "${phaseName}" never fired`,
        severity: 'blocker',
        hint: 'either the command did not run or it did not emit progress events; check phase log above',
        source: 'harness',
        agent: opts.agent,
      });
    }
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

async function runLive(
  opts: HarnessOpts,
  scenario: ScenarioConfig,
  ctx: { runId: string; runRoot: string; gbrainHome: string; transcriptPath: string },
): Promise<number> {
  let runner;
  try {
    runner = resolveAgentRunner(opts.agent);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }

  const detected = await runner.detect();
  if (!detected.available) {
    console.error(`agent "${opts.agent}" not available: ${detected.reason ?? 'unknown'}`);
    logFriction({
      runId: ctx.runId,
      phase: 'agent_detect',
      message: `agent ${opts.agent} not available: ${detected.reason ?? 'unknown'}`,
      severity: 'blocker',
      hint: opts.agent === 'openclaw' ? 'install openclaw or set OPENCLAW_BIN' : undefined,
      source: 'harness',
      agent: opts.agent,
    });
    return 2;
  }

  const sink = createTranscriptSink(ctx.transcriptPath);
  const env: Record<string, string> = {
    GBRAIN_HOME: ctx.gbrainHome,
    GBRAIN_FRICTION_RUN_ID: ctx.runId,
  };

  const brief = readBrief(scenario);
  let result;
  try {
    result = await runner.invoke({
      cwd: ctx.runRoot,
      brief,
      env,
      timeoutMs: SUBPROCESS_TIMEOUT_MS,
      transcriptSink: sink,
    });
  } finally {
    await sink.close();
  }

  if (result.exitCode !== 0) {
    logFriction({
      runId: ctx.runId,
      phase: 'agent_invoke',
      message: `agent exited with code ${result.exitCode} after ${result.durationMs}ms`,
      severity: 'error',
      source: 'harness',
      agent: opts.agent,
    });
    return result.exitCode;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function invokeGbrain(
  bin: string,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<PhaseOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => stdout.push(b));
    child.stderr?.on('data', (b: Buffer) => stderr.push(b));
    child.on('error', (err) => {
      const stderrJoined = Buffer.concat(stderr).toString('utf-8') + '\nspawn error: ' + err.message;
      resolve({
        phase: '',
        exitCode: 127,
        durationMs: Date.now() - start,
        stderrEvents: 0,
        stdoutTail: tailOf(Buffer.concat(stdout).toString('utf-8')),
        stderrTail: tailOf(stderrJoined),
      });
    });
    child.on('close', (code) => {
      const stderrText = Buffer.concat(stderr).toString('utf-8');
      resolve({
        phase: '',
        exitCode: typeof code === 'number' ? code : 1,
        durationMs: Date.now() - start,
        stderrEvents: parseProgressEvents(stderrText).length,
        stdoutTail: tailOf(Buffer.concat(stdout).toString('utf-8')),
        stderrTail: stderrText,
      });
    });
  });
}

function tailOf(s: string): string {
  if (s.length <= TAIL_BYTES) return s;
  return s.slice(-TAIL_BYTES);
}

// ---------------------------------------------------------------------------
// Argv parsing + helpers
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): HarnessOpts {
  const out: HarnessOpts = {
    scenario: 'fresh-install',
    live: false,
    agent: 'openclaw',
    keepTempdir: false,
    listAgents: false,
    help: args.includes('--help') || args.includes('-h'),
    gbrainBin: process.env.GBRAIN_BIN_OVERRIDE || process.execPath,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--live') out.live = true;
    else if (a === '--keep-tempdir') out.keepTempdir = true;
    else if (a === '--list-agents') out.listAgents = true;
    else if (a === '--scenario') out.scenario = args[++i] ?? out.scenario;
    else if (a === '--agent') out.agent = args[++i] ?? out.agent;
  }
  return out;
}

function newRunId(agent: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const suf = randomBytes(4).toString('hex');
  return `claw-test-${ts}-${agent}-${suf}`;
}

function cmdListAgents(): number {
  const names = listRegisteredAgents();
  if (!names.length) {
    console.log('no agents registered');
    return 0;
  }
  for (const name of names) {
    try {
      const runner = resolveAgentRunner(name);
      runner.detect().then((d) => {
        const status = d.available ? `available at ${d.binPath}` : `unavailable: ${d.reason}`;
        console.log(`${name}: ${status}`);
      }).catch(() => { /* best effort */ });
    } catch {
      console.log(`${name}: (factory error)`);
    }
  }
  return 0;
}

function printHelp() {
  console.log(`gbrain claw-test — end-to-end claw-setup friction harness

Usage:
  gbrain claw-test [--scenario <name>] [--live --agent <name>] [--keep-tempdir]
  gbrain claw-test --list-agents

Defaults:
  --scenario fresh-install
  --agent openclaw (live mode only)

Scripted mode runs canonical commands without an LLM (CI gate).
Live mode spawns a real agent and lets it drive (~5–10 min, costs tokens).

Examples:
  gbrain claw-test --scenario fresh-install
  gbrain claw-test --scenario upgrade-from-v0.18 --keep-tempdir
  gbrain claw-test --live --agent openclaw`);
}
