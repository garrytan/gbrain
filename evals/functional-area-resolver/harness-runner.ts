/**
 * functional-area-resolver A/B eval runner.
 *
 * Reads three variant resolver files + two fixture corpora, runs each
 * (fixture, variant, seed in {1,2,3}) through Anthropic Opus 4.7 via
 * gbrain's gateway, scores the response, writes one JSONL row per call,
 * computes per-variant accuracy mean + 95% CI, prints a summary table.
 *
 * Receipts bind (model, prompt_template_hash, fixtures_hash, ts, seed)
 * so re-runs are auditable. Output JSONL begins with a receipt header.
 *
 * Pinned to anthropic:claude-opus-4-7. Update MODEL_ID and re-baseline
 * when Anthropic ships a new Opus generation. Cost: ~$1.70 per full run
 * (225 calls × ~$0.0076 each at $5/$25 per MTok input/output).
 *
 * Lives outside `skills/` deliberately — the skillpack bundler walks
 * `skills/<skill>/` recursively, so an eval surface in there would ship
 * to every downstream install. Importing `src/core/ai/gateway.ts` is
 * legitimate from this location because the eval is gbrain-repo-only.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

import { configureGateway, chat } from '../../src/core/ai/gateway.ts';
import { loadConfig } from '../../src/core/config.ts';
import { ANTHROPIC_PRICING } from '../../src/core/anthropic-pricing.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// Default model — pinned so the canonical baseline-runs/<date>-opus-4-7.jsonl
// stays reproducible. Override with --model for cross-model eval (T3a).
export const MODEL_ID = 'anthropic:claude-opus-4-7';

export const MODEL_ALIASES: Record<string, string> = {
  opus:   'anthropic:claude-opus-4-7',
  sonnet: 'anthropic:claude-sonnet-4-6',
  haiku:  'anthropic:claude-haiku-4-5-20251001',
};

export function resolveModel(spec: string): { full: string; bare: string } {
  const full = MODEL_ALIASES[spec] ?? spec;
  const bare = full.startsWith('anthropic:') ? full.slice('anthropic:'.length) : full;
  return { full, bare };
}

const VARIANT_NAMES = ['baseline', 'functional-areas', 'resolver-of-resolvers'] as const;
type VariantName = (typeof VARIANT_NAMES)[number];

const SEEDS = [1, 2, 3] as const;

export interface Fixture {
  intent: string;
  expected_skill: string;
}

export interface RunRow {
  kind: 'run';
  fixture_id: number;
  corpus: 'training' | 'held_out';
  variant: VariantName;
  seed: number;
  predicted: string;
  expected: string;
  /** Strict score: predicted exactly equals expected. */
  correct: 0 | 1;
  /** Lenient score: predicted is in the same dispatcher area as expected (T1a). */
  correct_lenient: 0 | 1;
  model: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  ts: string;
}

export interface ReceiptRow {
  kind: 'receipt';
  model: string;
  prompt_template_hash: string;
  fixtures_hash: string;
  fixtures_held_out_hash: string;
  /** Git sha of the harness at run time (T4). Detect stale numbers when harness changes. */
  harness_sha: string | null;
  ts: string;
  cmd_args: string[];
}

// ---------------------------------------------------------------------------
// Pure functions (testable without API key)
// ---------------------------------------------------------------------------

export const PROMPT_TEMPLATE = `You are a routing classifier for a skill-based agent. Given the resolver below and the user's intent, return the single most-specific skill slug that should handle the intent.

Rules:
- Return ONLY a slug. No explanation, no quotes, no markdown — just the slug.
- Some entries are functional-area dispatchers shaped like:
    "**Area name**: triggers... → \`dispatcher-skill\` (dispatcher for: subskill-a, subskill-b, subskill-c, ...)"
  When the user's intent matches an area, RETURN THE MOST-SPECIFIC SUB-SKILL from that area's "dispatcher for" list, not the dispatcher itself. The dispatcher slug is only correct when no listed sub-skill is more specific to the intent.
- If a row has no dispatcher list, return its slug directly.

RESOLVER:
<<<RESOLVER_CONTENT>>>

USER INTENT: <<<INTENT>>>

SKILL SLUG:`;

