/**
 * gbrain brainstorm — bisociation-style idea generation grounded in your
 * own notes.
 *
 * v0.37.0 wave (D14 + D6 + D11 + D12). Pulls a small close-set via
 * hybridSearch, a far-set via prefix-stratified domain-bank, crosses them
 * via gateway.chat, and judges via the shared 5-axis rubric. Output cites
 * close + far slugs with a 0-1 distance score (D6 transparency).
 *
 * For "Lateral Synaptic Drift" — the inverted-judge / stale-bias variant —
 * see `src/commands/lsd.ts` which calls the same orchestrator with the
 * LSD_PROFILE config object.
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  runBrainstorm,
  formatBrainstormMarkdown,
  buildBrainstormFrontmatter,
  BRAINSTORM_PROFILE,
  LSD_PROFILE,
  type BrainstormProfile,
} from '../core/brainstorm/orchestrator.ts';
import { loadConfig } from '../core/config.ts';

export interface BrainstormCliArgs {
  question?: string;
  json: boolean;
  save?: boolean;
  yes: boolean;
  limit?: number;
  /** Cost ceiling in USD; aborts pre-run if estimate exceeds. Default $5. */
  maxCost?: number;
  /** Hard cap on far-set prefix sampling. Default 50. */
  maxFarSet?: number;
  /** When true, abort mid-run if running spend exceeds 5× estimate. */
  strictBudget?: boolean;
  /** Override the model used for the judge phase. */
  judgeModel?: string;
  /** Max ideas per judge LLM call. Default 100. */
  maxIdeasPerJudgeCall?: number;
  help: boolean;
  error?: string;
}

export function parseBrainstormArgs(args: string[]): BrainstormCliArgs {
  const out: BrainstormCliArgs = { json: false, yes: false, help: false };
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--json') {
      out.json = true;
    } else if (arg === '--save') {
      out.save = true;
    } else if (arg === '--no-save') {
      out.save = false;
    } else if (arg === '--yes' || arg === '-y') {
      out.yes = true;
    } else if (arg === '--limit') {
      const v = args[++i];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `--limit requires a positive integer (got ${v})`;
        return out;
      }
      out.limit = n;
    } else if (arg === '--max-cost') {
      const v = args[++i];
      const n = v ? parseFloat(v) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `--max-cost requires a positive number in USD (got ${v})`;
        return out;
      }
      out.maxCost = n;
    } else if (arg === '--max-far-set') {
      const v = args[++i];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `--max-far-set requires a positive integer (got ${v})`;
        return out;
      }
      out.maxFarSet = n;
    } else if (arg === '--strict-budget') {
      out.strictBudget = true;
    } else if (arg === '--judge-model') {
      const v = args[++i];
      if (!v) {
        out.error = `--judge-model requires a model id (e.g. anthropic:claude-sonnet-4-6)`;
        return out;
      }
      out.judgeModel = v;
    } else if (arg === '--max-ideas-per-judge-call') {
      const v = args[++i];
      const n = v ? parseInt(v, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) {
        out.error = `--max-ideas-per-judge-call requires a positive integer (got ${v})`;
        return out;
      }
      out.maxIdeasPerJudgeCall = n;
    } else if (arg.startsWith('--')) {
      out.error = `unknown flag: ${arg}`;
      return out;
    } else {
      positional.push(arg);
    }
    i++;
  }
  if (positional.length > 0) {
    out.question = positional.join(' ');
  }
  return out;
}

const BRAINSTORM_HELP = `Usage: gbrain brainstorm <question> [options]

Bisociation idea generator grounded in your own notes. Pulls a close-set
via hybrid search and a far-set via prefix-stratified domain-bank, crosses
them, judges with a 5-axis rubric. Output cites close + far slugs with a
0-1 distance score so you can see how far each collision actually traveled.

Options:
  --json                          Emit BrainstormResult as JSON (for agents)
  --save                          Save to wiki/ideas/<date>-brainstorm-<slug>.md (default ON)
  --no-save                       Don't save; print only
  --yes, -y                       Skip the 10s cost-preview wait (TTY only)
  --limit N                       Override the far-bank size (default 6 brainstorm / 12 LSD)
  --max-cost USD                  Abort if estimated cost exceeds USD (default 5)
  --max-far-set N                 Cap domain bank prefix sampling (default 50)
  --strict-budget                 Abort if running cost exceeds 5× the estimate
  --judge-model MODEL             Override the judge LLM (larger-context for big runs)
  --max-ideas-per-judge-call N    Max ideas per judge LLM call (default 100)
  --help, -h                      Show this help

Examples:
  gbrain brainstorm "why are AI coding tools converging on the same UX?"
  gbrain brainstorm "what's the real bottleneck on lab automation" --json

Cost: ~$0.05-0.15 per run. Set GBRAIN_NO_BRAINSTORM_PREVIEW=1 or pass --yes
to skip the TTY grace window in scripted callers.

See also: gbrain lsd — Lateral Synaptic Drift, the inverted-judge variant
that prefers forgotten pages and rejects ideas that are "too obvious."
`;

