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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, appendFileSync, chmodSync, cpSync, lstatSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { logFriction, frictionDir, frictionFile } from '../core/friction.ts';
import { loadScenario, listScenarios, readBrief, type ScenarioConfig } from '../core/claw-test/scenarios.ts';
import { parseProgressEvents, verifyExpectedPhases } from '../core/claw-test/progress-tail.ts';
import { resolveAgentRunner, listRegisteredAgents, registerAgentRunner, validateBinPathEnv } from '../core/claw-test/agent-runner.ts';
import { OpenClawRunner } from '../core/claw-test/runners/openclaw.ts';
import { HermesRunner } from '../core/claw-test/runners/hermes.ts';
import { GrokRunner } from '../core/claw-test/runners/grok.ts';
import { OpencodeRunner } from '../core/claw-test/runners/opencode.ts';
import { createTranscriptSink } from '../core/claw-test/transcript-capture.ts';

// Ensure built-in runners are registered.
registerAgentRunner('openclaw', () => new OpenClawRunner());
registerAgentRunner('hermes', () => new HermesRunner());
registerAgentRunner('grok', () => new GrokRunner());
registerAgentRunner('opencode', () => new OpencodeRunner());

interface HarnessOpts {
  scenario: string;
  live: boolean;
  agent: string;
  keepTempdir: boolean;
  listAgents: boolean;
  help: boolean;
  /** Path to the gbrain binary used to invoke child commands (always set by
   *  parseArgs: GBRAIN_BIN_OVERRIDE when valid; else the compiled gbrain
   *  binary, or a synthesized launcher when running under the bun runtime —
   *  see resolveGbrainBin). */
  gbrainBin: string;
}

interface PhaseOutcome {
  phase: string;
  exitCode: number;
  durationMs: number;
  stderrEvents: number;
  stdoutTail: string;
  stderrTail: string;
  /** Full stdout, only populated when invokeGbrain is asked to capture it. */
  stdoutFull?: string;
}

const TAIL_BYTES = 4_096;
/** Per-phase cap for the harness's own gbrain children (staging, scripted
 *  phases, oracle probes). Env override is a test/incident escape hatch. */
const SUBPROCESS_TIMEOUT_MS = envTimeoutMs('GBRAIN_CLAW_PHASE_TIMEOUT_MS', 5 * 60_000);
/** Wall clock for the live agent turn — real fresh-install turns run long
 *  (help text promises "5 to 10 min"), so the agent gets double the phase cap. */
const LIVE_AGENT_TIMEOUT_MS = envTimeoutMs('GBRAIN_CLAW_AGENT_TIMEOUT_MS', 10 * 60_000);

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function runClawTest(args: string[]): Promise<number> {
  const opts = parseArgs(args);

  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.listAgents) {
    return cmdListAgents();
  }

  // Charset guard: both values flow into filesystem paths (scenario → the
  // fixtures root join, agent → the run-id → the tempdir template), so a
  // traversal-shaped value would either escape the fixtures root or crash
  // sanitizeRunId mid-run. Usage error, exit 2.
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  for (const [flag, value] of [['scenario', opts.scenario], ['agent', opts.agent]] as const) {
    if (!NAME_RE.test(value)) {
      console.error(`invalid --${flag} value ${JSON.stringify(value)}: letters, digits, dot, dash, underscore only`);
      return 2;
    }
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

  // Run-start meta record. Agent-name resolution in `gbrain friction diff`
  // depends on this: a fully clean run otherwise writes zero agent-stamped
  // entries and could never be resolved by agent name. Uses the existing
  // phase-marker kind (no new FrictionKind) + additive scenario/harness_schema
  // fields.
  const agentLabel = opts.live ? opts.agent : 'scripted';
  try {
    logFriction({
      runId,
      phase: 'harness',
      kind: 'phase-marker',
      marker: 'start',
      message: `run start: scenario=${scenario.name} agent=${agentLabel}`,
      source: 'harness',
      agent: agentLabel,
      scenario: scenario.name,
      harnessSchema: 1,
    });
  } catch { /* best effort */ }

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
        agent: agentLabel,
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
  } catch (e) {
    // Without this, a thrown run (spawn failure, runner detect race) would
    // reach the finally block with exitCode still 0 and stamp a
    // `run complete … exit=0` meta record — the friction log (diff/render's
    // input) silently recording success for a crashed run.
    exitCode = 1;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`claw-test: run crashed: ${msg}`);
    if (e instanceof Error && e.stack) console.error(e.stack);
    try {
      logFriction({
        runId,
        phase: 'harness',
        message: `harness crashed: ${msg}`,
        severity: 'blocker',
        source: 'harness',
        agent: agentLabel,
      });
    } catch { /* best effort */ }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    // Run-completion meta record (pairs with the start marker above).
    try {
      logFriction({
        runId,
        phase: 'harness',
        kind: 'phase-marker',
        marker: 'end',
        message: `run complete: scenario=${scenario.name} agent=${agentLabel} exit=${exitCode}`,
        source: 'harness',
        agent: agentLabel,
        scenario: scenario.name,
      });
    } catch { /* best effort */ }
    // Persist agent/child-side friction BEFORE the tempdir is deleted. The
    // children run with GBRAIN_HOME=<runRoot>, so their friction lands under
    // <runRoot>/.gbrain/friction/<runId>.jsonl — rmSync below would silently
    // destroy it on every run, leaving `friction render`/`diff` with only the
    // harness's half of the story. Merge into the parent's friction file
    // (same runId; the two sides write disjoint entries).
    mergeChildFriction(runRoot, runId);
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

