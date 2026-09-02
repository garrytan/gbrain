/**
 * `gbrain agent` CLI: the user-facing entry point for the v0.15 subagent
 * runtime.
 *
 *   gbrain agent run <prompt> [flags]
 *   gbrain agent logs <job_id> [--follow] [--since <spec>]
 *
 * `run` submits a subagent job (or fan-out of N subagents + aggregator)
 * under the trusted-submit flag so the PROTECTED_JOB_NAMES guard doesn't
 * reject. It does NOT execute the loop here — the handler runs in a
 * `gbrain jobs work` process. `--follow` tails status until terminal;
 * without `--follow` (or with `--detach`) the CLI prints the job id and
 * exits, leaving the user to check back with `gbrain agent logs`.
 */

import * as fs from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { isQueueQuotaExceededError } from '../core/minions/admission.ts';
import { waitForCompletion, TimeoutError } from '../core/minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData, AggregatorHandlerData } from '../core/minions/types.ts';
import { resolveSourceId, isResolverUserError, ALL_SOURCES } from '../core/source-resolver.ts';
import { fetchSource } from '../core/sources-load.ts';
import { runAgentLogs } from './agent-logs.ts';

// ── arg parsing helpers ────────────────────────────────────

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
function hasFlag(args: string[], flag: string): boolean { return args.includes(flag); }

/** Keep CLI args that look like flags from being eaten as the prompt. */
function isKnownFlag(s: string): boolean {
  return s.startsWith('--');
}

// ── command dispatcher ────────────────────────────────────

export async function runAgent(engine: BrainEngine | null, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  // Subcommand-aware help that STOPS at the `--` terminator: `agent run --
  // --help` submits the LITERAL prompt; only a pre-`--` --help/-h is a help
  // request. Answered before any engine or queue work, so the
  // SELF_HELP_WITHOUT_ENGINE lane (engine === null) prints real help on a
  // brainless machine and can never submit a job (cathedral-6 eng review).
  const rest = args.slice(1);
  const dd = rest.indexOf('--');
  const helpScan = dd === -1 ? rest : rest.slice(0, dd);
  const wantsHelp = helpScan.includes('--help') || helpScan.includes('-h');

  switch (sub) {
    case 'run':
      if (wantsHelp) { printHelp(); return; }
      if (!engine) { console.error('gbrain agent run needs a configured brain. Run `gbrain init` first.'); process.exit(1); }
      await runAgentRun(engine, rest);
      return;
    case 'logs':
      if (wantsHelp) { printHelp(); return; }
      if (!engine) { console.error('gbrain agent logs needs a configured brain. Run `gbrain init` first.'); process.exit(1); }
      await runAgentLogsCmd(engine, rest);
      return;
    case 'register': {
      const { printRegisterHelp, runAgentRegister } = await import('./agent-register.ts');
      if (wantsHelp) { printRegisterHelp(); return; }
      await runAgentRegister(engine, rest);
      return;
    }
    default:
      console.error(`gbrain agent: unknown subcommand "${sub}"`);
      printHelp();
      process.exit(2);
  }
}

