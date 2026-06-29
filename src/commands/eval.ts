import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { isDeepStrictEqual } from 'util';
import type { BrainEngine } from '../core/engine.ts';
import type {
  ContextEvalFixtureMode,
  ContextEvalRunStatus,
  ReadContextProbeContext,
  RetrievalSelector,
} from '../core/types.ts';
import { readContext } from '../core/services/read-context-service.ts';
import { retrieveContext } from '../core/services/retrieve-context-service.ts';
import { retrievalSelectorId } from '../core/services/retrieval-selector-service.ts';
import { buildSkillSurfaceManifest } from '../core/services/skill-surface-manifest-service.ts';

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

export async function runEval(engine: BrainEngine, args: string[]) {
  const parsed = parseArgs(args);
  const domain = parsed.positionals[0];
  if (domain === 'context') {
    await runContextEval(engine, parsed);
    return;
  }
  if (domain === 'correction' && parsed.positionals[1] === 'record') {
    await runCorrectionRecord(engine, parsed);
    return;
  }
  usage();
  process.exitCode = 1;
}

async function runContextEval(engine: BrainEngine, parsed: ParsedArgs) {
  const fixturePath = stringFlag(parsed, 'fixture');
  const compareFiles = parsed.positionals.slice(1);
  const json = parsed.flags.json === true;

  if (fixturePath) {
    const fixture = readJsonFile(fixturePath);
    const report = await persistFixtureRun(engine, fixture, fixturePath);
    print(report, json);
    return;
  }

  if (parsed.flags.compare === true && compareFiles.length === 2) {
    const base = readJsonFile(compareFiles[0]!);
    const head = readJsonFile(compareFiles[1]!);
    print(compareReports(base, head), json);
    return;
  }

  usage();
  process.exitCode = 1;
}

async function persistFixtureRun(engine: BrainEngine, fixture: Record<string, unknown>, fixturePath: string) {
  const mode = fixtureMode(fixture.mode ?? fixture.fixture_mode);
  const cases = await fixtureCases(engine, fixture, mode);
  const passed = cases.filter((entry) => entry.passed).length;
  const failed = cases.length - passed;
  const manifest = buildSkillSurfaceManifest();
  const agentRules = manifest.find((entry) => entry.id === 'agent-rules');
  const skillSurfaceHash = createHash('sha256')
    .update(JSON.stringify(manifest.map((entry) => [entry.id, entry.sha256])))
    .digest('hex');
  const now = new Date();
  const status: ContextEvalRunStatus = failed === 0 ? 'passed' : 'failed';
  const run = await engine.putContextEvalRun({
    fixture_id: stringValue(fixture.id) ?? stringValue(fixture.fixture_id) ?? basename(fixturePath),
    fixture_mode: mode,
    status,
    model_id: stringValue(fixture.model_id) ?? null,
    skill_surface_hash: skillSurfaceHash,
    agent_rules_version: agentRules?.version ?? null,
    git_sha: gitSha(),
    retrieval_trace_ids: fixtureTraceIds(fixture),
    metrics: {
      total: cases.length,
      passed,
      failed,
      pass_rate: cases.length === 0 ? 0 : passed / cases.length,
    },
    metadata: {
      fixture_path: fixturePath,
      fixture_sha256: fileSha256(fixturePath),
    },
    started_at: now,
    completed_at: now,
  });

  const assertions = [];
  for (const entry of cases) {
    assertions.push(await engine.putContextEvalAssertion({
      run_id: run.id,
      case_id: entry.case_id,
      assertion_kind: entry.assertion_kind,
      passed: entry.passed,
      score: entry.score,
      expected: entry.expected,
      actual: entry.actual,
      message: entry.message,
      retrieval_trace_id: entry.retrieval_trace_id,
      metadata: entry.metadata,
    }));
  }

  return {
    run,
    assertions,
    summary: run.metrics,
  };
}