/**
 * v0.32.x: env vars that, when inherited from the parent process, would
 * break the claw-test scripted harness's "hermetic PGLite tempdir"
 * contract. The harness runs `gbrain init --pglite` then a sequence of
 * subsequent phases that ALL must hit the same tempdir brain. If the
 * parent process (e.g. a CI runner with DATABASE_URL set for OTHER e2e
 * tests) leaks DATABASE_URL into the children, loadConfig sees the env
 * var and silently flips inferredEngine to 'postgres' (config.ts:143-145),
 * forcing every phase to hit the parent's test Postgres instead of the
 * hermetic PGLite. Result: phases race against each other (multi-tenant
 * effects on the shared DB) and the harness hangs.
 *
 * Strip these on entry so the child env carries no Postgres-pointing
 * variable. PGLite-only by design.
 */
const POSTGRES_POLLUTION_ENV_VARS = ['DATABASE_URL', 'GBRAIN_DATABASE_URL'];

/**
 * Child env for gbrain invocations (scripted phases AND live-mode staging /
 * oracle probes): parent env minus Postgres-pointing vars AND minus every
 * other GBRAIN_* routing/tuning var — a stray operator GBRAIN_BRAIN_ID /
 * GBRAIN_SOURCE / threshold override would misroute the staging and oracle
 * probes and produce false verify verdicts (the same class scripts/run-e2e.sh
 * scrubs for e2e hermeticity). The two vars the harness owns are re-applied
 * last so a parent override can't win.
 */
function buildChildEnv(ctx: { runId: string; gbrainHome: string }): Record<string, string> {
  const parentEnv = process.env as Record<string, string | undefined>;
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (POSTGRES_POLLUTION_ENV_VARS.includes(k)) continue;
    if (k.startsWith('GBRAIN_')) continue;
    childEnv[k] = v;
  }
  childEnv.GBRAIN_HOME = ctx.gbrainHome;
  childEnv.GBRAIN_FRICTION_RUN_ID = ctx.runId;
  return childEnv;
}

/** The hermetic run's PGLite path (configDir appends '.gbrain'). One spelling
 *  for all probe/seed sites — a drifted copy would silently probe a
 *  nonexistent db and fail the upgrade oracle as "unreadable". */
function pgliteDbPath(gbrainHome: string): string {
  return join(gbrainHome, '.gbrain', 'brain.pglite');
}

