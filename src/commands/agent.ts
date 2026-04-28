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
    --model <id>                 Model id (defaults to provider's smart tier)
    --provider <name>            LLM provider: anthropic, openai, deepseek, custom
    --base-url <url>             Custom OpenAI-compatible base URL
    --max-turns <n>              Max assistant turns (default 20)
    --tools a,b,c                Subset of registered tool names (comma list)
    --timeout-ms <n>             Per-job wall-clock timeout
    --fanout-manifest <path>     JSON array of {prompt, input_vars?} — one child each
    --follow                     Tail status until terminal (default on TTY)
    --detach                     Submit + print job id, exit immediately

  Flags after \`run\` up to the first unrecognized token are parsed; the
  remainder is the prompt. Use \`--\` to explicitly terminate flag parsing.

VIEWING
  gbrain agent logs <job_id>
    --follow                     Keep polling until the job reaches terminal
    --since <spec>               ISO-8601 timestamp OR relative ("5m","1h","2d")

NOTES
  Submitting subagent jobs is trusted-only; MCP submitters receive
  permission_denied.   The worker needs the provider API key set
  (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, LLM_API_KEY), or the first LLM
  turn of a claimed job fails.
`);
}

// ── `gbrain agent run` ────────────────────────────────────

interface RunFlags {
  subagentDef?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  maxTurns?: number;
  tools?: string[];
  timeoutMs?: number;
  fanoutManifest?: string;
  follow: boolean;
  detach: boolean;
}

function parseRunFlags(args: string[]): { flags: RunFlags; rest: string[] } {
  const flags: RunFlags = {
    follow: process.stdout.isTTY === true,
    detach: false,
  };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (!isKnownFlag(a!)) break;
    switch (a) {
      case '--subagent-def': flags.subagentDef = args[++i]; i++; break;
      case '--model':        flags.model = args[++i]; i++; break;
      case '--provider':     flags.provider = args[++i]; i++; break;
      case '--base-url':     flags.baseUrl = args[++i]; i++; break;
      case '--max-turns':    flags.maxTurns = parseInt(args[++i] ?? '', 10); i++; break;
      case '--tools':        flags.tools = (args[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean); i++; break;
      case '--timeout-ms':   flags.timeoutMs = parseInt(args[++i] ?? '', 10); i++; break;
      case '--fanout-manifest': flags.fanoutManifest = args[++i]; i++; break;
      case '--follow':       flags.follow = true; i++; break;
      case '--no-follow':    flags.follow = false; i++; break;
      case '--detach':       flags.detach = true; flags.follow = false; i++; break;
      default:
        throw new Error(`unknown flag: ${a}. Run \`gbrain agent run --help\` for usage.`);
    }
  }
  return { flags, rest: args.slice(i) };
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
  if (flags.provider) data.provider = flags.provider;
  if (flags.baseUrl) data.base_url = flags.baseUrl;
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
      ...(flags.provider ? { provider: flags.provider } : {}),
      ...(flags.baseUrl ? { base_url: flags.baseUrl } : {}),
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
      ...(flags.provider ? { provider: flags.provider } : {}),
      ...(flags.baseUrl ? { base_url: flags.baseUrl } : {}),
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
