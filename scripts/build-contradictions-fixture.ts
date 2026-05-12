#!/usr/bin/env bun
/**
 * scripts/build-contradictions-fixture.ts (v0.32.6, T2)
 *
 * Build a privacy-redacted gold fixture for the contradiction probe judge
 * by running the probe against the user's REAL brain and hand-labeling
 * the candidate pairs. Output: test/fixtures/contradictions-eval-gold.jsonl.
 *
 * Privacy posture (CLAUDE.md rule): the operator MUST inspect the
 * generated file before commit. The redactor (fixture-redact.ts) is
 * best-effort; the pre-commit review is the safety net. Fail-closed if
 * any pair fails the isCleanForCommit check after redaction.
 *
 * Usage:
 *   bun run scripts/build-contradictions-fixture.ts \
 *     [--queries-file FILE.jsonl] \
 *     [--top-k N=5] \
 *     [--judge MODEL=claude-haiku-4-5] \
 *     [--max-pairs N=50] \
 *     [--output PATH=test/fixtures/contradictions-eval-gold.jsonl] \
 *     [--non-interactive]
 *
 * Interactive flow:
 *   - Probe runs with --no-cache (so candidate pairs aren't pre-judged).
 *   - For each candidate pair, the script prints A + B and prompts:
 *     y) contradiction, n) not contradiction, s) skip
 *     If y: prompt for severity (low|medium|high) and one-line axis.
 *   - After labeling, redact in-memory, write JSONL with audit comments.
 *   - Pre-commit safety: isCleanForCommit per line. Failures abort with
 *     a sentinel string the operator must resolve manually.
 *
 * Non-interactive flow (`--non-interactive`): captures candidates with
 * NO labels, redacts, writes JSONL. Operator labels manually later.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { runContradictionProbe } from '../src/core/eval-contradictions/runner.ts';

async function connectLocalEngine(): Promise<BrainEngine> {
  const cfg = loadConfig();
  if (!cfg) throw new Error('No brain configured. Run `gbrain init` first.');
  const engineCfg = toEngineConfig(cfg);
  const engine = await createEngine(engineCfg);
  await connectWithRetry(engine, engineCfg, { noRetry: false });
  return engine;
}
import {
  createRedactionSession,
  isCleanForCommit,
  redactSlug,
  redactText,
} from '../src/core/eval-contradictions/fixture-redact.ts';
import type { ContradictionPair, Severity } from '../src/core/eval-contradictions/types.ts';

interface ParsedFlags {
  queriesFile?: string;
  topK: number;
  judge: string;
  maxPairs: number;
  output: string;
  nonInteractive: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): ParsedFlags {
  const f: ParsedFlags = {
    topK: 5,
    judge: 'anthropic:claude-haiku-4-5',
    maxPairs: 50,
    output: 'test/fixtures/contradictions-eval-gold.jsonl',
    nonInteractive: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      return v;
    };
    if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--queries-file') f.queriesFile = next();
    else if (a === '--top-k') f.topK = Number.parseInt(next(), 10);
    else if (a === '--judge') f.judge = next();
    else if (a === '--max-pairs') f.maxPairs = Number.parseInt(next(), 10);
    else if (a === '--output') f.output = next();
    else if (a === '--non-interactive') f.nonInteractive = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return f;
}

function printHelp(): void {
  process.stderr.write(`Build a privacy-redacted gold fixture for the contradiction probe judge.

Usage:
  bun run scripts/build-contradictions-fixture.ts \\
    --queries-file FILE.jsonl       # one JSON object per line, {query: "..."}
    [--top-k N=5]
    [--judge MODEL=claude-haiku-4-5]
    [--max-pairs N=50]
    [--output PATH=test/fixtures/contradictions-eval-gold.jsonl]
    [--non-interactive]

Output: JSONL with one labeled-and-redacted pair per line. Lines that
fail isCleanForCommit are marked with a sentinel string the operator
MUST resolve manually before commit. Audit log printed to stderr.
`);
}

function readQueriesFile(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { query?: string };
        if (typeof parsed.query === 'string' && parsed.query.length > 0) {
          out.push(parsed.query);
        }
      } catch {
        // ignore
      }
    } else {
      out.push(trimmed);
    }
  }
  return out;
}

async function promptLabel(rl: ReturnType<typeof createInterface>, pair: ContradictionPair): Promise<{
  contradicts: boolean;
  severity: Severity;
  axis: string;
  skip: boolean;
}> {
  process.stderr.write(`\n--- Pair ---\n`);
  process.stderr.write(`A (${pair.a.slug}): ${pair.a.text.slice(0, 240)}${pair.a.text.length > 240 ? '…' : ''}\n`);
  process.stderr.write(`B (${pair.b.slug}): ${pair.b.text.slice(0, 240)}${pair.b.text.length > 240 ? '…' : ''}\n`);
  const ans = (await rl.question('Contradiction? [y/n/s skip]: ')).trim().toLowerCase();
  if (ans === 's' || ans === 'skip') {
    return { contradicts: false, severity: 'low', axis: '', skip: true };
  }
  if (ans !== 'y' && ans !== 'yes') {
    return { contradicts: false, severity: 'low', axis: '', skip: false };
  }
  let sev = (await rl.question('Severity [low/medium/high, default low]: ')).trim().toLowerCase();
  if (sev !== 'low' && sev !== 'medium' && sev !== 'high') sev = 'low';
  const axis = (await rl.question('One-line axis: ')).trim();
  return { contradicts: true, severity: sev as Severity, axis, skip: false };
}

async function main(): Promise<void> {
  let flags: ParsedFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    printHelp();
    process.exit(2);
  }
  if (flags.help) {
    printHelp();
    return;
  }

  if (!flags.queriesFile) {
    process.stderr.write(`--queries-file is required for the fixture build.\n`);
    printHelp();
    process.exit(2);
  }

  const queries = readQueriesFile(flags.queriesFile);
  if (queries.length === 0) {
    process.stderr.write(`No queries in ${flags.queriesFile}.\n`);
    process.exit(2);
  }

  process.stderr.write(`Building gold fixture against the local brain.\n`);
  process.stderr.write(`Queries: ${queries.length}  Top-K: ${flags.topK}  Max pairs: ${flags.maxPairs}\n`);
  process.stderr.write(`Output: ${flags.output}\n\n`);

  const engine = await connectLocalEngine();
  try {
    // Run the probe with --no-cache so we get candidate pairs without
    // pre-judged verdicts. We don't keep verdicts; we hand-label every pair.
    // We intercept pairs via judgeFn returning contradicts:false (so nothing
    // is filtered to findings) and accumulating them for labeling instead.
    const candidatePairs: ContradictionPair[] = [];
    await runContradictionProbe({
      engine,
      queries,
      judgeModel: flags.judge,
      topK: flags.topK,
      noCache: true,
      // Wide budget so we don't hit cap during candidate collection.
      budgetUsd: 100,
      yesOverride: true,
      // Hijack the judge to collect pairs without spending tokens.
      judgeFn: async (input) => {
        candidatePairs.push({
          kind: 'cross_slug_chunks',  // best-effort label; runner emits both kinds
          a: { slug: input.a.slug, chunk_id: 0, take_id: null, source_tier: 'curated', holder: input.a.holder ?? null, text: input.a.text },
          b: { slug: input.b.slug, chunk_id: 0, take_id: null, source_tier: 'curated', holder: input.b.holder ?? null, text: input.b.text },
          combined_score: 0,
        });
        return {
          verdict: { contradicts: false, severity: 'low', axis: '', confidence: 0, resolution_kind: null },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });

    process.stderr.write(`\nCollected ${candidatePairs.length} candidate pairs.\n`);
    const capped = candidatePairs.slice(0, flags.maxPairs);

    // Label.
    const rl = createInterface({ input, output });
    const session = createRedactionSession();
    const labeled: Array<{
      contradicts: boolean;
      severity: Severity;
      axis: string;
      query_redacted: string;
      a: { slug: string; text: string };
      b: { slug: string; text: string };
    }> = [];

    for (let i = 0; i < capped.length; i++) {
      const pair = capped[i];
      process.stderr.write(`\n[${i + 1}/${capped.length}]`);
      let label: { contradicts: boolean; severity: Severity; axis: string; skip: boolean };
      if (flags.nonInteractive) {
        label = { contradicts: false, severity: 'low', axis: '', skip: false };
      } else {
        label = await promptLabel(rl, pair);
        if (label.skip) continue;
      }
      const redactedA = {
        slug: redactSlug(session, pair.a.slug),
        text: redactText(session, pair.a.text),
      };
      const redactedB = {
        slug: redactSlug(session, pair.b.slug),
        text: redactText(session, pair.b.text),
      };
      labeled.push({
        contradicts: label.contradicts,
        severity: label.severity,
        axis: redactText(session, label.axis),
        // Query gets redacted too, in case it referenced real names.
        query_redacted: '',  // candidatePairs don't carry the query; populated by future iteration
        a: redactedA,
        b: redactedB,
      });
    }
    rl.close();

    // Pre-commit safety: every text field must pass isCleanForCommit.
    const out: string[] = [];
    let flagged = 0;
    out.push(`# Gold fixture for contradiction probe judge (v0.32.6)`);
    out.push(`# schema_version: 1`);
    out.push(`# Generated: ${new Date().toISOString()}`);
    out.push(`# Audit (in-memory redactions applied):`);
    for (const entry of session.audit.slice(0, 100)) {
      out.push(`#   ${entry}`);
    }
    out.push(`# Total redactions: ${session.audit.length}`);
    out.push(`#`);
    for (const row of labeled) {
      const cleanA = isCleanForCommit(row.a.text) && isCleanForCommit(row.a.slug);
      const cleanB = isCleanForCommit(row.b.text) && isCleanForCommit(row.b.slug);
      const sentinel = !cleanA || !cleanB ? '  [REDACT?]' : '';
      if (sentinel) flagged++;
      out.push(JSON.stringify({ ...row, ...(sentinel ? { _operator_review: 'REDACTION INCOMPLETE — fix manually before commit' } : {}) }));
    }

    // Ensure output dir exists, then write.
    mkdirSync(dirname(flags.output), { recursive: true });
    if (existsSync(flags.output)) {
      process.stderr.write(`\nWARN: ${flags.output} already exists. Overwriting.\n`);
    }
    writeFileSync(flags.output, out.join('\n') + '\n');
    process.stderr.write(`\nWrote ${labeled.length} labeled pairs to ${flags.output}.\n`);
    if (flagged > 0) {
      process.stderr.write(`*** ${flagged} pair(s) flagged with [REDACT?] — review before commit ***\n`);
      process.exit(1);
    }
    process.stderr.write(`OK — pre-commit safety pass. Inspect the file once more before committing.\n`);
  } finally {
    await engine.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
