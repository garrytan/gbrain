/**
 * v0.28: `gbrain think <question>` CLI.
 *
 * Thin wrapper around runThink + persistSynthesis. Local CLI = remote=false,
 * so --save and --take are honored. Reads ANTHROPIC_API_KEY from the env;
 * degrades to gather-only output with a warning if missing.
 */
import type { BrainEngine } from '../core/engine.ts';
import { runThink, persistSynthesis } from '../core/think/index.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function flagPresent(args: string[], name: string): boolean {
  return args.includes(name);
}

export async function runThinkCli(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain think "<question>" [options]

Options:
  --anchor <slug>          Pull the entity subgraph around this slug
  --rounds N               Multi-pass synthesis (default 1; gap-driven loop ships in v0.29)
  --save                   Persist a synthesis page under synthesis/<slug>-<date>.md
  --take                   Append a take row to the anchor page (requires --anchor)
  --model <name>           Override the model (alias or full id)
  --since YYYY-MM-DD       Start of temporal window
  --until YYYY-MM-DD       End of temporal window
  --json                   Output as JSON
  --help                   Show this help

Without --save, the synthesis is printed to stdout and discarded. With --save,
the synthesis page is persisted AND printed.

Set ANTHROPIC_API_KEY in the environment to run real synthesis. Without it,
the gather phase still runs and prints what would have been the input.
`);
    return;
  }

  // Strip flags from positional args
  const flagNames = ['--anchor', '--rounds', '--model', '--since', '--until'];
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagNames.includes(a)) { i++; continue; }
    if (a === '--save' || a === '--take' || a === '--json' || a === '--help' || a === '-h') continue;
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
  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    if (save || take) {
      console.error(
        '[thin-client] --save and --take are server-gated for remote callers ' +
        '(trust-boundary policy). Run on the host or use the MCP `think` tool ' +
        'with the `viaSubagent` context if you need persistence.',
      );
    }
    const raw = await callRemoteTool(cfg!, 'think', {
      question, anchor, rounds, model, since, until,
      // save/take intentionally NOT forwarded — server would ignore them;
      // we surface the intent above so users know what they lose.
    }, { timeoutMs: 180_000 });
    result = unpackToolResult<any>(raw);
  } else {
    result = await runThink(engine, {
      question, anchor, rounds, save, take, model, since, until,
      // Local CLI: no MCP allow-list filter — operator owns the brain.
    });

    // Persist if --save (the runThink path doesn't auto-persist; CLI does it explicitly)
    if (save) {
      const persisted = await persistSynthesis(engine, result);
      savedSlug = persisted.slug;
      evidenceInserted = persisted.evidenceInserted;
      for (const w of persisted.warnings) result.warnings.push(w);
    }
  }

  if (json) {
    console.log(JSON.stringify({
      ...result,
      saved_slug: savedSlug ?? null,
      evidence_inserted: evidenceInserted,
    }, null, 2));
    return;
  }

  // Human-readable output
  console.log(`# ${question}\n`);
  console.log(result.answer);
  console.log('');
  if (result.gaps.length > 0) {
    console.log('## Gaps');
    for (const g of result.gaps) console.log(`- ${g}`);
    console.log('');
  }
  console.log('---');
  console.log(`Model: ${result.modelUsed} | Pages: ${result.pagesGathered} | Takes: ${result.takesGathered} | Graph: ${result.graphHits} | Citations: ${result.citations.length}`);
  if (savedSlug) {
    console.log(`Saved: ${savedSlug} (${evidenceInserted} evidence rows)`);
  }
  if (result.warnings.length > 0) {
    console.error(`Warnings: ${result.warnings.join(', ')}`);
  }
}