async function runCorrectionRecord(engine: BrainEngine, parsed: ParsedArgs) {
  const traceId = requiredStringFlag(parsed, 'trace-id');
  const caseId = requiredStringFlag(parsed, 'case-id');
  const reason = requiredStringFlag(parsed, 'reason');
  const runId = stringFlag(parsed, 'run-id') ?? null;
  const json = parsed.flags.json === true;
  const correction = await engine.createContextEvalCorrection({
    trace_id: traceId,
    run_id: runId,
    case_id: caseId,
    reason,
    metadata: {
      source: 'mbrain eval correction record',
    },
  });
  print({ correction }, json);
}

function compareReports(base: Record<string, unknown>, head: Record<string, unknown>) {
  const baseMetrics = reportMetrics(base);
  const headMetrics = reportMetrics(head);
  return {
    base: baseMetrics,
    head: headMetrics,
    delta: {
      total: headMetrics.total - baseMetrics.total,
      passed: headMetrics.passed - baseMetrics.passed,
      failed: headMetrics.failed - baseMetrics.failed,
      pass_rate: headMetrics.pass_rate - baseMetrics.pass_rate,
    },
  };
}

async function fixtureCases(engine: BrainEngine, fixture: Record<string, unknown>, mode: ContextEvalFixtureMode) {
  const rawCases = arrayValue(fixture.cases)
    ?? arrayValue(fixture.assertions)
    ?? [];
  if (mode === 'live_retrieve') {
    const liveCases = [];
    for (let index = 0; index < rawCases.length; index += 1) {
      liveCases.push(await liveRetrieveCase(engine, fixture, rawCases[index], index));
    }
    return liveCases;
  }
  return rawCases.map((raw, index) => {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const expected = entry.expected ?? null;
    const actual = entry.actual ?? null;
    const passed = fixtureCasePass(entry, expected, actual);
    return {
      case_id: stringValue(entry.case_id) ?? stringValue(entry.id) ?? `case-${index + 1}`,
      assertion_kind: stringValue(entry.assertion_kind) ?? 'fixture_case',
      passed,
      score: typeof entry.score === 'number' ? entry.score : null,
      expected,
      actual,
      message: stringValue(entry.message) ?? (passed ? null : 'Fixture assertion did not match expected output.'),
      retrieval_trace_id: stringValue(entry.retrieval_trace_id) ?? null,
      metadata: objectValue(entry.metadata) ?? {},
    };
  });
}

