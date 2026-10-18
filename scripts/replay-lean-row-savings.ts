#!/usr/bin/env bun
/**
 * Keyless replay of recorded `search`/`query` tool results through the lean
 * row change (no `id` where `fetch` is not callable, `score` at 4
 * significant digits), to measure the characters it saves.
 *
 *   bun scripts/replay-lean-row-savings.ts <transcripts.jsonl[.gz]> [--results <results.jsonl>] [--json]
 *
 * Input: Cat 40 transcripts (gbrain-evals `--transcripts`): one JSON object
 * per attempt with `tools: [{ name, args, result }]`, where `result` is the
 * tool's text blocks joined by newlines (content[0] JSON first, then the
 * `[gbrain search]` / `[gbrain dates]` trailers and notices). The runner
 * stores at most 40,000 characters of each result; `--results` reads each
 * call's real size from the cell results (`sessions[].run.tool_calls[].chars`),
 * so a clipped call's saving is the saving measured on its stored prefix,
 * scaled to its real size (reported as estimated).
 *
 * Two surfaces per call: `starter` (fetch not callable: `id` dropped, unless
 * an earlier `request_tools {surface: "full"}` in the attempt widened it) and
 * `full` (fetch callable: only score rounding). The row edit is applied to the
 * serialized JSON text; on every unclipped call whose content[0] parses, the
 * result is checked against leanRow's own projection, and any difference is
 * reported as a mismatch. Characters are JavaScript string length.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { leanRow, leanScore } from '../src/core/search/lean-rows.ts';

interface ToolCall { name: string; args?: Record<string, unknown>; result?: string }
interface Attempt { attempt_id?: string; key: string; tools?: ToolCall[] }
interface Cell { attempt_id: string; sessions?: Array<{ run?: { tool_calls?: Array<{ name: string; chars: number }> } }> }

const REPLAYED_OPS = new Set(['search', 'query']);
const ID_FIELD = /,"id":"gbrain-page:v1:[A-Za-z0-9_-]+"/g;
const SCORE_FIELD = /"score":(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function lines(path: string): string[] {
  const raw = readFileSync(path);
  return (path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')).split('\n').filter(l => l.trim());
}

function rewrite(text: string, keepId: boolean): string {
  const scored = text.replace(SCORE_FIELD, (_m, n: string) => `"score":${JSON.stringify(leanScore(Number(n)))}`);
  return keepId ? scored : scored.replace(ID_FIELD, '');
}

/** leanRow's projection of content[0], plus the untouched trailers; null when content[0] is not a row array. */
function projected(result: string, keepId: boolean): string | null {
  const nl = result.indexOf('\n');
  const head = nl < 0 ? result : result.slice(0, nl);
  try {
    const rows = JSON.parse(head) as unknown;
    if (!Array.isArray(rows)) return null;
    return JSON.stringify(rows.map(r => leanRow(r as Record<string, unknown>, { keepId }))) + (nl < 0 ? '' : result.slice(nl));
  } catch { return null; }
}