function printHelp(): void {
  console.log(`gbrain agent — durable LLM agent runs (v0.15)

USAGE
  gbrain agent run <prompt> [flags]
  gbrain agent logs <job_id> [--follow] [--since <spec>]
  gbrain agent register <name> --harness <h> [flags]   (see: gbrain agent register --help)

SUBMITTING
  gbrain agent run <prompt>
    --subagent-def <name>        Named plugin subagent (from GBRAIN_PLUGIN_PATH)
    --model <id>                 Model id as provider:model (default: subagent tier model,
                                  anthropic:claude-sonnet-4-6). Non-Anthropic providers need
                                  agent.use_gateway_loop enabled — see NOTES below.
    --max-turns <n>              Max assistant turns (default 20)
    --tools a,b,c                Subset of registered tool names (comma list)
    --timeout-ms <n>             Per-job wall-clock timeout
    --source <id>                Brain source the subagent's writes are scoped to.
                                  Default: the standard resolution chain (GBRAIN_SOURCE,
                                  .gbrain-source, sources.default, ...) — see
                                  \`gbrain sources current\`
    --fanout-manifest <path>     JSON array of {prompt, input_vars?} — one child each
    --follow                     Tail status until terminal (default on TTY)
    --detach                     Submit + print job id, exit immediately

  Flags before the prompt are parsed normally. The no-value switches
  --detach, --follow and --no-follow are ALSO recognized when they trail
  the prompt, so \`gbrain agent run "do X" --detach\` detaches. Any other
  --word is treated as prompt text (no error). Use \`--\` to end flag
  parsing and pass the rest verbatim:
    gbrain agent run -- "literally --detach this, with --flags"

VIEWING
  gbrain agent logs <job_id>
    --follow                     Keep polling until the job reaches terminal
    --since <spec>               ISO-8601 timestamp OR relative ("5m","1h","2d")

NOTES
  This CLI path is trusted-only. (Remote MCP callers reach subagents through
  the scoped submit_agent operation, not through this command.)

  By default the worker runs the legacy Anthropic-direct path, which needs an
  Anthropic key — from ANTHROPIC_API_KEY or from anthropic_api_key in
  ~/.gbrain/config.json — or the first LLM turn of a claimed job fails.

  To run --model on a non-Anthropic provider, enable the provider-neutral
  gateway loop first, then supply whatever credential that provider needs
  (an API key for most; some recipes use OAuth or a local endpoint):
    gbrain config set agent.use_gateway_loop true
  Accepted values: true / 1 / yes / on.

  The gateway loop needs a provider whose recipe supports chat WITH tool
  calling AND declares supports_subagent_loop: true — not every recipe under
  src/core/ai/recipes/ qualifies. A model that cannot call tools, or whose
  tool_call_ids are not replay-stable, is refused at job start with the
  reason named.
`);
}

// ── `gbrain agent run` ────────────────────────────────────

interface RunFlags {
  subagentDef?: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  timeoutMs?: number;
  source?: string;
  fanoutManifest?: string;
  follow: boolean;
  detach: boolean;
}

/** No-value switches that may also trail the prompt and get hoisted out (#1738). */
const BOOLEAN_TAIL_FLAGS = new Set(['--follow', '--no-follow', '--detach']);

function applyBooleanFlag(flags: RunFlags, a: string): void {
  if (a === '--follow') flags.follow = true;
  else if (a === '--no-follow') flags.follow = false;
  else { flags.detach = true; flags.follow = false; } // --detach
}

/** Read the value for a value-flag, rejecting a missing or flag-shaped value. */
function requireFlagValue(args: string[], i: number, flag: string): string {
  const v = args[i];
  if (v === undefined || v.startsWith('--')) {
    throw new Error(`gbrain agent run: ${flag} requires a value. Run \`gbrain agent run --help\`.`);
  }
  return v;
}

function parseIntFlagValue(v: string, flag: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`gbrain agent run: ${flag} expects a number, got "${v}".`);
  }
  return n;
}

/**
 * Parse `agent run` args into flags + prompt (#1738).
 *
 *   args ──► [ leading flag zone ] [ ── ? ] [ prompt … (trailing booleans) ]
 *
 * Leading zone: known flags (value + boolean) are consumed left-to-right until
 * the first positional token, an UNKNOWN --flag, or an explicit `--`. An
 * unknown --flag is NOT an error — it begins the freeform prompt, so
 * `agent run "--note: do X"` works without `--`. Value-flags missing their
 * value throw a usage error instead of silently capturing `undefined`/`NaN`.
 *
 * Prompt zone: a trailing run of the no-value switches (--detach/--follow/
 * --no-follow) is hoisted out so `agent run "do X" --detach` detaches. Only
 * trailing switches are hoisted; a `--word` elsewhere in the prompt stays
 * verbatim. After an explicit `--`, nothing is hoisted.
 */