async function liveRetrieveCase(
  engine: BrainEngine,
  fixture: Record<string, unknown>,
  raw: unknown,
  index: number,
) {
  const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const query = stringValue(entry.query) ?? stringValue(fixture.query);
  const selectors = selectorArray(entry.selectors) ?? selectorArray(fixture.selectors);
  const expected = objectValue(entry.expected) ?? null;
  const retrieve = await retrieveContext(engine, {
    query,
    selectors,
    limit: numberValue(entry.limit ?? fixture.limit) || undefined,
    token_budget: numberValue(entry.token_budget ?? fixture.token_budget) || undefined,
    include_orientation: booleanValue(entry.include_orientation ?? fixture.include_orientation),
    include_push_context: booleanValue(entry.include_push_context ?? fixture.include_push_context),
    persist_trace: true,
  });
  const readSelectors = retrieve.read_plan.selected_selector_snapshots?.length
    ? retrieve.read_plan.selected_selector_snapshots
    : retrieve.required_reads;
  const probeContext: ReadContextProbeContext = {
    retrieve_trace_ids: retrieve.trace?.id ? [retrieve.trace.id] : [],
    candidate_signal_count: retrieve.candidate_signals.length,
    candidate_signal_ids: retrieve.candidate_signals.map((signal) => signal.candidate_id),
    search_chunk_count: retrieve.candidates.reduce((total, candidate) => total + candidate.matched_chunks.length, 0),
    context_map_consulted: retrieve.orientation.derived_consulted.length > 0,
  };
  const read = await readContext(engine, {
    query,
    selectors: readSelectors,
    token_budget: numberValue(entry.read_token_budget ?? fixture.read_token_budget) || undefined,
    max_selectors: numberValue(entry.max_selectors ?? fixture.max_selectors) || undefined,
    include_source_refs: true,
    persist_trace: true,
    probe_context: probeContext,
  });
  const actual = {
    selected_selectors: retrieve.read_plan.selected_selectors,
    read_selector_ids: read.canonical_reads.map((canonicalRead) => retrievalSelectorId(canonicalRead.selector)),
    answer_ready: read.answer_ready.ready,
    unsupported_reasons: read.answer_ready.unsupported_reasons,
    authority_class: read.answer_trust_footer?.authority_class ?? 'not_answer_evidence',
    trace_ids: [
      ...(retrieve.trace?.id ? [retrieve.trace.id] : []),
      ...(read.trace?.id ? [read.trace.id] : []),
    ],
  };
  const passed = fixtureCasePass(entry, expected, actual);
  return {
    case_id: stringValue(entry.case_id) ?? stringValue(entry.id) ?? `case-${index + 1}`,
    assertion_kind: stringValue(entry.assertion_kind) ?? 'live_retrieve',
    passed,
    score: typeof entry.score === 'number' ? entry.score : null,
    expected,
    actual,
    message: stringValue(entry.message) ?? (passed ? null : 'Live retrieval result did not match expected output.'),
    retrieval_trace_id: retrieve.trace?.id ?? read.trace?.id ?? null,
    metadata: {
      ...(objectValue(entry.metadata) ?? {}),
      read_trace_id: read.trace?.id ?? null,
    },
  };
}

function fixtureCasePass(entry: Record<string, unknown>, expected: unknown, actual: unknown): boolean {
  if (typeof entry.passed === 'boolean') return entry.passed;
  if (typeof entry.expected_pass === 'boolean') return entry.expected_pass;
  if ('expected' in entry || 'actual' in entry) return matchesExpected(expected, actual);
  return false;
}

function matchesExpected(expected: unknown, actual: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const actualRecord = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>)
      .every(([key, value]) => matchesExpected(value, actualRecord[key]));
  }
  return isDeepStrictEqual(actual, expected);
}

function fixtureMode(value: unknown): ContextEvalFixtureMode {
  return value === 'live_retrieve' ? 'live_retrieve' : 'injected_candidates';
}

function fixtureTraceIds(fixture: Record<string, unknown>): string[] {
  const ids = arrayValue(fixture.retrieval_trace_ids);
  return ids ? ids.map(String) : [];
}

function reportMetrics(report: Record<string, unknown>) {
  const metrics = objectValue(report.metrics)
    ?? objectValue(objectValue(report.run)?.metrics)
    ?? objectValue(report.summary)
    ?? {};
  const total = numberValue(metrics.total);
  const passed = numberValue(metrics.passed);
  const failed = numberValue(metrics.failed);
  return {
    total,
    passed,
    failed,
    pass_rate: typeof metrics.pass_rate === 'number'
      ? metrics.pass_rate
      : total === 0 ? 1 : passed / total,
  };
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const booleanFlags = new Set(['compare', 'json']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
    const key = rawKey!;
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }
    if (booleanFlags.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function print(payload: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(JSON.stringify(payload));
}

function usage() {
  console.error('Usage: mbrain eval context --fixture <file> [--json]');
  console.error('       mbrain eval context --compare <base.json> <head.json> [--json]');
  console.error('       mbrain eval correction record --trace-id <id> --case-id <id> --reason <text> [--json]');
}

function requiredStringFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function selectorArray(value: unknown): RetrievalSelector[] | undefined {
  const raw = arrayValue(value);
  if (!raw) return undefined;
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => entry as unknown as RetrievalSelector);
}