export function parseFixtures(rawJsonl: string): Fixture[] {
  const out: Fixture[] = [];
  const lines = rawJsonl.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('//')) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Bad fixture JSON: ${trimmed.slice(0, 80)} — ${(err as Error).message}`);
    }
    if (typeof obj.intent !== 'string' || typeof obj.expected_skill !== 'string') {
      throw new Error(`Fixture missing required fields: ${trimmed.slice(0, 80)}`);
    }
    out.push({ intent: obj.intent, expected_skill: obj.expected_skill });
  }
  return out;
}

export function loadVariant(path: string): string {
  return readFileSync(path, 'utf8');
}

export function buildPrompt(variantContent: string, intent: string): string {
  return PROMPT_TEMPLATE.replace('<<<RESOLVER_CONTENT>>>', variantContent).replace('<<<INTENT>>>', intent);
}

export function parseModelResponse(raw: string): string {
  // The model may return: bare slug, fenced slug, quoted slug, JSON-wrapped
  // slug, or slug with a leading explanation. We strip the obvious wrappers
  // and take the first line that looks like a slug.
  let s = raw.trim();
  // Strip ```...``` fences
  s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  // If the response is JSON like {"skill": "foo"}, extract.
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (typeof obj.skill === 'string') return obj.skill.trim().toLowerCase();
      if (typeof obj.skill_slug === 'string') return obj.skill_slug.trim().toLowerCase();
      if (typeof obj.expected_skill === 'string') return obj.expected_skill.trim().toLowerCase();
    } catch {}
  }
  // Strip surrounding quotes and backticks
  s = s.replace(/^[`"']|[`"']$/g, '').trim();
  // Take first non-empty line
  const firstLine = s.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? '';
  // If it starts with a prose preamble, look for a slug-shaped token
  const slugMatch = firstLine.match(/[a-z][a-z0-9-]+/i);
  return (slugMatch ? slugMatch[0] : firstLine).toLowerCase();
}

export function scoreFixture(predicted: string, expected: string): 0 | 1 {
  return predicted === expected ? 1 : 0;
}

/**
 * Parse every "...→ `dispatcher-slug` (dispatcher for: a, b, c, ...)" line
 * out of a variant resolver. Returns a map: dispatcher_slug → set of sub-skill
 * slugs reachable through it. Also includes the dispatcher_slug itself in
 * the set so it's a self-member.
 *
 * Variant shapes:
 *  - functional-areas.md: "→ `brain-ops` (dispatcher for: enrich, query, ...)"
 *  - resolver-of-resolvers.md: "→ `brain-ops`" (no dispatcher clause; returns {})
 *  - baseline.md: per-skill rows (each row's slug becomes its own area)
 *
 * Used by lenientScore: a predicted slug counts as "same area as expected"
 * if both belong to the same dispatcher's reachable set, OR predicted is the
 * dispatcher and expected is a sub-skill (or vice versa).
 */
