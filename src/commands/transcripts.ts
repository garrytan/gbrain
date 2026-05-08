/**
 * gbrain transcripts — Recent raw conversation transcripts.
 *
 * Local-only: this command reads `.txt` files from the dream-cycle corpus
 * directories. It exists as a CLI surface so humans can trigger the same
 * read path the v0.29 `get_recent_transcripts` MCP op uses (which is itself
 * gated on remote=false; subagents and MCP/HTTP callers cannot reach it).
 *
 * Usage:
 *   gbrain transcripts recent              # last 7 days, summaries
 *   gbrain transcripts recent --days 14
 *   gbrain transcripts recent --full       # full content (capped at 100KB/file)
 *   gbrain transcripts recent --json
 */

import type { BrainEngine } from '../core/engine.ts';

interface RunOpts {
  days?: number;
  full?: boolean;
  limit?: number;
  json?: boolean;
}

function parseArgs(args: string[]): RunOpts | { help: true } {
  const opts: RunOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--full') { opts.full = true; continue; }
    if (a === '--days') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n >= 0) opts.days = n;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(n) && n > 0) opts.limit = n;
      continue;
    }
  }
  return opts;
}

const HELP = `Usage: gbrain transcripts recent [options]

Recent raw conversation transcripts (NOT polished reflections). Reads from
the dream-cycle corpus dirs (dream.synthesize.session_corpus_dir and
dream.synthesize.meeting_transcripts_dir).

Options:
  --days N        Window in days (default 7)
  --limit N       Max transcripts (default 50)
  --full          Return full content (default: ~300-char summary). Capped 100KB/file.
  --json          JSON output for agents
  --help, -h      Show this help

Note: dream-generated outputs (frontmatter dream_generated: true) are skipped.
`;

export async function runTranscripts(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== 'recent') {
    console.log(HELP);
    if (sub && sub !== '--help' && sub !== '-h') process.exitCode = 2;
    return;
  }

  const parsed = parseArgs(args.slice(1));
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  const { listRecentTranscripts } = await import('../core/transcripts.ts');
  const rows = await listRecentTranscripts(engine, {
    days: parsed.days,
    summary: !parsed.full,
    limit: parsed.limit,
  });
  if (parsed.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('(no recent transcripts in the corpus dir)');
    return;
  }
  rows.forEach(r => {
    const date = r.date ?? r.mtime.slice(0, 10);
    console.log(`\n--- ${date} | ${r.path} | ${r.length} bytes ---`);
    console.log(r.summary);
  });
}
