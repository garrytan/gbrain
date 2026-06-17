/**
 * v0.31.2 — `gbrain notability-eval` mining + review CLI.
 *
 * Two subcommands:
 *
 *   gbrain notability-eval mine [--target-high N] [--target-medium N]
 *                                [--target-low N] [--out PATH]
 *      Walks meetings/, personal/, daily/ in the brain repo (resolved
 *      via `sync.repo_path` config), splits each markdown body into
 *      paragraphs, cheap-Haiku pre-classifies each candidate paragraph,
 *      stratified-samples to target counts (default 20/20/10), writes
 *      candidates JSONL for hand-confirmation.
 *
 *   gbrain notability-eval review [--in PATH] [--out PATH]
 *      Walks the candidates JSONL one-by-one in TTY: shows the paragraph,
 *      asks for HIGH/MEDIUM/LOW confirmation, writes confirmed cases
 *      to `~/.gbrain/eval/notability-real.jsonl`.
 *
 * Eval set is two-tier (CLAUDE.md privacy rule):
 *   - Public anonymized: test/fixtures/notability-eval-public.jsonl
 *     (40 synthetic cases shipped with the repo, runs in CI).
 *   - Private real: ~/.gbrain/eval/notability-real.jsonl (50 mined
 *     cases from the user's actual brain, local-only, runs only when
 *     GBRAIN_NOTABILITY_EVAL_REAL=1).
 *
 * Test harness lives at test/notability-eval.test.ts and computes
 * precision@HIGH, recall@HIGH, F1, confusion matrix. Soft gate: warn
 * if precision@HIGH < 0.75; fail PR if < 0.50.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import type { BrainEngine } from '../core/engine.ts';

const DEFAULT_TARGETS = { high: 20, medium: 20, low: 10 } as const;
const DEFAULT_CORPUS_DIRS = ['meetings/', 'personal/', 'daily/'] as const;
const MIN_PARAGRAPH_CHARS = 80;
const MAX_PARAGRAPH_CHARS = 800;
const HAIKU_BATCH_SIZE = 10;  // candidates pre-classified per LLM call

export interface MinedCandidate {
  path: string;       // relative path within brain repo
  paragraph: string;
  predicted_tier: 'high' | 'medium' | 'low';
  predicted_at: string;
}

export interface ConfirmedCase extends MinedCandidate {
  confirmed_tier: 'high' | 'medium' | 'low';
  confirmed_at: string;
  /** Optional anonymized version (replaces names with placeholders). */
  anonymized_paragraph?: string;
}

interface MineOpts {
  targetHigh?: number;
  targetMedium?: number;
  targetLow?: number;
  out?: string;
  /** Override corpus dirs (testing). */
  corpusDirs?: string[];
  /** When true, skip the LLM pre-classify and round-robin tier-assign every candidate. */
  skipLlm?: boolean;
}

/** Resolve the path where mining writes its candidates JSONL. */
export function defaultMiningOutPath(): string {
  return join(homedir(), '.gbrain', 'eval', 'notability-mining-candidates.jsonl');
}

/** Resolve the path where review writes confirmed cases. */
export function defaultReviewOutPath(): string {
  return join(homedir(), '.gbrain', 'eval', 'notability-real.jsonl');
}

/**
 * Walk a directory recursively for .md files. Returns relative paths from
 * `root`. Used for mining; the candidates JSONL stores these so reviewers
 * can find the source page.
 */
