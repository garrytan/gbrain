/**
 * v0.28: `gbrain think <question>` CLI.
 *
 * Thin wrapper around runThink + persistSynthesis. Local CLI = remote=false,
 * so --save and --take are honored. Reads ANTHROPIC_API_KEY from the env;
 * degrades to gather-only output with a warning if missing.
 */
import type { BrainEngine } from '../core/engine.ts';
import { runThink, persistSynthesis, stripGapsSection } from '../core/think/index.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { canonicalLookup } from '../core/model-pricing.ts';
import { embedQuery } from '../core/embedding.ts';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function flagPresent(args: string[], name: string): boolean {
  return args.includes(name);
}

/**
 * think's own cost was previously unsurfaced anywhere: not in this CLI's own
 * `--json` output, not in `budget_ledger`, and invisible to a wrapping
 * caller's own token accounting (the LLM call `think` makes is its own,
 * separate API call). Returns undefined when `usage` is absent (no-client/
 * stub paths, or a remote-MCP call that didn't forward it) or when the
 * resolved model has no entry in the canonical pricing table.
 */
export function computeThinkCostUsd(
  usage: { input_tokens: number; output_tokens: number } | undefined,
  modelUsed: string,
): number | undefined {
  if (!usage) return undefined;
  const pricing = canonicalLookup(modelUsed);
  if (!pricing) return undefined;
  return Number(
    ((usage.input_tokens / 1_000_000) * pricing.input
      + (usage.output_tokens / 1_000_000) * pricing.output).toFixed(4),
  );
}

