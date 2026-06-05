#!/usr/bin/env bun

import { execFileSync } from 'child_process';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type CommandOutputOptions = {
  allowTrailingText?: boolean;
};
type CommandOutputRunner = (args: string[], opts?: CommandOutputOptions) => string | Promise<string>;

type ReceiptInputs = {
  activeSource: any;
  features: any;
  status: any;
  remediationPlan: any;
};

type ReceiptSummary = {
  activeSource: string | null;
  brainScore: number | null;
  defaultSource: {
    sourceId: string;
    pages: number;
    chunksTotal: number;
    chunksUnembedded: number;
    embeddingCoveragePct: number | null;
  } | null;
  unacknowledgedFailures: number;
  autopilot: {
    installed: boolean;
    running: boolean;
    waiting: number;
  };
  maxReachableScore: number | null;
  recommendedCommands: string[];
};

function runGbrainCommandOutput(args: string[]): string {
  return execFileSync('bun', ['run', 'gbrain', ...args], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseJsonOutput(raw: string, opts?: CommandOutputOptions): any {
  const text = opts?.allowTrailingText ? extractLastJsonBlock(raw) : raw.trim();
  return JSON.parse(text);
}

export function extractLastJsonBlock(raw: string): string {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;
  let last = '';

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaping = false;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        last = raw.slice(start, i + 1);
        start = -1;
      }
    }
  }

  if (!last) {
    throw new Error('No JSON object found in command output');
  }

  return last;
}

function formatPlanCommand(step: any): string | null {
  if (!step || typeof step !== 'object') return null;

  if (step.job === 'embed' && step.params?.stale) {
    return 'gbrain embed --stale';
  }

  if (step.job === 'sync' && typeof step.params?.repoPath === 'string') {
    const flags: string[] = [];
    if (step.params?.noEmbed) flags.push('--no-embed');
    return ['gbrain', 'sync', step.params.repoPath, ...flags].join(' ');
  }

  if (step.job === 'extract' && typeof step.params?.mode === 'string') {
    const flags: string[] = [];
    if (typeof step.params?.dir === 'string') flags.push(step.params.dir);
    return ['gbrain', 'extract', step.params.mode, ...flags].join(' ');
  }

  return null;
}

function uniqueCommands(commands: Array<string | null | undefined>): string[] {
  const deduped: string[] = [];

  for (const command of commands) {
    if (!command || deduped.includes(command)) continue;
    deduped.push(command);
  }

  return deduped;
}

export function summarizeReceipt(inputs: ReceiptInputs): ReceiptSummary {
  const sources = inputs.status?.sync?.sources ?? [];
  const defaultSource = sources.find((source: any) => source?.source_id === 'default') ?? null;
  const autopilot = inputs.status?.autopilot ?? {};

  const featureCommands = (inputs.features?.recommendations ?? []).map((item: any) => item?.command);
  const remediationCommands = (inputs.remediationPlan?.plan ?? []).map(formatPlanCommand);

  return {
    activeSource:
      typeof inputs.activeSource?.source_id === 'string'
        ? inputs.activeSource.source_id
        : null,
    brainScore: typeof inputs.features?.brain_score === 'number' ? inputs.features.brain_score : null,
    defaultSource: defaultSource
      ? {
          sourceId: defaultSource.source_id,
          pages: Number(defaultSource.pages ?? 0),
          chunksTotal: Number(defaultSource.chunks_total ?? 0),
          chunksUnembedded: Number(defaultSource.chunks_unembedded ?? 0),
          embeddingCoveragePct:
            typeof defaultSource.embedding_coverage_pct === 'number'
              ? defaultSource.embedding_coverage_pct
              : null,
        }
      : null,
    unacknowledgedFailures: Number(inputs.status?.sync?.unacknowledged_failures ?? 0),
    autopilot: {
      installed: Boolean(autopilot.installed),
      running: Boolean(autopilot.running),
      waiting: Number(inputs.status?.queue?.waiting ?? 0),
    },
    maxReachableScore:
      typeof inputs.remediationPlan?.max_reachable_score === 'number'
        ? inputs.remediationPlan.max_reachable_score
        : null,
    recommendedCommands: uniqueCommands([...featureCommands, ...remediationCommands]),
  };
}

export async function collectReceiptFromCommandOutput(runCommandOutput: CommandOutputRunner): Promise<ReceiptSummary> {
  const inputs: ReceiptInputs = {
    activeSource: parseJsonOutput(await runCommandOutput(['sources', 'current', '--json'])),
    features: parseJsonOutput(await runCommandOutput(['features', '--json'])),
    status: parseJsonOutput(await runCommandOutput(['status', '--json'])),
    remediationPlan: parseJsonOutput(
      await runCommandOutput(['doctor', '--remediation-plan', '--json'], {
        allowTrailingText: true,
      }),
      { allowTrailingText: true },
    ),
  };

  return summarizeReceipt(inputs);
}

export async function collectReceipt(): Promise<ReceiptSummary> {
  return collectReceiptFromCommandOutput((args) => runGbrainCommandOutput(args));
}

function renderText(summary: ReceiptSummary): string {
  const defaultBacklog = summary.defaultSource
    ? `${summary.defaultSource.pages} pages, ${summary.defaultSource.chunksUnembedded}/${summary.defaultSource.chunksTotal} unembedded`
    : 'unknown';
  const commands = summary.recommendedCommands.length > 0
    ? summary.recommendedCommands.map(command => `  - ${command}`).join('\n')
    : '  - none';

  return [
    `Active source: ${summary.activeSource ?? 'unknown'}`,
    `Brain score: ${summary.brainScore ?? 'unknown'}`,
    `Default backlog: ${defaultBacklog}`,
    `Unacknowledged failures: ${summary.unacknowledgedFailures}`,
    `Autopilot: installed=${summary.autopilot.installed ? 'yes' : 'no'}, running=${summary.autopilot.running ? 'yes' : 'no'}, waiting=${summary.autopilot.waiting}`,
    `Max reachable score: ${summary.maxReachableScore ?? 'unknown'}`,
    'Recommended commands:',
    commands,
  ].join('\n');
}

async function main(): Promise<number> {
  const jsonMode = process.argv.slice(2).includes('--json');
  const summary = await collectReceipt();

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(renderText(summary));
  }

  return 0;
}

if (import.meta.main) {
  const code = await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[offramp:receipt] ${message}\n`);
    return 1;
  });
  process.exit(code);
}
