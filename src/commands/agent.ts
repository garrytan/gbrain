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
import { waitForCompletion, TimeoutError } from '../core/minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData, AggregatorHandlerData } from '../core/minions/types.ts';
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

export async function runAgent(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  switch (sub) {
    case 'run':
      await runAgentRun(engine, args.slice(1));
      return;
    case 'logs':
      await runAgentLogsCmd(engine, args.slice(1));
      return;
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

SUBMITTING
  gbrain agent run <prompt>
    --subagent-def <name>        Named plugin subagent (from GBRAIN_PLUGIN_PATH)
    --model <id>                 Anthropic model id (defaults to sonnet)
    --max-turns <n>              Max assistant turns (default 20)
    --tools a,b,c                Subset of registered tool names (comma list)
    --timeout-ms <n>             Per-job wall-clock timeout
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
  Submitting subagent jobs is trusted-only; MCP submitters receive
  permission_denied. The worker needs ANTHROPIC_API_KEY set, or the
  first LLM turn of a claimed job fails.
`);
}

// ── `gbrain agent run` ────────────────────────────────────

interface RunFlags {
  subagentDef?: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  timeoutMs?: number;
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

export async function runAgentRun(engine: BrainEngine, args: string[]): Promise<void> {
  const { flags, rest } = parseRunFlags(args);
  const queue = new MinionQueue(engine);

  // Fan-out path: --fanout-manifest supplies explicit child inputs. The
  // aggregator submits first (so its id is available as parent for each
  // child); children submit with on_child_fail='continue' so mixed
  // outcomes don't cascade; aggregator waits in waiting-children until
  // Lane 1B's terminal-set check unblocks it.
  if (flags.fanoutManifest) {
    await runFanout(engine, queue, flags, rest.join(' '));
    return;
  }

  const prompt = rest.join(' ').trim();
  if (!prompt) {
    console.error('gbrain agent run: prompt is required');
    process.exit(2);
  }

  const data: SubagentHandlerData = { prompt };
  if (flags.subagentDef) data.subagent_def = flags.subagentDef;
  if (flags.model) data.model = flags.model;
  if (flags.maxTurns) data.max_turns = flags.maxTurns;
  if (flags.tools && flags.tools.length > 0) data.allowed_tools = flags.tools;

  const submitOpts: Partial<MinionJobInput> = { max_stalled: 3 };
  if (flags.timeoutMs) submitOpts.timeout_ms = flags.timeoutMs;

  const job = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
    allowProtectedSubmit: true,
  });

  process.stderr.write(`submitted: job ${job.id} (subagent)\n`);

  if (flags.detach || !flags.follow) {
    process.stdout.write(String(job.id) + '\n');
    return;
  }

  await followJob(engine, queue, job.id, flags.timeoutMs);
}

// ── fan-out ───────────────────────────────────────────────

async function runFanout(engine: BrainEngine, queue: MinionQueue, flags: RunFlags, promptTemplate: string): Promise<void> {
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
    process.stderr.write(`submitted: job ${job.id} (single-entry manifest short-circuit)\n`);
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
    const child = await queue.add('subagent', data as unknown as Record<string, unknown>, submitOpts, {
      allowProtectedSubmit: true,
    });
    childIds.push(child.id);
  }

  // Update the aggregator's data with the final children_ids. We have to
  // do this after submission because each add() returns the committed
  // row's id; the aggregator's seed started with an empty array.
  await engine.executeRaw(
    `UPDATE minion_jobs SET data = jsonb_set(data, '{children_ids}', $1::jsonb) WHERE id = $2`,
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
