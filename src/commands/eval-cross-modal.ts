/**
 * gbrain eval cross-modal — multi-model quality gate (v0.27.x).
 *
 * Three different-provider frontier models score the OUTPUT against the TASK
 * on a fixed dimension list. Verdict: PASS (exit 0) / FAIL (exit 1) /
 * INCONCLUSIVE (exit 2; <2/3 model successes).
 *
 * Reuses `src/core/ai/gateway.ts` for provider config + auth (T1+T2). Bypasses
 * `connectEngine()` via the cli.ts no-DB branch (T3=A) so onboarding works
 * before `gbrain init`. Receipts are bound to (slug, SKILL.md sha-8) so
 * `gbrain skillify check` can detect stale audits (T10=A).
 *
 * Cost guardrails (T11=B):
 *   - Default cycles = 3 in TTY, 1 in non-TTY (limits scripted bulk spend).
 *   - Cost-estimate prints to stderr before each cycle.
 *   - `--budget-usd` hard cap is a v0.27.x follow-up TODO.
 */

import { existsSync, readFileSync } from 'fs';

import { gbrainPath, loadConfig } from '../core/config.ts';
import { configureGateway, isAvailable } from '../core/ai/gateway.ts';
import {
  DEFAULT_DIMENSIONS,
  DEFAULT_SLOTS,
  estimateCost,
  runEval,
} from '../core/cross-modal-eval/runner.ts';
import type {
  ProgressEvent,
  RunEvalResult,
  SlotConfig,
} from '../core/cross-modal-eval/runner.ts';

const HELP = `gbrain eval cross-modal — multi-model quality gate

USAGE:
  gbrain eval cross-modal --task "<description>" --output <path-or-skill-slug> [flags]

REQUIRED:
  --task "..."             What the OUTPUT was meant to achieve.
  --output <path>          File whose content gets scored. Pass a skill slug
                           shortcut (e.g. \`--output skills/my-skill/SKILL.md\`)
                           to bind the receipt to that skill (T10).

FLAGS:
  --slug <name>            Receipt filename slug. Defaults to inferred slug
                           from --output path (skills/<slug>/SKILL.md → <slug>),
                           or a content sha for ad-hoc inputs.
  --dimensions "d1,d2,..." Comma-separated dimension list. Default: 5 standard
                           dimensions (goal, depth, sourcing, specificity, useful).
  --cycles N               1-3. Default: 3 in TTY, 1 in non-TTY (T11). Each
                           cycle is 3 model calls; verdict aggregates over them.
  --slot-a-model <id>      Override default 'openai:gpt-4o'.
  --slot-b-model <id>      Override default 'anthropic:claude-opus-4-7'.
  --slot-c-model <id>      Override default 'google:gemini-1.5-pro'.
  --receipt-dir <path>     Default: gbrainPath('eval-receipts').
  --max-tokens N           Output token budget per call. Default: 4000.
  --json                   Emit final aggregate as JSON to stdout (progress to stderr).
  --help, -h               Show this help.

EXIT CODES:
  0  PASS  — every dim mean >=7 AND no model scored any dim <5.
  1  FAIL  — at least one dim mean <7 OR at least one model scored a dim <5.
  2  INCONCLUSIVE — fewer than 2/3 models returned parseable scores. Receipt
     is still written for forensics; the gate is not authoritative.

CONFIGURATION:
  Models resolve via the gbrain AI gateway. Configure with:
    gbrain providers test            # see what's configured
    gbrain config                    # set keys
  Or set env vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY,
  TOGETHER_API_KEY, etc. The gateway reads from \`~/.gbrain/config.json\` plus
  process.env.

EXAMPLES:
  gbrain eval cross-modal \\
    --task "Skillify SKILL.md teaches the 11-item meta-skill checklist" \\
    --output skills/skillify/SKILL.md

  gbrain eval cross-modal \\
    --task "PR description sells the value of cross-modal eval" \\
    --output /tmp/pr-description.md \\
    --cycles 1
`;