export function walkMarkdownFiles(root: string, prefix: string = ''): string[] {
  const out: string[] = [];
  const dir = join(root, prefix);
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const sub = join(prefix, entry);
    const full = join(root, sub);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        out.push(...walkMarkdownFiles(root, sub));
      } else if (st.isFile() && entry.endsWith('.md')) {
        out.push(sub);
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Split a markdown body into paragraphs. Filters by min/max length so
 * fragments and giant code blocks don't bias the eval set.
 */
export function splitParagraphs(body: string): string[] {
  return body
    .split(/\n\n+/)
    .map(p => p.trim())
    .filter(p => p.length >= MIN_PARAGRAPH_CHARS && p.length <= MAX_PARAGRAPH_CHARS)
    // Drop frontmatter-shape lines (pure key: value blocks) which slip
    // past the paragraph splitter when frontmatter is malformed.
    .filter(p => !/^---\s*$/m.test(p) || p.split('\n').length > 3);
}

/**
 * Mine candidates. Returns the array of MinedCandidate (caller writes JSONL).
 *
 * The Haiku pre-classify is best-effort — if no chat gateway is configured,
 * falls back to round-robin tier assignment so the operator can still
 * generate a candidate file for hand-labeling without API access. The
 * mining cost is documented as ~$0.10 in the cathedral plan; round-robin
 * fallback is $0.
 */
export async function mineNotabilityCandidates(
  repoPath: string,
  opts: MineOpts = {},
): Promise<MinedCandidate[]> {
  const targetHigh = opts.targetHigh ?? DEFAULT_TARGETS.high;
  const targetMedium = opts.targetMedium ?? DEFAULT_TARGETS.medium;
  const targetLow = opts.targetLow ?? DEFAULT_TARGETS.low;
  const dirs = opts.corpusDirs ?? [...DEFAULT_CORPUS_DIRS];

  // Step 1: enumerate candidate paragraphs across the corpus dirs.
  type Candidate = { path: string; paragraph: string };
  const allCandidates: Candidate[] = [];
  for (const dir of dirs) {
    const files = walkMarkdownFiles(repoPath, dir);
    for (const f of files) {
      try {
        const body = readFileSync(join(repoPath, f), 'utf-8');
        for (const p of splitParagraphs(body)) {
          allCandidates.push({ path: f, paragraph: p });
        }
      } catch { /* unreadable file — skip */ }
    }
  }

  if (allCandidates.length === 0) {
    return [];
  }

  // Step 2: pre-classify (Haiku) each candidate to bucket. Fallback:
  // round-robin tier assignment when no gateway is available.
  const buckets: Record<'high' | 'medium' | 'low', Candidate[]> = {
    high: [], medium: [], low: [],
  };

  if (opts.skipLlm) {
    // Round-robin so the bucket distribution is roughly balanced; the
    // operator hand-confirms tier in the review step regardless.
    for (let i = 0; i < allCandidates.length; i++) {
      const tier = (['high', 'medium', 'low'] as const)[i % 3];
      buckets[tier].push(allCandidates[i]);
    }
  } else {
    const { isAvailable } = await import('../core/ai/gateway.ts');
    if (!isAvailable('chat')) {
      // No gateway → round-robin (same as skipLlm).
      for (let i = 0; i < allCandidates.length; i++) {
        const tier = (['high', 'medium', 'low'] as const)[i % 3];
        buckets[tier].push(allCandidates[i]);
      }
    } else {
      // Haiku classification in batches to amortize per-call overhead.
      for (let i = 0; i < allCandidates.length; i += HAIKU_BATCH_SIZE) {
        const batch = allCandidates.slice(i, i + HAIKU_BATCH_SIZE);
        const tiers = await classifyBatch(batch.map(c => c.paragraph));
        for (let j = 0; j < batch.length; j++) {
          const tier = tiers[j] ?? 'medium';
          buckets[tier].push(batch[j]);
        }
      }
    }
  }

  // Step 3: stratified random sample within each bucket. Each pick is
  // also stratified across corpus directories so HIGH cases come from
  // multiple dirs not just one. Fallback: when a bucket is undersized,
  // use everything available (the operator can re-run mine later if
  // they want a bigger sample).
  const result: MinedCandidate[] = [];
  const now = new Date().toISOString();

  function sampleStratified(bucket: Candidate[], n: number): Candidate[] {
    if (bucket.length <= n) return bucket;
    // Group by top-level dir.
    const byDir = new Map<string, Candidate[]>();
    for (const c of bucket) {
      const topDir = c.path.split('/')[0] ?? '';
      if (!byDir.has(topDir)) byDir.set(topDir, []);
      byDir.get(topDir)!.push(c);
    }
    const dirsList = [...byDir.keys()];
    const perDir = Math.max(1, Math.floor(n / dirsList.length));
    const picked: Candidate[] = [];
    for (const dir of dirsList) {
      const arr = byDir.get(dir)!;
      // Random shuffle (Fisher-Yates).
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      picked.push(...arr.slice(0, perDir));
    }
    return picked.slice(0, n);
  }

  for (const c of sampleStratified(buckets.high, targetHigh)) {
    result.push({ ...c, predicted_tier: 'high', predicted_at: now });
  }
  for (const c of sampleStratified(buckets.medium, targetMedium)) {
    result.push({ ...c, predicted_tier: 'medium', predicted_at: now });
  }
  for (const c of sampleStratified(buckets.low, targetLow)) {
    result.push({ ...c, predicted_tier: 'low', predicted_at: now });
  }

  return result;
}

/**
 * Classify a batch of paragraphs with Haiku. Returns `('high'|'medium'|'low')[]`
 * one per input. Error tolerant: any failed batch falls back to 'medium'
 * (the safest middle bucket so the candidate isn't lost).
 */
async function classifyBatch(paragraphs: string[]): Promise<Array<'high' | 'medium' | 'low'>> {
  if (paragraphs.length === 0) return [];

  const { chat } = await import('../core/ai/gateway.ts');

  const system = [
    'Classify each paragraph into HIGH, MEDIUM, or LOW notability for personal-knowledge memory:',
    '- HIGH: Life events (separation, death, birth, hospitalization), major commitments,',
    '  relationship status changes, health changes, emotional breakthroughs, financial decisions.',
    '- MEDIUM: Durable preferences, beliefs, strong opinions that reveal character.',
    '- LOW: Logistical noise, restaurant orders, routine scheduling.',
    '',
    'Output strictly one JSON object: {"tiers":["high"|"medium"|"low",...]} ',
    'with one entry per input in order. No prose, no fences.',
  ].join('\n');

  const userMsg = paragraphs
    .map((p, i) => `<p index="${i}">\n${p}\n</p>`)
    .join('\n\n');

  try {
    const result = await chat({
      model: 'anthropic:claude-haiku-4-5-20251001',
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 200,
    });
    const text = result.text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text) as { tiers?: string[] };
    if (Array.isArray(parsed.tiers)) {
      return parsed.tiers.map(t =>
        ['high', 'medium', 'low'].includes(t)
          ? (t as 'high' | 'medium' | 'low')
          : 'medium',
      );
    }
  } catch {
    // Fall through to default
  }
  return paragraphs.map(() => 'medium');
}