export async function runThinkCli(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain think "<question>" [options]

Options:
  --anchor <slug>          Pull the entity subgraph around this slug
  --rounds N               Multi-pass synthesis (default 1; gap-driven loop ships in v0.29)
  --save                   Persist a synthesis page under synthesis/<slug>-<date>.md
  --take                   Append a take row to the anchor page (requires --anchor)
  --model <name>           Override the model: provider:model (preferred) or
                           provider/model or a bare alias. An explicit --model that
                           can't be resolved is a hard error (exit 1) — never a
                           silent no-LLM degrade.
  --source <id>            Scope evidence gathering to this source. An unknown
                           or archived source is a hard error (exit 1).
  --since YYYY-MM-DD       Start of temporal window
  --until YYYY-MM-DD       End of temporal window
  --with-calibration       Inject the active calibration profile (anti-bias rewrite)
  --calibration-holder <h> Holder whose calibration profile to use (default: self)
  --json                   Output as JSON
  --help                   Show this help

Without --save, the synthesis is printed to stdout and discarded. With --save,
the synthesis page is persisted AND printed. If --save is given but no synthesis
was produced (no LLM available, or empty result), nothing is saved and the command
exits non-zero.

Set ANTHROPIC_API_KEY (or run: gbrain config set anthropic_api_key ...) to run
real synthesis. Without it AND without --save, the gather phase still runs and
prints what would have been the input (exit 0).
`);
    return;
  }

  // Strip flags from positional args.
  // #4508: --source and --calibration-holder were MISSING here — the flag and
  // its value joined the positional question, so `think "q" --source X`
  // echoed `# --source X q` and silently ignored the scope.
  const flagNames = ['--anchor', '--rounds', '--model', '--since', '--until', '--source', '--calibration-holder'];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagNames.includes(a)) { i++; continue; }
    if (a === '--save' || a === '--take' || a === '--json' || a === '--help' || a === '-h' || a === '--with-calibration') continue;
    positional.push(a);
  }
  const question = positional.join(' ').trim();
  if (!question) {
    console.error('Missing question. Try: gbrain think "What do we know about acme-example?"');
    process.exit(1);
  }

  const json = flagPresent(args, '--json');
  const save = flagPresent(args, '--save');
  const take = flagPresent(args, '--take');
  const anchor = flagValue(args, '--anchor');
  const roundsStr = flagValue(args, '--rounds');
  const rounds = roundsStr ? Math.max(1, parseInt(roundsStr, 10) || 1) : 1;
  const model = flagValue(args, '--model');
  const since = flagValue(args, '--since');
  const until = flagValue(args, '--until');
  // v0.36.1.0 (E1, D22) — anti-bias rewrite mode. Off by default (no
  // regression for existing think users). When on, the active calibration
  // profile gets injected per D22 placement (after retrieval, before question).
  const withCalibration = flagPresent(args, '--with-calibration');
  const calibrationHolder = flagValue(args, '--calibration-holder');
  // #4508: parse --source; validated (existence + shape) in the local branch
  // below where a real engine is available.
  const source = flagValue(args, '--source');

  if (take && !anchor) {
    console.error('--take requires --anchor (the take row needs a target page)');
    process.exit(1);
  }

  // v0.31.1 (Issue #734): on thin-client installs, route through MCP. The
  // server's `think` handler intentionally ignores --save and --take for
  // remote callers (operations.ts:1103-1135 trust-boundary gate). Document
  // here loudly so users get a clear warning instead of silent loss.
  let result: any;
  let savedSlug: string | undefined;
  let evidenceInserted = 0;
  // #2556: --take persistence outputs.
  let takeRow: number | null = null;
  let takePath: string | undefined;
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    if (save || take) {
      console.error(
        '[thin-client] --save and --take are server-gated for remote callers ' +
        '(trust-boundary policy). Run on the host or use the MCP `think` tool ' +
        'with the `viaSubagent` context if you need persistence.',
      );
    }
    if (source !== undefined) {
      // #4508: the remote `think` op scopes by the server's session/auth, not
      // a per-call param — say so instead of silently dropping the flag.
      console.error(
        '[thin-client] --source is scoped by the remote server (session/auth) ' +
        'and cannot be overridden per call — the flag is not forwarded.',
      );
    }
    const raw = await callRemoteTool(cfg!, 'think', {
      question, anchor, rounds, model, since, until,
      // save/take intentionally NOT forwarded — server would ignore them;
      // we surface the intent above so users know what they lose.
    }, { timeoutMs: 180_000 });
    result = unpackToolResult<any>(raw);
  } else {
    try {
      // #4508: validate --source before the gather runs — an unknown or
      // archived source is a hard exit 1 (SourceTargetError message names
      // it), never a silent full-brain gather.
      let sourceId: string | undefined;
      if (source !== undefined) {
        const { resolveSourceWithTier } = await import('../core/source-resolver.ts');
        sourceId = (await resolveSourceWithTier(engine, source)).source_id;
      }
      result = await runThink(engine, {
        question, anchor, rounds, save, take, model, since, until,
        // Fail-closed trust: local CLI must say so explicitly, or trajectory
        // injection degrades to visibility='world' rows.
        remote: false,
        // #3734: activate takes' vector retrieval arm for CLI think.
        embedQuestion: (q) => embedQuery(q),
        // #4508: thread the validated scope (RunThinkOpts.sourceId).
        ...(sourceId ? { sourceId } : {}),
        // #1698: explicit --model → hard error on an unresolvable model (no silent
        // degrade to the no-LLM stub). Omitting --model keeps the graceful default path.
        modelExplicit: !!model,
        // v0.36.1.0 (E1) — opt-in anti-bias rewrite. Falls back to baseline
        // think when no profile exists, with NO_CALIBRATION_PROFILE warning.
        withCalibration,
        ...(calibrationHolder ? { calibrationHolder } : {}),
        // Local CLI: no MCP allow-list filter — operator owns the brain.
      });

      // Persist if --save (the runThink path doesn't auto-persist; CLI does it explicitly)
      if (save) {
        const persisted = await persistSynthesis(engine, result);
        savedSlug = persisted.slug || undefined;  // '' = persist-skip signal (#10)
        evidenceInserted = persisted.evidenceInserted;
        for (const w of persisted.warnings) result.warnings.push(w);
        // #1698 (F2): --save requested but no synthesis was produced (no LLM, empty,
        // or malformed) → exit non-zero. Saving nothing with exit 0 when the user
        // explicitly asked to save is itself a silent failure.
        if (!persisted.slug) {
          console.error(
            'think: --save requested but no synthesis was produced (no LLM available ' +
            'or empty result) — nothing saved.',
          );
          process.exit(1);
        }
      }

      // #2556: --take was documented (and parsed) since v0.28 but never
      // executed — runThink ignored opts.take entirely. Persist md-first
      // through the canonical takes write-through; a refusal (no repo, empty
      // answer, failed synthesis, write error) exits non-zero (same F2
      // posture as --save: the user explicitly asked for a persist).
      if (take && anchor) {
        const { persistTakeFromSynthesis } = await import('../core/think/persist-take.ts');
        const persisted = await persistTakeFromSynthesis(engine, result, { anchor });
        takeRow = persisted.take_row;
        takePath = persisted.path;
        for (const w of persisted.warnings) result.warnings.push(w);
        if (persisted.take_row === null) {
          console.error(
            `think: --take requested but no take row was appended (${persisted.warnings.join(', ') || 'unknown reason'}).`,
          );
          process.exit(1);
        }
      }
    } catch (e) {
      // #1698: an unresolvable explicit --model throws here. Clean non-zero exit
      // with the actionable message, not a stack trace.
      console.error((e as Error).message);
      process.exit(1);
    }
  }

  const costUsd = computeThinkCostUsd(
    (result as { usage?: { input_tokens: number; output_tokens: number } }).usage,
    result.modelUsed,
  );

  if (json) {
    console.log(JSON.stringify({
      ...result,
      cost_usd: costUsd ?? null,
      saved_slug: savedSlug ?? null,
      evidence_inserted: evidenceInserted,
      take_row: takeRow,
    }, null, 2));
    return;
  }

  // Human-readable output
  console.log(`# ${question}\n`);
  console.log(stripGapsSection(result.answer));
  console.log('');
  if (result.gaps.length > 0) {
    console.log('## Gaps');
    for (const g of result.gaps) console.log(`- ${g}`);
    console.log('');
  }
  console.log('---');
  const costSuffix = costUsd !== undefined ? ` | Cost: $${costUsd.toFixed(4)}` : '';
  console.log(`Model: ${result.modelUsed} | Pages: ${result.pagesGathered} | Takes: ${result.takesGathered} | Graph: ${result.graphHits} | Citations: ${result.citations.length}${costSuffix}`);
  if (savedSlug) {
    console.log(`Saved: ${savedSlug} (${evidenceInserted} evidence rows)`);
  }
  if (takeRow !== null) {
    console.log(`Take: row ${takeRow} appended to ${anchor}${takePath ? ` (${takePath})` : ''}`);
  }
  if (result.warnings.length > 0) {
    console.error(`Warnings: ${result.warnings.join(', ')}`);
  }
}
