/**
 * `gbrain wakeshift watch job <id> | write <request_id> | cron <name>` (Wakeshift plan D8): have gbrain wake
 * this conversation when a job, a pending write or a cron run finishes, from a shell. `gbrain wakeshift
 * accept-terms <terms_version>` records the user's agreement to a shared brain's agreement step (accept_wakeshift_terms). On a thin client
 * (`gbrain init --mcp-only`: Muse, Grok Bot) it calls the brain host's watch_job, watch_write_request or
 * watch_cron over MCP; on a brain host it calls the op with the trusted local context, whose refusal names the
 * local wait (gbrain jobs wait <id>), because a CLI run has no conversation to wake. The result prints as text or
 * one JSON line, and Wakeshift's addition (the tool tail) is always the last stdout line, where the agent reads
 * it. `--session-key`, `--harness` and `--conversation-id` pass through per call, exactly as given: the
 * session key is never written to disk, config or a log.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { GBrainConfig } from '../core/config.ts';

export const WAKESHIFT_WATCH_HELP = `gbrain wakeshift watch — have gbrain wake this conversation when something finishes

Usage:
  gbrain wakeshift watch job <id>              a job (submit_job, submit_agent, gbrain jobs submit)
  gbrain wakeshift watch write <request_id>    a pending write (exit 10, write_pending)
  gbrain wakeshift watch cron <name>           a scheduled run registered with gbrain wakeshift cron add
  gbrain wakeshift accept-terms <terms_version>
                                               after the user agreed to the agreement step a watch returned
                                               (agreement_required), record it; then run the watch again

Flags:
  --session-key K       this conversation's session_key from an earlier result (a secret: never logged or saved)
  --harness H           the program you run in (claude-code, codex, cursor, grok-bot, openclaw, ...)
  --conversation-id C   your own id for this conversation, if your program gives you one
  --json                print the result as one JSON line

On a thin client it calls the brain host over MCP. Wakeshift's instructions, when it sends any, are the last
line of output: follow them. Without Wakeshift, wait with gbrain jobs wait <id>. Guide: docs/guides/wakeshift.md`;

const TARGETS = {
  job: { tool: 'watch_job', param: 'id' },
  write: { tool: 'watch_write_request', param: 'request_id' },
  cron: { tool: 'watch_cron', param: 'name' },
} as const;

const VALUE_FLAGS = { '--session-key': 'session_key', '--harness': 'harness', '--conversation-id': 'conversation_id' } as const;

export interface WatchCall { tool: string; params: Record<string, unknown>; json: boolean }

/** Parse the watch arguments into the op and its params; a string is the usage problem. */
export function parseWatchArgs(args: readonly string[]): WatchCall | string {
  const params: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') continue;
    if (a in VALUE_FLAGS) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return `${a} needs a value`;
      params[VALUE_FLAGS[a as keyof typeof VALUE_FLAGS]] = v;
      i++;
      continue;
    }
    if (a.startsWith('-')) return `unknown flag ${a}`;
    positionals.push(a);
  }
  const [kind, target, extra] = positionals;
  if (kind === 'accept-terms') {
    if (!target || extra !== undefined) return 'accept-terms takes exactly one terms_version (from the agreement step)';
    if (Object.keys(params).length > 0) return 'accept-terms takes no --session-key, --harness or --conversation-id';
    return { tool: 'accept_wakeshift_terms', params: { terms_version: target }, json: args.includes('--json') };
  }
  if (!kind || !(kind in TARGETS)) return 'name what to watch: job <id>, write <request_id> or cron <name>';
  if (!target || extra !== undefined) return `watch ${kind} takes exactly one ${TARGETS[kind as keyof typeof TARGETS].param}`;
  const spec = TARGETS[kind as keyof typeof TARGETS];
  if (kind === 'job' && !/^[1-9]\d{0,15}$/.test(target)) return `job id must be a positive number (got ${target})`;
  return { tool: spec.tool, params: { [spec.param]: kind === 'job' ? Number(target) : target, ...params }, json: args.includes('--json') };
}

