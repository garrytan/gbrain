import type { BrainEngine } from '../core/engine.ts';
import { loadConfig } from '../core/config.ts';
import { normalizeAutoPromoteConfig, type AutoPromoteConfig } from '../core/auto-promote/config.ts';
import { detectRestrictedRunners } from '../core/runners/runner-registry.ts';
import type { RestrictedRunnerCandidate } from '../core/runners/runner-registry.ts';
import { createCliRunnerExecutor } from '../core/auto-promote/cli-executor.ts';
import { runAutoPromote, type RunAutoPromoteResult } from '../core/auto-promote/service.ts';
import { saveBrainReport } from './report.ts';

export interface AutoPromoteArgs {
  dry_run: boolean;
  scope_id: string;
  limit?: number;
  json: boolean;
  digest: boolean;
  report_dir: string;
}

export function parseAutoPromoteArgs(args: string[]): AutoPromoteArgs {
  const apply = hasFlag(args, '--apply');
  const dryRunFlag = hasFlag(args, '--dry-run');
  const dry_run = dryRunFlag || !apply; // default dry-run unless --apply
  return {
    dry_run,
    scope_id: readFlag(args, '--scope-id') ?? readFlag(args, '--scope') ?? 'workspace:default',
    json: hasFlag(args, '--json'),
    digest: hasFlag(args, '--digest'),
    report_dir: readFlag(args, '--report-dir') ?? '.',
    ...(readNumberFlag(args, '--limit') !== undefined ? { limit: readNumberFlag(args, '--limit') } : {}),
  };
}

export function buildAutoPromoteDigest(input: {
  result: RunAutoPromoteResult;
  dry_run: boolean;
  scope_id: string;
  now: string;
}): string {
  const c = input.result.counts;
  const exclusionsByReason = new Map<string, number>();
  for (const entry of input.result.excluded) {
    exclusionsByReason.set(entry.reason, (exclusionsByReason.get(entry.reason) ?? 0) + 1);
  }
  const lines = [
    `Mode: ${input.dry_run ? 'dry-run (no mutations applied)' : 'apply'}`,
    `Scope: ${input.scope_id}`,
    `Generated: ${input.now}`,
    '',
    '## Summary',
    `- Promotable (auto-promoted): ${c.auto_promoted}`,
    `- Canonical handoffs: ${c.canonical_handoffs}`,
    `- Canonical writes: ${c.canonical_writes}`,
    `- Escalated for review: ${c.escalated}`,
    `- Deferred: ${c.deferred}`,
    `- Excluded: ${c.excluded}`,
  ];
  if (input.result.audit) {
    lines.push(`- Audit entries: ${input.result.audit.length}`);
  }
  if (exclusionsByReason.size > 0) {
    lines.push('', '## Exclusions by reason');
    for (const [reason, count] of [...exclusionsByReason.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${reason}: ${count}`);
    }
  }
  if (input.dry_run) {
    lines.push(
      '',
      '## Next step',
      c.auto_promoted > 0
        ? `Run \`mbrain auto-promote --apply\` to promote the ${c.auto_promoted} confident candidate(s).`
        : 'No candidates met the confidence bar; review staged candidates via `mbrain memory-report`.',
    );
  }
  return lines.join('\n');
}

export async function runAutoPromoteCommand(engine: BrainEngine, args: string[]): Promise<void> {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log('Usage: mbrain auto-promote [--apply] [--dry-run] [--scope-id <id>] [--limit <n>] [--json] [--digest] [--report-dir <brain-dir>]');
    console.log('  --digest saves a summary report under <brain-dir>/reports/auto-promote-digest/ (default: current directory).');
    return;
  }
  const parsed = parseAutoPromoteArgs(args);
  const base = normalizeAutoPromoteConfig(loadConfig()?.auto_promote as Partial<AutoPromoteConfig> | undefined);
  const config: AutoPromoteConfig = { ...base, dry_run: parsed.dry_run };

  if (!config.enabled) {
    const msg = { status: 'disabled', message: 'auto_promote is disabled. Set auto_promote.enabled=true in config to use it.' };
    console.log(parsed.json ? JSON.stringify(msg, null, 2) : msg.message);
    return;
  }

  const availability = await detectRestrictedRunners({ priority: config.runner_priority });
  const runners = selectSupportedRunners(availability.candidates, config.runner_priority);
  if (runners.length === 0) {
    const msg = { status: 'no_runner', message: 'No restricted runner (claude/codex) available; nothing auto-promoted.' };
    console.log(parsed.json ? JSON.stringify(msg, null, 2) : msg.message);
    return;
  }

  const result = await runAutoPromote({
    engine,
    config,
    now: new Date().toISOString(),
    runner: runners[0],
    runners,
    runnerExecutor: createCliRunnerExecutor({ model: config.first_pass_model }),
    contextLoader: createPageContextLoader(engine),
    scope_id: parsed.scope_id,
    allow_canonical_page_writes: parsed.dry_run === false,
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
  });

  let digestPath: string | null = null;
  if (parsed.digest) {
    const now = new Date();
    const digest = buildAutoPromoteDigest({
      result,
      dry_run: parsed.dry_run,
      scope_id: parsed.scope_id,
      now: now.toISOString(),
    });
    digestPath = saveBrainReport({
      brainDir: parsed.report_dir,
      type: 'auto-promote-digest',
      title: 'Auto-Promote Digest',
      content: digest,
      now,
    });
  }

  if (parsed.json) {
    console.log(JSON.stringify(digestPath ? { ...result, digest_path: digestPath } : result, null, 2));
  } else {
    if (digestPath) console.log(`digest saved: ${digestPath}`);
    const c = result.counts;
    console.log(
      `auto-promote (${config.dry_run ? 'dry-run' : 'apply'}, runners=${runners.map((runner) => runner.kind).join(',')}): promoted ${c.auto_promoted}, handoffs ${c.canonical_handoffs}, canonical_writes ${c.canonical_writes}, escalated ${c.escalated}, deferred ${c.deferred}, excluded ${c.excluded} (low_risk=${c.selected_low_risk}, risky=${c.selected_risky})`,
    );
  }
}