interface ParsedArgs {
  help: boolean;
  task?: string;
  output?: string;
  slug?: string;
  dimensions?: string[];
  cycles?: number;
  slotAModel?: string;
  slotBModel?: string;
  slotCModel?: string;
  receiptDir?: string;
  maxTokens?: number;
  json: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--task':
        if (next === undefined) break;
        out.task = next;
        i++;
        break;
      case '--output':
        if (next === undefined) break;
        out.output = next;
        i++;
        break;
      case '--slug':
        if (next === undefined) break;
        out.slug = next;
        i++;
        break;
      case '--dimensions':
        if (next === undefined) break;
        out.dimensions = next.split(',').map(s => s.trim()).filter(Boolean);
        i++;
        break;
      case '--cycles':
        if (next === undefined) break;
        out.cycles = parseIntStrict(next);
        i++;
        break;
      case '--slot-a-model':
        if (next === undefined) break;
        out.slotAModel = next;
        i++;
        break;
      case '--slot-b-model':
        if (next === undefined) break;
        out.slotBModel = next;
        i++;
        break;
      case '--slot-c-model':
        if (next === undefined) break;
        out.slotCModel = next;
        i++;
        break;
      case '--receipt-dir':
        if (next === undefined) break;
        out.receiptDir = next;
        i++;
        break;
      case '--max-tokens':
        if (next === undefined) break;
        out.maxTokens = parseIntStrict(next);
        i++;
        break;
      case '--json':
        out.json = true;
        break;
    }
  }
  return out;
}

function parseIntStrict(s: string): number {
  const m = String(s).trim();
  if (!/^\d+$/.test(m)) {
    throw new Error(`expected positive integer, got: ${s}`);
  }
  return parseInt(m, 10);
}

function inferSlugFromOutputPath(path: string): string | undefined {
  // skills/<slug>/SKILL.md or .../skills/<slug>/...
  const m = path.replace(/\\/g, '/').match(/(?:^|\/)skills\/([^/]+)\/SKILL\.md$/);
  return m ? m[1] : undefined;
}

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Configure the AI gateway from `~/.gbrain/config.json` + process.env.
 *
 * Mirrors the body of `cli.ts:connectEngine()` minus the DB connect — we call
 * this from the no-DB branch so the gateway is ready when runEval starts.
 * Returns true on success; false (and prints a hint) when no config is found.
 */
function configureGatewayForCli(): boolean {
  const config = loadConfig();
  if (!config) {
    // No config file is fine for the eval command — env vars alone may serve.
    // We still call configureGateway so gateway recipes can read the env map.
    configureGateway({
      embedding_model: undefined,
      embedding_dimensions: undefined,
      expansion_model: undefined,
      chat_model: undefined,
      chat_fallback_chain: undefined,
      base_urls: undefined,
      env: { ...process.env },
    });
    return true;
  }
  configureGateway({
    embedding_model: config.embedding_model,
    embedding_dimensions: config.embedding_dimensions,
    expansion_model: config.expansion_model,
    chat_model: config.chat_model,
    chat_fallback_chain: config.chat_fallback_chain,
    base_urls: config.provider_base_urls,
    env: { ...process.env },
  });
  return true;
}