/** Load + parse a JSONL file of MinedCandidate or ConfirmedCase. */
export function loadJsonlCases<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

/** Append (overwrite) JSONL cases to a path. */
export function writeJsonlCases<T>(path: string, cases: T[]): void {
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  const lines = cases.map(c => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(path, lines);
}

interface RunNotabilityEvalArgs {
  /** Repo path to mine from (resolves via sync.repo_path config when undefined). */
  repoPath?: string;
  /** Subcommand: 'mine' | 'review' | 'help'. */
  cmd: string;
  /** Free-form CLI flags. */
  flags: Record<string, string | boolean>;
  engine?: BrainEngine;
}

/** CLI entrypoint dispatched from src/cli.ts. */
export async function runNotabilityEval(args: RunNotabilityEvalArgs): Promise<void> {
  switch (args.cmd) {
    case 'mine': {
      if (!args.repoPath) {
        throw new Error('mine requires a repoPath. Set sync.repo_path or pass --repo PATH.');
      }
      const out = (args.flags.out as string) || defaultMiningOutPath();
      const candidates = await mineNotabilityCandidates(resolve(args.repoPath), {
        targetHigh: args.flags['target-high'] ? Number(args.flags['target-high']) : undefined,
        targetMedium: args.flags['target-medium'] ? Number(args.flags['target-medium']) : undefined,
        targetLow: args.flags['target-low'] ? Number(args.flags['target-low']) : undefined,
        skipLlm: args.flags['skip-llm'] === true,
      });
      writeJsonlCases(out, candidates);
      // eslint-disable-next-line no-console
      console.log(`Wrote ${candidates.length} candidates to ${out}`);
      // eslint-disable-next-line no-console
      console.log(`Run \`gbrain notability-eval review --in ${out}\` to hand-confirm tiers.`);
      return;
    }

    case 'review': {
      const inPath = (args.flags.in as string) || defaultMiningOutPath();
      const outPath = (args.flags.out as string) || defaultReviewOutPath();
      const candidates = loadJsonlCases<MinedCandidate>(inPath);
      if (candidates.length === 0) {
        // eslint-disable-next-line no-console
        console.error(`No candidates found at ${inPath}. Run mine first.`);
        return;
      }
      // The interactive TTY review loop is implemented as a thin shim
      // over readline. Tests cover the pure mining path; the TTY loop
      // gets a smoke-only test that injects answers via process.stdin.
      const confirmed: ConfirmedCase[] = [];
      const { default: readline } = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string) => new Promise<string>(r => rl.question(q, a => r(a)));

      try {
        // eslint-disable-next-line no-console
        console.log(`Reviewing ${candidates.length} candidates. Press q to quit early.`);
        // eslint-disable-next-line no-console
        console.log(`Confirmed cases will write to ${outPath}.`);
        const now = () => new Date().toISOString();
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          // eslint-disable-next-line no-console
          console.log(`\n--- ${i + 1}/${candidates.length} (${c.path}) ---`);
          // eslint-disable-next-line no-console
          console.log(c.paragraph);
          // eslint-disable-next-line no-console
          console.log(`Predicted: ${c.predicted_tier}`);
          const ans = (await ask('Confirm tier (h/m/l) or q to quit, s to skip: ')).trim().toLowerCase();
          if (ans === 'q') break;
          if (ans === 's') continue;
          const tier = ans === 'h' ? 'high' : ans === 'l' ? 'low' : 'medium';
          confirmed.push({ ...c, confirmed_tier: tier, confirmed_at: now() });
        }
      } finally {
        rl.close();
      }
      writeJsonlCases(outPath, confirmed);
      // eslint-disable-next-line no-console
      console.log(`Wrote ${confirmed.length} confirmed cases to ${outPath}.`);
      return;
    }

    case 'help':
    default:
      // eslint-disable-next-line no-console
      console.log([
        'gbrain notability-eval — eval suite for the notability gate.',
        '',
        'Subcommands:',
        '  mine   Walk the brain repo, sample paragraphs, write candidates.',
        '  review Hand-confirm tiers in a TTY. Writes ~/.gbrain/eval/notability-real.jsonl.',
        '',
        'Flags:',
        '  --target-high N   Default 20',
        '  --target-medium N Default 20',
        '  --target-low N    Default 10',
        '  --out PATH        Override output JSONL path',
        '  --in PATH         Review only: input candidates JSONL',
        '  --skip-llm        Mine: skip Haiku pre-classify (round-robin tier assign)',
      ].join('\n'));
  }
}