export function createAutoPromoteDreamDependency(engine: BrainEngine) {
  return {
    run: async (input: {
      scope_id: string;
      now?: string;
      dry_run?: boolean;
      limit?: number;
      allow_canonical_page_writes?: boolean;
      max_runner_calls?: number;
      time_budget_ms?: number;
      exclude_candidate_ids?: string[];
      signal?: AbortSignal;
    }) => {
      const base = normalizeAutoPromoteConfig(loadConfig()?.auto_promote as Partial<AutoPromoteConfig> | undefined);
      const config: AutoPromoteConfig = { ...base, dry_run: input.dry_run !== false };
      if (!config.enabled) return { counts: zeroCounts() };
      const availability = await detectRestrictedRunners({ priority: config.runner_priority });
      const runners = selectSupportedRunners(availability.candidates, config.runner_priority);
      if (runners.length === 0) return { counts: zeroCounts() };
      const result = await runAutoPromote({
        engine,
        config,
        now: input.now ?? new Date().toISOString(),
        runner: runners[0],
        runners,
        runnerExecutor: createCliRunnerExecutor({ model: config.first_pass_model }),
        contextLoader: createPageContextLoader(engine),
        scope_id: input.scope_id,
        allow_canonical_page_writes: input.allow_canonical_page_writes === true,
        max_runner_calls: input.max_runner_calls,
        time_budget_ms: input.time_budget_ms,
        exclude_candidate_ids: input.exclude_candidate_ids,
        signal: input.signal,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { counts: result.counts };
    },
  };
}

function createPageContextLoader(engine: BrainEngine) {
  return async (ref: string) => {
    const page = await engine.getPage(ref);
    return {
      text: page ? `${page.compiled_truth}\n\n---\n\n${page.timeline}` : '',
      content_hash: page?.content_hash ?? null,
    };
  };
}

function zeroCounts() {
  return {
    selected_low_risk: 0,
    selected_risky: 0,
    auto_promoted: 0,
    canonical_handoffs: 0,
    canonical_writes: 0,
    escalated: 0,
    deferred: 0,
    excluded: 0,
  };
}

function selectSupportedRunners(
  candidates: RestrictedRunnerCandidate[],
  priority: AutoPromoteConfig['runner_priority'],
): RestrictedRunnerCandidate[] {
  const supported = new Set(['claude_code', 'codex']);
  const runners: RestrictedRunnerCandidate[] = [];
  for (const kind of priority) {
    if (!supported.has(kind)) continue;
    const candidate = candidates.find((entry) => entry.kind === kind);
    if (candidate?.available) runners.push(candidate);
  }
  return runners;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readFlag(args: string[], flag: string): string | undefined {
  const eq = args.find((arg) => arg.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index !== -1) return args[index + 1];
  return undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const raw = readFlag(args, flag);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
