#!/usr/bin/env bun
// harness.mjs — takes-bootstrap classifier eval runner (H1 / TODOS TODO-E).
//
// LIVE mode (default; requires a chat-capable key, spends real tokens):
//   bun evals/takes-bootstrap/harness.mjs [--max N] [--out results.jsonl]
// Per corpus case: seeds the fixture page into a throwaway PGLite brain and
// runs the REAL production path — extractTakesFromPages (consent gate,
// prompt, parseClaimsJson, addTakesBatch) — then reads the takes rows back
// as that case's predictions. ~123 Haiku-class calls per full run.
//
// REPLAY mode ($0, deterministic):
//   bun evals/takes-bootstrap/harness.mjs --replay results.jsonl
// Re-scores a saved predictions file against the current corpus/scorer
// (the functional-area-resolver rescore.mjs pattern).
//
// Keyless environments REFUSE loudly (never fake a score): graduation of
// the autopilot tier requires a passing LIVE run recorded in the PR.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const corpus = readFileSync(join(here, 'corpus.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));

const { scoreCorpus } = await import('./scorer.ts');

function finish(predictions) {
  const report = scoreCorpus(corpus, predictions);
  console.log(JSON.stringify(report, null, 2));
  console.log(report.graduated
    ? `\nGRADUATED (scorer v${report.scorer_version}): per-kind bars met, 0 malformed, 0 forbid violations.`
    : `\nNOT GRADUATED:\n  - ${report.failures.join('\n  - ')}`);
  process.exit(report.graduated ? 0 : 1);
}

const replay = flag('--replay');
if (replay) {
  const predictions = readFileSync(replay, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  finish(predictions);
}

// ── LIVE mode ───────────────────────────────────────────────────────────────
const { isAvailable } = await import('../../src/core/ai/gateway.ts');
if (!isAvailable('chat')) {
  console.error('takes-bootstrap harness: no chat-capable provider configured — refusing to run keyless.');
  console.error('Set a key (e.g. ANTHROPIC_API_KEY) or use --replay <results.jsonl> to re-score a saved run.');
  process.exit(2);
}

const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
const { extractTakesFromPages } = await import('../../src/core/extract-takes-from-pages.ts');

const max = Number(flag('--max') ?? corpus.length);
const outPath = flag('--out') ?? join(here, 'results-latest.jsonl');
const predictions = [];

const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();

let done = 0;
for (const c of corpus.slice(0, max)) {
  // Fresh page per case; unique slug isolates takes rows.
  await engine.putPage(c.page.slug, {
    type: c.page.type, title: c.page.title, compiled_truth: c.page.body, frontmatter: {},
  }, {});
  const res = await extractTakesFromPages(engine, {
    bootstrapEnabled: true,
    maxPages: 1,
    includeCovered: false,
    holder: 'eval',
  });
  if (res.llm_unavailable) {
    console.error(`case ${c.id}: gateway became unavailable mid-run — aborting (partial results NOT scored).`);
    process.exit(2);
  }
  const page = await engine.getPage(c.page.slug, {});
  const rows = page
    ? await engine.executeRaw(
        `SELECT claim, kind, weight FROM takes WHERE page_id = $1 AND holder = 'eval'`,
        [page.id],
      )
    : [];
  predictions.push({
    id: c.id,
    claims: rows.map(r => ({ claim: String(r.claim), kind: String(r.kind), weight: Number(r.weight) })),
  });
  done += 1;
  if (done % 10 === 0) console.error(`…${done}/${Math.min(max, corpus.length)}`);
}
await engine.disconnect();

writeFileSync(outPath, predictions.map(p => JSON.stringify(p)).join('\n') + '\n');
console.error(`predictions written to ${outPath}`);
finish(predictions);