export async function runEvalCrossModal(args: string[]): Promise<number> {
  const parsed = parseArgs(args);

  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (!parsed.task) {
    process.stderr.write('Error: --task "<description>" is required\n\n');
    process.stderr.write(HELP);
    return 1;
  }
  if (!parsed.output) {
    process.stderr.write('Error: --output <path> is required\n\n');
    process.stderr.write(HELP);
    return 1;
  }

  if (!existsSync(parsed.output)) {
    process.stderr.write(`Error: --output path not found: ${parsed.output}\n`);
    return 1;
  }

  const outputContent = readFileSync(parsed.output, 'utf-8');
  if (outputContent.trim().length === 0) {
    process.stderr.write(`Error: --output file is empty: ${parsed.output}\n`);
    return 1;
  }

  const slug = parsed.slug ?? inferSlugFromOutputPath(parsed.output);
  const cycles = parsed.cycles ?? (isTTY() ? 3 : 1);
  const dimensions = parsed.dimensions ?? DEFAULT_DIMENSIONS;
  const receiptDir = parsed.receiptDir ?? gbrainPath('eval-receipts');
  const maxTokens = parsed.maxTokens ?? 4000;

  const slots: SlotConfig[] = [
    { id: 'A', model: parsed.slotAModel ?? DEFAULT_SLOTS[0]!.model },
    { id: 'B', model: parsed.slotBModel ?? DEFAULT_SLOTS[1]!.model },
    { id: 'C', model: parsed.slotCModel ?? DEFAULT_SLOTS[2]!.model },
  ];

  // Configure the AI gateway. Without this, every chat() call throws
  // "AI gateway is not configured" because the cli.ts no-DB branch skips
  // connectEngine (T3=A).
  configureGatewayForCli();

  // Probe whether the gateway can serve `chat`. If not, we can't run.
  if (!isAvailable('chat')) {
    process.stderr.write(
      'Error: AI gateway has no usable chat provider. ' +
        'Configure one of OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY ' +
        'in your shell or run `gbrain config` to set keys.\n',
    );
    return 1;
  }

  // Cost estimate (T11=B).
  const cost = estimateCost(slots, cycles, maxTokens);
  process.stderr.write(
    `[eval cross-modal] estimated cost: ~$${cost.perCycleUSD.toFixed(2)}/cycle, ` +
      `~$${cost.perRunMaxUSD.toFixed(2)} max for ${cycles} cycle(s).\n`,
  );
  for (const note of cost.notes) {
    process.stderr.write(`[eval cross-modal] note: ${note}\n`);
  }

  // Progress reporter (stderr only).
  const onProgress = (ev: ProgressEvent) => {
    switch (ev.kind) {
      case 'cycle_start':
        process.stderr.write(`[eval cross-modal] cycle ${ev.cycle}/${ev.total} starting...\n`);
        break;
      case 'slot_done': {
        const status = ev.ok ? 'ok' : 'failed';
        process.stderr.write(
          `[eval cross-modal]   slot ${ev.slotId} (${ev.modelId}) ${status} in ${ev.ms}ms\n`,
        );
        break;
      }
      case 'cycle_end':
        process.stderr.write(`[eval cross-modal] cycle ${ev.cycle} verdict: ${ev.verdict}\n`);
        break;
    }
  };

  let result: RunEvalResult;
  try {
    result = await runEval({
      task: parsed.task,
      output: outputContent,
      slug,
      dimensions,
      slots,
      cycles,
      receiptDir,
      maxTokens,
      onProgress,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[eval cross-modal] runtime error: ${msg}\n`);
    return 1;
  }

  // Final summary to stderr (always) + JSON to stdout (when --json).
  const verdict = result.finalAggregate.verdict;
  process.stderr.write('\n');
  process.stderr.write(`[eval cross-modal] ${result.finalAggregate.verdictMessage}\n`);
  process.stderr.write(`[eval cross-modal] receipt: ${result.finalReceiptPath}\n`);

  if (parsed.json) {
    process.stdout.write(
      JSON.stringify(
        {
          verdict,
          aggregate: result.finalAggregate,
          cycles: result.cycles.map(c => ({
            cycle: c.cycle,
            receipt_path: c.receipt_path,
            verdict: c.aggregate.verdict,
            overall: c.aggregate.overall,
          })),
          finalReceiptPath: result.finalReceiptPath,
        },
        null,
        2,
      ),
    );
    process.stdout.write('\n');
  }

  if (verdict === 'pass') return 0;
  if (verdict === 'inconclusive') return 2;
  return 1;
}