function parseRunFlags(args: string[]): { flags: RunFlags; rest: string[] } {
  const flags: RunFlags = {
    follow: process.stdout.isTTY === true,
    detach: false,
  };
  let i = 0;
  let escaped = false;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') { i++; escaped = true; break; }
    if (!a.startsWith('--')) break;
    let known = true;
    switch (a) {
      case '--subagent-def':    flags.subagentDef = requireFlagValue(args, ++i, a); break;
      case '--model':           flags.model = requireFlagValue(args, ++i, a); break;
      case '--max-turns':       flags.maxTurns = parseIntFlagValue(requireFlagValue(args, ++i, a), a); break;
      case '--tools':           flags.tools = requireFlagValue(args, ++i, a).split(',').map(s => s.trim()).filter(Boolean); break;
      case '--timeout-ms':      flags.timeoutMs = parseIntFlagValue(requireFlagValue(args, ++i, a), a); break;
      case '--source':          flags.source = requireFlagValue(args, ++i, a); break;
      case '--fanout-manifest': flags.fanoutManifest = requireFlagValue(args, ++i, a); break;
      case '--follow':          flags.follow = true; break;
      case '--no-follow':       flags.follow = false; break;
      case '--detach':          flags.detach = true; flags.follow = false; break;
      default:                  known = false; break;
    }
    if (!known) break; // unknown --flag → first token of the (freeform) prompt
  }
  const rest = args.slice(i);
  // An explicit `--` terminates flag parsing wherever it appears — leading
  // zone (escaped) OR after a positional (the leading loop breaks before it,
  // so `escaped` stays false). Honor both: when the prompt carries a literal
  // `--`, hoist nothing, so `agent run note -- --detach` keeps `--detach`
  // verbatim instead of silently flipping detach mode.
  if (!escaped && !rest.includes('--')) {
    while (rest.length > 0 && BOOLEAN_TAIL_FLAGS.has(rest[rest.length - 1]!)) {
      applyBooleanFlag(flags, rest.pop()!);
    }
  }
  return { flags, rest };
}

/**
 * #2922: resolve the brain source for a subagent submission via the
 * canonical chain (explicit --source → GBRAIN_SOURCE → .gbrain-source →
 * local_path match → sources.default → sole non-default → 'default').
 * Pre-fix, `gbrain agent run` never resolved a source, so every page an
 * agent job wrote landed in the seed 'default' source even on brains with
 * `gbrain sources default <id>` configured.
 *
 * The `__all__` sentinel is rejected here: subagent writes must target
 * exactly one source (and `validateSourceId` at tool-registry build time
 * would reject it anyway — better to fail at submit than at claim).
 */
async function resolveAgentSource(engine: BrainEngine, explicit: string | undefined): Promise<string> {
  // An empty `--source ""` must fail loudly, not silently degrade to the
  // env/dotfile/default tiers (resolveSourceId's `if (explicit)` treats a
  // falsy value as omitted — explicit-but-empty would slip through).
  if (explicit !== undefined && explicit.trim() === '') {
    console.error('gbrain agent run: --source requires a non-empty value. Run `gbrain agent run --help`.');
    process.exit(2);
  }
  let resolved: string;
  try {
    resolved = await resolveSourceId(engine, explicit ?? null);
  } catch (e) {
    if (isResolverUserError(e)) {
      console.error(`gbrain agent run: ${(e as Error).message}`);
      process.exit(1);
    }
    throw e;
  }
  if (resolved === ALL_SOURCES) {
    console.error(
      `gbrain agent run: --source ${ALL_SOURCES} is not supported — ` +
      `subagent writes must target exactly one source. Pass a concrete --source <id>.`,
    );
    process.exit(2);
  }
  // Archived-source guard, mirroring dream.ts: writing subagent pages into
  // an archived (normally invisible) source would mask them until restore.
  const src = await fetchSource(engine, resolved);
  if (src?.archived === true) {
    console.error(
      `gbrain agent run: source ${resolved} is archived; restore with ` +
      `\`gbrain sources restore ${resolved}\` before submitting agent jobs`,
    );
    process.exit(1);
  }
  return resolved;
}