async function runScripted(
  opts: HarnessOpts,
  scenario: ScenarioConfig,
  ctx: { runId: string; runRoot: string; gbrainHome: string },
): Promise<number> {
  // Filter out Postgres-pointing env vars before forwarding to children.
  // The harness is PGLite-only by design; an inherited DATABASE_URL
  // would force loadConfig() to flip the engine to 'postgres' at the
  // next phase boundary and break the hermetic-tempdir contract.
  const childEnv = buildChildEnv(ctx);

  const phases: { name: string; argv: string[] }[] = [];
  // Phase 2: install_brain. `--no-embedding` defers embedding setup so the
  // claw-test runs without API keys (v0.37.10.0+ requires an embedding
  // provider OR the deferral flag); this harness exercises CLI ergonomics,
  // not embedding pipelines.
  phases.push({ name: 'install_brain', argv: ['init', '--pglite', '--no-embedding'] });

  // Phase 3: import (only when scenario has a brain dir)
  // Capture brainDir for downstream phases that need an explicit --dir
  // (extract requires it post-#688 — defaults to configured source, and
  // gbrain init --pglite doesn't register a fs source).
  let brainDir: string | undefined;
  if (scenario.brainRelative) {
    brainDir = join(scenario.dir, scenario.brainRelative);
    phases.push({ name: 'import', argv: ['import', brainDir, '--no-embed', '--progress-json'] });
  }

  // Phase 4: query (best-effort sanity)
  phases.push({ name: 'query', argv: ['query', 'the'] });

  // Phase 5: extract (positional argument is required: 'all' covers links + timeline).
  // Pass --dir explicitly because the install_brain phase doesn't register
  // a fs source; without --dir, post-#688 extract refuses with "No brain
  // directory configured." When the scenario has no brain dir, skip.
  if (brainDir) {
    phases.push({ name: 'extract', argv: ['extract', 'all', '--source', 'fs', '--dir', brainDir, '--progress-json'] });
  }

  // Phase 6: verify
  phases.push({ name: 'verify', argv: ['doctor', '--json', '--progress-json'] });

  // Pre-phase: upgrade scenario seeds the database. A missing dump is a LOUD
  // failure, not a skip: skipping would init a current-version database and
  // report a false-green "upgrade" that never exercised a migration.
  if (scenario.kind === 'upgrade') {
    const seedSql = scenario.seedRelative ? join(scenario.dir, scenario.seedRelative, 'dump.sql') : null;
    if (!seedSql || !existsSync(seedSql)) {
      const msg = seedSql
        ? `upgrade scenario has no seed dump at ${seedSql}`
        : 'upgrade scenario declares no seed dir';
      logFriction({
        runId: ctx.runId,
        phase: 'seed',
        message: msg,
        severity: 'blocker',
        hint: 'upgrade runs need a real dump.sql to measure the migration (see the TODOS entry for the v0.18 seed dump)',
        source: 'harness',
        agent: 'scripted',
      });
      console.error(`[seed] ${msg}`);
      return 1;
    }
    const dbPath = pgliteDbPath(ctx.gbrainHome);
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
        agent: 'scripted',
      });
      return 1;
    }
  }

  const allStderr: string[] = [];
  const outcomes: PhaseOutcome[] = [];
  for (const phase of phases) {
    const outcome = await invokeGbrain(opts.gbrainBin, phase.argv, ctx.runRoot, childEnv);
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
        agent: 'scripted',
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
        agent: 'scripted',
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
        agent: 'scripted',
      });
    }
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

/** Per-agent install hints for the agent_detect blocker. */
const AGENT_INSTALL_HINTS: Record<string, string> = {
  openclaw: 'install openclaw or set OPENCLAW_BIN',
  hermes: 'install hermes (https://hermes-agent.nousresearch.com) or set HERMES_BIN',
  // Official xAI CLI only — the community superagent-ai grok-cli ships a
  // colliding `grok` binary (docs/mcp/GROK-CLI-PIN.md).
  grok: 'install grok (npm: @xai-official/grok, or https://x.ai/cli/install.sh) or set GROK_BIN',
  // SST terminal agent — not OpenClaw, and not the renamed-to-Crush ancestor
  // that shares the binary name (docs/mcp/OPENCODE-CLI-PIN.md).
  opencode: 'install opencode (npm: opencode-ai, or https://opencode.ai/install) or set OPENCODE_BIN',
};

