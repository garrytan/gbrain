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
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  runBrainstorm,
  formatBrainstormMarkdown,
  buildBrainstormFrontmatterObject,
  BRAINSTORM_PROFILE,
  LSD_PROFILE,
  type BrainstormProfile,
} from '../core/brainstorm/orchestrator.ts';
import { loadConfig } from '../core/config.ts';
import { StructuredAgentError } from '../core/errors.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import { importFromContent } from '../core/import-file.ts';
import { writePageThrough, type WriteThroughResult } from '../core/write-through.ts';
import { randomBytes } from 'crypto';

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
  /** TX4: resume a crashed run by run_id. */
  resume?: string;
  /** Bypass the 7-day staleness gate on resume. */
  forceResume?: boolean;
  /** When true, print the list of saved runs + exit. */
  listRuns?: boolean;
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
    } else if (arg === '--resume') {
      const v = args[++i];
      if (!v || v.startsWith('--')) {
        out.error = `--resume requires a run_id (use --list-runs to see saved runs)`;
        return out;
      }
      out.resume = v;
    } else if (arg === '--force-resume') {
      out.forceResume = true;
    } else if (arg === '--list-runs') {
      out.listRuns = true;
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
  --resume RUN_ID                 Resume a previously-crashed run (uses --list-runs ids)
  --force-resume                  Bypass the 7-day staleness gate on --resume
  --list-runs                     Print saved run_ids and exit
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
  --resume RUN_ID                 Resume a previously-crashed run (uses --list-runs ids)
  --force-resume                  Bypass the 7-day staleness gate on --resume
  --list-runs                     Print saved run_ids and exit
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
  if (parsed.listRuns) {
    const { listRuns } = await import('../core/brainstorm/checkpoint.ts');
    const runs = listRuns();
    if (parsed.json) {
      console.log(JSON.stringify(runs, null, 2));
    } else if (runs.length === 0) {
      console.log('No saved brainstorm runs.');
    } else {
      console.log('Saved runs (newest first):');
      console.log('run_id            | iso_date                  | question');
      console.log('------------------+---------------------------+----------------');
      for (const r of runs) {
        const iso = new Date(r.mtime).toISOString();
        console.log(`${r.run_id} | ${iso} | ${r.question.slice(0, 60)}`);
      }
    }
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

  // v0.39.3.0 WARN-10 + CV11 — catch StructuredAgentError 'brainstorm_timeout'
  // surfaced by the orchestrator's outer wrap and format it like the
  // cli.ts:188-191 OperationError block (Error [code]: message + Hint line
  // + exit 1). Non-typed errors (including BudgetExhausted from v0.39.0.0
  // T10's gateway-layer cap) fall through to the dispatcher's existing
  // catch. Without this CLI formatter, the typed error reaches main()'s
  // generic catch which prints `e.message` only — losing the structured
  // `.hint` field that's the whole point of the orchestrator-level wrap.
  let result;
  try {
    result = await runBrainstorm(engine, config, {
      question: parsed.question,
      profile: effectiveProfile,
      skipCostPreview: skipPreview,
      // v0.39.0.0 T10 cost-cap surface — wired in master, preserved here.
      maxCostUsd: parsed.maxCost,
      maxFarSet: parsed.maxFarSet,
      strictBudget: parsed.strictBudget,
      judgeModel: parsed.judgeModel,
      maxIdeasPerJudgeCall: parsed.maxIdeasPerJudgeCall,
      resumeRunId: parsed.resume,
      forceResume: parsed.forceResume,
    });
  } catch (err) {
    if (err instanceof StructuredAgentError) {
      if (parsed.json) {
        // Agents reading --json get the structured envelope (matches
        // serializeError shape from src/core/errors.ts).
        console.log(JSON.stringify({ error: err.envelope }, null, 2));
      } else {
        console.error(`Error [${err.envelope.code}]: ${err.envelope.message}`);
        if (err.envelope.hint) console.error(`  Hint: ${err.envelope.hint}`);
      }
      process.exit(1);
    }
    throw err; // not our error class — let the dispatcher handle it
  }

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
    const title = `${profile.label === 'lsd' ? 'LSD' : 'Brainstorm'}: ${parsed.question.slice(0, 100)}`;
    // Build ONE frontmatter object and render via the canonical serializer so
    // the saved file round-trips through `gbrain sync` byte-for-byte. Include
    // filtered ideas (onlyPassed:false) so a future --retry-judge has the full
    // set to re-score.
    const fmObj = buildBrainstormFrontmatterObject(result);
    const body = formatBrainstormMarkdown(result, { onlyPassed: false, includeMeta: true });
    const content = serializeMarkdown(fmObj, body, '', { type: 'note', title, tags: [] });

    const outcome = await persistSavedIdea(engine, { slug, content, provenanceVia: profile.label });
    const msg = formatSaveOutcome(outcome, { profileLabel: profile.label, slug });
    if (msg.stdout) console.log(msg.stdout);
    for (const line of msg.stderr) console.error(line);
    if (msg.exitCode) setCliExitVerdict(msg.exitCode);
  }
}

