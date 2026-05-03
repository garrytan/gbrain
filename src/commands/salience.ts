/**
 * gbrain salience — Pages recently touched, ranked by emotional + activity salience.
 *
 * Deterministic: zero LLM calls. The score blends `emotional_weight`
 * (computed during the dream cycle's recompute_emotional_weight phase),
 * the count of active takes, and a recency-decay term. See the engine method
 * `getRecentSalience` for the SQL.
 *
 * Usage:
 *   gbrain salience                            # top 20 over last 14 days
 *   gbrain salience --days 7                   # narrower window
 *   gbrain salience --kind personal            # filter to slug-prefix
 *   gbrain salience --json                     # JSON for agents
 */

import type { BrainEngine } from '../core/engine.ts';

interface RunOpts {
  days?: number;
  limit?: number;
  slugPrefix?: string;
  json?: boolean;
}

function parseArgs(args: string[]): RunOpts | { help: true } {
  const opts: RunOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
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
    if (a === '--kind' || a === '--slug-prefix') {
      const v = args[++i];
      if (v) opts.slugPrefix = v;
      continue;
    }
  }
  return opts;
}

const HELP = `Usage: gbrain salience [options]

Pages recently touched, ranked by emotional + activity salience. Surfaces
what's unusual without needing a search term — the inverse of /query.

Options:
  --days N            Window in days (default 14)
  --limit N           Max results (default 20, capped at 100)
  --kind PREFIX       Slug-prefix filter (e.g. personal, wiki/people)
  --slug-prefix P     Same as --kind
  --json              JSON output for agents
  --help, -h          Show this help
`;

export async function runSalience(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) {
    console.log(HELP);
    return;
  }
  const rows = await engine.getRecentSalience({
    days: parsed.days,
    limit: parsed.limit,
    slugPrefix: parsed.slugPrefix,
  });
  if (parsed.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('(no pages touched in the salience window)');
    return;
  }
  // Human format: rank | score | emotion | takes | slug — title
  const header = `${pad('#', 3)} ${pad('score', 7)} ${pad('emo', 5)} ${pad('takes', 6)}  slug — title`;
  console.log(header);
  console.log('-'.repeat(Math.min(80, header.length)));
  rows.forEach((r, i) => {
    const score = r.score.toFixed(3);
    const emo = r.emotional_weight.toFixed(2);
    const takes = String(r.take_count);
    console.log(`${pad(String(i + 1), 3)} ${pad(score, 7)} ${pad(emo, 5)} ${pad(takes, 6)}  ${r.slug} — ${r.title}`);
  });
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