/**
 * Live mode. Hermeticity posture (deliberate, documented): live mode runs the
 * OPERATOR's configured agent — the real agent home (~/.openclaw, ~/.hermes,
 * model settings, skills) is inherited — against a HERMETIC BRAIN
 * (GBRAIN_HOME=tempdir). The fully hermetic lane is the door e2e
 * (install-real-hermes.serial.test.ts), which isolates the agent home too.
 */
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
      hint: AGENT_INSTALL_HINTS[opts.agent],
      source: 'harness',
      agent: opts.agent,
    });
    return 2;
  }

  // ---- Stage the scenario (scenario-driven; mirrors the scripted branch) ----
  // The BRIEF's preconditions must actually exist before the agent reads it:
  // fresh-install promises "workspace already has an AGENTS.md", "3 small
  // markdown pages already there" (./brain), and "user just ran gbrain init".
  // Without staging, every live run starts in an empty tempdir and the run
  // measures recovery-from-broken-fixture, not gbrain friction.
  const childEnv = buildChildEnv(ctx);
  const gbrainBin = opts.gbrainBin;
  const stageFailed = await stageLiveScenario(opts, scenario, ctx, childEnv, gbrainBin);
  if (stageFailed !== 0) return stageFailed;

  // Upgrade oracle needs the pre-turn schema version (non-mutating probe —
  // any gbrain CLI connect would auto-apply migrations and do the agent's
  // work for it).
  const dbPath = pgliteDbPath(ctx.gbrainHome);
  let preVersion: number | null = null;
  if (scenario.kind === 'upgrade') {
    const { readPgliteSchemaVersion } = await import('../core/claw-test/seed-pglite.ts');
    preVersion = await readPgliteSchemaVersion(dbPath);
  }

  // ---- PATH shim: the BRIEF says `gbrain …`; make bare `gbrain` resolve to
  // THIS harness's binary (operator PATH may have none, or a stale global). ----
  const shimDir = join(ctx.runRoot, '.harness-bin');
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, 'gbrain');
  // Single-quoted: validateBinPathEnv rejects quote/metacharacter values, so
  // the interpolation cannot break out of the quoting.
  writeFileSync(shimPath, `#!/bin/sh\nexec '${gbrainBin}' "$@"\n`, 'utf-8');
  chmodSync(shimPath, 0o755);

  const sink = createTranscriptSink(ctx.transcriptPath);
  const env: Record<string, string> = {
    GBRAIN_HOME: ctx.gbrainHome,
    GBRAIN_FRICTION_RUN_ID: ctx.runId,
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
  };

  const brief = readBrief(scenario);
  let result;
  try {
    result = await runner.invoke({
      cwd: ctx.runRoot,
      brief,
      env,
      timeoutMs: LIVE_AGENT_TIMEOUT_MS,
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

  // ---- Success oracle: exit code alone passes an agent that did nothing. ----
  return verifyLiveOutcome(opts, scenario, ctx, childEnv, gbrainBin, preVersion);
}

/** Stage the workspace per scenario.kind before the agent turn. Returns 0 or a failing exit code. */
async function stageLiveScenario(
  opts: HarnessOpts,
  scenario: ScenarioConfig,
  ctx: { runId: string; runRoot: string; gbrainHome: string },
  childEnv: Record<string, string>,
  gbrainBin: string,
): Promise<number> {
  const failStage = (message: string, hint?: string): number => {
    logFriction({
      runId: ctx.runId,
      phase: 'stage',
      message,
      severity: 'blocker',
      hint,
      source: 'harness',
      agent: opts.agent,
    });
    console.error(`[stage] ${message}`);
    return 1;
  };

  if (scenario.kind === 'upgrade') {
    // Seed ONLY — running init here would walk the migration chain forward
    // and do the very upgrade the agent turn is supposed to perform (any
    // gbrain connect auto-migrates). Same seed-first order as scripted mode.
    if (scenario.seedRelative) {
      const seedSql = join(scenario.dir, scenario.seedRelative, 'dump.sql');
      if (existsSync(seedSql)) {
        const dbPath = pgliteDbPath(ctx.gbrainHome);
        mkdirSync(join(ctx.gbrainHome, '.gbrain'), { recursive: true });
        const { seedPgliteFromFile } = await import('../core/claw-test/seed-pglite.ts');
        try {
          await seedPgliteFromFile({ dbPath, sqlPath: seedSql });
          console.log(`[stage] replayed ${seedSql} → ${dbPath}`);
        } catch (e) {
          return failStage(`seed replay failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        return failStage(`upgrade scenario has no seed dump at ${seedSql}`, 'upgrade runs need a real dump.sql to measure the migration (see the TODOS entry for the v0.18 seed dump)');
      }
    } else {
      return failStage('upgrade scenario declares no seed dir');
    }
    return 0;
  }

  // fresh-install: copy the scenario's brain pages + an AGENTS.md stub, then
  // init the brain (the BRIEF says the user "just ran gbrain init").
  if (scenario.brainRelative) {
    const src = join(scenario.dir, scenario.brainRelative);
    if (!existsSync(src)) {
      // Fail loudly, matching the upgrade branch's missing-seed blocker: a
      // silent skip here would fail the query oracle later with the
      // misleading hint "the agent likely skipped the import step" when the
      // real cause is a broken fixture.
      return failStage(`fresh-install scenario declares brain dir ${scenario.brainRelative} but it does not exist at ${src}`);
    }
    cpSync(src, join(ctx.runRoot, 'brain'), { recursive: true });
  }
  const agentsMd = join(ctx.runRoot, 'AGENTS.md');
  if (!existsSync(agentsMd)) {
    // Deliberately references NO skill files: staging creates none, and a row
    // pointing at a missing SKILL.md flips doctor's resolver_health to fail
    // (caught in rehearsal). Post-v0.33 scaffolded skills route via their own
    // frontmatter triggers, so a prose stub satisfies the BRIEF's
    // "workspace already has an AGENTS.md routing file" precondition.
    writeFileSync(
      agentsMd,
      '# Workspace routing\n\nSkills scaffolded under `skills/` route via their frontmatter `triggers:`.\n',
      'utf-8',
    );
  }
  const init = await invokeGbrain(gbrainBin, ['init', '--pglite', '--no-embedding'], ctx.runRoot, childEnv);
  if (init.exitCode !== 0) {
    return failStage(`gbrain init failed during staging (exit ${init.exitCode})`, init.stderrTail.trim().slice(0, 500));
  }
  console.log('[stage] fresh-install workspace staged (brain pages + AGENTS.md + init)');
  return 0;
}

/** Post-turn verification. Logs friction (phase 'verify') and returns 1 on any failure. */
async function verifyLiveOutcome(
  opts: HarnessOpts,
  scenario: ScenarioConfig,
  ctx: { runId: string; runRoot: string; gbrainHome: string },
  childEnv: Record<string, string>,
  gbrainBin: string,
  preVersion: number | null,
): Promise<number> {
  const failures: { message: string; hint?: string }[] = [];

  if (scenario.kind === 'upgrade') {
    // The upgrade oracle is the schema version reaching LATEST during the
    // agent turn, read via the non-mutating direct-PGLite probe (doctor/any
    // CLI connect would apply the migrations itself and mask a do-nothing
    // agent). MUST run before any declared query oracle below — the query's
    // own CLI connect migrates, which would corrupt a later version read.
    const { readPgliteSchemaVersion } = await import('../core/claw-test/seed-pglite.ts');
    const { LATEST_VERSION } = await import('../core/migrate.ts');
    const dbPath = pgliteDbPath(ctx.gbrainHome);
    const postVersion = await readPgliteSchemaVersion(dbPath);
    if (preVersion === null || postVersion === null) {
      failures.push({ message: `upgrade oracle: schema version unreadable (pre=${preVersion} post=${postVersion})` });
    } else if (postVersion <= preVersion) {
      failures.push({
        message: `upgrade oracle: schema version did not advance during the agent turn (pre=${preVersion} post=${postVersion})`,
        hint: 'the agent never ran a gbrain command that walks the migration chain',
      });
    } else if (postVersion < LATEST_VERSION) {
      // Advancing one step is not an upgrade: any gbrain connect migrates to
      // latest, so a partial version means the agent's run died mid-chain.
      failures.push({
        message: `upgrade oracle: schema version advanced but stopped short of latest (pre=${preVersion} post=${postVersion} latest=${LATEST_VERSION})`,
        hint: 'a gbrain command started the migration chain but did not complete it',
      });
    }
  } else {
    // doctor: fresh --no-embedding brains report status "warnings" (observed
    // — embedding setup is deferred by design), so healthy AND warnings both
    // pass. Anything else — including output the harness cannot parse — is a
    // failure: an oracle that shrugs at unparsable output fails open.
    const doc = await invokeGbrain(gbrainBin, ['doctor', '--json'], ctx.runRoot, childEnv, { captureFullStdout: true });
    if (doc.exitCode !== 0) {
      failures.push({ message: `verify: doctor exited ${doc.exitCode}`, hint: doc.stderrTail.trim().slice(0, 300) });
    } else {
      const report = parseLastJson(doc.stdoutFull ?? doc.stdoutTail);
      const status = report && typeof report === 'object' ? (report as Record<string, unknown>).status : undefined;
      if (report === null || typeof status !== 'string') {
        failures.push({ message: 'verify: doctor exited 0 but its JSON output was unparsable' });
      } else if (status !== 'healthy' && status !== 'warnings') {
        failures.push({ message: `verify: doctor reports status ${JSON.stringify(status)}` });
      }
    }
  }

  // A declared oracle is enforced for EVERY kind (loadScenario validates it
  // for every kind — accepting config it never enforces would be a silent
  // no-op; an upgrade agent that migrates the schema but loses the seeded
  // data must still fail a declared query oracle).
  const oracle = scenario.oracle;
  if (oracle?.query) {
    const q = await invokeGbrain(gbrainBin, ['query', oracle.query, '--json'], ctx.runRoot, childEnv, { captureFullStdout: true });
    const parsed = q.exitCode === 0 ? parseLastJson(q.stdoutFull ?? q.stdoutTail) : null;
    const min = oracle.minResults ?? 1;
    // query --json emits a bare array; anything else on a zero exit means the
    // command's contract broke — fail even when min_results is 0, because
    // "0 results required" never licenses unparsable output.
    if (q.exitCode === 0 && !Array.isArray(parsed)) {
      failures.push({
        message: `verify: query ${JSON.stringify(oracle.query)} exited 0 but its JSON output was unparsable`,
      });
    } else {
      const count = Array.isArray(parsed) ? parsed.length : 0;
      if (q.exitCode !== 0 || count < min) {
        failures.push({
          message: `verify: query ${JSON.stringify(oracle.query)} returned ${count} result(s), expected >= ${min} (exit ${q.exitCode})`,
          hint: 'the agent likely skipped the import step from the brief',
        });
      }
    }
  }
  for (const rel of oracle?.filesExist ?? []) {
    if (!existsSync(join(ctx.runRoot, rel))) {
      failures.push({
        message: `verify: expected file missing after run: ${rel}`,
        hint: 'the agent likely skipped a brief step that produces this file',
      });
    }
  }

  for (const f of failures) {
    logFriction({
      runId: ctx.runId,
      phase: 'verify',
      message: f.message,
      severity: 'error',
      hint: f.hint,
      source: 'harness',
      agent: opts.agent,
    });
    console.error(`[verify] ${f.message}`);
  }
  return failures.length ? 1 : 0;
}

/**
 * Parse the trailing JSON document from CLI stdout (defensive: banners or
 * notices may precede the payload).
 */
function parseLastJson(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch { /* fall through */ }
  const starts = ['{', '['];
  for (let i = 0; i < text.length; i++) {
    if (starts.includes(text[i])) {
      try {
        return JSON.parse(text.slice(i));
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

/** Refuse to import child friction files larger than this — the file lives in
 *  a workspace the AGENT writes to, so its size is untrusted. */
const CHILD_FRICTION_MAX_BYTES = 4 * 1024 * 1024;

/**
 * E0: merge the child-side friction file (written under the run's hermetic
 * GBRAIN_HOME) into the parent process's friction dir so it survives tempdir
 * cleanup. Best-effort — a merge failure never fails the run.
 *
 * The child file is UNTRUSTED input (in live mode the agent can write
 * arbitrary bytes at that path), and the destination is the operator's
 * permanent friction log: require a regular file (no symlink — an agent-
 * dropped link could import any readable file on the box), cap the size, and
 * append only lines that parse as JSON objects so the log stays valid JSONL.
 * Exported for tests.
 */
export function mergeChildFriction(runRoot: string, runId: string): void {
  try {
    const childFile = join(runRoot, '.gbrain', 'friction', `${runId}.jsonl`);
    const st = lstatSync(childFile, { throwIfNoEntry: false });
    if (!st) return;
    if (!st.isFile()) {
      console.error(`[friction] skipping child friction merge: ${childFile} is not a regular file`);
      return;
    }
    if (st.size > CHILD_FRICTION_MAX_BYTES) {
      console.error(`[friction] skipping child friction merge: ${childFile} is ${st.size} bytes (cap ${CHILD_FRICTION_MAX_BYTES})`);
      return;
    }
    const parentFile = frictionFile(runId);
    if (resolve(childFile) === resolve(parentFile)) return;
    const raw = readFileSync(childFile, 'utf-8');
    if (!raw.trim()) return;
    const kept: string[] = [];
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) kept.push(line);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    if (skipped) console.error(`[friction] child friction merge skipped ${skipped} non-JSONL line(s)`);
    if (!kept.length) return;
    const dir = frictionDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(parentFile, kept.join('\n') + '\n', 'utf-8');
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function invokeGbrain(
  bin: string,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  invokeOpts?: { captureFullStdout?: boolean },
): Promise<PhaseOutcome> {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const child = spawn(bin, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (b: Buffer) => stdout.push(b));
    child.stderr?.on('data', (b: Buffer) => stderr.push(b));

    // A hung child (e.g. a leaked PGLite lock holder from the agent turn)
    // must not wedge the harness/CI job forever: SIGTERM at the phase cap,
    // SIGKILL if it lingers.
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const wallClockTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 10_000);
    }, SUBPROCESS_TIMEOUT_MS);
    const clearTimers = () => {
      clearTimeout(wallClockTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    let settled = false;
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      let stderrText = Buffer.concat(stderr).toString('utf-8');
      if (timedOut) stderrText += `\nharness: killed after ${SUBPROCESS_TIMEOUT_MS}ms phase timeout`;
      const stdoutText = Buffer.concat(stdout).toString('utf-8');
      resolvePromise({
        phase: '',
        exitCode: typeof code === 'number' ? code : (timedOut ? 124 : 1),
        durationMs: Date.now() - start,
        stderrEvents: parseProgressEvents(stderrText).length,
        stdoutTail: tailOf(stdoutText),
        stderrTail: stderrText,
        // The 4KB tail is fine for logging but NOT for parsing JSON payloads
        // (doctor --json exceeds it and would lose its opening brace).
        ...(invokeOpts?.captureFullStdout ? { stdoutFull: stdoutText } : {}),
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      const stderrJoined = Buffer.concat(stderr).toString('utf-8') + '\nspawn error: ' + err.message;
      resolvePromise({
        phase: '',
        exitCode: 127,
        durationMs: Date.now() - start,
        stderrEvents: 0,
        stdoutTail: tailOf(Buffer.concat(stdout).toString('utf-8')),
        stderrTail: tailOf(stderrJoined),
      });
    });
    // 'close' (pipes drained) is the clean path; 'exit' + grace covers a
    // grandchild that inherits the pipes and outlives the kill — without it a
    // timed-out phase whose child leaked a subprocess would wedge forever.
    child.on('close', (code) => settle(code));
    child.on('exit', (code) => {
      const t = setTimeout(() => settle(code), 2_000);
      t.unref?.();
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
    gbrainBin: resolveGbrainBin(),
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

/**
 * Resolve the gbrain binary child invocations use. GBRAIN_BIN_OVERRIDE goes
 * through the same absolute/no-dotdot/no-metacharacter validation as the
 * *_BIN runner overrides — the value is interpolated into a generated
 * PATH-shim script in live mode, so a relative value would re-resolve through
 * the shimmed PATH and self-exec forever, and quoting-hostile characters
 * would become code. Invalid overrides are rejected loudly (stderr) and the
 * harness falls back to the current executable.
 *
 * The fallback is NOT bare process.execPath: under `bun run src/cli.ts` (the
 * canonical source install) or a bun-global launcher, execPath is the Bun
 * RUNTIME, and children would run `bun init` / `bun import` instead of gbrain
 * — scaffolding a Bun project in the hermetic workspace and failing the rest
 * of the run. When execPath looks like bun, synthesize a launcher shim that
 * re-enters this checkout's cli.ts; only a compiled gbrain binary returns
 * execPath directly.
 */
let cachedGbrainBin: string | null = null;

function resolveGbrainBin(): string {
  if (cachedGbrainBin) return cachedGbrainBin;
  cachedGbrainBin = resolveGbrainBinUncached();
  return cachedGbrainBin;
}

function resolveGbrainBinUncached(): string {
  const override = process.env.GBRAIN_BIN_OVERRIDE?.trim();
  if (override) {
    const invalid = validateBinPathEnv('GBRAIN_BIN_OVERRIDE', override);
    if (!invalid) return override;
    console.error(`ignoring ${invalid}; falling back to the current executable`);
  }
  const exe = process.execPath;
  if (/^bun(-profile)?(\.exe)?$/i.test(basename(exe))) {
    // src/commands/claw-test.ts → ../cli.ts. Under a compiled binary this
    // branch never fires (execPath is the gbrain binary itself); under bun
    // (dev checkout or bun-global install) import.meta resolves to the real
    // source file next to cli.ts.
    const cliTs = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
    if (existsSync(cliTs) && !/['\n\r]/.test(exe) && !/['\n\r]/.test(cliTs)) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-launcher-'));
      const launcher = join(dir, 'gbrain');
      writeFileSync(launcher, `#!/bin/sh\nexec '${exe}' '${cliTs}' "$@"\n`, 'utf-8');
      chmodSync(launcher, 0o755);
      return launcher;
    }
    console.error(
      'claw-test: running under the bun runtime but the gbrain CLI entrypoint could not be located — ' +
      'child gbrain invocations would run bun itself. Set GBRAIN_BIN_OVERRIDE to a gbrain binary.',
    );
  }
  return exe;
}

function newRunId(agent: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const suf = randomBytes(4).toString('hex');
  return `claw-test-${ts}-${agent}-${suf}`;
}

async function cmdListAgents(): Promise<number> {
  const names = listRegisteredAgents();
  if (!names.length) {
    console.log('no agents registered');
    return 0;
  }
  // Detect concurrently but AWAIT all of them, then print in
  // listRegisteredAgents() order (the accessor sorts alphabetically).
  // The prior fire-and-forget .then() version returned before any detection
  // resolved, so output could vanish in CLI teardown.
  const lines = await Promise.all(names.map(async (name) => {
    try {
      const runner = resolveAgentRunner(name);
      try {
        const d = await runner.detect();
        return `${name}: ${d.available ? `available at ${d.binPath}` : `unavailable: ${d.reason}`}`;
      } catch {
        return `${name}: (detect error)`;
      }
    } catch {
      return `${name}: (factory error)`;
    }
  }));
  for (const line of lines) console.log(line);
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

Live mode runs YOUR configured agent (it may read/write your real agent home,
e.g. ~/.openclaw or ~/.hermes) against a hermetic brain. The door e2e suite is
the fully hermetic lane.

Examples:
  gbrain claw-test --scenario fresh-install
  gbrain claw-test --scenario upgrade-from-v0.18 --keep-tempdir
  gbrain claw-test --live --agent openclaw
  gbrain claw-test --live --agent opencode
  gbrain claw-test --live --agent hermes
  gbrain claw-test --live --agent grok`);
}