/** Wakeshift's addition in a remote result: the last text block after the JSON body, unless it is gbrain's own. */
export function remoteToolTail(res: unknown): string | undefined {
  const content = (res as { content?: Array<{ type?: string; text?: unknown }> } | undefined)?.content;
  if (!Array.isArray(content) || content.length < 2) return undefined;
  const last = content.at(-1)!;
  return last.type === 'text' && typeof last.text === 'string' && last.text.trim() && !last.text.startsWith('[gbrain ') ? last.text : undefined;
}

/** Print the result (text or one JSON line), then the tail as the last stdout line. */
export function printWatchResult(result: unknown, tail: string | undefined, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    const r = (result ?? {}) as Record<string, unknown>;
    const target = r.job ?? r.request_id ?? r.cron ?? r.target;
    if (r.watching === true) {
      console.log(`Watching ${String(r.event ?? 'it')}${target !== undefined ? ` for ${String(target)}` : ''}: this conversation wakes when it finishes${r.expires_in ? ` (watch ${String(r.watch)}, lasts ${String(r.expires_in)})` : ''}.`);
      if (r.already_finished === true || r.already_settled === true) console.log('It has already finished, so the wake goes out now.');
      if (typeof r.note === 'string') console.log(r.note);
      if (typeof r.fallback === 'string') console.log(r.fallback);
    } else if (r.accepted === true) {
      console.log(`Recorded the user's agreement (terms version ${String(r.terms_version)}). Run the watch again.`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  }
  if (tail) console.log(tail.trimEnd());
}

function usage(problem: string): void {
  console.error(`gbrain wakeshift watch: ${problem}\n\n${WAKESHIFT_WATCH_HELP}`);
}

/** Thin client: the brain host's watch op over MCP. Remote errors propagate to the CLI dispatcher, like every routed command. */
export async function runWakeshiftWatchRemote(cfg: GBrainConfig, args: string[]): Promise<void> {
  const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
  if (args.includes('--help') || args.includes('-h')) { console.log(WAKESHIFT_WATCH_HELP); return; }
  const call = parseWatchArgs(args);
  if (typeof call === 'string') { usage(call); setCliExitVerdict(2); return; }
  const { callRemoteTool, unpackToolResult } = await import('../core/mcp-client.ts');
  const res = await callRemoteTool(cfg, call.tool, call.params);
  printWatchResult(unpackToolResult(res), remoteToolTail(res), call.json);
}

/**
 * Brain host: the op with the trusted local context (remote = false). watch_job refuses it with the local wait as
 * its fix, which prints like any CLI error; a result's tail still prints last.
 */
export async function runWakeshiftWatch(engine: BrainEngine, args: string[]): Promise<void> {
  const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
  if (args.includes('--help') || args.includes('-h')) { console.log(WAKESHIFT_WATCH_HELP); return; }
  const call = parseWatchArgs(args);
  if (typeof call === 'string') { usage(call); setCliExitVerdict(2); return; }
  const { operationsByName } = await import('../core/operations.ts');
  const { OperationError, opError } = await import('../core/ops/contract.ts');
  const { writeCliError } = await import('../cli/cli-error.ts');
  const { loadConfig } = await import('../core/config.ts');
  let tail: string | undefined;
  try {
    const op = operationsByName[call.tool];
    if (!op) throw opError('unknown_tool', `This gbrain has no ${call.tool} operation.`, 'Upgrade gbrain on the brain host (gbrain upgrade).');
    const ctx = {
      engine, config: loadConfig() ?? ({ engine: engine.kind } as GBrainConfig), dryRun: false, remote: false as const,
      logger: { info: (m: string) => console.error(m), warn: (m: string) => console.error(m), error: (m: string) => console.error(m) },
      emitToolTail: (t: { text?: string }) => { tail = t.text; },
    };
    printWatchResult(await op.handler(ctx as Parameters<typeof op.handler>[0], call.params), tail, call.json);
  } catch (e) {
    if (!(e instanceof OperationError)) throw e;
    setCliExitVerdict(writeCliError(e, 'wakeshift', { json: call.json }));
  }
}