export function parseDispatcherLists(variantContent: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Match both Unicode `→` (used in the real production AGENTS.md the variants
  // came from) AND ASCII `->` (what SKILL.md's template emits when a user
  // follows the documented instructions). Codex review P2-2: without ASCII
  // support, downstream-authored resolvers silently fall through to strict
  // scoring even though SKILL.md tells the user the template uses `->`.
  const re = /(?:→|->)\s*`([a-z][a-z0-9-]*)`\s*\(dispatcher for:\s*([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(variantContent)) !== null) {
    const dispatcher = m[1];
    const subSkills = m[2].split(',').map(s => s.trim()).filter(s => /^[a-z][a-z0-9-]*$/.test(s));
    const set = new Set<string>([dispatcher, ...subSkills]);
    out.set(dispatcher, set);
  }
  return out;
}

/**
 * Lenient scoring: predicted is correct if (predicted == expected) OR
 * (both predicted and expected are in the same dispatcher's reachable set
 * per the variant). This is the T1a re-scoring that surfaces "the LLM
 * picked a legitimate sub-skill, just not the one my fixture named."
 *
 * For variants with no dispatcher clauses (baseline, resolver-of-resolvers),
 * lenient collapses to strict.
 */
export function scoreFixtureLenient(
  predicted: string,
  expected: string,
  dispatcherLists: Map<string, Set<string>>,
): 0 | 1 {
  if (predicted === expected) return 1;
  for (const set of dispatcherLists.values()) {
    if (set.has(predicted) && set.has(expected)) return 1;
  }
  return 0;
}

/** Capture the harness git sha so receipts can detect stale numbers. */
export function getHarnessSha(): string | null {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return sha.length === 40 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Mean and 95% CI via t-distribution (n=3, df=2, t-critical ≈ 4.303).
 * For n=3 with df=2 the 95% two-tailed t-critical is 4.303 per standard
 * tables. Returns the half-width of the CI (mean ± halfWidth).
 */
export function meanAndCI95(values: number[]): { mean: number; halfWidthCI: number } {
  if (values.length === 0) return { mean: 0, halfWidthCI: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return { mean, halfWidthCI: 0 };
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  const stdErr = Math.sqrt(variance / values.length);
  const tCrit = values.length === 3 ? 4.303 : values.length === 2 ? 12.706 : 1.96;
  return { mean, halfWidthCI: tCrit * stdErr };
}

export function estimateCost(
  numCalls: number,
  modelBare: string = 'claude-opus-4-7',
  inputTokensPerCall = 1000,
  outputTokensPerCall = 50,
): number {
  const pricing = ANTHROPIC_PRICING[modelBare];
  if (!pricing) return 0;
  const input = (numCalls * inputTokensPerCall) / 1_000_000;
  const output = (numCalls * outputTokensPerCall) / 1_000_000;
  return input * pricing.input + output * pricing.output;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function writeJsonl(rows: (RunRow | ReceiptRow)[], outputPath: string): void {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(outputPath, lines, 'utf8');
}

export interface ParsedArgs {
  limit: number | null;
  parallel: number;
  output: string | null;
  help: boolean;
  yes: boolean;
  /** Model alias ('opus','sonnet','haiku') or full provider:model id. */
  model: string;
  /** Variants directory (default ./variants). */
  variantsDir: string;
  /** Custom variant glob (overrides default 3 variants); used by description-length sweep. */
  variantFiles: string[] | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    limit: null, parallel: 1, output: null, help: false, yes: false,
    model: MODEL_ID, variantsDir: 'variants', variantFiles: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--limit') {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v) || v < 1) throw new Error(`--limit must be a positive integer`);
      out.limit = v;
    } else if (a === '--parallel') {
      const v = parseInt(argv[++i], 10);
      if (!Number.isFinite(v) || v < 1) throw new Error(`--parallel must be a positive integer`);
      out.parallel = v;
    } else if (a === '--output') {
      out.output = argv[++i];
    } else if (a === '--model') {
      const v = argv[++i];
      if (!v) throw new Error(`--model requires a value (alias or provider:model)`);
      out.model = v;
    } else if (a === '--variants-dir') {
      const v = argv[++i];
      if (!v) throw new Error(`--variants-dir requires a path`);
      out.variantsDir = v;
    } else if (a === '--variants') {
      // Comma-separated list of variant file basenames (without .md). Used by sweep.
      const v = argv[++i];
      if (!v) throw new Error(`--variants requires a comma-separated list`);
      out.variantFiles = v.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gateway wrapper (mockable via __setChatTransportForTests)
// ---------------------------------------------------------------------------

async function callModel(prompt: string, modelFull: string): Promise<{ text: string; input_tokens: number; output_tokens: number; latency_ms: number }> {
  const t0 = Date.now();
  const result = await chat({
    model: modelFull,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 64,
  });
  return {
    text: result.text,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    latency_ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `functional-area-resolver A/B eval harness

Usage:
  bun run harness-runner.ts [flags]
  node harness.mjs [flags]                    # CLI shim

Flags:
  --limit N            Run only the first N (fixture × variant × seed) tuples
  --parallel N         Run N tuples in parallel (default 1; gateway rate-lease bound)
  --output PATH        Write JSONL to PATH (default: ./run-<ISO-ts>.jsonl)
  --model SPEC         Model alias (opus|sonnet|haiku) or full provider:model id
                       Default: opus (anthropic:claude-opus-4-7)
  --variants-dir PATH  Override variants directory (default: ./variants)
  --variants A,B,C     Comma-separated variant basenames (default: all 3 in variants-dir)
                       Useful for description-length sweep where you have 4+ variants.
  --yes                Skip the cost-estimate confirmation prompt
  --help               Print this help

Cost rough estimates (75 calls/variant × num-variants × 3 seeds):
  Opus:   ~$1.70 per 225-call run (1 model × 3 variants × 25 fixtures × 3 seeds)
  Sonnet: ~$1.02 per 225-call run
  Haiku:  ~$0.34 per 225-call run

Output JSONL has each row scored TWICE: 'correct' (strict, predicted==expected)
and 'correct_lenient' (predicted and expected are in the same dispatcher area).
Summary reports both.
`;

async function maybePromptCost(numCalls: number, modelFull: string, autoConfirm: boolean): Promise<boolean> {
  const { bare } = resolveModel(modelFull);
  const cost = estimateCost(numCalls, bare);
  process.stderr.write(`Estimated cost: ~$${cost.toFixed(2)} for ${numCalls} LLM calls via ${modelFull}.\n`);
  if (autoConfirm) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write('Non-TTY context; pass --yes to confirm.\n');
    return false;
  }
  process.stderr.write('Press Enter to continue or Ctrl-C to abort. ');
  return await new Promise(resolve => {
    process.stdin.once('data', () => resolve(true));
    process.stdin.once('end', () => resolve(false));
  });
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const { full: modelFull, bare: modelBare } = resolveModel(args.model);

  // Self-configure the gateway (matches src/commands/eval-cross-modal.ts:195-220).
  const config = loadConfig();
  configureGateway({
    embedding_model: config?.embedding_model,
    embedding_dimensions: config?.embedding_dimensions,
    expansion_model: config?.expansion_model,
    chat_model: config?.chat_model ?? modelFull,
    chat_fallback_chain: config?.chat_fallback_chain,
    base_urls: config?.provider_base_urls,
    env: { ...process.env } as Record<string, string>,
  });

  // Provider-aware auth check (codex review P2-3). The CLI advertises full
  // provider:model support and the test suite covers `openai:gpt-4o`, so the
  // env-var gate must match the provider that will actually be called.
  // Unknown providers fall through to the gateway, which will raise a clear
  // recipe-specific error if any required env var is missing.
  const REQUIRED_ENV_BY_PROVIDER: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    groq: 'GROQ_API_KEY',
    voyage: 'VOYAGE_API_KEY',
    together: 'TOGETHER_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    dashscope: 'DASHSCOPE_API_KEY',
    zhipu: 'ZHIPUAI_API_KEY',
  };
  const providerId = modelFull.includes(':') ? modelFull.split(':', 1)[0] : 'anthropic';
  const requiredEnv = REQUIRED_ENV_BY_PROVIDER[providerId];
  if (requiredEnv && !process.env[requiredEnv]) {
    process.stderr.write(`Error: ${requiredEnv} is not set. The harness needs it to reach ${modelFull}.\n`);
    return 2;
  }

  // Load fixtures + variants.
  const evalsDir = __dirname;
  const fixturesTraining = parseFixtures(readFileSync(join(evalsDir, 'fixtures.jsonl'), 'utf8'));
  const fixturesHeldOut = parseFixtures(readFileSync(join(evalsDir, 'fixtures-held-out.jsonl'), 'utf8'));

  // Dynamic variants: --variants overrides the default 3, --variants-dir overrides location.
  const variantsAbsDir = resolve(evalsDir, args.variantsDir);
  const variantBasenames = args.variantFiles
    ?? (VARIANT_NAMES as readonly string[]).map(n => n);
  const variants: Record<string, string> = {};
  const dispatcherListsByVariant: Record<string, Map<string, Set<string>>> = {};
  for (const name of variantBasenames) {
    const content = loadVariant(join(variantsAbsDir, `${name}.md`));
    variants[name] = content;
    dispatcherListsByVariant[name] = parseDispatcherLists(content);
  }

  // Build the (fixture × variant × seed) tuple list.
  type Tuple = { fixture: Fixture; corpus: 'training' | 'held_out'; fixture_id: number; variant: string; seed: number };
  const tuples: Tuple[] = [];
  for (const variant of variantBasenames) {
    fixturesTraining.forEach((f, i) => {
      for (const seed of SEEDS) tuples.push({ fixture: f, corpus: 'training', fixture_id: i, variant, seed });
    });
    fixturesHeldOut.forEach((f, i) => {
      for (const seed of SEEDS) tuples.push({ fixture: f, corpus: 'held_out', fixture_id: i, variant, seed });
    });
  }
  const totalCalls = args.limit ? Math.min(args.limit, tuples.length) : tuples.length;
  const workQueue = tuples.slice(0, totalCalls);

  // Cost-estimate prompt (skipped for tiny --limit runs to keep dev iteration fast).
  if (totalCalls >= 20) {
    const proceed = await maybePromptCost(totalCalls, modelFull, args.yes);
    if (!proceed) {
      process.stderr.write('Aborted.\n');
      return 1;
    }
  }

  // Compute receipt header.
  const fixturesHash = hashContent(readFileSync(join(evalsDir, 'fixtures.jsonl'), 'utf8'));
  const fixturesHeldOutHash = hashContent(readFileSync(join(evalsDir, 'fixtures-held-out.jsonl'), 'utf8'));
  const promptTemplateHash = hashContent(PROMPT_TEMPLATE);
  const harnessSha = getHarnessSha();
  const tsStart = new Date().toISOString();
  const receipt: ReceiptRow = {
    kind: 'receipt',
    model: modelFull,
    prompt_template_hash: promptTemplateHash,
    fixtures_hash: fixturesHash,
    fixtures_held_out_hash: fixturesHeldOutHash,
    harness_sha: harnessSha,
    ts: tsStart,
    cmd_args: argv,
  };

  // Output path.
  const outputPath = args.output ?? join(evalsDir, `run-${tsStart.replace(/[:.]/g, '-')}.jsonl`);
  process.stderr.write(`Writing receipt + ${totalCalls} runs to ${outputPath}\n`);

  const rows: (RunRow | ReceiptRow)[] = [receipt];

  // Sequential or simple bounded-parallel execution.
  let completed = 0;
  async function processTuple(t: Tuple): Promise<RunRow> {
    const prompt = buildPrompt(variants[t.variant], t.fixture.intent);
    const { text, input_tokens, output_tokens, latency_ms } = await callModel(prompt, modelFull);
    const predicted = parseModelResponse(text);
    const correct = scoreFixture(predicted, t.fixture.expected_skill);
    const correct_lenient = scoreFixtureLenient(
      predicted,
      t.fixture.expected_skill,
      dispatcherListsByVariant[t.variant] ?? new Map(),
    );
    const row: RunRow = {
      kind: 'run',
      fixture_id: t.fixture_id,
      corpus: t.corpus,
      variant: t.variant as VariantName,
      seed: t.seed,
      predicted,
      expected: t.fixture.expected_skill,
      correct,
      correct_lenient,
      model: modelFull,
      input_tokens,
      output_tokens,
      latency_ms,
      ts: new Date().toISOString(),
    };
    completed++;
    if (completed % 10 === 0 || completed === totalCalls) {
      process.stderr.write(`  ${completed}/${totalCalls} done\n`);
    }
    return row;
  }

  // Bounded parallel: chunk into args.parallel-sized batches.
  for (let i = 0; i < workQueue.length; i += args.parallel) {
    const batch = workQueue.slice(i, i + args.parallel);
    const results = await Promise.all(batch.map(processTuple));
    rows.push(...results);
  }

  // Write JSONL.
  writeJsonl(rows, outputPath);

  // Compute per-variant accuracy. Both strict + lenient. Held-out is the
  // headline; training is reported separately.
  const runRows = rows.filter((r): r is RunRow => r.kind === 'run');
  type CorpusKey = 'training' | 'held_out';
  type Acc = { training: number[]; held_out: number[] };
  const strictSummary: Record<string, Acc> = {};
  const lenientSummary: Record<string, Acc> = {};
  for (const variant of variantBasenames) {
    strictSummary[variant] = { training: [], held_out: [] };
    lenientSummary[variant] = { training: [], held_out: [] };
    for (const corpus of ['training', 'held_out'] as const) {
      for (const seed of SEEDS) {
        const subset = runRows.filter(r => r.variant === variant && r.corpus === corpus && r.seed === seed);
        if (subset.length === 0) continue;
        strictSummary[variant][corpus].push(subset.reduce((a, r) => a + r.correct, 0) / subset.length);
        lenientSummary[variant][corpus].push(subset.reduce((a, r) => a + r.correct_lenient, 0) / subset.length);
      }
    }
  }

  // Print summary.
  const fmt = (vals: number[]) => {
    if (vals.length === 0) return '—';
    const { mean, halfWidthCI } = meanAndCI95(vals);
    return `${(mean * 100).toFixed(1)}% ± ${(halfWidthCI * 100).toFixed(1)}%`;
  };

  process.stderr.write(`\n=== A/B Eval Summary (model: ${modelFull}) ===\n`);
  process.stderr.write('                              | STRICT scoring                                  | LENIENT (same-area)\n');
  process.stderr.write('Variant                       | Held-out               | Training              | Held-out             | Training\n');
  process.stderr.write('------------------------------|------------------------|------------------------|----------------------|----------------------\n');
  for (const variant of variantBasenames) {
    process.stderr.write(
      `${variant.padEnd(30)}| ${fmt(strictSummary[variant].held_out).padEnd(22)} | ${fmt(strictSummary[variant].training).padEnd(22)} | ${fmt(lenientSummary[variant].held_out).padEnd(20)} | ${fmt(lenientSummary[variant].training)}\n`,
    );
  }
  process.stderr.write('\nLENIENT counts a prediction as correct if it shares a dispatcher area with the expected target.\n');
  process.stderr.write('For variants without "(dispatcher for: ...)" clauses (baseline, resolver-of-resolvers), LENIENT == STRICT.\n');
  process.stderr.write('\nReceipt + runs written to: ' + outputPath + '\n');

  return 0;
}

// Bun entrypoint: run main when invoked as a script.
if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