const LSD_HELP = `Usage: gbrain lsd <question> [options]

LSD = Lateral Synaptic Drift. Same bisociation engine as \`gbrain brainstorm\`
with the distance dial maxed: bigger far-bank (12 pages), smaller close-set
(2 pages), forgotten pages preferred via the stale-bias signal, inverted
judge that REJECTS ideas scoring too high on coherence ("too obvious — you'd
have thought of this without LSD"), every idea must invert at least one
implicit axiom. Output is ephemeral by default — pass --save if an idea lands.

Options:
  --json                          Emit BrainstormResult as JSON
  --save                          Persist to wiki/ideas/<date>-lsd-<slug>.md (default OFF)
  --yes, -y                       Skip the 10s cost-preview wait (TTY only)
  --limit N                       Override the far-bank size (default 12)
  --max-cost USD                  Abort if estimated cost exceeds USD (default 5)
  --max-far-set N                 Cap domain bank prefix sampling (default 50)
  --strict-budget                 Abort if running cost exceeds 5× the estimate
  --judge-model MODEL             Override the judge LLM (larger-context for big runs)
  --max-ideas-per-judge-call N    Max ideas per judge LLM call (default 100)
  --help, -h                      Show this help

Examples:
  gbrain lsd "why are AI coding tools converging on the same UX?"
  gbrain lsd "the unspoken assumption in venture pricing" --save

Cost: ~$0.20-0.40 per run.

See also: gbrain brainstorm — the sober, cite-heavy default variant.
`;

/** Shared body: brainstorm.ts → runBrainstormCli(BRAINSTORM_PROFILE); lsd.ts → runBrainstormCli(LSD_PROFILE). */
async function runBrainstormCli(
  engine: BrainEngine,
  args: string[],
  profile: BrainstormProfile,
  help: string,
): Promise<void> {
  const parsed = parseBrainstormArgs(args);
  if (parsed.help) {
    console.log(help);
    return;
  }
  if (parsed.error) {
    console.error(`gbrain ${profile.label}: ${parsed.error}`);
    console.error(help);
    process.exit(2);
    return;
  }
  if (!parsed.question || parsed.question.trim().length === 0) {
    console.error(`gbrain ${profile.label}: question required`);
    console.error(help);
    process.exit(2);
    return;
  }

  const config = loadConfig() ?? {};
  // Honor env-var skip for scripted environments that can't easily pass --yes.
  const skipPreview = parsed.yes || process.env.GBRAIN_NO_BRAINSTORM_PREVIEW === '1';

  // --limit override: replace m_far on a shallow copy of the profile.
  const effectiveProfile: BrainstormProfile = parsed.limit
    ? { ...profile, m_far: parsed.limit }
    : profile;

  const result = await runBrainstorm(engine, config, {
    question: parsed.question,
    profile: effectiveProfile,
    skipCostPreview: skipPreview,
    maxCostUsd: parsed.maxCost,
    maxFarSet: parsed.maxFarSet,
    strictBudget: parsed.strictBudget,
    judgeModel: parsed.judgeModel,
    maxIdeasPerJudgeCall: parsed.maxIdeasPerJudgeCall,
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable: render via formatBrainstormMarkdown. `onlyPassed: true`
  // by default — passes-only output is the headline; failed ideas live in
  // the JSON / saved page for triage.
  const md = formatBrainstormMarkdown(result, { onlyPassed: true, includeMeta: true });
  console.log(md);

  // Save policy: brainstorm defaults to save-on; lsd defaults to save-off.
  // CLI --save / --no-save overrides the default.
  const shouldSave = parsed.save ?? profile.default_save;
  if (shouldSave) {
    const slug = buildIdeaSlug(parsed.question, profile.label);
    const frontmatter = buildBrainstormFrontmatter(result, { slug });
    // Re-render content for save: include filtered ideas too so --retry-judge
    // (when implemented) has the full set to re-score.
    const body = formatBrainstormMarkdown(result, { onlyPassed: false, includeMeta: true });
    const content = frontmatter + body;
    try {
      await engine.putPage(slug, {
        title: `${profile.label === 'lsd' ? 'LSD' : 'Brainstorm'}: ${parsed.question.slice(0, 100)}`,
        type: 'note',
        compiled_truth: content,
        frontmatter: {
          mode: profile.frontmatter_mode,
          generated_at: new Date().toISOString(),
          question: parsed.question,
          judge_failed: result.judge_failed,
          unscored: result.judge_failed,
          close_slugs: result.close_set.map((c) => c.slug),
          far_slugs: result.far_set.map((f) => f.slug),
        },
        timeline: '',
      });
      console.log(`\n_Saved to \`${slug}\`._`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`gbrain ${profile.label}: save failed: ${msg}`);
    }
  }
}

/** Slugify the question for the saved page path. Capped + collision-resistant via date prefix. */
function buildIdeaSlug(question: string, label: 'brainstorm' | 'lsd'): string {
  const date = new Date().toISOString().slice(0, 10);
  const stem = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return `wiki/ideas/${date}-${label}-${stem || 'untitled'}`;
}

/** CLI entry: `gbrain brainstorm`. */
export async function runBrainstormCommand(engine: BrainEngine, args: string[]): Promise<void> {
  return runBrainstormCli(engine, args, BRAINSTORM_PROFILE, BRAINSTORM_HELP);
}

/** CLI entry: `gbrain lsd`. */
export async function runLsdCommand(engine: BrainEngine, args: string[]): Promise<void> {
  return runBrainstormCli(engine, args, LSD_PROFILE, LSD_HELP);
}