export async function runAgentRun(engine: BrainEngine, args: string[]): Promise<void> {
  const { flags, rest } = parseRunFlags(args);
  const queue = new MinionQueue(engine);

  // #2922: resolve once at submit time; both the single-job and fan-out
  // paths stamp it on SubagentHandlerData.source_id so buildOpContext
  // scopes every tool call to it instead of the legacy 'default'.
  const sourceId = await resolveAgentSource(engine, flags.source);

  // Fan-out path: --fanout-manifest supplies explicit child inputs. The
  // aggregator submits first (so its id is available as parent for each
  // child); children submit with on_child_fail='continue' so mixed
  // outcomes don't cascade; aggregator waits in waiting-children until
  // Lane 1B's terminal-set check unblocks it.
  if (flags.fanoutManifest) {
    await runFanout(engine, queue, flags, rest.join(' '), sourceId);
    return;
  }

  const prompt = rest.join(' ').trim();
  if (!prompt) {
    console.error('gbrain agent run: prompt is required');
    process.exit(2);
  }

  const data: SubagentHandlerData = { prompt, source_id: sourceId };
  if (flags.subagentDef) data.subagent_def = flags.subagentDef;
  if (flags.model) data.model = flags.model;
  if (flags.maxTurns) data.max_turns = flags.maxTurns;
  if (flags.tools && flags.tools.length > 0) data.allowed_tools = flags.tools;

  const submitOpts: Partial<MinionJobInput> = { max_stalled: 3 };
  if (flags.timeoutMs) submitOpts.timeout_ms = flags.timeoutMs;

  const job = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
    allowProtectedSubmit: true,
  });

  // Honest-dispatch at the interactive surface (codex re-review): a
  // param-coalesced submit returns an EXISTING waiting job — printing
  // 'submitted' would tell the operator a new run was queued when it wasn't.
  process.stderr.write(job.coalesced === true
    ? `coalesced: identical params matched existing waiting job ${job.id} (subagent). ` +
      `Vary the prompt/params or pass a fresh idempotency key for an independent run.\n`
    : `submitted: job ${job.id} (subagent)\n`);

  if (flags.detach || !flags.follow) {
    process.stdout.write(String(job.id) + '\n');
    return;
  }

  await followJob(engine, queue, job.id, flags.timeoutMs);
}

// ── fan-out ───────────────────────────────────────────────

async function runFanout(engine: BrainEngine, queue: MinionQueue, flags: RunFlags, promptTemplate: string, sourceId: string): Promise<void> {
  const manifestPath = flags.fanoutManifest!;
  let manifest: Array<{ prompt?: string; input_vars?: Record<string, unknown> }>;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('manifest must be a JSON array');
    manifest = parsed as typeof manifest;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`gbrain agent run: invalid --fanout-manifest ${manifestPath}: ${msg}`);
    process.exit(2);
  }

  if (manifest.length === 0) {
    console.error('gbrain agent run: --fanout-manifest is empty; nothing to run');
    process.exit(2);
  }

  // Short-circuit: 1 entry → single subagent, no aggregator.
  if (manifest.length === 1) {
    const entry = manifest[0]!;
    const data: SubagentHandlerData = {
      prompt: entry.prompt ?? promptTemplate,
      source_id: sourceId,
      ...(entry.input_vars ? { input_vars: entry.input_vars } : {}),
      ...(flags.subagentDef ? { subagent_def: flags.subagentDef } : {}),
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.maxTurns ? { max_turns: flags.maxTurns } : {}),
      ...(flags.tools && flags.tools.length > 0 ? { allowed_tools: flags.tools } : {}),
    };
    const submitOpts: Partial<MinionJobInput> = { max_stalled: 3 };
    if (flags.timeoutMs) submitOpts.timeout_ms = flags.timeoutMs;
    const job = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
      allowProtectedSubmit: true,
    });
    process.stderr.write(job.coalesced === true
      ? `coalesced: identical params matched existing waiting job ${job.id} (single-entry manifest short-circuit).\n`
      : `submitted: job ${job.id} (single-entry manifest short-circuit)\n`);
    if (flags.detach || !flags.follow) { process.stdout.write(`${job.id}\n`); return; }
    await followJob(engine, queue, job.id, flags.timeoutMs);
    return;
  }

  // N-entry fan-out: aggregator first (so we have its id as parent), then
  // N children, then flip the aggregator's children_ids to include them.
  const aggregatorSeed: AggregatorHandlerData = { children_ids: [] };
  const aggregator = await queue.add(
    'subagent_aggregator',
    aggregatorSeed as unknown as Record<string, unknown>,
    { max_stalled: 3 },
    { allowProtectedSubmit: true },
  );

  const childIds: number[] = [];
  for (const entry of manifest) {
    const data: SubagentHandlerData = {
      prompt: entry.prompt ?? promptTemplate,
      source_id: sourceId,
      ...(entry.input_vars ? { input_vars: entry.input_vars } : {}),
      ...(flags.subagentDef ? { subagent_def: flags.subagentDef } : {}),
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.maxTurns ? { max_turns: flags.maxTurns } : {}),
      ...(flags.tools && flags.tools.length > 0 ? { allowed_tools: flags.tools } : {}),
    };
    const submitOpts: Partial<MinionJobInput> = {
      parent_job_id: aggregator.id,
      on_child_fail: 'continue',       // mixed-outcome aggregation
      max_stalled: 3,
    };
    if (flags.timeoutMs) submitOpts.timeout_ms = flags.timeoutMs;
    let child;
    try {
      child = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
        allowProtectedSubmit: true,
      });
    } catch (e) {
      // Admission quota mid-fanout: a partial tree (some children submitted,
      // children_ids never written) would leave the aggregator torn — cancel
      // the WHOLE tree (cascades to already-submitted children) and surface
      // the quota message. All-or-nothing beats a wedged aggregator.
      if (isQueueQuotaExceededError(e)) {
        await queue.cancelJob(aggregator.id).catch(() => {});
        console.error(
          `fanout aborted at child ${childIds.length + 1}/${manifest.length}: ${e.message}\n` +
          `Aggregator ${aggregator.id} and its ${childIds.length} submitted child(ren) were cancelled.`,
        );
        process.exit(1);
      }
      throw e;
    }
    childIds.push(child.id);
  }

  // Update the aggregator's data with the final children_ids. We have to
  // do this after submission because each add() returns the committed
  // row's id; the aggregator's seed started with an empty array.
  await engine.executeRaw(
    `UPDATE minion_jobs SET data = jsonb_set(data, '{children_ids}', $1::text::jsonb) WHERE id = $2`,
    [JSON.stringify(childIds), aggregator.id],
  );

  process.stderr.write(
    `submitted: aggregator job ${aggregator.id} + ${childIds.length} subagent children ` +
    `(${childIds[0]}..${childIds[childIds.length - 1]})\n`,
  );

  if (flags.detach || !flags.follow) {
    process.stdout.write(`${aggregator.id}\n`);
    return;
  }
  await followJob(engine, queue, aggregator.id, flags.timeoutMs);
}