function main(): void {
  const args = process.argv.slice(2);
  const resultsAt = args.indexOf('--results');
  const resultsPath = resultsAt >= 0 ? args[resultsAt + 1] : undefined;
  const path = args.find((a, i) => !a.startsWith('--') && (resultsAt < 0 || i !== resultsAt + 1));
  if (!path) {
    process.stderr.write('usage: bun scripts/replay-lean-row-savings.ts <transcripts.jsonl[.gz]> [--results <results.jsonl>] [--json]\n');
    process.exit(2);
  }
  const realChars = new Map<string, number[]>();
  if (resultsPath) {
    for (const l of lines(resultsPath)) {
      const cell = JSON.parse(l) as Cell;
      realChars.set(cell.attempt_id, (cell.sessions ?? []).flatMap(s => (s.run?.tool_calls ?? []).map(c => c.chars)));
    }
  }
  const ops: Record<string, { calls: number; clipped: number; mismatches: number; before: number; starter: number; full: number; before_exact: number; starter_exact: number; full_exact: number }> = {};
  let gbrainToolChars = 0;
  let joinFailures = 0;
  for (const l of lines(path)) {
    const attempt = JSON.parse(l) as Attempt;
    const tools = attempt.tools ?? [];
    const sizes = attempt.attempt_id ? realChars.get(attempt.attempt_id) : undefined;
    if (resultsPath && sizes?.length !== tools.length) joinFailures++;
    const usable = sizes?.length === tools.length ? sizes : undefined;
    const gbrainArm = tools.some(t => REPLAYED_OPS.has(t.name));
    let widened = false;
    tools.forEach((call, i) => {
      const recorded = call.result ?? '';
      const real = Math.max(usable?.[i] ?? recorded.length, recorded.length);
      if (gbrainArm) gbrainToolChars += real;
      if (call.name === 'request_tools' && call.args?.surface === 'full' && !recorded.startsWith('{"error"')) widened = true;
      if (!REPLAYED_OPS.has(call.name)) return;
      const t = (ops[call.name] ??= { calls: 0, clipped: 0, mismatches: 0, before: 0, starter: 0, full: 0, before_exact: 0, starter_exact: 0, full_exact: 0 });
      const starterText = rewrite(recorded, widened);
      const fullText = rewrite(recorded, true);
      t.calls++;
      t.before += real;
      if (real > recorded.length) {
        t.clipped++;
        t.starter += Math.round(real * starterText.length / recorded.length);
        t.full += Math.round(real * fullText.length / recorded.length);
        return;
      }
      for (const [text, keepId] of [[starterText, widened], [fullText, true]] as const) {
        const check = projected(recorded, keepId);
        if (check !== null && check !== text) t.mismatches++;
      }
      t.starter += starterText.length;
      t.full += fullText.length;
      t.before_exact += real;
      t.starter_exact += starterText.length;
      t.full_exact += fullText.length;
    });
  }
  const pct = (saved: number, of: number) => (of === 0 ? 0 : Math.round((saved / of) * 10_000) / 100);
  const report = {
    input: path,
    results: resultsPath ?? null,
    join_failures: joinFailures,
    gbrain_arm_tool_result_chars: gbrainToolChars,
    ops: Object.fromEntries(Object.entries(ops).map(([op, t]) => [op, {
      ...t,
      starter_saved_pct: pct(t.before - t.starter, t.before),
      full_saved_pct: pct(t.before - t.full, t.before),
      starter_saved_pct_exact_calls: pct(t.before_exact - t.starter_exact, t.before_exact),
      full_saved_pct_exact_calls: pct(t.before_exact - t.full_exact, t.before_exact),
      starter_saved_pct_of_gbrain_tool_chars: pct(t.before - t.starter, gbrainToolChars),
      full_saved_pct_of_gbrain_tool_chars: pct(t.before - t.full, gbrainToolChars),
    }])),
  };
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`gbrain-arm tool-result characters: ${gbrainToolChars}${resultsPath ? ` (real sizes from ${resultsPath}; ${joinFailures} attempts not joined)` : ' (stored sizes)'}\n`);
  for (const [op, r] of Object.entries(report.ops)) {
    process.stdout.write(`${op}: ${r.calls} calls, ${r.clipped} clipped in the transcript (estimated), ${r.mismatches} projection mismatches; ${r.before} chars\n`
      + `  starter (no fetch): ${r.starter} chars, saves ${r.before - r.starter} = ${r.starter_saved_pct}% of ${op} (${r.starter_saved_pct_exact_calls}% on unclipped calls), ${r.starter_saved_pct_of_gbrain_tool_chars}% of gbrain tool results\n`
      + `  full (fetch callable): ${r.full} chars, saves ${r.before - r.full} = ${r.full_saved_pct}% of ${op} (${r.full_saved_pct_exact_calls}% on unclipped calls), ${r.full_saved_pct_of_gbrain_tool_chars}% of gbrain tool results\n`);
  }
}

main();