/** Outcome of persisting a saved idea to both sinks. */
export interface SaveOutcome {
  /** True when the canonical DB import (importFromContent) succeeded. */
  dbSaved: boolean;
  /** Set when the DB import threw. */
  dbError?: string;
  /** Disk write-through result (rendered from the saved row). */
  writeThrough: WriteThroughResult;
}

export interface SaveMessage {
  /** Human-readable success line for stdout (omitted when nothing persisted). */
  stdout?: string;
  /** Error / warning lines for stderr. */
  stderr: string[];
  /** Nonzero ONLY when nothing was persisted (no DB row AND no file). */
  exitCode: number;
}

/**
 * Persist a saved idea through the CANONICAL ingestion path: importFromContent
 * (chunks + tags + content_hash + source_path, but `noEmbed` so we don't pay
 * embedding cost at save time) writes the DB row, then the shared
 * `writePageThrough` helper renders that row to disk. Rendering from the row
 * means the two sinks cannot diverge, and the row matches what `gbrain sync`
 * would produce — so a later sync doesn't churn it. The file is only attempted
 * when the DB write landed (it's rendered from the row).
 */
export async function persistSavedIdea(
  engine: BrainEngine,
  args: { slug: string; content: string; sourceId?: string; provenanceVia: string },
): Promise<SaveOutcome> {
  const sourceId = args.sourceId ?? 'default';
  let dbSaved = false;
  let dbError: string | undefined;
  try {
    await importFromContent(engine, args.slug, args.content, {
      noEmbed: true,
      sourceId,
      sourcePath: `${args.slug}.md`,
    });
    dbSaved = true;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }
  const writeThrough: WriteThroughResult = dbSaved
    ? await writePageThrough(engine, args.slug, {
        sourceId,
        frontmatterOverrides: { source_kind: args.provenanceVia },
      })
    : { written: false, skipped: 'page_not_found_after_write' };
  return { dbSaved, dbError, writeThrough };
}

/**
 * Render an honest save message from the outcome. Every branch names the real
 * state; the only nonzero exit is the total-failure case (nothing persisted),
 * so scripts can't read a failed `--save` as success. A file-write failure when
 * the DB row landed stays exit 0 — the row is durable and `gbrain sync`
 * reconciles the disk file on the next run.
 */
export function formatSaveOutcome(
  outcome: SaveOutcome,
  ctx: { profileLabel: string; slug: string },
): SaveMessage {
  const { dbSaved, dbError, writeThrough } = outcome;
  const stderr: string[] = [];
  if (dbError) stderr.push(`gbrain ${ctx.profileLabel}: DB save failed: ${dbError}`);
  if (writeThrough.error) {
    stderr.push(`gbrain ${ctx.profileLabel}: file write failed: ${writeThrough.error}`);
  }

  if (dbSaved && writeThrough.written) {
    return {
      stdout: `\n_Saved to DB page \`${ctx.slug}\` and file \`${writeThrough.path}\`._`,
      stderr,
      exitCode: 0,
    };
  }
  if (dbSaved && writeThrough.skipped === 'no_repo_configured') {
    return {
      stdout: `\n_Saved to DB page \`${ctx.slug}\` (no \`sync.repo_path\` set — skipped file write)._`,
      stderr,
      exitCode: 0,
    };
  }
  if (dbSaved && writeThrough.skipped === 'repo_not_found') {
    return {
      stdout: `\n_Saved to DB page \`${ctx.slug}\` (\`sync.repo_path\` is not a directory — skipped file write)._`,
      stderr,
      exitCode: 0,
    };
  }
  if (dbSaved) {
    // File write attempted but errored (already on stderr). Row is durable.
    return {
      stdout: `\n_Saved to DB page \`${ctx.slug}\` (file NOT written — see error above; \`gbrain sync\` will reconcile)._`,
      stderr,
      exitCode: 0,
    };
  }
  // Nothing persisted — the silent-false-success bug class. Exit nonzero.
  stderr.push(
    `gbrain ${ctx.profileLabel}: save FAILED — neither DB page nor file was written. The idea is NOT persisted.`,
  );
  return { stderr, exitCode: 1 };
}

/**
 * Slugify the question for the saved page path. Collision-resistant via a date
 * prefix AND a random nonce suffix — two same-day runs whose questions share
 * the first 60 slug chars (or both slugify to empty → `untitled`) would
 * otherwise produce the same slug, and both the DB upsert and the file write
 * would silently clobber the earlier idea. The nonce is injectable so tests are
 * deterministic; production uses crypto random.
 */
export function buildIdeaSlug(
  question: string,
  label: 'brainstorm' | 'lsd',
  nonce?: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const stem = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  const suffix = nonce ?? randomBytes(3).toString('hex');
  return `wiki/ideas/${date}-${label}-${stem || 'untitled'}-${suffix}`;
}

/** CLI entry: `gbrain brainstorm`. */
export async function runBrainstormCommand(engine: BrainEngine, args: string[]): Promise<void> {
  return runBrainstormCli(engine, args, BRAINSTORM_PROFILE, BRAINSTORM_HELP);
}

/** CLI entry: `gbrain lsd`. */
export async function runLsdCommand(engine: BrainEngine, args: string[]): Promise<void> {
  return runBrainstormCli(engine, args, LSD_PROFILE, LSD_HELP);
}