// ── follow ────────────────────────────────────────────────

async function followJob(engine: BrainEngine, queue: MinionQueue, jobId: number, timeoutMs?: number): Promise<void> {
  process.stderr.write(`[gbrain agent] following job ${jobId} (Ctrl-C to detach)...\n`);
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once('SIGINT', onSigint);
  try {
    // Streaming logs happen in the background; we poll the terminal state
    // in parallel so the function returns as soon as the job completes.
    const logsP = runAgentLogs(engine, jobId, { follow: true, signal: ac.signal, pollMs: 1000 });
    try {
      const job = await waitForCompletion(queue, jobId, {
        timeoutMs: timeoutMs ?? 24 * 60 * 60 * 1000,
        pollMs: 1000,
        signal: ac.signal,
      });
      ac.abort();
      await logsP.catch(() => {});
      process.stderr.write(`[gbrain agent] job ${jobId} terminal: ${job.status}\n`);
      if (job.result != null) process.stdout.write(JSON.stringify(job.result, null, 2) + '\n');
      if (job.status !== 'completed') process.exit(1);
    } catch (e) {
      if (e instanceof TimeoutError) {
        process.stderr.write(`[gbrain agent] timeout after ${e.elapsedMs}ms — job is still running. Check with: gbrain jobs get ${jobId}\n`);
        process.exit(3);
      }
      throw e;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

// ── `gbrain agent logs` ────────────────────────────────────

async function runAgentLogsCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const jobIdStr = args.find(a => !isKnownFlag(a));
  if (!jobIdStr) {
    console.error('gbrain agent logs: <job_id> is required');
    process.exit(2);
  }
  const jobId = parseInt(jobIdStr, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    console.error(`gbrain agent logs: "${jobIdStr}" is not a valid job id`);
    process.exit(2);
  }
  const follow = hasFlag(args, '--follow');
  const since = parseFlag(args, '--since');

  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once('SIGINT', onSigint);
  try {
    await runAgentLogs(engine, jobId, { follow, since, signal: ac.signal });
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

// Expose for tests.
export const __testing = {
  parseRunFlags,
};
